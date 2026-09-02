import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog, getBlog, updateBlog } from '../src/blogs.js'
import { createPost, getPost, listPosts, updatePost } from '../src/posts.js'
import { createRenderer, formatDate } from '../src/rendering/generator.js'
import { ogLocale, resolveLanguage, textDirection } from '../src/rendering/seo.js'
import { buildFrontmatter } from '../src/rendering/frontmatter.js'
import { buildRssFeed } from '../src/rendering/feeds.js'
import { stringsFor, THEME_LANGUAGES } from '../src/rendering/strings.js'
import {
  BlogPatchSchema,
  CreateBlogInputSchema,
  PostInputSchema,
  PostPatchSchema,
} from '../src/schema/index.js'
import { isSupportedLanguage, languageTag } from '../src/schema/post-input-base.js'
import { createApiRouter } from '../src/api/index.js'

// Blog + post `language` (BCP-47). Spec:
// docs/superpowers/specs/2026-09-02-language-design.md

describe('languageTag schema', () => {
  it('accepts real tags and canonicalises case', () => {
    expect(languageTag.parse('ru')).toBe('ru')
    expect(languageTag.parse('pt-br')).toBe('pt-BR')
    expect(languageTag.parse('EN-us')).toBe('en-US')
    expect(languageTag.parse('zh-hant-tw')).toBe('zh-Hant-TW')
  })

  it('rejects names, unknown tags, extensions, blanks, and junk with the documented message', () => {
    for (const bad of ['Russian', 'xx', 'ru-u-ca-islamic', '', 'a'.repeat(40), 'not a tag']) {
      const r = languageTag.safeParse(bad)
      expect(r.success, bad).toBe(false)
      expect(JSON.stringify(r.error?.issues)).toMatch(/BCP-47|Too big/)
    }
  })

  it('isSupportedLanguage is the single predicate behind the schema', () => {
    expect(isSupportedLanguage('ja')).toBe(true)
    expect(isSupportedLanguage('xx')).toBe(false)
    expect(isSupportedLanguage('Russian')).toBe(false)
  })

  it('checks the language subtag only: an unknown region rides on its language (documented)', () => {
    // Regions and scripts are open lists; ICU lookup falls back to `en`,
    // so the page is still correctly tagged and dated. See the JSDoc.
    expect(languageTag.parse('en-XX')).toBe('en-XX')
    expect(textDirection('en-XX')).toBe('ltr')
    expect(formatDate('2026-09-02T00:00:00Z', 'en-XX')).toBe('September 2, 2026')
  })

  it('blog input defaults to en; post input has no default; patches accept the field', () => {
    expect(CreateBlogInputSchema.parse({}).language).toBe('en')
    expect(PostInputSchema.parse({ title: 'T', body: 'b' }).language).toBeUndefined()
    expect(PostInputSchema.parse({ title: 'T', body: 'b', language: 'RU' }).language).toBe('ru')
    expect(BlogPatchSchema.parse({ language: 'de' }).language).toBe('de')
    expect(PostPatchSchema.parse({ language: null }).language).toBeNull()
    expect(BlogPatchSchema.safeParse({ language: null }).success).toBe(false)
  })
})

describe('language helpers', () => {
  it('resolveLanguage: post override wins, else blog default', () => {
    expect(resolveLanguage({ language: 'ar' }, { language: 'en' })).toBe('ar')
    expect(resolveLanguage({ language: undefined }, { language: 'ru' })).toBe('ru')
  })

  it('textDirection is decided by script, not language', () => {
    expect(textDirection('en')).toBe('ltr')
    expect(textDirection('ar')).toBe('rtl')
    expect(textDirection('he')).toBe('rtl')
    expect(textDirection('fa')).toBe('rtl')
    expect(textDirection('ar-Latn')).toBe('ltr')
    expect(textDirection('az-Arab')).toBe('rtl')
  })

  it('ogLocale emits language_TERRITORY from likely subtags', () => {
    expect(ogLocale('ru')).toBe('ru_RU')
    expect(ogLocale('en')).toBe('en_US')
    expect(ogLocale('pt')).toBe('pt_BR')
    expect(ogLocale('zh-Hant-TW')).toBe('zh_TW')
    expect(ogLocale('pt-PT')).toBe('pt_PT')
  })

  it('formatDate follows the locale and stays UTC-pinned', () => {
    expect(formatDate('2026-09-02T00:00:00Z', 'ru')).toBe('2 сентября 2026 г.')
    expect(formatDate('2026-09-02T00:00:00Z', 'de')).toBe('2. September 2026')
    expect(formatDate('2026-09-02T23:59:59Z', 'en-US')).toBe('September 2, 2026')
  })

  it('stringsFor looks up by primary subtag and falls back to English', () => {
    expect(stringsFor('pt-BR').moreFrom).toBe('Mais deste blog')
    expect(stringsFor('ru').mainSite).toBe('Основной сайт')
    expect(stringsFor('sw')).toEqual(stringsFor('en'))
  })

  it('every translated language has every key (no half-translated entries)', () => {
    expect(THEME_LANGUAGES).toContain('en')
    for (const tag of THEME_LANGUAGES) {
      const s = stringsFor(tag)
      expect(s.moreFrom.trim().length, tag).toBeGreaterThan(0)
      expect(s.mainSite.trim().length, tag).toBeGreaterThan(0)
    }
  })

  it('frontmatter emits language right after slug; RSS emits channel <language>', () => {
    const fm = buildFrontmatter({ title: 'T', slug: 's', language: 'ru', date: null })
    expect(fm.split('\n').slice(0, 4)).toEqual(['---', 'title: "T"', 'slug: "s"', 'language: "ru"'])
    const rss = buildRssFeed({
      blog: { id: 'b', name: 'b', language: 'pt-BR' },
      blogRoot: 'https://b.example/',
      feedUrl: 'https://b.example/feed.xml',
      posts: [],
    })
    expect(rss).toContain('<language>pt-BR</language>')
  })
})

describe('language — store and lifecycle', () => {
  let dir: string
  let store: Store
  let outputDir: string
  let renderer: ReturnType<typeof createRenderer>

  const read = (...p: string[]) => readFileSync(join(outputDir, ...p), 'utf8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-language-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
    renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a blog defaults to en and persists an explicit language; posts persist an override', () => {
    expect(createBlog(store, { name: 'plain' }).blog.language).toBe('en')
    const { blog } = createBlog(store, { name: 'ru-blog', language: 'ru' })
    expect(blog.language).toBe('ru')
    expect(getBlog(store, blog.id).language).toBe('ru')

    const { post } = createPost(store, renderer, blog.id, { title: 'T', body: 'b', language: 'de' })
    expect(post.language).toBe('de')
    expect(getPost(store, blog.id, post.slug).language).toBe('de')
    expect(listPosts(store, blog.id)[0]?.language).toBe('de')
    const plain = createPost(store, renderer, blog.id, { title: 'U', body: 'b' })
    expect(plain.post.language).toBeUndefined()
  })

  it('a Russian blog renders Russian pages: lang, dir, dates, chrome, meta, feed, frontmatter', () => {
    const { blog } = createBlog(store, { name: 'ru-blog', language: 'ru' })
    updateBlog(store, renderer, blog.id, { parentSiteUrl: 'https://parent.example' })
    createPost(store, renderer, blog.id, { title: 'Первый', slug: 'pervyj', body: 'тело' })
    createPost(store, renderer, blog.id, { title: 'Второй', slug: 'vtoroj', body: 'тело' })
    store.db
      .prepare("UPDATE posts SET published_at = '2026-09-02T00:00:00.000Z' WHERE slug = 'vtoroj'")
      .run()
    renderer.renderBlogPosts(blog.id)
    renderer.renderBlog(blog.id)

    const post = read(blog.id, 'pervyj', 'index.html')
    expect(post).toContain('<html lang="ru" dir="ltr">')
    expect(post).toContain('Ещё в этом блоге')
    expect(post).toContain('Основной сайт &rarr;')
    expect(post).toContain('<meta property="og:locale" content="ru_RU">')
    expect(post).toContain('"inLanguage":"ru"')

    const index = read(blog.id, 'index.html')
    expect(index).toContain('<html lang="ru" dir="ltr">')
    expect(index).toContain('2 сентября 2026 г.')

    expect(read(blog.id, 'feed.xml')).toContain('<language>ru</language>')
    expect(read(blog.id, 'pervyj.md')).toContain('language: "ru"')
  })

  it('a post override changes only that page; RTL scripts get dir="rtl"', () => {
    const { blog } = createBlog(store, { name: 'en-blog' })
    createPost(store, renderer, blog.id, { title: 'Hello', slug: 'hello', body: 'b' })
    createPost(store, renderer, blog.id, {
      title: 'مرحبا',
      slug: 'marhaba',
      body: 'نص',
      language: 'ar',
    })

    const ar = read(blog.id, 'marhaba', 'index.html')
    expect(ar).toContain('<html lang="ar" dir="rtl">')
    expect(ar).toContain('المزيد من هذه المدونة')
    expect(ar).toContain('<meta property="og:locale" content="ar_EG">')
    expect(read(blog.id, 'marhaba.md')).toContain('language: "ar"')

    expect(read(blog.id, 'hello', 'index.html')).toContain('<html lang="en" dir="ltr">')
    expect(read(blog.id, 'index.html')).toContain('<html lang="en" dir="ltr">')
    expect(read(blog.id, 'feed.xml')).toContain('<language>en</language>')
  })

  it('updatePost: language merges, null clears the override, omission keeps it', () => {
    const { blog } = createBlog(store, { name: 'en-blog' })
    const { post } = createPost(store, renderer, blog.id, { title: 'T', slug: 'tt', body: 'b' })

    updatePost(store, renderer, blog.id, post.slug, { language: 'fr' })
    expect(getPost(store, blog.id, post.slug).language).toBe('fr')
    expect(read(blog.id, 'tt', 'index.html')).toContain('<html lang="fr"')

    updatePost(store, renderer, blog.id, post.slug, { title: 'T2' })
    expect(getPost(store, blog.id, post.slug).language).toBe('fr')

    updatePost(store, renderer, blog.id, post.slug, { language: null })
    expect(getPost(store, blog.id, post.slug).language).toBeUndefined()
    expect(read(blog.id, 'tt', 'index.html')).toContain('<html lang="en"')
  })

  it('updateBlog: a language change rewrites HTML, .md and manifests; analytics change rewrites HTML only', () => {
    const { blog } = createBlog(store, { name: 'en-blog' })
    createPost(store, renderer, blog.id, { title: 'T', slug: 'tt', body: 'b' })
    const md = vi.spyOn(renderer, 'renderPostMarkdown')
    const manifests = vi.spyOn(renderer, 'renderManifests')
    const pages = vi.spyOn(renderer, 'renderBlogPosts')

    updateBlog(store, renderer, blog.id, { analytics: { umami: { siteId: 's' } } })
    expect(pages).toHaveBeenCalledTimes(1)
    expect(md).not.toHaveBeenCalled()
    expect(manifests).not.toHaveBeenCalled()

    const updated = updateBlog(store, renderer, blog.id, { language: 'ru' })
    expect(updated.language).toBe('ru')
    expect(pages).toHaveBeenCalledTimes(2)
    expect(md).toHaveBeenCalledTimes(1)
    expect(manifests).toHaveBeenCalledTimes(1)
    expect(read(blog.id, 'tt', 'index.html')).toContain('<html lang="ru"')
    expect(read(blog.id, 'tt.md')).toContain('language: "ru"')
    expect(read(blog.id, 'feed.xml')).toContain('<language>ru</language>')

    // Same value again → no-op.
    updateBlog(store, renderer, blog.id, { language: 'ru' })
    expect(pages).toHaveBeenCalledTimes(2)
  })

  it('updateBlog: a render failure restores the prior language', () => {
    const { blog } = createBlog(store, { name: 'en-blog' })
    createPost(store, renderer, blog.id, { title: 'T', slug: 'tt', body: 'b' })
    const spy = vi.spyOn(renderer, 'renderManifests').mockImplementation(() => {
      throw new Error('synthetic manifests failure')
    })
    expect(() => updateBlog(store, renderer, blog.id, { language: 'ru' })).toThrow(
      'synthetic manifests failure',
    )
    spy.mockRestore()
    expect(getBlog(store, blog.id).language).toBe('en')
  })

  it('/schema still serialises (refine + overwrite, not transform) and documents language', async () => {
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const res = await app.request('/schema')
    expect(res.status).toBe(200)
    const body = JSON.stringify(await res.json())
    expect(body).toContain('"language"')
    expect(body).toContain('BCP-47')
  })

  it('migration 009 upgrades a pre-009 database: blogs read en, posts read no override', () => {
    // Build a database that predates 009: open it (all migrations run),
    // then drop the two columns and forget that 009 ran. Legacy rows go
    // in through raw SQL because the app-level writers now set language.
    const { blog } = createBlog(store, { name: 'legacy' })
    createPost(store, renderer, blog.id, { title: 'T', slug: 'tt', body: 'b' })
    store.db.exec(
      "ALTER TABLE blogs DROP COLUMN language; ALTER TABLE posts DROP COLUMN language; DELETE FROM schema_migrations WHERE filename = '009_language.sql'",
    )
    expect(() => store.db.prepare('SELECT language FROM blogs').all()).toThrow()
    const dbPath = join(dir, 'test.db')
    store.close()

    store = createStore({ dbPath })
    const applied = store.db
      .prepare('SELECT filename FROM schema_migrations WHERE filename = ?')
      .get('009_language.sql')
    expect(applied).toBeDefined()
    expect(getBlog(store, blog.id).language).toBe('en')
    expect(getPost(store, blog.id, 'tt').language).toBeUndefined()
    // And the reopened store writes the new columns normally.
    expect(createBlog(store, { name: 'fresh', language: 'ru' }).blog.language).toBe('ru')
  })
})
