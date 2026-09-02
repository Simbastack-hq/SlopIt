---
title: Language tags — validate with Intl, canonicalise with overwrite, direction by script
tags: [schema, rendering, i18n, zod]
severity: p3
date: 2026-09-02
applies-to: [core, platform, self-hosted]
---

## Rule

`language` on blogs (default `en`) and posts (optional override) is a BCP-47 tag validated and canonicalised at the Zod boundary by `languageTag` in `src/schema/post-input-base.ts`. Everything downstream (`<html lang>`, `dir`, dates, `og:locale`, JSON-LD `inLanguage`, `.md` frontmatter, RSS `<language>`) reads the stored canonical value through `resolveLanguage(post, blog)` in `src/rendering/seo.ts`. No i18n library.

## The validator, and why each piece is there

```ts
z.string().max(35)
  .refine(isSupportedLanguage, { message: '…e.g. "en", "ru", "pt-BR"', abort: true })
  .overwrite(canonicalLanguage)
```

- `Intl.getCanonicalLocales(tag)` throws `RangeError` on malformed input (`"Russian"` is *not* malformed — a 7-letter language subtag is syntactically legal — so shape alone is not enough).
- `Intl.DateTimeFormat.supportedLocalesOf(tag).length > 0` rejects tags ICU has no data for (`xx`, `russian`). An agent passing a language *name* gets a ZOD_VALIDATION error with examples instead of a page tagged with nonsense.
- `new Intl.Locale(tag).baseName !== canonical` rejects extension subtags (`ru-u-ca-islamic`) that would otherwise leak into `lang` attributes.
- **`overwrite`, not `transform`.** `z.toJSONSchema` (the public `/schema` endpoint) throws "Transforms cannot be represented in JSON Schema" on Zod 4.3.6. `overwrite` is a type-preserving transform that JSON Schema can ignore.
- **`abort: true` on the refine.** Zod 4 keeps running later checks after a failed refine; without `abort`, `overwrite` ran `getCanonicalLocales` on the bad input and threw `RangeError` out of `parse` instead of returning an issue. Caught by the "rejects junk" test.
- The `.describe()` text lands in `/schema` and in every MCP tool schema automatically, so the examples reach agents where they read the contract.

## Direction and og:locale from `Intl.Locale#maximize()`

- Direction is decided by the **script** the tag maximises to, against a fixed RTL set (`Arab Hebr Thaa Syrc Nkoo Adlm`): `ar` → rtl, `ar-Latn` → ltr, `az-Arab` → rtl. `Intl.Locale#getTextInfo()` would be the direct answer but does not exist on Node 20, which production runs (Node 20.20.1, ICU 78.2, full data). `maximize()` exists on both 20 and 24.
- `og:locale` is `language_REGION` from the maximised tag (`ru` → `ru_RU`, `zh-Hant-TW` → `zh_TW`, `pt` → `pt_BR`). No hand-written territory table, no hyphen→underscore guesswork.

## Prod caveat

The validator only accepts what the *server's* ICU supports. Node's official builds ship full ICU; a `small-icu` build would reject every non-English tag at signup. If a self-hoster reports "ru rejected", check `node -p "Intl.DateTimeFormat.supportedLocalesOf('ru')"` on their box.

## Where the chrome strings live

`src/rendering/strings.ts` — two labels per language ("More from this blog", "Main site"), looked up by primary subtag, English fallback. It sits in `rendering/`, not `themes/`: `tsc` emits `dist/themes/*.js` for anything under `src/themes/`, which makes `dist/themes` exist before the build's `cp -R src/themes dist/themes` runs, and `cp` then nests the theme assets one level too deep. Keep `src/themes/` asset-only.

## Pointers

- `src/schema/post-input-base.ts` — `isSupportedLanguage`, `canonicalLanguage`, `languageTag`
- `src/rendering/seo.ts` — `resolveLanguage`, `textDirection`, `ogLocale`
- `src/rendering/strings.ts` — `stringsFor`
- `src/db/migrations/009_language.sql`
- `tests/language.test.ts`
- `docs/superpowers/specs/2026-09-02-language-design.md`
