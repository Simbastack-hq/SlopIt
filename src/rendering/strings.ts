/**
 * Theme chrome strings — the two fixed labels a reader sees on a post
 * page that are not the author's content. Everything else on a page is
 * either the author's markdown, a date (formatted by ICU for the page's
 * language), or brand ("Powered by SlopIt", kept English on purpose).
 *
 * Plain text only: the fragment builders in rendering/generator.ts
 * HTML-escape whatever they insert, so a translation never needs to
 * think about markup.
 *
 * Lookup is by primary language subtag (`pt-BR` → `pt`) with English as
 * the fallback for anything not listed. Adding a language is one object
 * here; the drift-guard test asserts every entry has every key.
 */
export interface ThemeStrings {
  /** Heading of the "newest three posts" block at the end of a post. */
  moreFrom: string
  /** Label of the optional link back to the blog's parent site. */
  mainSite: string
}

const STRINGS: Record<string, ThemeStrings> = {
  en: { moreFrom: 'More from this blog', mainSite: 'Main site' },
  es: { moreFrom: 'Más de este blog', mainSite: 'Sitio principal' },
  de: { moreFrom: 'Mehr aus diesem Blog', mainSite: 'Hauptseite' },
  fr: { moreFrom: 'Plus d’articles de ce blog', mainSite: 'Site principal' },
  pt: { moreFrom: 'Mais deste blog', mainSite: 'Site principal' },
  it: { moreFrom: 'Altro da questo blog', mainSite: 'Sito principale' },
  ru: { moreFrom: 'Ещё из этого блога', mainSite: 'Основной сайт' },
  ja: { moreFrom: 'このブログの他の記事', mainSite: 'メインサイト' },
  zh: { moreFrom: '本博客更多文章', mainSite: '主站' },
  ar: { moreFrom: 'المزيد من هذه المدونة', mainSite: 'الموقع الرئيسي' },
  hi: { moreFrom: 'इस ब्लॉग से और', mainSite: 'मुख्य साइट' },
}

/** Languages with a translated chrome. Exported for the drift-guard test. */
export const THEME_LANGUAGES: readonly string[] = Object.keys(STRINGS)

/** Strings for a (canonical) BCP-47 tag; English when not translated. */
export function stringsFor(tag: string): ThemeStrings {
  return STRINGS[new Intl.Locale(tag).language] ?? STRINGS.en
}
