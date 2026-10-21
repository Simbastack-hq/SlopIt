import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlog } from '../src/blogs.js'
import { createStore, type Store } from '../src/db/store.js'
import { SlopItError } from '../src/errors.js'
import {
  deleteFact,
  drainPendingFactRenders,
  getFact,
  listFacts,
  setFact,
  type SetFactInput,
} from '../src/facts.js'
import { createPost, deletePost, getPost, updatePost } from '../src/posts.js'
import { createRenderer, type MutationRenderer } from '../src/rendering/generator.js'
import type { PostInput } from '../src/schema/index.js'

const T1 = '2030-01-01T00:00:00.000Z'
const T2 = '2030-02-01T00:00:00.000Z'
const T3 = '2030-03-01T00:00:00.000Z'

const thrown = (fn: () => unknown): SlopItError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SlopItError)
    return e as SlopItError
  }
  throw new Error('expected a throw')
}

/** Every file under `dir` → content, for "nothing changed" checks. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(dir, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

describe('live facts', () => {
  let dir: string
  let out: string
  let store: Store
  let renderer: MutationRenderer
  let blogId: string

  const read = (path: string) => readFileSync(join(out, blogId, path), 'utf8')
  const set = (name: string, input: SetFactInput, r: MutationRenderer = renderer) =>
    setFact(store, r, blogId, name, input)
  const post = (input: PostInput, r: MutationRenderer = renderer) =>
    createPost(store, r, blogId, input).post
  const at = (iso: string) => vi.setSystemTime(new Date(iso))
  const dateModified = (html: string) => /"dateModified":"([^"]+)"/.exec(html)?.[1]
  const lastmod = (slug: string) =>
    new RegExp(`<loc>https://f\\.example/${slug}/</loc>\\s*<lastmod>([^<]+)</lastmod>`).exec(
      read('sitemap.xml'),
    )?.[1]
  const rows = () => ({
    facts: store.db.prepare('SELECT * FROM facts ORDER BY blog_id, name').all(),
    pending: store.db.prepare('SELECT * FROM fact_renders_pending').all(),
  })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    dir = mkdtempSync(join(tmpdir(), 'slopit-facts-'))
    out = join(dir, 'out')
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderer = createRenderer({ store, outputDir: out, baseUrl: 'https://f.example/' })
    blogId = createBlog(store, { name: 'facts' }).blog.id
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('a value change reaches every representation', () => {
    beforeEach(() => {
      at(T1)
      set('pro_price', { value: '$12/mo' })
      post({ title: 'Pricing', body: 'Pro costs {{fact:pro_price}}, billed monthly.\n\nMore.' })
      post({ title: 'Other', body: 'No figures here.' })
    })

    it('page, .md twin, feed, llms.txt, home and "More from" all show the current value', () => {
      at(T2)
      const res = set('pro_price', { value: '$15/mo' })
      expect(res).toMatchObject({ changed: true, dry_run: false, rerendered: 1 })

      const page = read('pricing/index.html')
      expect(page).toContain('<p>Pro costs $15/mo, billed monthly.</p>')
      expect(page).toContain(
        '<p class="facts-note">Some figures on this page are kept current by the publisher. Least recently confirmed: February 1, 2030.</p>',
      )
      const twin = read('pricing.md')
      expect(twin).toContain('\n\nPro costs $15/mo, billed monthly.\n\nMore.\n\n')
      expect(twin.endsWith('Least recently confirmed: February 1, 2030.\n')).toBe(true)
      const feed = read('feed.xml')
      expect(feed).toContain('Pro costs $15/mo, billed monthly.')
      expect(feed).toContain('<p>Some figures on this page are kept current by the publisher.')
      expect(read('llms.txt')).toContain('Pro costs $15/mo')
      expect(read('index.html')).toContain('Pro costs $15/mo')
      expect(read('other/index.html')).toContain('Pro costs $15/mo')

      for (const file of [
        'pricing/index.html',
        'pricing.md',
        'feed.xml',
        'llms.txt',
        'index.html',
      ]) {
        expect(read(file), file).not.toContain('$12/mo')
        expect(read(file), file).not.toContain('{{fact:')
      }
      // The post that uses no fact gets no note.
      expect(read('other/index.html')).not.toContain('facts-note')
      expect(read('other.md')).not.toContain('kept current')
    })

    it('a value change moves dateModified, sitemap lastmod and the .md `updated`', () => {
      at(T2)
      set('pro_price', { value: '$15/mo' })
      expect(dateModified(read('pricing/index.html'))).toBe(T2)
      expect(read('pricing/index.html')).toContain(
        `<meta property="article:modified_time" content="${T2}">`,
      )
      expect(lastmod('pricing')).toBe(T2)
      expect(read('pricing.md')).toContain(`updated: "${T2}"`)
      // A post without facts keeps its own modified time.
      expect(lastmod('other')).not.toBe(T2)
    })

    it('feed items of fact-using posts carry <atom:updated>; confirmations never move it', () => {
      const item = (slug: string) =>
        read('feed.xml')
          .split('<item>')
          .find((i) => i.includes(`/${slug}/</link>`))!
      at(T2)
      set('pro_price', { value: '$15/mo' })
      expect(item('pricing')).toContain(`<atom:updated>${T2}</atom:updated>`)
      expect(item('pricing')).toContain(
        '<guid isPermaLink="true">https://f.example/pricing/</guid>',
      )
      expect(item('other')).not.toContain('atom:updated')
      at(T3)
      set('pro_price', { value: '$15/mo' })
      expect(item('pricing')).toContain(`<atom:updated>${T2}</atom:updated>`)
      expect(read('feed.xml')).toContain('xmlns:atom="http://www.w3.org/2005/Atom"')
    })

    it('a same-value set moves the confirmation date only', () => {
      at(T2)
      set('pro_price', { value: '$15/mo' })
      at(T3)
      const res = set('pro_price', { value: '$15/mo', confirmed_at: '2030-02-20' })
      expect(res.changed).toBe(false)
      expect(res.fact).toMatchObject({ updated_at: T2, confirmed_at: '2030-02-20T00:00:00.000Z' })
      const page = read('pricing/index.html')
      expect(page).toContain('Least recently confirmed: February 20, 2030.')
      expect(dateModified(page)).toBe(T2)
      expect(lastmod('pricing')).toBe(T2)
    })

    it('the note shows the oldest confirmation among the post’s facts', () => {
      at(T2)
      set('seats', { value: '5 seats', confirmed_at: '2029-12-15' })
      updatePost(store, renderer, blogId, 'pricing', {
        body: 'Pro costs {{fact:pro_price}} for {{fact:seats}}.',
      })
      expect(read('pricing/index.html')).toContain('Least recently confirmed: December 15, 2029.')
    })

    it('dry_run writes nothing and shows every affected line', () => {
      post({ title: 'Plan', status: 'draft', body: 'Draft: {{fact:pro_price}}.' })
      const before = { files: tree(out), rows: rows() }
      at(T2)
      const res = set('pro_price', { value: '$15/mo', dry_run: true })
      expect({ files: tree(out), rows: rows() }).toEqual(before)
      expect(res).toEqual({
        fact: expect.objectContaining({ value: '$15/mo', updated_at: T2 }) as unknown,
        changed: true,
        dry_run: true,
        rerendered: 0,
        affected_posts: [
          {
            slug: 'pricing',
            title: 'Pricing',
            status: 'published',
            url: 'https://f.example/pricing/',
            lines: [
              {
                line: 1,
                before: 'Pro costs $12/mo, billed monthly.',
                after: 'Pro costs $15/mo, billed monthly.',
              },
            ],
          },
          {
            slug: 'plan',
            title: 'Plan',
            status: 'draft',
            lines: [{ line: 1, before: 'Draft: $12/mo.', after: 'Draft: $15/mo.' }],
          },
        ],
      })
      expect(res.fact.used_by).toEqual([
        { slug: 'pricing', status: 'published' },
        { slug: 'plan', status: 'draft' },
      ])
    })

    it('expected_value: a stale value is FACT_CONFLICT and nothing changes', () => {
      const before = rows()
      const err = thrown(() => set('pro_price', { value: '$20/mo', expected_value: '$9/mo' }))
      expect(err.code).toBe('FACT_CONFLICT')
      expect(err.details).toMatchObject({ current_value: '$12/mo' })
      expect(thrown(() => set('pro_price', { value: '$20/mo', expected_value: null })).code).toBe(
        'FACT_CONFLICT',
      )
      expect(
        thrown(() => set('new_one', { value: '1', expected_value: '0' })).details,
      ).toMatchObject({ current_value: null })
      expect(rows()).toEqual(before)
      expect(set('pro_price', { value: '$20/mo', expected_value: '$12/mo' }).changed).toBe(true)
      expect(set('new_one', { value: '1', expected_value: null }).changed).toBe(true)
    })
  })

  describe('reads, metadata and validation', () => {
    it('list and get return values, dates, metadata and used_by', () => {
      at(T1)
      set('pro_price', { value: ' $12/mo ', note: 'from Stripe', source_url: 'https://x.com/p' })
      post({ title: 'A', body: '{{fact:pro_price}}' })
      post({ title: 'B', status: 'draft', body: 'x {{fact:pro_price}}' })
      const fact = {
        name: 'pro_price',
        value: '$12/mo',
        note: 'from Stripe',
        source_url: 'https://x.com/p',
        confirmed_at: T1,
        updated_at: T1,
        used_by: [
          { slug: 'a', status: 'published' },
          { slug: 'b', status: 'draft' },
        ],
      }
      expect(listFacts(store, renderer, blogId)).toEqual({ facts: [fact], render_pending: false })
      expect(getFact(store, renderer, blogId, 'pro_price')).toEqual({
        fact,
        render_pending: false,
      })
      expect(thrown(() => getFact(store, renderer, blogId, 'nope')).code).toBe('FACT_NOT_FOUND')
    })

    it('omitted note/source_url keep their value, null clears it', () => {
      set('a', { value: '1', note: 'n', source_url: 'https://x.com' })
      expect(set('a', { value: '2' }).fact).toMatchObject({
        note: 'n',
        source_url: 'https://x.com',
      })
      expect(set('a', { value: '2', note: null, source_url: null }).fact).toMatchObject({
        note: null,
        source_url: null,
      })
    })

    it('rejects bad names, values, confirmed_at and source_url', () => {
      at(T1)
      for (const name of ['Price', '1st', 'a-b', 'x'.repeat(41), '']) {
        expect(thrown(() => set(name, { value: '1' })).code, name).toBe('FACT_NAME_INVALID')
      }
      expect(thrown(() => set('a', { value: '[x](y)' })).code).toBe('FACT_VALUE_INVALID')
      for (const c of ['2030-01-01T00:06:00Z', '1999-12-31', 'yesterday', '2030-01-01T10:00']) {
        expect(thrown(() => set('a', { value: '1', confirmed_at: c })).code, c).toBe(
          'FACT_CONFIRMED_AT_INVALID',
        )
      }
      // Within five minutes of clock skew is fine; offsets are normalised.
      expect(set('a', { value: '1', confirmed_at: '2030-01-01T00:04:00Z' }).fact.confirmed_at).toBe(
        '2030-01-01T00:04:00.000Z',
      )
      expect(
        set('a', { value: '1', confirmed_at: '2030-01-01T02:00:00+03:00' }).fact.confirmed_at,
      ).toBe('2029-12-31T23:00:00.000Z')
      expect(() => set('a', { value: '1', source_url: 'http://x.com' })).toThrow()
      expect(rows().facts).toHaveLength(1)
    })
  })

  describe('delete', () => {
    it('refuses a fact any post uses, drafts included, naming them', () => {
      set('a', { value: '1' })
      post({ title: 'Live', body: '{{fact:a}}' })
      post({ title: 'Later', status: 'draft', body: '{{fact:a}}' })
      const err = thrown(() => deleteFact(store, renderer, blogId, 'a'))
      expect(err.code).toBe('FACT_IN_USE')
      expect(err.details).toEqual({ name: 'a', posts: ['live', 'later'] })

      deletePost(store, renderer, blogId, 'live')
      expect(thrown(() => deleteFact(store, renderer, blogId, 'a')).details).toMatchObject({
        posts: ['later'],
      })
      updatePost(store, renderer, blogId, 'later', { body: 'plain 1' })
      expect(deleteFact(store, renderer, blogId, 'a')).toEqual({ deleted: true })
      expect(thrown(() => deleteFact(store, renderer, blogId, 'a')).code).toBe('FACT_NOT_FOUND')
    })
  })

  describe('caps', () => {
    it('FACT_LIMIT: a 101st fact is refused; existing ones still change', () => {
      const insert = store.db.prepare(
        "INSERT INTO facts VALUES (?, ?, '1', NULL, NULL, 'x', 'x', 'x')",
      )
      for (let i = 0; i < 100; i++) insert.run(blogId, `f${i}`)
      expect(thrown(() => set('one_more', { value: '1' })).code).toBe('FACT_LIMIT')
      expect(set('f7', { value: '2' }).changed).toBe(true)
    })

    it('FACT_FANOUT: over 200 published fact-using posts is a 413 with no writes', () => {
      set('a', { value: '1' })
      const insert = store.db.prepare(
        "INSERT INTO posts (id, blog_id, slug, title, body, status, published_at) VALUES (?, ?, ?, 't', 'x {{fact:a}}', 'published', 'x')",
      )
      for (let i = 0; i < 201; i++) insert.run(`p${i}`, blogId, `p-${i}`)
      const before = { files: tree(out), rows: rows() }
      const err = thrown(() => set('a', { value: '2' }))
      expect(err.code).toBe('FACT_FANOUT')
      expect(err.details).toEqual({ posts: 201, limit: 200 })
      expect({ files: tree(out), rows: rows() }).toEqual(before)
    })
  })

  describe('recovery: a failed render stays pending until something drains it', () => {
    let failing: MutationRenderer
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      failing = {
        ...renderer,
        renderBlogPosts: () => {
          throw new Error('disk full')
        },
      }
      set('pro_price', { value: '$12/mo' })
      post({ title: 'Pricing', body: 'Pro costs {{fact:pro_price}}.' })
    })

    const failOnce = () => {
      const err = thrown(() => set('pro_price', { value: '$15/mo' }, failing))
      expect(err.code).toBe('FACT_RENDER_PENDING')
      expect(rows().pending).toHaveLength(1)
      expect(getFact(store, failing, blogId, 'pro_price')).toMatchObject({
        fact: { value: '$15/mo' },
        render_pending: true,
      })
      expect(read('pricing/index.html')).toContain('$12/mo')
    }

    it('a read reports render_pending without throwing; the next working call drains it', () => {
      failOnce()
      expect(listFacts(store, failing, blogId).render_pending).toBe(true)
      expect(listFacts(store, renderer, blogId).render_pending).toBe(false)
      expect(read('pricing/index.html')).toContain('Pro costs $15/mo.')
      expect(rows().pending).toEqual([])
    })

    it('retrying a compare-and-set whose render failed repairs the pages, then conflicts', () => {
      const cas = { value: '$15/mo', expected_value: '$12/mo' }
      expect(thrown(() => set('pro_price', cas, failing)).code).toBe('FACT_RENDER_PENDING')
      expect(read('pricing/index.html')).toContain('$12/mo')
      // The identical retry drains first: pages repaired, then the stale
      // expected_value is reported with the value that is now current.
      const err = thrown(() => set('pro_price', cas))
      expect(err.code).toBe('FACT_CONFLICT')
      expect(err.details).toMatchObject({ current_value: '$15/mo' })
      expect(rows().pending).toEqual([])
      expect(read('pricing/index.html')).toContain('Pro costs $15/mo.')
    })

    it('a capped request still writes nothing, pending render included', () => {
      failOnce()
      const insert = store.db.prepare(
        "INSERT INTO facts VALUES (?, ?, '1', NULL, NULL, 'x', 'x', 'x')",
      )
      for (let i = 0; i < 99; i++) insert.run(blogId, `f${i}`)
      const before = { files: tree(out), rows: rows() }
      expect(thrown(() => set('one_more', { value: '1' })).code).toBe('FACT_LIMIT')
      expect({ files: tree(out), rows: rows() }).toEqual(before)
    })

    it('re-sending the same value repairs it', () => {
      failOnce()
      expect(set('pro_price', { value: '$15/mo' })).toMatchObject({ changed: false, rerendered: 1 })
      expect(read('pricing/index.html')).toContain('Pro costs $15/mo.')
    })

    it('a post write drains it first', () => {
      failOnce()
      post({ title: 'Unrelated', body: 'x' })
      expect(rows().pending).toEqual([])
      expect(read('pricing/index.html')).toContain('Pro costs $15/mo.')
    })

    it('a write that cannot drain fails loudly before doing anything', () => {
      failOnce()
      expect(thrown(() => post({ title: 'Blocked', body: 'x' }, failing)).code).toBe(
        'FACT_RENDER_PENDING',
      )
      expect(() => getPost(store, blogId, 'blocked')).toThrow()
      expect(thrown(() => deleteFact(store, failing, blogId, 'pro_price')).code).toBe(
        'FACT_RENDER_PENDING',
      )
    })

    it('drainPendingFactRenders (host boot) finishes it, and reports what it could not', () => {
      failOnce()
      expect(drainPendingFactRenders(store, () => failing)).toEqual({
        drained: [],
        failed: [blogId],
      })
      expect(rows().pending).toHaveLength(1)
      expect(drainPendingFactRenders(store, () => renderer)).toEqual({
        drained: [blogId],
        failed: [],
      })
      expect(rows().pending).toEqual([])
      expect(read('pricing/index.html')).toContain('Pro costs $15/mo.')
      expect(drainPendingFactRenders(store, () => renderer)).toEqual({ drained: [], failed: [] })
    })
  })

  describe('post writes', () => {
    it('a published post may only use facts that exist; a draft may use any', () => {
      const err = thrown(() => post({ title: 'P', body: 'Price {{fact:later}}.' }))
      expect(err.code).toBe('FACT_NOT_FOUND')
      expect(err.details).toEqual({ names: ['later'] })

      post({ title: 'D', status: 'draft', body: 'Price {{fact:later}} on {{fact:v}}.' })
      set('v', { value: 'v2' })
      // A draft preview (renderPost on a draft) keeps an unknown token literal.
      const preview = join(dir, 'preview')
      createRenderer({ store, outputDir: preview, baseUrl: 'https://f.example/' }).renderPost(
        blogId,
        getPost(store, blogId, 'd'),
      )
      const html = readFileSync(join(preview, blogId, 'd', 'index.html'), 'utf8')
      expect(html).toContain('Price {{fact:later}} on v2.')
      expect(html).toContain('class="facts-note"')

      expect(
        thrown(() => updatePost(store, renderer, blogId, 'd', { status: 'published' })).code,
      ).toBe('FACT_NOT_FOUND')
      set('later', { value: 'soon' })
      updatePost(store, renderer, blogId, 'd', { status: 'published' })
      expect(read('d/index.html')).toContain('Price soon on v2.')
    })

    it('a fact-using post without its own excerpt stores none; rendering derives it', () => {
      set('a', { value: '$12' })
      const excerpt = () => getPost(store, blogId, 'e').excerpt
      post({ title: 'E', body: 'Costs $9 today.' })
      expect(excerpt()).toBe('Costs $9 today.')
      updatePost(store, renderer, blogId, 'e', { body: 'Costs {{fact:a}} today.' })
      expect(excerpt()).toBeUndefined()
      expect(read('index.html')).toContain('<p>Costs $12 today.</p>')
      set('a', { value: '$14' })
      expect(read('index.html')).toContain('<p>Costs $14 today.</p>')
      // Leaving facts brings a stored auto-excerpt back.
      updatePost(store, renderer, blogId, 'e', { body: 'Costs $13 today.' })
      expect(excerpt()).toBe('Costs $13 today.')
      // Without facts on either side, the excerpt stays as it was (as before).
      updatePost(store, renderer, blogId, 'e', { body: 'Something else.' })
      expect(excerpt()).toBe('Costs $13 today.')
      // A hand-written excerpt is never replaced.
      post({ title: 'H', body: 'Old.', excerpt: 'Hand-written.' })
      updatePost(store, renderer, blogId, 'h', { body: 'Now {{fact:a}}.' })
      expect(getPost(store, blogId, 'h').excerpt).toBe('Hand-written.')
      expect(post({ title: 'N', body: 'New {{fact:a}}.' }).excerpt).toBeUndefined()
    })

    it('a value is text: never a YouTube player, a link or a share image', () => {
      set('video', { value: 'https://youtu.be/3mlRiF-LeMc' })
      set('site', { value: 'www.example.com' })
      post({ title: 'V', body: 'Watch:\n\n{{fact:video}}\n\nOr visit {{fact:site}}.' })
      const page = read('v/index.html')
      expect(page).toContain('<p>https://youtu.be/3mlRiF-LeMc</p>')
      expect(page).toContain('<p>Or visit www.example.com.</p>')
      expect(page).not.toContain('<iframe')
      expect(page).not.toContain('i.ytimg.com')
      expect(read('feed.xml')).not.toContain('href="https://youtu.be')
      expect(read('v.md')).toContain('https\\://youtu.be/3mlRiF-LeMc')
      expect(read('v.md')).toContain('Or visit www\\.example.com.')
    })

    it('literal {{…}} and {{{…}}} in a post render as written (no template re-reading)', () => {
      post({ title: 'Braces', body: 'Write {{foo}} and {{{bar}}} and {{postTitle}} literally.' })
      expect(read('braces/index.html')).toContain(
        '<p>Write {{foo}} and {{{bar}}} and {{postTitle}} literally.</p>',
      )
      // A value that completes {{…}} around a token used to throw on render,
      // leaving the fact pending and every later post write failing.
      set('a', { value: 'hello world' })
      post({ title: 'Wrapped', body: 'x {{{{fact:a}}}} y' })
      set('a', { value: 'missing' })
      expect(read('wrapped/index.html')).toContain('<p>x {{missing}} y</p>')
      expect(rows().pending).toEqual([])
      post({ title: 'Still works', body: 'ok' })
    })

    it('rejects tokens in headings, addresses and fields other than the body', () => {
      set('a', { value: '1' })
      expect(thrown(() => post({ title: 'H', body: 'x\n\n## Now {{fact:a}}' })).code).toBe(
        'FACT_IN_HEADING',
      )
      expect(thrown(() => post({ title: 'U', body: '[x](https://a.com/{{fact:a}})' })).code).toBe(
        'FACT_IN_URL',
      )
      expect(thrown(() => post({ title: 'Costs {{fact:a}}', body: 'x' })).code).toBe(
        'FACT_NOT_ALLOWED_HERE',
      )
      post({ title: 'Ok', body: 'fine {{fact:a}}' })
      expect(
        thrown(() => updatePost(store, renderer, blogId, 'ok', { excerpt: '{{fact:a}}' })).code,
      ).toBe('FACT_NOT_ALLOWED_HERE')
    })
  })

  it('facts belong to one blog', () => {
    set('a', { value: '1' })
    const other = createBlog(store, { name: 'other' }).blog.id
    expect(listFacts(store, renderer, other).facts).toEqual([])
    expect(
      thrown(() => createPost(store, renderer, other, { title: 'X', body: '{{fact:a}}' })).code,
    ).toBe('FACT_NOT_FOUND')
    expect(thrown(() => deleteFact(store, renderer, other, 'a')).code).toBe('FACT_NOT_FOUND')
  })
})
