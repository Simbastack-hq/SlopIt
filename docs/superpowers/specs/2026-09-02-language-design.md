# Blog and Post Language — Minimal i18n Design Spec

**Status:** Approved 2026-09-02 (Codex plan review round 1 folded in).
**Scope:** `@slopit/core` schema, store, API, MCP, rendering, theme. Adds an optional `language` field on blogs (default `en`) and an optional per-post `language` override, and threads the effective language into every output a reader, crawler, or agent sees. Adds a two-string table so the theme's own chrome renders in the reader's language. No platform change required.

**Branch:** `feat/language` (stacked on `feat/related-posts`, PR to `dev` after it merges).

---

## Why

47 of the 102 published posts on slopit.io today contain Cyrillic. Nearly half the platform's content is Russian, and every one of those pages ships `<html lang="en">`, English-formatted dates, no `og:locale`, no `inLanguage`, no feed `<language>`. That is a real SEO, accessibility, and "is this my blog?" gap for the one persona that actually activated (an SEO content pipeline publishing in bulk).

Agent-native framing: the agent publishing knows what language it wrote in. One optional field, defaulting to `en`, lets it say so. No human step, no required field.

## Goals

1. `language` on the blog (BCP-47 tag, default `en`), settable at signup and via `PATCH /blogs/:id` / `update_blog`.
2. `language` on the post (optional override), settable on create and update, clearable with `null`.
3. Effective post language = `post.language ?? blog.language`. It drives: `<html lang>` and `dir`, date formatting, `og:locale`, JSON-LD `inLanguage`, `.md` frontmatter `language`. Blog language drives the index page's `lang`/`dir`, index date formatting, and RSS `<language>`.
4. The two theme strings a reader sees on a post page ("More from this blog", "Main site") render in the page's language for eleven languages, falling back to English.
5. Right-to-left scripts get `dir="rtl"`, decided by script, not language.
6. Validation via the standard library (`Intl`). Malformed, unknown, or extension-carrying tags are rejected with an actionable error. No new dependency.

## Non-goals

- **Translating the landing page, dashboard, SKILL.md, MCP tool descriptions, error messages, the empty-state copy.** Agents read English; the empty state is owner-only and seen once; platform copy is a separate decision.
- **Multi-language versions of one post / `hreflang`.** The "translate into 8 languages" agent use case is real and this schema is its foundation (each translation is a post with its own `language`), but the cross-linking field (`translationOf`) and `hreflang` emission wait until someone publishes translations.
- **Translating the platform CTA card or "Powered by SlopIt".** Marketing copy stays English; brand stays brand.
- **Per-item language in RSS.** RSS 2.0 has no item-level language element. Channel-level only.
- **Locale-aware anything beyond dates.** No number formatting, no pluralisation machinery, no message-format library.
- **Backfilling existing hosted blogs.** The core migration defaults every existing row to `en`. Setting `ru` on the Russian-language hosted blogs is a per-blog PATCH the operator (NJ) makes after deploy. Listed in the PR.

---

## Design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Blog default + per-post override, both named `language`.** | Maps 1:1 onto every output: HTML `lang` and JSON-LD `inLanguage` are per document (post), RSS `<language>` and the index page are per blog. A blog-only field would force a migration the day someone publishes a mixed-language blog; a post-only field makes every agent repeat itself. |
| 2 | **Validation** is a shared Zod field `languageTag` in `src/schema/post-input-base.ts`: `z.string().max(35).refine(isSupportedLanguage).overwrite(canonicalLanguage).describe(...)`. `isSupportedLanguage(tag)`: `Intl.DateTimeFormat.supportedLocalesOf(tag).length > 0` **and** `new Intl.Locale(tag).baseName === Intl.getCanonicalLocales(tag)[0]` (no `-u-`/`-x-`/`-t-` extensions). `canonicalLanguage(tag)`: `Intl.getCanonicalLocales(tag)[0]` (`EN-us` → `en-US`). Error message: `Expected a BCP-47 language tag with locale data, e.g. "en", "ru", "pt-BR"`. | `refine + overwrite` keeps `z.toJSONSchema` working (a `.transform` throws "Transforms cannot be represented in JSON Schema" on Zod 4.3.6; verified). `supportedLocalesOf` rejects `xx` and `Russian` while accepting every real language ICU knows; verified on this machine (ICU 77) and on the prod box (Node 20.20.1, ICU 78.2, full data). Extension subtags are rejected so `lang` attributes stay plain. Fail loud, per CLAUDE.md. |
| 3 | The `.describe()` text (examples, default, `null` clears a post override) flows into `GET /schema` and every MCP tool schema automatically. | Agents see the contract where they read it; zero drift. |
| 4 | Blog column: `language TEXT NOT NULL DEFAULT 'en'`. Post column: `language TEXT` (nullable; NULL = inherit). One migration, `009_language.sql`. | Two columns, no JSON, no sibling table. Existing rows read as `en` / NULL. |
| 5 | `BlogSchema.language: string` (always present). `CreateBlogInputSchema.language` optional, default `en`. `BlogPatchSchema.language` optional, **not nullable** (there is always a value; "reset" is `{ language: 'en' }`). | Mirrors `theme`, the other always-present blog attribute with a default. |
| 6 | `PostInputBaseSchema.language` optional, no default. `PostSchema.language` optional (the stored override only). `PostPatchSchema.language` optional **and nullable**: `null` clears the override (SQL NULL), omission leaves it unchanged. | API responses show what was stored, like every other optional post field; the *effective* value appears in rendered outputs. `null`-clears is documented in SKILL.md and the field description. (Codex #1.) |
| 7 | `resolveLanguage(post, blog)` in `src/rendering/seo.ts` = `post.language ?? blog.language`. Single source of truth, like `resolveDescription`. | Stored values are canonical and non-blank, so no `nonBlank` dance. |
| 8 | `formatDate(iso, locale)` gains a required locale argument and uses `toLocaleDateString(locale, …)`. Still UTC-pinned. | Verified on Node 20 and 24: `ru`, `ja`, `ar`, `hi` etc. format natively. One argument, no library. |
| 9 | `<html lang="{{lang}}" dir="{{dir}}">` on both templates. `dir` = `rtl` when `new Intl.Locale(tag).maximize().script` ∈ `{Arab, Hebr, Thaa, Syrc, Nkoo, Adlm}`, else `ltr`. Helper `textDirection(tag)` in `src/rendering/seo.ts`. | Script decides direction, not language: `ar-Latn` → ltr, `az-Arab` → rtl. `Intl.Locale#getTextInfo()` would be ideal but does not exist on prod's Node 20; `maximize()` exists on both and is deterministic. (Codex #5, different mechanism.) |
| 10 | `og:locale` = `${maximized.language}_${maximized.region}` (`ru` → `ru_RU`, `zh-Hant-TW` → `zh_TW`, `pt` → `pt_BR`). JSON-LD `inLanguage: tag`. | OG's documented shape is `language_TERRITORY`; `maximize()` supplies the likely region from CLDR instead of a hand-written table or omitting the signal. (Codex #6, different mechanism.) |
| 11 | RSS: `<language>{blog.language}</language>` in `<channel>`, canonical casing, XML-escaped. `.md` frontmatter: `language: "<effective>"` after `slug`. | No lossy lowercasing. Key order stable for agents diffing files. |
| 12 | **Theme strings live in `src/themes/strings.ts`**: `{ moreFrom, mainSite }` per language; `stringsFor(tag)` looks up by `new Intl.Locale(tag).language` and falls back to `en`. Languages: `en, es, de, fr, pt, it, ru, ja, zh, ar, hi`. Values are plain text; the fragment builders escape them. | Two strings a reader actually sees, eleven languages, one file. The empty-state copy stays English (owner-only, seen once, a pun). More languages arrive as PRs (core is MIT). (Codex #2 partially: cut the strings, kept the breadth NJ asked for.) |
| 13 | Strings are chosen by the **blog** language on the index page and by the **effective post** language on a post page. | Chrome follows the document it sits in. |
| 14 | `updateBlog`: any changed field → `renderBlogPosts` + `renderBlog` (HTML, from the related-posts PR). **Additionally, when `language` changed** → every published post's `.md` and the manifests (`renderPostMarkdown` per post + `renderManifests`). | Frontmatter and `feed.xml` carry language; analytics/parentSiteUrl do not. One `if`. (Codex #8.) |
| 15 | SKILL.md documents `language` on both objects in one paragraph with a Russian example and the `null` rule. `update_blog` description mentions language. | Contract lives where agents read it. |
| 16 | No platform change required. `POST /api/signup` and `PATCH` pass through the core schemas. The `/start` form does not get a language picker in this PR. | Agents set it. Humans on `/start` can ask their agent. |

## Rendering details

- `generator.ts`: `writePostHtml` computes `lang = resolveLanguage(post, blog)`, `dir = textDirection(lang)`, `postPublishedAtDisplay: formatDate(post.publishedAt, lang)`, `strings = stringsFor(lang)`; passes `lang`, `dir` to the template; `renderMoreFrom(strings, self, published)` and `renderParentSiteLink(strings, url)` take their labels from the table. `renderBlog` does the same with `blog.language`; `renderPostList(posts, locale)` formats dates with the blog locale.
- `seo.ts`: `resolveLanguage`, `textDirection`, `ogLocale`; `buildSeoMeta` emits `og:locale`; `buildJsonLd` emits `inLanguage`.
- `feeds.ts`: `RssFeedInput.language`; `buildRssFeed` emits `<language>`.
- `frontmatter.ts`: `language` key added after `slug`.
- `themes/strings.ts`: new. `themes/README.md`: document the string table and how to add a language.

## Store / API / MCP threading (exhaustive)

- Blog reads: `createBlog` (INSERT + hydrate SELECT), `getBlogsByEmail`, `getBlogByName`, `getBlogInternal`.
- Blog write: `updateBlog` handles `language` alongside `analytics` and `parentSiteUrl` (only changed columns written; compensation restores all three).
- Post reads: `listPublishedPostsForBlog`, `getPost`, `listPosts`, `createPost` hydrate SELECT.
- Post writes: `createPost` INSERT; `updatePost` merge (`'language' in parsed ? parsed.language : prior.language`, `null` → NULL), UPDATE, and compensation UPDATE.
- MCP: `signup`'s hand-written generic becomes `z.infer<typeof CreateBlogInputSchema>`; `create_post`/`update_post`/`update_blog` pick the field up via the shared schemas.
- REST: no new routes. `/schema` picks it up.

## Tests

- Schema: accepts `ru`, `pt-BR`, `zh-Hant-TW`, canonicalises `EN-us` → `en-US`; rejects `Russian`, `xx`, `ru-u-ca-islamic`, `''`, 40-char junk with the documented message; blog default `en`; post default absent; `PostPatchSchema` accepts `language: null`.
- `/schema` regression: response contains `language` with its description (proves `toJSONSchema` still works).
- Store round-trips: blog language persists; post override persists; `listPosts`/`getPost` include it; `createPost` hydrate returns it.
- `updateBlog`: language change writes the column and re-renders HTML + `.md` + manifests; `analytics` change re-renders HTML only (no `.md` rewrite); same-value patch is a no-op; compensation restores language on render failure.
- `updatePost`: `language: 'ru'` merges; `language: null` clears to NULL and the page falls back to the blog language; omitted key leaves the prior value.
- Rendering (temp dir): Russian blog → index and post pages carry `lang="ru" dir="ltr"`, Russian date, Russian "More from" heading; Arabic post on an English blog → post page `lang="ar" dir="rtl"`, index stays `en`/`ltr`; `ar-Latn` → `ltr`, `az-Arab` → `rtl`; `og:locale` `ru_RU`, `inLanguage`, RSS `<language>`, frontmatter `language` all present with the right value.
- `formatDate`: locale argument changes output; still UTC-pinned.
- `stringsFor`: `pt-BR` → `pt`; unknown → `en`; every language object has both keys (drift guard).
- Migration: a pre-009 DB opens, existing blog reads `language: 'en'`, existing post `language: undefined`.
- SKILL.md drift test: mentions `language` and the `null` rule.

## Migration safety

`009_language.sql` is two `ALTER TABLE ADD COLUMN` statements. No data rewrite. Self-hosted `docker compose up` migrates on boot as today.

## MVP vs deferred

- **MVP:** an agent sets `language` once at signup (or per post) and every page, feed, and `.md` on that blog is correctly tagged and dated; a post override can be set and cleared; the two post-page chrome strings read natively in eleven languages.
- **Deferred:** languages outside the eleven (correct attributes and dates, English chrome); translations of one post with `hreflang`; a language picker on `/start`; backfilling existing hosted blogs (operator action, one PATCH per blog).
