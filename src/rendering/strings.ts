/**
 * Theme chrome strings — the three fixed labels a reader sees on a page
 * that are not the author's content. Everything else on a page is
 * either the author's markdown, a date (formatted by ICU for the page's
 * language), a language name (also from ICU), or brand ("Powered by
 * SlopIt", kept English on purpose).
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
  /** `aria-label` of the language switcher (the row of language names). */
  otherLanguages: string
}

const STRINGS: Record<string, ThemeStrings> = {
  en: { moreFrom: 'More from this blog', mainSite: 'Main site', otherLanguages: 'Other languages' },
  es: {
    moreFrom: 'Más de este blog',
    mainSite: 'Sitio principal',
    otherLanguages: 'Otros idiomas',
  },
  de: {
    moreFrom: 'Mehr aus diesem Blog',
    mainSite: 'Hauptseite',
    otherLanguages: 'Andere Sprachen',
  },
  fr: {
    moreFrom: 'Plus d’articles de ce blog',
    mainSite: 'Site principal',
    otherLanguages: 'Autres langues',
  },
  pt: { moreFrom: 'Mais deste blog', mainSite: 'Site principal', otherLanguages: 'Outros idiomas' },
  it: {
    moreFrom: 'Altri articoli da questo blog',
    mainSite: 'Sito principale',
    otherLanguages: 'Altre lingue',
  },
  ru: { moreFrom: 'Ещё в этом блоге', mainSite: 'Основной сайт', otherLanguages: 'Другие языки' },
  ja: { moreFrom: 'このブログの他の記事', mainSite: 'メインサイト', otherLanguages: '他の言語' },
  zh: { moreFrom: '更多文章', mainSite: '主站', otherLanguages: '其他语言' },
  ar: {
    moreFrom: 'المزيد من هذه المدونة',
    mainSite: 'الموقع الرئيسي',
    otherLanguages: 'لغات أخرى',
  },
  hi: { moreFrom: 'इस ब्लॉग के और लेख', mainSite: 'मुख्य साइट', otherLanguages: 'अन्य भाषाएँ' },
  sw: {
    moreFrom: 'Zaidi kutoka blogu hii',
    mainSite: 'Tovuti kuu',
    otherLanguages: 'Lugha nyingine',
  },
}

/** Languages with a translated chrome. Exported for the drift-guard test. */
export const THEME_LANGUAGES: readonly string[] = Object.keys(STRINGS)

/** Strings for a (canonical) BCP-47 tag; English when not translated. */
export function stringsFor(tag: string): ThemeStrings {
  return STRINGS[new Intl.Locale(tag).language] ?? STRINGS.en
}

/**
 * A language's name in that language (its autonym), for the switcher:
 * `de` → "Deutsch", `ru` → "Русский", `pt-BR` → "Português (Brasil)".
 * A reader recognises their own language's name in their own language,
 * so no translation table is needed. CLDR lower-cases some names in
 * running text (`français`, `русский`); the first letter is upper-cased
 * with that language's casing rules so a row of names reads uniformly.
 * ICU returns the tag itself for a language it has no name for.
 */
export function languageLabel(tag: string): string {
  const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag
  return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1)
}
