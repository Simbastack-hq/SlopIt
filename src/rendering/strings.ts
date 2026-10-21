/**
 * Theme chrome strings — the fixed labels a reader (or a screen reader)
 * meets on a page that are not the author's content. Everything else on a page is
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
  /** `aria-label` of the contents rail beside a long post. */
  contents: string
  /**
   * The line under a post that shows live facts. `{date}` is replaced
   * with the oldest confirmation date among them, formatted for the page.
   * Starts with a word, so it stays a plain paragraph in the `.md` twin.
   */
  factsNote: string
}

const STRINGS: Record<string, ThemeStrings> = {
  en: {
    moreFrom: 'More from this blog',
    mainSite: 'Main site',
    otherLanguages: 'Other languages',
    contents: 'Contents',
    factsNote:
      'Some figures on this page are kept current by the publisher. Least recently confirmed: {date}.',
  },
  es: {
    moreFrom: 'Más de este blog',
    mainSite: 'Sitio principal',
    otherLanguages: 'Otros idiomas',
    contents: 'Contenido',
    factsNote:
      'El editor mantiene al día algunas cifras de esta página. Confirmación más antigua: {date}.',
  },
  de: {
    moreFrom: 'Mehr aus diesem Blog',
    mainSite: 'Hauptseite',
    otherLanguages: 'Andere Sprachen',
    contents: 'Inhalt',
    factsNote:
      'Einige Angaben auf dieser Seite hält der Herausgeber aktuell. Älteste Bestätigung: {date}.',
  },
  fr: {
    moreFrom: 'Plus d’articles de ce blog',
    mainSite: 'Site principal',
    otherLanguages: 'Autres langues',
    contents: 'Sommaire',
    factsNote:
      'L’éditeur tient à jour certains chiffres de cette page. Confirmation la plus ancienne\xa0: {date}.',
  },
  pt: {
    moreFrom: 'Mais deste blog',
    mainSite: 'Site principal',
    otherLanguages: 'Outros idiomas',
    contents: 'Conteúdo',
    factsNote:
      'O editor mantém atualizados alguns números desta página. Confirmação mais antiga: {date}.',
  },
  it: {
    moreFrom: 'Altri articoli da questo blog',
    mainSite: 'Sito principale',
    otherLanguages: 'Altre lingue',
    contents: 'Indice',
    factsNote:
      'L’editore tiene aggiornati alcuni dati di questa pagina. Conferma meno recente: {date}.',
  },
  ru: {
    moreFrom: 'Ещё в этом блоге',
    mainSite: 'Основной сайт',
    otherLanguages: 'Другие языки',
    contents: 'Содержание',
    factsNote:
      'Некоторые цифры на этой странице издатель поддерживает в актуальном состоянии. Самое давнее подтверждение: {date}.',
  },
  ja: {
    moreFrom: 'このブログの他の記事',
    mainSite: 'メインサイト',
    otherLanguages: '他の言語',
    contents: '目次',
    factsNote: 'このページの一部の数値は発行者が最新の状態に保っています。最も古い確認日：{date}',
  },
  zh: {
    moreFrom: '更多文章',
    mainSite: '主站',
    otherLanguages: '其他语言',
    contents: '目录',
    factsNote: '本页部分数据由发布者保持更新。最早确认日期：{date}',
  },
  ar: {
    moreFrom: 'المزيد من هذه المدونة',
    mainSite: 'الموقع الرئيسي',
    otherLanguages: 'لغات أخرى',
    contents: 'المحتويات',
    factsNote: 'يحرص الناشر على تحديث بعض الأرقام في هذه الصفحة. أقدم تأكيد: {date}.',
  },
  hi: {
    moreFrom: 'इस ब्लॉग के और लेख',
    mainSite: 'मुख्य साइट',
    otherLanguages: 'अन्य भाषाएँ',
    contents: 'विषय-सूची',
    factsNote: 'इस पेज के कुछ आँकड़े प्रकाशक अद्यतन रखते हैं। सबसे पुरानी पुष्टि: {date}।',
  },
  sw: {
    moreFrom: 'Zaidi kutoka blogu hii',
    mainSite: 'Tovuti kuu',
    otherLanguages: 'Lugha nyingine',
    contents: 'Yaliyomo',
    factsNote:
      'Mchapishaji husasisha baadhi ya takwimu kwenye ukurasa huu. Uthibitisho wa zamani zaidi: {date}.',
  },
  // Traditional-script Chinese differs from `zh` (Simplified) in some of
  // the labels; keyed by language-script so `zh-Hant`, `zh-TW` and
  // `zh-HK` (which all maximise to Hant) get it.
  'zh-Hant': {
    moreFrom: '更多文章',
    mainSite: '主站',
    otherLanguages: '其他語言',
    contents: '目錄',
    factsNote: '本頁部分數據由發布者保持更新。最早確認日期：{date}',
  },
}

/** Languages with a translated chrome. Exported for the drift-guard test. */
export const THEME_LANGUAGES: readonly string[] = Object.keys(STRINGS)

/**
 * Strings for a (canonical) BCP-47 tag: the language-script entry when
 * one exists (`zh-Hant`), else the language (`pt-BR` → `pt`), else
 * English. The script comes from likely subtags, so `zh-TW` finds the
 * Traditional entry without listing every region.
 */
export function stringsFor(tag: string): ThemeStrings {
  const locale = new Intl.Locale(tag).maximize()
  return STRINGS[`${locale.language}-${locale.script}`] ?? STRINGS[locale.language] ?? STRINGS.en
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
