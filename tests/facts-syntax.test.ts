import { describe, expect, it } from 'vitest'
import { SlopItError } from '../src/errors.js'
import { autoExcerpt } from '../src/posts.js'
import {
  checkFactValue,
  factLines,
  factNames,
  materializePost,
  scanFacts,
  substituteFacts,
  validatePostFacts,
  type FactRecord,
} from '../src/rendering/facts.js'
import { renderMarkdown } from '../src/rendering/markdown.js'
import type { Post } from '../src/schema/index.js'

const thrown = (fn: () => unknown): SlopItError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SlopItError)
    return e as SlopItError
  }
  throw new Error('expected a throw')
}

const values = (o: Record<string, string>) => new Map(Object.entries(o))
const KNOWN = new Set(['price', 'version', 'n', 'a', 'b'])
const check = (body: string, published = true, fields = {}) =>
  validatePostFacts(body, fields, published, KNOWN)

describe('scanFacts — one scanner, code is never scanned', () => {
  it('finds tokens outside code with 1-based lines', () => {
    const md = 'Pro is {{fact:price}}.\n\nNow {{fact:version}} and {{fact:price}} again.'
    expect(scanFacts(md).map((o) => [o.name, o.line])).toEqual([
      ['price', 1],
      ['version', 3],
      ['price', 3],
    ])
    expect(factNames(md)).toEqual(['price', 'version'])
  })

  it('leaves tokens in ``` and ~~~ fences and inline code alone', () => {
    const md = [
      '```',
      '{{fact:price}}',
      '```',
      '~~~',
      '{{fact:price}}',
      '~~~',
      'Use `{{fact:price}}` in a body.',
    ].join('\n')
    expect(scanFacts(md)).toEqual([])
    expect(substituteFacts(md, values({ price: '$12' }))).toBe(md)
  })

  it('treats anything but the exact token as literal text, never an error', () => {
    for (const md of [
      '{{ fact:price }}',
      '{{fact:Price}}',
      '{{fact:price}',
      '{fact:price}}',
      '{{fact:9lives}}',
      '{{fact:' + 'a'.repeat(41) + '}}',
      '{{Fact:price}}',
    ]) {
      expect(scanFacts(md), md).toEqual([])
      expect(() => check(md), md).not.toThrow()
    }
    expect(factNames('{{fact:' + 'a'.repeat(40) + '}}')).toEqual(['a'.repeat(40)])
  })

  it('stays linear on a long line packed with tokens', () => {
    const md = '{{fact:a}}'.repeat(20_000) + ' ' + 'x '.repeat(50_000)
    const t = Date.now()
    scanFacts(md)
    substituteFacts(md, values({ a: '1' }))
    check(md)
    expect(Date.now() - t).toBeLessThan(2000)
  })
})

describe('checkFactValue — values are inert plain text', () => {
  it.each(['[', ']', '<', '>', '*', '_', '~', '`', '|', '\\', '{', '}'])(
    'rejects %s, naming it',
    (ch) => {
      const err = thrown(() => checkFactValue(`a${ch}b`))
      expect(err.code).toBe('FACT_VALUE_INVALID')
      expect(err.details.character).toBe(ch)
      expect(err.message).toContain(`"${ch}"`)
    },
  )

  it('rejects empty, too long, multi-line and control characters', () => {
    for (const v of ['', '   ', 'x'.repeat(121), 'a\nb', 'a\u0007b', 'a b']) {
      expect(thrown(() => checkFactValue(v)).code, JSON.stringify(v)).toBe('FACT_VALUE_INVALID')
    }
  })

  it('accepts and trims ordinary values', () => {
    for (const v of ['$12/mo', 'v2.4.1', '1,000+', 'AT&T', '-5%', '#1', '10 GB', '€9,99', '1.']) {
      expect(checkFactValue(`  ${v} `)).toBe(v)
    }
    expect(checkFactValue('x'.repeat(120))).toHaveLength(120)
  })
})

describe('substitution — a value at a line start never becomes block syntax', () => {
  // Each body puts a hostile value where a block would start; the rendered
  // page must hold exactly one paragraph (or list item / quote the author
  // wrote) with the value as text.
  const render = (md: string, v: string) => renderMarkdown(substituteFacts(md, values({ n: v })))

  it.each([
    '# heading',
    '## h',
    '- item',
    '+ item',
    '> quote',
    '=== ',
    '---',
    '1. item',
    '1) item',
  ])('a line that is only {{fact:n}} = %j stays a paragraph', (v) => {
    const html = render('Intro line\n{{fact:n}}', v)
    expect(html).not.toMatch(/<h\d|<li|<blockquote|<hr|<ol|<ul/)
    expect(html).toContain(v.trim().replace(/>/g, '&gt;'))
  })

  it('escapes inside list items and blockquotes too', () => {
    const md = '- {{fact:n}}\n\n> {{fact:n}}\n\n1. {{fact:n}}'
    const html = render(md, '# not a heading')
    expect(html).not.toMatch(/<h\d/)
    expect(html.match(/# not a heading/g)).toHaveLength(3)
  })

  it('looks at back-to-back tokens and the author text around them together', () => {
    const v = values({ a: '1', b: '. x', n: '5' })
    expect(renderMarkdown(substituteFacts('{{fact:a}}{{fact:b}}', v))).not.toContain('<ol')
    expect(renderMarkdown(substituteFacts('{{fact:n}}. Item', v))).not.toContain('<ol')
    expect(renderMarkdown(substituteFacts('1{{fact:b}}', v))).not.toContain('<ol')
    expect(renderMarkdown(substituteFacts('{{fact:n}}. Item', v))).toContain('5. Item')
  })

  it('looks at a #, - or = run the author typed right before the token', () => {
    const v = values({ hash: '# x', dash: '--', eq: '==', two: '- -' })
    for (const md of [
      '#{{fact:hash}}',
      'Para\n-{{fact:dash}}',
      'Para\n={{fact:eq}}',
      '-{{fact:two}}',
    ]) {
      expect(renderMarkdown(substituteFacts(md, v)), md).not.toMatch(/<h\d|<hr|<li/)
    }
    expect(substituteFacts('#{{fact:hash}}', v)).toBe('#\\# x')
    expect(substituteFacts('#{{fact:dash}}', v)).toBe('#--')
  })

  it('stays linear with many tokens after a long prefix on one line', () => {
    const md = '#'.repeat(50_000) + 'x' + ' {{fact:a}}'.repeat(20_000)
    const t = Date.now()
    substituteFacts(md, values({ a: '1' }))
    expect(Date.now() - t).toBeLessThan(2000)
  })

  it('does not escape a value in the middle of a line', () => {
    expect(substituteFacts('Rank {{fact:n}} today', values({ n: '#1' }))).toBe('Rank #1 today')
    expect(substituteFacts('{{fact:n}} today', values({ n: '#1' }))).toBe('\\#1 today')
  })

  it('leaves unknown tokens literal', () => {
    expect(substituteFacts('a {{fact:x}} b', values({ n: '1' }))).toBe('a {{fact:x}} b')
  })

  it('a value is HTML-escaped text on the page', () => {
    const html = renderMarkdown(substituteFacts('Get {{fact:n}} now', values({ n: 'AT&T "x"' })))
    expect(html).toContain('AT&amp;T &quot;x&quot;')
  })
})

describe('validatePostFacts — where a token may sit', () => {
  it('allows text, lists, quotes, table cells, emphasis, link text and image alt', () => {
    const md = [
      'Text {{fact:price}}.',
      '- item {{fact:price}}',
      '> quote {{fact:price}}',
      '',
      '| Plan | Price |',
      '|---|---|',
      '| Pro | {{fact:price}} |',
      '',
      '**{{fact:price}}** and _{{fact:price}}_',
      '[costs {{fact:price}}](https://example.com/pricing)',
      '![chart for {{fact:version}}](https://img.example/a.png)',
    ].join('\n')
    expect(() => check(md)).not.toThrow()
  })

  it.each([
    ['## Pricing {{fact:price}}', 1],
    ['Intro\n\n# {{fact:price}}', 3],
    ['Price {{fact:price}}\n---', 1],
    ['First {{fact:price}}\nsecond line\n===', 1],
    ['> ## In a quote {{fact:price}}', 1],
    ['- # In a list {{fact:price}}', 1],
  ])('FACT_IN_HEADING: %j (line %i)', (md, line) => {
    const err = thrown(() => check(md))
    expect(err.code).toBe('FACT_IN_HEADING')
    expect(err.details).toEqual({ name: 'price', line })
    expect(err.message).toContain(`line ${line}`)
  })

  it('a list item followed by --- is a list and a rule, not a heading', () => {
    expect(() => check('- item {{fact:price}}\n---')).not.toThrow()
  })

  it.each([
    ['[pricing](https://x.com/{{fact:price}})', 1],
    ['![a](https://img.example/{{fact:version}}.png)', 1],
    ['[a](https://x.com "title {{fact:price}}")', 1],
    ['Text\n\n[ref]: https://x.com/{{fact:price}}', 3],
    ['See [the page][ref].\n\n[ref]: https://x.com/{{fact:price}}', 3],
    ['Go to <https://x.com/{{fact:price}}>', 1],
    ['Go to <{{fact:price}}>', 1],
    ['Tag <{{fact:price}} attr', 1],
    ['Bare https://x.com/{{fact:price}} link', 1],
    ['Bare www.{{fact:price}}.com link', 1],
  ])('FACT_IN_URL: %j (line %i)', (md, line) => {
    const err = thrown(() => check(md))
    expect(err.code).toBe('FACT_IN_URL')
    expect(err.details).toMatchObject({ line })
  })

  it('reports the first offending token in document order', () => {
    const err = thrown(() => check('ok {{fact:a}}\n\n[x]({{fact:b}})\n\n## {{fact:n}}'))
    expect(err.code).toBe('FACT_IN_URL')
    expect(err.details).toEqual({ name: 'b', line: 3 })
  })

  it.each(['title', 'excerpt', 'seoTitle', 'seoDescription', 'author', 'coverImage', 'slug'])(
    'FACT_NOT_ALLOWED_HERE in %s',
    (field) => {
      const err = thrown(() => check('body', true, { [field]: 'x {{fact:price}}' }))
      expect(err.code).toBe('FACT_NOT_ALLOWED_HERE')
      expect(err.details).toEqual({ field, name: 'price' })
    },
  )

  it('FACT_NOT_ALLOWED_HERE in a tag', () => {
    expect(thrown(() => check('body', true, { tags: ['ok', '{{fact:price}}'] })).code).toBe(
      'FACT_NOT_ALLOWED_HERE',
    )
  })

  it('unknown names: fine in a draft, FACT_NOT_FOUND (all of them) when published', () => {
    const md = '{{fact:nope}} and {{fact:price}} and {{fact:gone}} and {{fact:nope}}'
    expect(() => check(md, false)).not.toThrow()
    const err = thrown(() => check(md, true))
    expect(err.code).toBe('FACT_NOT_FOUND')
    expect(err.details).toEqual({ names: ['nope', 'gone'] })
  })

  it('contexts are checked in drafts too', () => {
    expect(thrown(() => check('## {{fact:nope}}', false)).code).toBe('FACT_IN_HEADING')
  })
})

describe('factLines — the dry-run preview', () => {
  it('returns whole source lines with the value before and after', () => {
    const md =
      'Intro.\n\n| Pro | {{fact:price}} |\n- {{fact:version}} costs {{fact:price}}\n\n`{{fact:price}}`'
    const before = values({ price: '$12', version: 'v1' })
    const after = values({ price: '$15', version: 'v1' })
    expect(factLines(md, 'price', before, after)).toEqual([
      { line: 3, before: '| Pro | $12 |', after: '| Pro | $15 |' },
      { line: 4, before: '- v1 costs $12', after: '- v1 costs $15' },
    ])
  })

  it('shows the literal token for a fact that does not exist yet', () => {
    expect(factLines('A {{fact:new}}.', 'new', values({}), values({ new: '7' }))).toEqual([
      { line: 1, before: 'A {{fact:new}}.', after: 'A 7.' },
    ])
  })
})

describe('materializePost', () => {
  const post = (body: string, extra: Partial<Post> = {}): Post => ({
    id: 'p1',
    blogId: 'b1',
    slug: 's',
    title: 'T',
    body,
    excerpt: autoExcerpt(body),
    tags: [],
    status: 'published',
    publishedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    ...extra,
  })
  const fact = (value: string, confirmedAt: string, updatedAt: string): FactRecord => ({
    value,
    confirmedAt,
    updatedAt,
  })
  const facts = new Map([
    ['pro_price', fact('$12/mo', '2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')],
    ['version', fact('v2.4.1', '2026-02-15T00:00:00.000Z', '2025-12-01T00:00:00.000Z')],
  ])

  it('returns the very same post when the body has no tokens (byte-identical output)', () => {
    const p = post('No facts here, `{{fact:pro_price}}` is code.')
    expect(materializePost(p, facts).post).toBe(p)
    expect(materializePost(p, facts).factsNote).toBeUndefined()
  })

  it('returns the same post when every name is unknown (draft preview keeps the token)', () => {
    const p = post('Soon: {{fact:later}}', { status: 'draft' })
    expect(materializePost(p, facts)).toEqual({ post: p })
  })

  it('substitutes body and auto-excerpt, moves updatedAt to the newest value change, notes the oldest confirmation', () => {
    const p = post('Pro is {{fact:pro_price}} on {{fact:version}}; {{fact:later}} later.')
    expect(p.excerpt).toBe('Pro is {{fact:pro_price}} on {{fact:version}}; {{fact:later}} later.')
    const m = materializePost(p, facts)
    expect(m.post.body).toBe('Pro is $12/mo on v2.4.1; {{fact:later}} later.')
    expect(m.post.excerpt).toBe('Pro is $12/mo on v2.4.1; {{fact:later}} later.')
    // SQLite's 'YYYY-MM-DD HH:MM:SS' compares as UTC, not as text.
    expect(m.post.updatedAt).toBe('2026-02-01T00:00:00.000Z')
    expect(m.factsNote).toEqual({ oldestConfirmedAt: '2026-02-15T00:00:00.000Z' })
  })

  it('keeps the post updatedAt when it is newer than every fact change', () => {
    const p = post('{{fact:version}}', { updatedAt: '2026-06-01T00:00:00.000Z' })
    expect(materializePost(p, facts).post.updatedAt).toBe('2026-06-01T00:00:00.000Z')
  })

  it('substitutes the excerpt only for names the body uses outside code', () => {
    // autoExcerpt turned `{{fact:pro_price}}` (code) into a bare, underscore-less string.
    const p = post('Write `{{fact:pro_price}}` and {{fact:version}}.')
    const m = materializePost(p, new Map([...facts, ['proprice', facts.get('pro_price')!]]))
    expect(m.post.excerpt).toBe('Write {{fact:proprice}} and v2.4.1.')
  })
})

describe('autoExcerpt with fact tokens', () => {
  it('keeps token names whole (the stripping drops underscores elsewhere)', () => {
    expect(autoExcerpt('**Pro** is {{fact:pro_price}} for _you_.')).toBe(
      'Pro is {{fact:pro_price}} for you.',
    )
  })

  it('never cuts a token in half', () => {
    const body = 'x'.repeat(150) + ' {{fact:pro_price}} tail'
    expect(autoExcerpt(body)).toBe('x'.repeat(150) + '…')
  })

  it('a body without tokens is excerpted exactly as before', () => {
    // Expected value computed with autoExcerpt as it was before live facts.
    const body = '# Title\n\n> quote with *emph* and `code_span`\n\n' + 'word '.repeat(60)
    expect(autoExcerpt(body)).toBe(
      'Title quote with emph and codespan ' + 'word '.repeat(24) + 'word…',
    )
  })
})
