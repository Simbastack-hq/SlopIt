import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog, updateBlog } from '../src/blogs.js'
import { createPost } from '../src/posts.js'
import {
  createRenderer,
  LANGUAGE_MENU_MIN,
  renderLanguageMenu,
  renderLanguageNav,
} from '../src/rendering/generator.js'
import { loadTheme } from '../src/rendering/templates.js'

// The masthead language menu: a page in four or more languages switches
// language through a globe button in the masthead instead of the inline
// row of names under the title (or under the masthead on a home page).

const entries = (...tags: string[]) => tags.map((t) => ({ language: t, href: `../${t}/` }))

/** The masthead element of a rendered page. */
const masthead = (html: string) => html.match(/<header class="masthead">[\s\S]*?<\/header>/)![0]

describe('language menu — fragments', () => {
  it('the menu takes over from the row at four languages', () => {
    expect(LANGUAGE_MENU_MIN).toBe(4)
    const three = entries('en', 'de', 'fr')
    const four = entries('en', 'de', 'fr', 'es')
    expect(renderLanguageNav(three, 'en', 'x')).toContain('class="translations"')
    expect(renderLanguageMenu(three, 'en', 'x')).toBe('')
    expect(renderLanguageNav(four, 'en', 'x')).toBe('')
    expect(renderLanguageMenu(four, 'en', 'x')).toContain('class="lang-menu"')
  })

  it('a labelled nav around a <details>: globe, code for the eye, autonym for screen readers', () => {
    const html = renderLanguageMenu(entries('en', 'de', 'fr', 'ar'), 'de', 'Andere Sprachen')
    expect(html).toMatch(
      /^<nav class="lang-menu" aria-label="Andere Sprachen"><details><summary><svg [^>]*aria-hidden="true"/,
    )
    expect(html).toContain('<span class="lang-menu-code" aria-hidden="true">DE</span>')
    expect(html).toContain('<span class="visually-hidden" lang="de">Deutsch</span></summary>')
    expect(html).toContain('</ul></details><script>')
    expect(html.endsWith('</script></nav>')).toBe(true)
  })

  it('one link per language, named in its own language, the current one marked', () => {
    const html = renderLanguageMenu(entries('en', 'de', 'fr', 'ar'), 'en', 'Other languages')
    expect(html.match(/<li>/g)).toHaveLength(4)
    expect(html).toContain(
      '<li><a lang="en" hreflang="en" href="../en/" aria-current="page"><span dir="auto">English</span></a></li>',
    )
    expect(html).toContain(
      '<li><a lang="de" hreflang="de" href="../de/"><span dir="auto">Deutsch</span></a></li>',
    )
    // dir="auto" isolates a right-to-left name inside a left-to-right list.
    expect(html).toContain('<span dir="auto">العربية</span>')
    expect(html.match(/aria-current/g)).toHaveLength(1)
  })

  it('the code is the primary subtag unless two entries share it', () => {
    const code = (tags: string[], current: string) =>
      renderLanguageMenu(entries(...tags), current, 'x').match(
        /class="lang-menu-code" aria-hidden="true">([^<]*)</,
      )![1]
    expect(code(['en', 'de', 'fr', 'pt-BR'], 'pt-BR')).toBe('PT')
    expect(code(['en', 'pt-PT', 'fr', 'pt-BR'], 'pt-BR')).toBe('PT-BR')
    expect(code(['en', 'zh-Hant', 'zh', 'fr'], 'zh-Hant')).toBe('ZH-HANT')
    expect(code(['en', 'zh-Hant', 'zh', 'fr'], 'en')).toBe('EN')
  })

  it('escapes the label and every href', () => {
    const html = renderLanguageMenu(
      [
        { language: 'en', href: '../a"b/' },
        { language: 'de', href: '../<x>/' },
        { language: 'fr', href: '../fr/' },
        { language: 'es', href: '../es/' },
      ],
      'en',
      'Other <languages>',
    )
    expect(html).toContain('aria-label="Other &lt;languages&gt;"')
    expect(html).toContain('href="../a&quot;b/"')
    expect(html).toContain('href="../&lt;x&gt;/"')
    expect(html).not.toContain('<x>')
  })

  it('both theme templates have the slot in the masthead, after the main-site link', () => {
    const theme = loadTheme('minimal')
    for (const template of [theme.post, theme.index]) {
      expect(masthead(template)).toContain('{{{parentSiteLink}}}{{{languageMenu}}}')
    }
  })

  it('the theme drops the list from the end edge, so it mirrors in RTL', () => {
    const css = readFileSync(loadTheme('minimal').cssPath, 'utf8')
    const list = css.match(/\.lang-menu ul \{([^}]*)\}/)![1]
    expect(list).toContain('inset-inline-end: 0;')
    expect(list).not.toMatch(/\b(left|right):/)
  })
})

describe('language menu — rendered pages', () => {
  let dir: string
  let store: Store
  let outputDir: string
  let renderer: ReturnType<typeof createRenderer>

  const read = (...p: string[]) => readFileSync(join(outputDir, ...p), 'utf8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-lang-menu-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
    renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const GROUP = ['en', 'ar', 'de', 'es', 'fr', 'it', 'nl', 'zh'] as const
  const slugOf = (lang: string) => `why-${lang}`

  /**
   * An `en` blog with a main-site link, the post `why-en` in eight
   * languages, and `pack-en` in three.
   */
  const blog = () => {
    const { blog } = createBlog(store, { name: 'multi' })
    updateBlog(store, renderer, blog.id, { parentSiteUrl: 'https://multi.example' })
    for (const lang of GROUP) {
      createPost(store, renderer, blog.id, {
        title: `Why (${lang})`,
        body: `Body (${lang})`,
        slug: slugOf(lang),
        language: lang,
        ...(lang === 'en' ? {} : { translationOf: slugOf('en') }),
      })
    }
    createPost(store, renderer, blog.id, { title: 'Pack', body: 'b', slug: 'pack-en' })
    for (const lang of ['de', 'fr']) {
      createPost(store, renderer, blog.id, {
        title: `Pack (${lang})`,
        body: 'b',
        slug: `pack-${lang}`,
        language: lang,
        translationOf: 'pack-en',
      })
    }
    return blog
  }

  it('a post in eight languages: the menu in the masthead, no row under the title', () => {
    const { id } = blog()
    const html = read(id, slugOf('en'), 'index.html')
    const head = masthead(html)
    expect(head).toContain(
      '<a class="parent-site" href="https://multi.example">Main site &rarr;</a><nav class="lang-menu" aria-label="Other languages">',
    )
    expect(head).toContain('<span class="lang-menu-code" aria-hidden="true">EN</span>')
    expect(head.match(/<li>/g)).toHaveLength(8)
    for (const lang of GROUP.slice(1)) {
      expect(head).toContain(`<a lang="${lang}" hreflang="${lang}" href="../${slugOf(lang)}/">`)
    }
    expect(head).toContain(`href="../${slugOf('en')}/" aria-current="page"`)
    expect(html).not.toContain('class="translations"')
  })

  it('the menu changes nothing about URLs or hreflang', () => {
    const { id } = blog()
    const html = read(id, slugOf('de'), 'index.html')
    const alternates = html.match(/<link rel="alternate" hreflang="[^"]+" href="[^"]+">/g)!
    expect(alternates).toHaveLength(GROUP.length + 1)
    for (const lang of GROUP) {
      expect(html).toContain(
        `<link rel="alternate" hreflang="${lang}" href="https://b.example/${slugOf(lang)}/">`,
      )
    }
    expect(html).toContain(
      `<link rel="alternate" hreflang="x-default" href="https://b.example/${slugOf('en')}/">`,
    )
  })

  it('each sibling shows its own language as current, in its own chrome and direction', () => {
    const { id } = blog()
    const de = read(id, slugOf('de'), 'index.html')
    expect(masthead(de)).toContain('<nav class="lang-menu" aria-label="Andere Sprachen">')
    expect(masthead(de)).toContain('<span class="lang-menu-code" aria-hidden="true">DE</span>')
    expect(de).toContain(`href="../${slugOf('de')}/" aria-current="page"`)

    const ar = read(id, slugOf('ar'), 'index.html')
    expect(ar).toContain('<html lang="ar" dir="rtl">')
    expect(masthead(ar)).toContain('<nav class="lang-menu" aria-label="لغات أخرى">')
    expect(masthead(ar)).toContain('<span class="lang-menu-code" aria-hidden="true">AR</span>')
  })

  it('a post in three languages keeps the row and gets no menu', () => {
    const { id } = blog()
    const html = read(id, 'pack-en', 'index.html')
    expect(html).not.toContain('class="lang-menu"')
    expect(html).toContain('<nav class="translations" aria-label="Other languages">')
    expect(html).toContain('href="../pack-de/">Deutsch</a>')
  })

  it('a post with no translations on the same blog has neither', () => {
    const { id } = blog()
    createPost(store, renderer, id, { title: 'Solo', body: 'b', slug: 'solo' })
    const html = read(id, 'solo', 'index.html')
    expect(html).not.toContain('class="lang-menu"')
    expect(html).not.toContain('class="translations"')
  })

  it('home pages of a blog in eight languages link each language home through the menu', () => {
    const { id } = blog()
    const root = read(id, 'index.html')
    expect(masthead(root)).toContain('<nav class="lang-menu" aria-label="Other languages">')
    expect(masthead(root)).toContain('<a lang="de" hreflang="de" href="lang/de/">')
    expect(masthead(root)).toContain(
      '<a lang="en" hreflang="en" href="lang/en/" aria-current="page">',
    )
    expect(root).not.toContain('class="translations"')

    const nl = read(id, 'lang', 'nl', 'index.html')
    expect(masthead(nl)).toContain('<a lang="en" hreflang="en" href="../../lang/en/">')
    expect(masthead(nl)).toContain(
      '<a lang="nl" hreflang="nl" href="../../lang/nl/" aria-current="page">',
    )
    expect(nl).not.toContain('class="translations"')
  })

  it('home pages of a blog in three languages keep the row', () => {
    const { blog: b } = createBlog(store, { name: 'three' })
    for (const lang of ['en', 'de', 'fr']) {
      createPost(store, renderer, b.id, {
        title: lang,
        body: 'b',
        slug: `p-${lang}`,
        language: lang,
      })
    }
    const root = read(b.id, 'index.html')
    expect(root).toContain('<nav class="translations" aria-label="Other languages">')
    expect(root).not.toContain('class="lang-menu"')
  })

  it('one menu script per page, scoped in a block beside the contents rail script', () => {
    const { id } = blog()
    const html = read(id, slugOf('en'), 'index.html')
    expect(html.match(/<details>/g)).toHaveLength(1)
    const script = masthead(html).match(/<script>([\s\S]*?)<\/script>/)![1]
    expect(script.trim().startsWith('{')).toBe(true)
    expect(script.trim().endsWith('}')).toBe(true)
  })
})
