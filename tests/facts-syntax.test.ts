import { describe, expect, it } from 'vitest'
import { SlopItError } from '../src/errors.js'
import { autoExcerpt } from '../src/posts.js'
import {
  checkFactValue,
  factLines,
  factNames,
  factsToMarkdown,
  materializePost,
  scanFacts,
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

const post = (body: string, extra: Partial<Post> = {}): Post => ({
  id: 'p1',
  blogId: 'b1',
  slug: 's',
  title: 'T',
  body,
  tags: [],
  status: 'published',
  publishedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01 00:00:00',
  updatedAt: '2026-01-01 00:00:00',
  ...extra,
})
const fact = (
  value: string,
  confirmedAt = '2026-03-01T00:00:00.000Z',
  updatedAt = confirmedAt,
): FactRecord => ({ value, confirmedAt, updatedAt })
const factMap = (o: Record<string, string>) =>
  new Map(Object.entries(o).map(([k, v]) => [k, fact(v)]))
const pageHtml = (body: string, o: Record<string, string>) =>
  materializePost(post(body), factMap(o)).bodyHtml()

describe('scanFacts — one scanner, code decided by the lexer', () => {
  it('finds live tokens with 1-based lines', () => {
    const md = 'Pro is {{fact:price}}.\n\nNow {{fact:version}} and {{fact:price}} again.'
    expect(scanFacts(md).map((o) => [o.name, o.line])).toEqual([
      ['price', 1],
      ['version', 3],
      ['price', 3],
    ])
    expect(factNames(md)).toEqual(['price', 'version'])
  })

  it.each([
    ['``` fence', '```\n{{fact:price}}\n```'],
    ['~~~ fence', '~~~\n{{fact:price}}\n~~~'],
    ['inline code', 'Use `{{fact:price}}` here.'],
    ['double-backtick span', 'Use ``{{fact:price}}`` here.'],
    ['span holding a backtick', 'Use `` a`{{fact:price}} `` here.'],
    ['inline code over two lines', 'Use `a\n{{fact:price}}` here.'],
    ['unclosed fence (runs to the end)', 'Intro\n\n```\n{{fact:price}}\nmore'],
    ['4-backtick fence holding ```', '````\n```\n{{fact:price}}\n```\n````'],
    ['indented code', 'Intro\n\n    {{fact:price}}'],
    ['code in a list item', '- item\n\n      {{fact:price}}'],
    ['code in a quote', '> `{{fact:price}}`'],
  ])('%s is code: not live, not validated, not substituted', (_, md) => {
    expect(scanFacts(md)).toEqual([])
    expect(() => check(md.replace('price', 'unknown_name'))).not.toThrow()
    expect(pageHtml(md, { price: 'VALUE' })).not.toContain('VALUE')
    expect(factsToMarkdown(md, values({ price: 'VALUE' }))).toBe(md)
  })

  it('a backslash before the token makes it literal; an escaped backslash does not', () => {
    expect(scanFacts('\\{{fact:price}}')).toEqual([])
    expect(pageHtml('\\{{fact:price}}', { price: 'V' })).toBe('<p>{{fact:price}}</p>\n')
    expect(factNames('\\\\{{fact:price}}')).toEqual(['price'])
  })

  it('treats anything but the exact token as literal text, never an error', () => {
    for (const md of [
      '{{ fact:price }}',
      '{{fact:Price}}',
      '{{fact:price}',
      '{fact:price}}',
      '{{fact:9lives}}',
      '{{fact:' + 'a'.repeat(41) + '}}',
    ]) {
      expect(scanFacts(md), md).toEqual([])
      expect(() => check(md), md).not.toThrow()
    }
    expect(factNames('{{fact:' + 'a'.repeat(40) + '}}')).toEqual(['a'.repeat(40)])
  })

  it('stays fast on a long line packed with tokens', () => {
    const md = '{{fact:a}}'.repeat(10_000) + ' ' + 'x '.repeat(50_000)
    const t = Date.now()
    scanFacts(md)
    check(md)
    factsToMarkdown(md, values({ a: '1' }))
    expect(Date.now() - t).toBeLessThan(5000)
  })
})

describe('checkFactValue — values are plain text', () => {
  it.each(['[', ']', '<', '>', '*', '_', '~', '`', '|', '\\', '{', '}'])(
    'rejects %s, naming it',
    (ch) => {
      const err = thrown(() => checkFactValue(`a${ch}b`))
      expect(err.code).toBe('FACT_VALUE_INVALID')
      expect(err.details.character).toBe(ch)
    },
  )

  it('rejects empty, too long, multi-line, control characters and rule-like values', () => {
    for (const v of ['', '   ', 'x'.repeat(121), 'a\nb', 'a\u0007b', 'a b']) {
      expect(thrown(() => checkFactValue(v)).code, JSON.stringify(v)).toBe('FACT_VALUE_INVALID')
    }
    for (const v of ['-', '---', ':-:', '= =', '- : -', '===']) {
      expect(thrown(() => checkFactValue(v)).message, v).toMatch(/only of -, : and =/)
    }
  })

  it('accepts and trims ordinary values', () => {
    for (const v of ['$12/mo', 'v2.4.1', '1,000+', 'AT&T', '-5%', '#1', '10 GB', '€9,99', '1.']) {
      expect(checkFactValue(`  ${v} `)).toBe(v)
    }
  })
})

// Values a fact may hold that would be markdown, a URL, an embed or an
// entity if they were parsed: every output must show them as written.
const HOSTILE = [
  '# heading',
  '## h',
  '- item',
  '+ item',
  '> quote',
  '1. item',
  '1) item',
  '=x',
  'https://youtu.be/3mlRiF-LeMc',
  'https://example.com/path',
  'www.example.com',
  'ops@example.com',
  '&#49;',
  'AT&T',
  '&amp;',
  '$12/mo',
  ':-: ok',
]
// Where a value can sit: alone on a line, after container markers, mid-
// sentence, in a table cell, emphasis, link text, back to back.
const CONTEXTS = [
  '{{fact:n}}',
  'Intro line\n{{fact:n}}',
  '- {{fact:n}}',
  '> {{fact:n}}',
  '1. {{fact:n}}',
  'Rank {{fact:n}} today.',
  '{{fact:n}}. Next',
  '| A | B |\n|---|---|\n| x | {{fact:n}} |',
  '**{{fact:n}}**',
  '[see {{fact:n}}](https://example.com)',
  '{{fact:n}}{{fact:n}}',
]
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

describe('the page: values are escaped text, never parsed', () => {
  it.each(HOSTILE)('%j shows as written, in every context', (v) => {
    for (const ctx of CONTEXTS) {
      const html = pageHtml(ctx, { n: v })
      expect(html, ctx).toContain(escapeHtml(v))
      expect(html, ctx).not.toMatch(/<h\d|<iframe|<hr/)
      expect(html, ctx).not.toContain('')
      if (!ctx.startsWith('>')) expect(html, ctx).not.toContain('<blockquote')
      if (!/^(- |1\. )/.test(ctx)) expect(html, ctx).not.toContain('<li')
      if (!ctx.startsWith('[see')) expect(html, ctx).not.toContain('<a ')
    }
  })

  it('a value alone in a paragraph is never a YouTube player, a link or a list', () => {
    expect(pageHtml('{{fact:n}}', { n: 'https://youtu.be/3mlRiF-LeMc' })).toBe(
      '<p>https://youtu.be/3mlRiF-LeMc</p>\n',
    )
    expect(pageHtml('{{fact:n}}', { n: '1. item' })).toBe('<p>1. item</p>\n')
    expect(pageHtml('Text {{fact:n}} more', { n: '&#49;' })).toBe('<p>Text &amp;#49; more</p>\n')
  })

  it('author text that looks like a placeholder is left alone', () => {
    const md = 'Odd abcdef0123450 text and {{fact:n}}.'
    expect(pageHtml(md, { n: 'V' })).toBe(`<p>Odd abcdef0123450 text and V.</p>\n`)
  })

  it('unknown tokens stay literal', () => {
    expect(pageHtml('a {{fact:x}} b', { n: '1' })).toBe('<p>a {{fact:x}} b</p>\n')
  })
})

describe('the .md twin: values as literal-equivalent markdown', () => {
  // The twin, rendered by the page's own parser, says what the page says.
  it.each(HOSTILE)('%j: the twin renders exactly like the page', (v) => {
    for (const ctx of CONTEXTS) {
      const twin = factsToMarkdown(ctx, values({ n: v }))
      expect(renderMarkdown(twin), `${ctx} → ${twin}`).toBe(pageHtml(ctx, { n: v }))
    }
  })

  it('keeps ordinary values readable', () => {
    expect(factsToMarkdown('Pro is {{fact:n}}.', values({ n: '$12/mo' }))).toBe('Pro is $12/mo.')
    expect(factsToMarkdown('On {{fact:n}} now', values({ n: 'v2.4.1' }))).toBe('On v2.4.1 now')
  })

  it('escapes what would become an entity, an autolink or block syntax', () => {
    const t = (v: string, ctx = 'x {{fact:n}} y') => factsToMarkdown(ctx, values({ n: v }))
    expect(t('&#49;')).toBe('x \\&#49; y')
    expect(t('ops@example.com')).toBe('x ops\\@example.com y')
    expect(t('https://example.com')).toBe('x https\\://example.com y')
    expect(t('see www.example.com')).toBe('x see www\\.example.com y')
    expect(t('# h', '{{fact:n}}')).toBe('\\# h')
    expect(t('5', '{{fact:n}}. Next')).toBe('5\\. Next')
  })

  it("falls back to strict escaping when a value joins the author's text into syntax", () => {
    for (const [ctx, v] of [
      ['Go to https:{{fact:n}} now', '//evil.example'],
      ['Visit www{{fact:n}} today', '.example.com'],
      ['See [{{fact:n}}] here\n\n[42]: https://example.com', '42'],
      ['Mail me{{fact:n}} soon', '@example.com'],
      ['Price &{{fact:n}} ok', 'amp;'],
      ['x &#{{fact:n}} y', '49;'],
    ]) {
      const twin = factsToMarkdown(ctx, values({ n: v }))
      expect(renderMarkdown(twin), `${ctx} → ${twin}`).toBe(pageHtml(ctx, { n: v }))
    }
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
    ['Text\n\n[ref {{fact:price}}]: /target', 3],
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
  it('returns whole source lines with live tokens replaced before and after', () => {
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
  const facts = new Map([
    ['pro_price', fact('$12/mo', '2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')],
    ['version', fact('v2.4.1', '2026-02-15T00:00:00.000Z', '2025-12-01T00:00:00.000Z')],
  ])

  it('returns the very same post when the body has no live tokens (byte-identical output)', () => {
    const p = post('No facts here, `{{fact:pro_price}}` is code.', { excerpt: 'x' })
    const m = materializePost(p, facts)
    expect(m.post).toBe(p)
    expect(m.factsNote).toBeUndefined()
    expect(m.bodyHtml()).toBe(renderMarkdown(p.body))
  })

  it('moves updatedAt to the newest value change and notes the oldest confirmation', () => {
    const m = materializePost(post('Pro is {{fact:pro_price}} on {{fact:version}}.'), facts)
    expect(m.post.body).toBe('Pro is $12/mo on v2.4.1.')
    // SQLite's 'YYYY-MM-DD HH:MM:SS' compares as UTC, not as text.
    expect(m.post.updatedAt).toBe('2026-02-01T00:00:00.000Z')
    expect(m.factsNote).toEqual({ oldestConfirmedAt: '2026-02-15T00:00:00.000Z' })
    const newer = post('{{fact:version}}', { updatedAt: '2026-06-01T00:00:00.000Z' })
    expect(materializePost(newer, facts).post.updatedAt).toBe('2026-06-01T00:00:00.000Z')
  })

  it('derives a missing excerpt from live tokens only (code stays literal)', () => {
    // The code span is not substituted; autoExcerpt drops its underscore as
    // it always has for code text (`code_span` → `codespan`).
    const m = materializePost(post('Use `{{fact:pro_price}}` to show {{fact:pro_price}}.'), facts)
    expect(m.post.excerpt).toBe('Use {{fact:proprice}} to show $12/mo.')
    const long = materializePost(post('word '.repeat(40) + '{{fact:version}}'), facts)
    expect(long.post.excerpt).toBe(('word '.repeat(40) + 'v2.4.1').slice(0, 160).trimEnd() + '…')
  })

  it('never touches an excerpt the author wrote', () => {
    const m = materializePost(post('{{fact:pro_price}}', { excerpt: 'Written by hand.' }), facts)
    expect(m.post.excerpt).toBe('Written by hand.')
    expect(m.post.seoDescription).toBeUndefined()
  })

  it('a blank excerpt falls back to a description with values as text', () => {
    const m = materializePost(
      post('**Pro** is {{fact:pro_price}} on AT&T.', { excerpt: '' }),
      facts,
    )
    expect(m.post.excerpt).toBe('')
    expect(m.post.seoDescription).toBe('Pro is $12/mo on AT&T.')
  })

  it('keeps unknown tokens literal (a draft preview) and adds no note', () => {
    const m = materializePost(post('Soon {{fact:later_on}}.', { status: 'draft' }), facts)
    expect(m.bodyHtml()).toBe('<p>Soon {{fact:later_on}}.</p>\n')
    expect(m.post.excerpt).toBe('Soon {{fact:later_on}}.')
    expect(m.factsNote).toBeUndefined()
  })
})

describe('autoExcerpt', () => {
  it('excerpts exactly as before live facts', () => {
    // Expected value computed with autoExcerpt as it was before live facts.
    const body = '# Title\n\n> quote with *emph* and `code_span`\n\n' + 'word '.repeat(60)
    expect(autoExcerpt(body)).toBe(
      'Title quote with emph and codespan ' + 'word '.repeat(24) + 'word…',
    )
  })
})
