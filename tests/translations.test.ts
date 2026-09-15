import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../src/db/store.js'
import { createApiKey, createBlog, updateBlog } from '../src/blogs.js'
import {
  createPost,
  deletePost,
  getPost,
  listBlogLanguages,
  updatePost,
  type TranslationPolicy,
} from '../src/posts.js'
import {
  createRenderer,
  homeUrl,
  renderAlternates,
  renderLanguageNav,
} from '../src/rendering/generator.js'
import { languageLabel, stringsFor, THEME_LANGUAGES } from '../src/rendering/strings.js'
import { buildSitemap } from '../src/rendering/feeds.js'
import {
  PostInputSchema,
  PostPatchSchema,
  PostSchema,
  type PostInput,
} from '../src/schema/index.js'
import { SlopItError } from '../src/errors.js'
import { createApiRouter } from '../src/api/index.js'
import { createMcpServer } from '../src/mcp/server.js'
import { generateSkillFile } from '../src/skill.js'
import { attachAuth, callTool } from './mcp/helpers.js'

// Translation groups, per-language home pages, hreflang, the switcher.
// Spec: docs/superpowers/specs/2026-09-15-translations-design.md

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof SlopItError) return e.code
    throw e
  }
  throw new Error('expected a SlopItError')
}

const refuse: TranslationPolicy = () => ({ ok: false, reason: 'Translations need the paid plan' })

describe('translations — schema and fragments', () => {
  it('translationOf is input-only: accepted on create and patch (nullable), absent from Post', () => {
    expect(
      PostInputSchema.parse({ title: 'T', body: 'b', translationOf: 'hello' }).translationOf,
    ).toBe('hello')
    expect(PostPatchSchema.parse({ translationOf: null }).translationOf).toBeNull()
    expect(PostInputSchema.safeParse({ title: 'T', body: 'b', translationOf: null }).success).toBe(
      false,
    )
    expect('translationOf' in PostSchema.shape).toBe(false)
    expect('translationGroup' in PostSchema.shape).toBe(true)
  })

  it('every translated chrome has the switcher label', () => {
    for (const tag of THEME_LANGUAGES) {
      expect(stringsFor(tag).otherLanguages.trim().length, tag).toBeGreaterThan(0)
    }
    expect(stringsFor('de').otherLanguages).toBe('Andere Sprachen')
  })

  it('languageLabel is the autonym with an initial capital', () => {
    expect(languageLabel('de')).toBe('Deutsch')
    expect(languageLabel('fr')).toBe('Français')
    expect(languageLabel('ru')).toBe('Русский')
    expect(languageLabel('pt-BR')).toBe('Português (Brasil)')
    expect(languageLabel('sw')).toBe('Kiswahili')
  })

  it('homeUrl: root for the root language, lang/<lowercase tag>/ otherwise', () => {
    expect(homeUrl('https://b.example/', 'en', 'en')).toBe('https://b.example/')
    expect(homeUrl('https://b.example/', 'pt-BR', 'en')).toBe('https://b.example/lang/pt-br/')
  })

  it('renderAlternates: nothing below two entries; self included; x-default only when the root language is present', () => {
    const en = { language: 'en', url: 'https://b.example/hello/' }
    const de = { language: 'de', url: 'https://b.example/hallo/' }
    expect(renderAlternates([en], 'en')).toBe('')
    const both = renderAlternates([en, de], 'en')
    expect(both).toContain('<link rel="alternate" hreflang="en" href="https://b.example/hello/">')
    expect(both).toContain('<link rel="alternate" hreflang="de" href="https://b.example/hallo/">')
    expect(both).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://b.example/hello/">',
    )
    expect(
      renderAlternates([de, { language: 'fr', url: 'https://b.example/bonjour/' }], 'en'),
    ).not.toContain('x-default')
  })

  it('renderLanguageNav: autonyms, current as a span, everything escaped', () => {
    const html = renderLanguageNav(
      [
        { language: 'en', href: 'lang/en/' },
        { language: 'de', href: 'lang/de/' },
        { language: 'ar', href: 'lang/ar/' },
      ],
      'en',
      'Other <languages>',
    )
    expect(html).toContain('<nav class="translations" aria-label="Other &lt;languages&gt;">')
    expect(html).toContain('<span aria-current="page" lang="en" dir="auto">English</span>')
    expect(html).toContain('<a lang="de" hreflang="de" dir="auto" href="lang/de/">Deutsch</a>')
    expect(html).toContain('<a lang="ar" hreflang="ar" dir="auto" href="lang/ar/">العربية</a>')
    expect(renderLanguageNav([{ language: 'en', href: '/' }], 'en', 'x')).toBe('')
  })

  it('buildSitemap lists language homes after the root and before posts', () => {
    const out = buildSitemap({
      blogRoot: 'https://b.example/',
      homes: [{ url: 'https://b.example/lang/de/', updatedAt: '2026-09-01T00:00:00Z' }],
      posts: [{ canonicalUrl: 'https://b.example/a/', updatedAt: '2026-09-02T00:00:00Z' }],
      updatedAt: '2026-09-02T00:00:00Z',
    })
    const locs = [...out.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    expect(locs).toEqual([
      'https://b.example/',
      'https://b.example/lang/de/',
      'https://b.example/a/',
    ])
  })
})

describe('translations — store, lifecycle and rendering', () => {
  let dir: string
  let store: Store
  let outputDir: string
  let renderer: ReturnType<typeof createRenderer>

  const read = (...p: string[]) => readFileSync(join(outputDir, ...p), 'utf8')
  const exists = (...p: string[]) => existsSync(join(outputDir, ...p))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-translations-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
    renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const publish = (blogId: string, input: Partial<PostInput> & { slug: string }) =>
    createPost(store, renderer, blogId, {
      title: input.slug,
      body: `Body of ${input.slug}`,
      ...input,
    }).post

  /** An `en` blog with hello (en) and hallo (de, translation of hello). */
  const pair = () => {
    const { blog } = createBlog(store, { name: 'pair' })
    publish(blog.id, { slug: 'hello' })
    publish(blog.id, { slug: 'hallo', language: 'de', translationOf: 'hello' })
    return blog
  }

  describe('createPost with translationOf', () => {
    it('links both posts into one group and freezes both languages', () => {
      const blog = pair()
      const hello = getPost(store, blog.id, 'hello')
      const hallo = getPost(store, blog.id, 'hallo')
      expect(hallo.translationGroup).toBeDefined()
      expect(hello.translationGroup).toBe(hallo.translationGroup)
      // The target inherited `en` before; joining a group makes it explicit.
      expect(hello.language).toBe('en')
      expect(hallo.language).toBe('de')
    })

    it('one post per language per group: the conflict names the existing member and writes nothing', () => {
      const blog = pair()
      let err: SlopItError | undefined
      try {
        publish(blog.id, { slug: 'hallo-2', language: 'de', translationOf: 'hello' })
      } catch (e) {
        err = e as SlopItError
      }
      expect(err?.code).toBe('TRANSLATION_CONFLICT')
      expect(err?.details).toEqual({ language: 'de', slug: 'hallo' })
      expect(codeOf(() => getPost(store, blog.id, 'hallo-2'))).toBe('POST_NOT_FOUND')
    })

    it('forgetting `language` on a translation collides with the original (the blog default)', () => {
      const { blog } = createBlog(store, { name: 'forgot' })
      publish(blog.id, { slug: 'hello' })
      expect(codeOf(() => publish(blog.id, { slug: 'hello-again', translationOf: 'hello' }))).toBe(
        'TRANSLATION_CONFLICT',
      )
      // The failed join left the target exactly as it was.
      expect(getPost(store, blog.id, 'hello').translationGroup).toBeUndefined()
      expect(getPost(store, blog.id, 'hello').language).toBeUndefined()
    })

    it('the target must exist in the same blog (tenant isolation)', () => {
      const { blog: a } = createBlog(store, { name: 'blog-a' })
      const { blog: b } = createBlog(store, { name: 'blog-b' })
      publish(b.id, { slug: 'hello-b' })
      expect(
        codeOf(() => publish(a.id, { slug: 'xx', language: 'de', translationOf: 'hello-b' })),
      ).toBe('POST_NOT_FOUND')
      expect(
        codeOf(() => publish(a.id, { slug: 'yy', language: 'de', translationOf: 'nope' })),
      ).toBe('POST_NOT_FOUND')
    })

    it('a refusing policy → TRANSLATIONS_DISABLED with its reason, before anything is read or written', () => {
      const { blog } = createBlog(store, { name: 'gated' })
      publish(blog.id, { slug: 'hello' })
      let err: SlopItError | undefined
      try {
        createPost(
          store,
          renderer,
          blog.id,
          { title: 'Hallo', slug: 'hallo', body: 'b', language: 'de', translationOf: 'hello' },
          { translationPolicy: refuse },
        )
      } catch (e) {
        err = e as SlopItError
      }
      expect(err?.code).toBe('TRANSLATIONS_DISABLED')
      expect(err?.message).toBe('Translations need the paid plan')
      expect(getPost(store, blog.id, 'hello').translationGroup).toBeUndefined()
      expect(codeOf(() => getPost(store, blog.id, 'hallo'))).toBe('POST_NOT_FOUND')
    })

    it('the policy is not consulted for a plain post', () => {
      const { blog } = createBlog(store, { name: 'plain' })
      const policy = vi.fn(refuse)
      createPost(store, renderer, blog.id, { title: 'T', body: 'b' }, { translationPolicy: policy })
      expect(policy).not.toHaveBeenCalled()
    })

    it('a render failure after a join restores the target row too', () => {
      const { blog } = createBlog(store, { name: 'comp' })
      publish(blog.id, { slug: 'hello' })
      vi.spyOn(renderer, 'renderBlogPosts').mockImplementationOnce(() => {
        throw new Error('synthetic')
      })
      expect(() =>
        publish(blog.id, { slug: 'hallo', language: 'de', translationOf: 'hello' }),
      ).toThrow('synthetic')
      const hello = getPost(store, blog.id, 'hello')
      expect(hello.translationGroup).toBeUndefined()
      expect(hello.language).toBeUndefined()
      expect(codeOf(() => getPost(store, blog.id, 'hallo'))).toBe('POST_NOT_FOUND')
    })
  })

  describe('updatePost membership', () => {
    it('joins an existing post, moves it between groups, and unlinks with null (never gated)', () => {
      const blog = pair()
      publish(blog.id, { slug: 'bonjour', language: 'fr' })
      const joined = updatePost(store, renderer, blog.id, 'bonjour', {
        translationOf: 'hello',
      }).post
      expect(joined.translationGroup).toBe(getPost(store, blog.id, 'hello').translationGroup)
      expect(joined.language).toBe('fr')

      // A second group; moving bonjour there leaves the first group intact.
      publish(blog.id, { slug: 'other' })
      const moved = updatePost(store, renderer, blog.id, 'bonjour', { translationOf: 'other' }).post
      expect(moved.translationGroup).toBe(getPost(store, blog.id, 'other').translationGroup)
      expect(moved.translationGroup).not.toBe(joined.translationGroup)
      expect(getPost(store, blog.id, 'hallo').translationGroup).toBe(joined.translationGroup)

      const left = updatePost(
        store,
        renderer,
        blog.id,
        'bonjour',
        { translationOf: null },
        { translationPolicy: refuse },
      ).post
      expect(left.translationGroup).toBeUndefined()
      expect(left.language).toBe('fr')
    })

    it('a post cannot translate itself', () => {
      const blog = pair()
      expect(
        codeOf(() => updatePost(store, renderer, blog.id, 'hello', { translationOf: 'hello' })),
      ).toBe('BAD_REQUEST')
    })

    it('language on a member is always explicit: null resolves to the blog default, and conflicts apply', () => {
      const blog = pair()
      // hallo → null would become `en`, which hello holds.
      expect(codeOf(() => updatePost(store, renderer, blog.id, 'hallo', { language: null }))).toBe(
        'TRANSLATION_CONFLICT',
      )
      expect(getPost(store, blog.id, 'hallo').language).toBe('de')
      // A group without an `en` member: null stores `en` explicitly.
      publish(blog.id, { slug: 'hola', language: 'es' })
      publish(blog.id, { slug: 'ciao', language: 'it', translationOf: 'hola' })
      const ciao = updatePost(store, renderer, blog.id, 'ciao', { language: null }).post
      expect(ciao.language).toBe('en')
      // An explicit change to a taken language is refused too.
      expect(codeOf(() => updatePost(store, renderer, blog.id, 'hallo', { language: 'en' }))).toBe(
        'TRANSLATION_CONFLICT',
      )
    })

    it('a render failure restores this post and the adopted target', () => {
      const { blog } = createBlog(store, { name: 'comp2' })
      publish(blog.id, { slug: 'hello' })
      publish(blog.id, { slug: 'bonjour', language: 'fr' })
      vi.spyOn(renderer, 'renderBlogPosts').mockImplementationOnce(() => {
        throw new Error('synthetic')
      })
      expect(() =>
        updatePost(store, renderer, blog.id, 'bonjour', { translationOf: 'hello', title: 'New' }),
      ).toThrow('synthetic')
      expect(getPost(store, blog.id, 'bonjour')).toMatchObject({
        title: 'bonjour',
        language: 'fr',
        translationGroup: undefined,
      })
      expect(getPost(store, blog.id, 'hello')).toMatchObject({
        language: undefined,
        translationGroup: undefined,
      })
    })

    it('a refusing policy blocks re-linking as well as first links', () => {
      const blog = pair()
      publish(blog.id, { slug: 'bonjour', language: 'fr' })
      expect(
        codeOf(() =>
          updatePost(
            store,
            renderer,
            blog.id,
            'bonjour',
            { translationOf: 'hello' },
            { translationPolicy: refuse },
          ),
        ),
      ).toBe('TRANSLATIONS_DISABLED')
    })
  })

  it('the slug `lang` is reserved, whether given or derived from the title', () => {
    const { blog } = createBlog(store, { name: 'reserved' })
    expect(codeOf(() => publish(blog.id, { slug: 'lang' }))).toBe('POST_SLUG_RESERVED')
    expect(codeOf(() => createPost(store, renderer, blog.id, { title: 'Lang', body: 'b' }))).toBe(
      'POST_SLUG_RESERVED',
    )
    expect(exists(blog.id, 'lang')).toBe(false)
  })

  describe('rendering a trilingual blog', () => {
    let blogId: string
    beforeEach(() => {
      const blog = pair()
      blogId = blog.id
      publish(blogId, { slug: 'ola', language: 'pt-BR', translationOf: 'hello' })
      publish(blogId, { slug: 'second-en' })
      publish(blogId, { slug: 'zweiter', language: 'de' })
    })

    it('one home page per language, each listing only its language, in its chrome', () => {
      expect(listBlogLanguages(store, blogId)).toEqual(['en', 'de', 'pt-BR'])

      const root = read(blogId, 'index.html')
      expect(root).toContain('<html lang="en" dir="ltr">')
      expect(root).toContain('href="hello/"')
      expect(root).toContain('href="second-en/"')
      expect(root).not.toContain('href="hallo/"')
      expect(root).toContain('<link rel="canonical" href="https://b.example/" />')

      const de = read(blogId, 'lang', 'de', 'index.html')
      expect(de).toContain('<html lang="de" dir="ltr">')
      expect(de).toContain('href="../../style.css"')
      expect(de).toContain('href="../../favicon.svg"')
      expect(de).toContain('href="../../hallo/"')
      expect(de).toContain('href="../../zweiter/"')
      expect(de).not.toContain('hello/"')
      expect(de).toContain('<link rel="canonical" href="https://b.example/lang/de/" />')
      expect(de).toContain('aria-label="Andere Sprachen"')

      expect(exists(blogId, 'lang', 'pt-br', 'index.html')).toBe(true)
    })

    it('home pages cross-link with hreflang (x-default → root) and a switcher', () => {
      const root = read(blogId, 'index.html')
      expect(root).toContain('<link rel="alternate" hreflang="en" href="https://b.example/">')
      expect(root).toContain(
        '<link rel="alternate" hreflang="de" href="https://b.example/lang/de/">',
      )
      expect(root).toContain(
        '<link rel="alternate" hreflang="pt-BR" href="https://b.example/lang/pt-br/">',
      )
      expect(root).toContain(
        '<link rel="alternate" hreflang="x-default" href="https://b.example/">',
      )
      expect(root).toContain('<span aria-current="page" lang="en" dir="auto">English</span>')
      expect(root).toContain('href="lang/de/">Deutsch</a>')
      expect(root).toContain('href="lang/pt-br/">Português (Brasil)</a>')

      const de = read(blogId, 'lang', 'de', 'index.html')
      expect(de).toContain('href="../../lang/en/">English</a>')
      expect(de).toContain('href="../../lang/pt-br/">Português (Brasil)</a>')
      expect(de).toContain('<span aria-current="page" lang="de" dir="auto">Deutsch</span>')
    })

    it('a grouped post carries hreflang for every published member, og:locale:alternate, and the switcher', () => {
      const hallo = read(blogId, 'hallo', 'index.html')
      expect(hallo).toContain(
        '<link rel="alternate" hreflang="en" href="https://b.example/hello/">',
      )
      expect(hallo).toContain(
        '<link rel="alternate" hreflang="de" href="https://b.example/hallo/">',
      )
      expect(hallo).toContain(
        '<link rel="alternate" hreflang="pt-BR" href="https://b.example/ola/">',
      )
      expect(hallo).toContain(
        '<link rel="alternate" hreflang="x-default" href="https://b.example/hello/">',
      )
      expect(hallo).toContain('<meta property="og:locale" content="de_DE">')
      expect(hallo).toContain('<meta property="og:locale:alternate" content="en_US">')
      expect(hallo).toContain('<meta property="og:locale:alternate" content="pt_BR">')
      expect(hallo).not.toContain('og:locale:alternate" content="de_DE"')
      expect(hallo).toContain('href="../hello/">English</a>')
      expect(hallo).toContain('href="../ola/">Português (Brasil)</a>')
      expect(hallo).toContain('<span aria-current="page" lang="de" dir="auto">Deutsch</span>')
    })

    it('"More from this blog" stays in the post\'s language; home links are language-aware', () => {
      const hallo = read(blogId, 'hallo', 'index.html')
      expect(hallo).toContain('Mehr aus diesem Blog')
      expect(hallo).toContain('href="../zweiter/"')
      expect(hallo).not.toContain('href="../second-en/"')
      expect(hallo).toContain('<a class="masthead-name" href="../lang/de/">')
      expect(read(blogId, 'hello', 'index.html')).toContain(
        '<a class="masthead-name" href="../lang/en/">',
      )
    })

    it('a standalone post in a second language has home pages but no post-level alternates', () => {
      const zweiter = read(blogId, 'zweiter', 'index.html')
      expect(zweiter).not.toContain('hreflang=')
      expect(zweiter).not.toContain('class="translations"')
      expect(zweiter).toContain('href="../lang/de/">')
    })

    it('drafts and unpublished siblings drop out; a lone member has no alternates', () => {
      createPost(store, renderer, blogId, {
        title: 'Brouillon',
        slug: 'brouillon',
        body: 'b',
        language: 'fr',
        translationOf: 'hello',
        status: 'draft',
      })
      expect(read(blogId, 'hello', 'index.html')).not.toContain('hreflang="fr"')

      updatePost(store, renderer, blogId, 'ola', { status: 'draft' })
      updatePost(store, renderer, blogId, 'hallo', { status: 'draft' })
      const hello = read(blogId, 'hello', 'index.html')
      expect(hello).not.toContain('hreflang=')
      expect(hello).not.toContain('class="translations"')
      expect(hello).not.toContain('og:locale:alternate')
    })

    it('a group without a root-language member emits no x-default', () => {
      publish(blogId, { slug: 'hola', language: 'es' })
      publish(blogId, { slug: 'ciao', language: 'it', translationOf: 'hola' })
      const hola = read(blogId, 'hola', 'index.html')
      expect(hola).toContain('hreflang="it"')
      expect(hola).not.toContain('x-default')
    })

    it('feeds are per language and the sitemap lists the language homes, never ?lang=', () => {
      // /feed.xml keeps its historical meaning: every language, root language
      // as the channel language. Per-language feeds live under lang/.
      const rootFeed = read(blogId, 'feed.xml')
      expect(rootFeed).toContain('<language>en</language>')
      expect(rootFeed).toContain('https://b.example/hello/')
      expect(rootFeed).toContain('https://b.example/hallo/')
      const enFeed = read(blogId, 'lang', 'en', 'feed.xml')
      expect(enFeed).toContain('https://b.example/hello/')
      expect(enFeed).not.toContain('https://b.example/hallo/')
      expect(enFeed).toContain('<link>https://b.example/lang/en/</link>')

      const deFeed = read(blogId, 'lang', 'de', 'feed.xml')
      expect(deFeed).toContain('<language>de</language>')
      expect(deFeed).toContain('<link>https://b.example/lang/de/</link>')
      expect(deFeed).toContain('href="https://b.example/lang/de/feed.xml"')
      expect(deFeed).toContain('https://b.example/hallo/')
      expect(deFeed).not.toContain('https://b.example/hello/')

      const sitemap = read(blogId, 'sitemap.xml')
      expect(sitemap).toContain('<loc>https://b.example/lang/de/</loc>')
      expect(sitemap).toContain('<loc>https://b.example/lang/pt-br/</loc>')
      expect(sitemap).not.toContain('?lang=')
      // The root language's lang/ copy is a duplicate (canonical → /), not a sitemap entry.
      expect(sitemap).not.toContain('/lang/en/')
    })

    it('the last post of a language takes its home with it; lang/ goes when empty', () => {
      updatePost(store, renderer, blogId, 'ola', { status: 'draft' })
      expect(exists(blogId, 'lang', 'pt-br')).toBe(false)
      expect(exists(blogId, 'lang', 'de', 'index.html')).toBe(true)
      expect(read(blogId, 'sitemap.xml')).not.toContain('/lang/pt-br/')

      deletePost(store, renderer, blogId, 'hallo')
      // A language change on the remaining German post empties German.
      updatePost(store, renderer, blogId, 'zweiter', { language: 'en' })
      expect(exists(blogId, 'lang')).toBe(false)
      expect(read(blogId, 'index.html')).not.toContain('class="translations"')
      expect(read(blogId, 'hello', 'index.html')).toContain('<a class="masthead-name" href="..">')
    })
  })

  it('root language follows what is actually published, and a default change moves the homes', () => {
    const { blog } = createBlog(store, { name: 'drift' })
    publish(blog.id, { slug: 'privet', language: 'ru' })
    publish(blog.id, { slug: 'poka', language: 'ru' })
    expect(listBlogLanguages(store, blog.id)).toEqual(['ru'])
    let root = read(blog.id, 'index.html')
    expect(root).toContain('<html lang="ru" dir="ltr">')
    expect(root).toContain('href="privet/"')
    expect(root).not.toContain('class="translations"')
    expect(root).not.toContain('Nothing here yet')
    expect(exists(blog.id, 'lang')).toBe(false)
    expect(read(blog.id, 'feed.xml')).toContain('<language>ru</language>')

    // Explicit `en`: a post that merely inherits the default would follow the
    // default to `ru` in the PATCH below, which is the documented rule.
    publish(blog.id, { slug: 'hello', language: 'en' })
    expect(listBlogLanguages(store, blog.id)).toEqual(['en', 'ru'])
    root = read(blog.id, 'index.html')
    expect(root).toContain('<html lang="en" dir="ltr">')
    expect(read(blog.id, 'lang', 'ru', 'index.html')).toContain('href="../../privet/"')

    updateBlog(store, renderer, blog.id, { language: 'ru' })
    expect(listBlogLanguages(store, blog.id)).toEqual(['ru', 'en'])
    expect(read(blog.id, 'index.html')).toContain('<html lang="ru" dir="ltr">')
    expect(read(blog.id, 'lang', 'en', 'index.html')).toContain('href="../../hello/"')
    // Russian is the root now, and keeps its stable home too (canonical → /).
    expect(read(blog.id, 'lang', 'ru', 'index.html')).toContain(
      '<link rel="canonical" href="https://b.example/" />',
    )
    // Post URLs never moved.
    expect(exists(blog.id, 'privet', 'index.html')).toBe(true)
    expect(read(blog.id, 'privet', 'index.html')).toContain(
      '<a class="masthead-name" href="../lang/ru/">',
    )
  })

  it('a monolingual blog renders no switcher, no hreflang, a plain home link, and one canonical', () => {
    const { blog } = createBlog(store, { name: 'mono' })
    publish(blog.id, { slug: 'one' })
    publish(blog.id, { slug: 'two' })
    const root = read(blog.id, 'index.html')
    expect(root).not.toContain('class="translations"')
    expect(root).not.toContain('hreflang=')
    expect(root.match(/rel="canonical"/g)).toHaveLength(1)
    expect(root).toContain('href="favicon.svg"')
    const one = read(blog.id, 'one', 'index.html')
    expect(one).not.toContain('class="translations"')
    expect(one).not.toContain('hreflang=')
    expect(one).toContain('<a class="masthead-name" href="..">')
    expect(exists(blog.id, 'lang')).toBe(false)
  })

  it('a pre-existing post with slug `lang` blocks multilingual rendering loudly', () => {
    const { blog } = createBlog(store, { name: 'legacy' })
    publish(blog.id, { slug: 'hello' })
    // Simulate a row written before the reservation existed.
    store.db
      .prepare(
        "INSERT INTO posts (id, blog_id, slug, title, body, status, published_at) VALUES ('legacy1', ?, 'lang', 'Lang', 'b', 'published', '2026-01-01T00:00:00Z')",
      )
      .run(blog.id)
    renderer.renderPost(blog.id, getPost(store, blog.id, 'lang'))
    expect(() => publish(blog.id, { slug: 'hallo', language: 'de' })).toThrow(/slug "lang"/)
  })
})

describe('translations — over REST and MCP', () => {
  let dir: string
  let store: Store
  let renderer: ReturnType<typeof createRenderer>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-translations-transport-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.example' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('REST: a refusing policy yields 403 TRANSLATIONS_DISABLED; /schema documents translationOf', async () => {
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      translationPolicy: refuse,
    })
    const { blog } = createBlog(store, { name: 'rest' })
    const { apiKey } = createApiKey(store, blog.id)
    const post = (body: unknown) =>
      app.request(`/blogs/${blog.id}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      })
    expect((await post({ title: 'Hello', slug: 'hello', body: 'b' })).status).toBe(200)
    const res = await post({ title: 'Hallo', body: 'b', language: 'de', translationOf: 'hello' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('TRANSLATIONS_DISABLED')
    expect(body.error.message).toBe('Translations need the paid plan')

    const schema = (await (await app.request('/schema')).json()) as {
      properties: Record<string, unknown>
    }
    expect(schema.properties).toHaveProperty('translationOf')
  })

  it('MCP: create_post carries translationOf; the same policy refuses with the REST-parity envelope', async () => {
    const { blog } = createBlog(store, { name: 'mcp' })
    const { apiKey } = createApiKey(store, blog.id)
    const boot = async (policy?: TranslationPolicy) => {
      const server = createMcpServer({
        store,
        rendererFor: () => renderer,
        baseUrl: 'https://api.example',
        translationPolicy: policy,
      })
      const [clientT, serverT] = InMemoryTransport.createLinkedPair()
      await server.connect(serverT)
      const client = new Client({ name: 'test', version: '0' }, {})
      attachAuth(clientT, apiKey)
      await client.connect(clientT)
      return { client, close: async () => (await client.close(), await server.close()) }
    }

    const open = await boot()
    const first = await callTool(open.client, 'create_post', {
      blog_id: blog.id,
      title: 'Hello',
      slug: 'hello',
      body: 'b',
    })
    expect(first.isError).toBeFalsy()
    const second = await callTool(open.client, 'create_post', {
      blog_id: blog.id,
      title: 'Hallo',
      slug: 'hallo',
      body: 'b',
      language: 'de',
      translationOf: 'hello',
    })
    expect(second.isError).toBeFalsy()
    const created = (second.structuredContent as { post: { translationGroup?: string } }).post
    expect(created.translationGroup).toBe(getPost(store, blog.id, 'hello').translationGroup)
    await open.close()

    const gated = await boot(refuse)
    const refused = await callTool(gated.client, 'create_post', {
      blog_id: blog.id,
      title: 'Bonjour',
      slug: 'bonjour',
      body: 'b',
      language: 'fr',
      translationOf: 'hello',
    })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.structuredContent)).toContain('TRANSLATIONS_DISABLED')
    await gated.close()
  })

  it('SKILL.md documents translationOf and the language homes', () => {
    const doc = generateSkillFile({ baseUrl: 'https://api.example/api' })
    expect(doc).toContain('translationOf')
    expect(doc).toContain('/lang/<tag>/')
    expect(doc).toContain('TRANSLATION_CONFLICT')
    expect(doc).toContain('TRANSLATIONS_DISABLED')
  })
})

describe('translations — code review round 2', () => {
  let dir: string
  let store: Store
  let outputDir: string
  let renderer: ReturnType<typeof createRenderer>

  const read = (...p: string[]) => readFileSync(join(outputDir, ...p), 'utf8')
  const exists = (...p: string[]) => existsSync(join(outputDir, ...p))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-translations-r2-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
    renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const publish = (blogId: string, input: Partial<PostInput> & { slug: string }) =>
    createPost(store, renderer, blogId, {
      title: input.slug,
      body: `Body of ${input.slug}`,
      ...input,
    }).post

  it('pruning touches directories only: a legacy `lang` post keeps its page on a monolingual blog', () => {
    const { blog } = createBlog(store, { name: 'legacy-mono' })
    publish(blog.id, { slug: 'hello' })
    store.db
      .prepare(
        "INSERT INTO posts (id, blog_id, slug, title, body, status, published_at) VALUES ('legacy2', ?, 'lang', 'Lang', 'b', 'published', '2026-01-01T00:00:00Z')",
      )
      .run(blog.id)
    renderer.renderPost(blog.id, getPost(store, blog.id, 'lang'))
    expect(exists(blog.id, 'lang', 'index.html')).toBe(true)

    // Any ordinary edit re-renders and then prunes; the legacy page survives.
    updatePost(store, renderer, blog.id, 'hello', { title: 'Edited' })
    expect(exists(blog.id, 'lang', 'index.html')).toBe(true)
    expect(read(blog.id, 'lang', 'index.html')).toContain('Lang')
  })

  it("a publish that makes another language the root keeps every language's URL", () => {
    const { blog } = createBlog(store, { name: 'root-flip' })
    publish(blog.id, { slug: 'de-1', language: 'de' })
    publish(blog.id, { slug: 'de-2', language: 'de' })
    publish(blog.id, { slug: 'fr-1', language: 'fr' })
    publish(blog.id, { slug: 'fr-2', language: 'fr' })
    // No English post: the root is the most-published language, tie → alphabetical.
    expect(listBlogLanguages(store, blog.id)).toEqual(['de', 'fr'])
    expect(exists(blog.id, 'lang', 'fr', 'index.html')).toBe(true)
    expect(exists(blog.id, 'lang', 'de', 'index.html')).toBe(true)
    expect(read(blog.id, 'lang', 'de', 'index.html')).toContain('href="https://b.example/" />')

    publish(blog.id, { slug: 'fr-3', language: 'fr' })
    expect(listBlogLanguages(store, blog.id)).toEqual(['fr', 'de'])
    expect(read(blog.id, 'index.html')).toContain('<html lang="fr"')
    expect(exists(blog.id, 'lang', 'de', 'index.html')).toBe(true)
    // French moved to / but its own URL and feed are still there for bookmarks and subscribers.
    expect(read(blog.id, 'lang', 'fr', 'index.html')).toContain(
      '<link rel="canonical" href="https://b.example/" />',
    )
    expect(read(blog.id, 'lang', 'fr', 'feed.xml')).toContain('<language>fr</language>')
  })

  it('translationOf accepts a one-character auto-generated slug', () => {
    const { blog } = createBlog(store, { name: 'short' })
    const a = createPost(store, renderer, blog.id, { title: 'A', body: 'b' }).post
    expect(a.slug).toBe('a')
    const de = publish(blog.id, { slug: 'aa', language: 'de', translationOf: 'a' })
    expect(de.translationGroup).toBe(getPost(store, blog.id, 'a').translationGroup)
    publish(blog.id, { slug: 'bonjour', language: 'fr' })
    const fr = updatePost(store, renderer, blog.id, 'bonjour', { translationOf: 'a' }).post
    expect(fr.translationGroup).toBe(de.translationGroup)
  })

  it('feeds cap at 20 after filtering by language, never before', () => {
    const { blog } = createBlog(store, { name: 'feed-cap' })
    publish(blog.id, { slug: 'einzig', language: 'de' })
    for (let i = 0; i < 25; i++) publish(blog.id, { slug: `en-${i}` })
    const en = read(blog.id, 'lang', 'en', 'feed.xml')
    expect((en.match(/<item>/g) ?? []).length).toBe(20)
    expect(en).not.toContain('/einzig/')
    const de = read(blog.id, 'lang', 'de', 'feed.xml')
    expect((de.match(/<item>/g) ?? []).length).toBe(1)
    expect(de).toContain('/einzig/')
  })
})

describe('translations — audit round (2026-09-16)', () => {
  let dir: string
  let store: Store
  let outputDir: string
  let renderer: ReturnType<typeof createRenderer>

  const read = (...p: string[]) => readFileSync(join(outputDir, ...p), 'utf8')
  const exists = (...p: string[]) => existsSync(join(outputDir, ...p))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-translations-audit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
    renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const publish = (blogId: string, input: Partial<PostInput> & { slug: string }) =>
    createPost(store, renderer, blogId, {
      title: input.slug,
      body: `Body of ${input.slug}`,
      ...input,
    }).post

  const failNextRenderBlogPosts = () =>
    vi.spyOn(renderer, 'renderBlogPosts').mockImplementationOnce(() => {
      throw new Error('synthetic')
    })

  it('a failed publish leaves no public trace: no page, no .md, no language home, no feed entry, no hreflang', () => {
    const { blog } = createBlog(store, { name: 'trace' })
    publish(blog.id, { slug: 'hello' })
    publish(blog.id, { slug: 'hallo', language: 'de', translationOf: 'hello' })
    failNextRenderBlogPosts()
    expect(() =>
      publish(blog.id, { slug: 'ola', language: 'pt-BR', translationOf: 'hello' }),
    ).toThrow('synthetic')
    expect(exists(blog.id, 'ola', 'index.html')).toBe(false)
    expect(exists(blog.id, 'ola.md')).toBe(false)
    expect(exists(blog.id, 'lang', 'pt-br')).toBe(false)
    expect(read(blog.id, 'feed.xml')).not.toContain('/ola/')
    expect(read(blog.id, 'sitemap.xml')).not.toContain('/ola/')
    expect(read(blog.id, 'llms.txt')).not.toContain('/ola/')
    expect(read(blog.id, 'hello', 'index.html')).not.toContain('hreflang="pt-BR"')
    // What existed before the failure is untouched.
    expect(exists(blog.id, 'lang', 'de', 'index.html')).toBe(true)
    expect(read(blog.id, 'hello', 'index.html')).toContain('hreflang="de"')
  })

  it('a failed draft→published patch removes the files it wrote; a failed edit restores the prior page', () => {
    const { blog } = createBlog(store, { name: 'trace2' })
    publish(blog.id, { slug: 'hello' })
    createPost(store, renderer, blog.id, {
      title: 'Entwurf',
      slug: 'entwurf',
      body: 'b',
      language: 'de',
      status: 'draft',
    })

    failNextRenderBlogPosts()
    expect(() => updatePost(store, renderer, blog.id, 'entwurf', { status: 'published' })).toThrow(
      'synthetic',
    )
    expect(getPost(store, blog.id, 'entwurf').status).toBe('draft')
    expect(exists(blog.id, 'entwurf', 'index.html')).toBe(false)
    expect(exists(blog.id, 'entwurf.md')).toBe(false)
    expect(exists(blog.id, 'lang')).toBe(false)
    expect(read(blog.id, 'feed.xml')).not.toContain('/entwurf/')

    failNextRenderBlogPosts()
    expect(() => updatePost(store, renderer, blog.id, 'hello', { title: 'Neuer Titel' })).toThrow(
      'synthetic',
    )
    expect(getPost(store, blog.id, 'hello').title).toBe('hello')
    const page = read(blog.id, 'hello', 'index.html')
    expect(page).toContain('<h1>hello</h1>')
    expect(page).not.toContain('Neuer Titel')
  })

  it('the root language keeps a stable home and feed under lang/ (a duplicate whose canonical is /)', () => {
    const { blog } = createBlog(store, { name: 'stable' })
    publish(blog.id, { slug: 'hello' })
    publish(blog.id, { slug: 'hallo', language: 'de' })
    const copy = read(blog.id, 'lang', 'en', 'index.html')
    expect(copy).toContain('<html lang="en"')
    expect(copy).toContain('<link rel="canonical" href="https://b.example/" />')
    expect(copy).not.toContain('<link rel="alternate" hreflang=')
    expect(copy).toContain('href="../../hello/"')
    expect(copy).toContain('<span aria-current="page" lang="en" dir="auto">English</span>')
    expect(copy).toContain('href="../../lang/de/">Deutsch</a>')
    expect(read(blog.id, 'lang', 'en', 'feed.xml')).toContain('<language>en</language>')
    // The canonical root still carries the alternates.
    expect(read(blog.id, 'index.html')).toContain('hreflang="x-default"')
    expect(read(blog.id, 'index.html')).toContain('href="lang/de/">Deutsch</a>')
    // Post home links never point at the negotiated root.
    expect(read(blog.id, 'hello', 'index.html')).toContain(
      '<a class="masthead-name" href="../lang/en/">',
    )
    expect(read(blog.id, 'hallo', 'index.html')).toContain(
      '<a class="masthead-name" href="../lang/de/">',
    )
    // Back to one language: the whole lang/ tree goes, home link back to `..`.
    deletePost(store, renderer, blog.id, 'hallo')
    expect(exists(blog.id, 'lang')).toBe(false)
    expect(read(blog.id, 'hello', 'index.html')).toContain('<a class="masthead-name" href="..">')
  })

  it('Traditional Chinese gets its own chrome; Simplified and unknown tags keep the existing lookup', () => {
    expect(stringsFor('zh-Hant').otherLanguages).toBe('其他語言')
    expect(stringsFor('zh-TW').otherLanguages).toBe('其他語言')
    expect(stringsFor('zh-HK').otherLanguages).toBe('其他語言')
    expect(stringsFor('zh').otherLanguages).toBe('其他语言')
    expect(stringsFor('zh-Hans').otherLanguages).toBe('其他语言')
    expect(stringsFor('zh-CN').otherLanguages).toBe('其他语言')
    expect(stringsFor('pt-BR').otherLanguages).toBe('Outros idiomas')
    expect(stringsFor('nl')).toEqual(stringsFor('en'))
  })
})

describe('translations — review of the audit fixes (2026-09-16)', () => {
  let dir: string
  let store: Store
  let outputDir: string
  let renderer: ReturnType<typeof createRenderer>

  const read = (...p: string[]) => readFileSync(join(outputDir, ...p), 'utf8')
  const exists = (...p: string[]) => existsSync(join(outputDir, ...p))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-translations-r4-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
    renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const publish = (blogId: string, input: Partial<PostInput> & { slug: string }) =>
    createPost(store, renderer, blogId, {
      title: input.slug,
      body: `Body of ${input.slug}`,
      ...input,
    }).post

  it('a persistent render failure still removes the row, the post files and the stale language home, and reports the incomplete recovery', () => {
    const { blog } = createBlog(store, { name: 'persist' })
    publish(blog.id, { slug: 'hello' })
    publish(blog.id, { slug: 'hallo', language: 'de', translationOf: 'hello' })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(renderer, 'renderBlogPosts').mockImplementation(() => {
      throw new Error('synthetic')
    })
    expect(() =>
      publish(blog.id, { slug: 'ola', language: 'pt-BR', translationOf: 'hello' }),
    ).toThrow(/^synthetic \(compensation incomplete: synthetic\)$/)
    expect(quiet).toHaveBeenCalled()
    expect(codeOf(() => getPost(store, blog.id, 'ola'))).toBe('POST_NOT_FOUND')
    expect(exists(blog.id, 'ola', 'index.html')).toBe(false)
    expect(exists(blog.id, 'ola.md')).toBe(false)
    // pruneLanguageHomes and renderManifests ran although renderBlogPosts failed again.
    expect(exists(blog.id, 'lang', 'pt-br')).toBe(false)
    expect(exists(blog.id, 'lang', 'de', 'index.html')).toBe(true)
    expect(read(blog.id, 'feed.xml')).not.toContain('/ola/')
    expect(read(blog.id, 'sitemap.xml')).not.toContain('/lang/pt-br/')
  })

  it('a one-shot failure whose recovery completes rethrows the original error untouched', () => {
    const { blog } = createBlog(store, { name: 'oneshot' })
    publish(blog.id, { slug: 'hello' })
    vi.spyOn(renderer, 'renderBlogPosts').mockImplementationOnce(() => {
      throw new Error('synthetic')
    })
    let thrown: unknown
    try {
      publish(blog.id, { slug: 'hallo', language: 'de' })
    } catch (e) {
      thrown = e
    }
    expect((thrown as Error).message).toBe('synthetic')
    expect(exists(blog.id, 'lang')).toBe(false)
  })

  it('deletePost removes the files and prunes even when the re-render fails, since a retry can never reach them', () => {
    const { blog } = createBlog(store, { name: 'del' })
    publish(blog.id, { slug: 'hello' })
    publish(blog.id, { slug: 'hallo', language: 'de' })
    expect(exists(blog.id, 'lang', 'de', 'index.html')).toBe(true)
    vi.spyOn(renderer, 'renderBlog').mockImplementationOnce(() => {
      throw new Error('synthetic')
    })
    expect(() => deletePost(store, renderer, blog.id, 'hallo')).toThrow('synthetic')
    expect(codeOf(() => getPost(store, blog.id, 'hallo'))).toBe('POST_NOT_FOUND')
    expect(exists(blog.id, 'hallo', 'index.html')).toBe(false)
    expect(exists(blog.id, 'hallo.md')).toBe(false)
    expect(exists(blog.id, 'lang')).toBe(false)
  })
})
