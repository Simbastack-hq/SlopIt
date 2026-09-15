# Translations — one post in several languages, and a home page per language

**Status:** Approved 2026-09-15 (Codex plan review round 1 folded in; see `REVIEW.md` in the worktree for the ledger).
**Scope:** `@slopit/core` schema, primitives, rendering, theme, SKILL doc (this spec). A short companion spec in `slopit-platform` (`docs/specs/2026-09-15-translations-pro-design.md`) covers visitor-language negotiation and the Pro gate. Together they are one feature; they ship as two PRs (core first).
**Branches:** core `feat/translations` (from `dev`); platform `feat/translations` (from `main`).
**Builds on:** `2026-09-02-language-design.md`, which shipped blog + post `language`, ICU dates, `dir`, `og:locale`, `inLanguage`, frontmatter `language`, and chrome strings in eleven languages, and listed "translations of one post with `hreflang`" as the deferred next step. This is that step.

---

## Why

A blog owner (first customers: NJ's own product blogs) writes a post in one language and has an agent translate it into two or three more. Today each translation is just another post: correctly tagged and dated, but unrelated to its siblings. The consequences:

- Search engines see three unrelated pages and may rank the wrong language for a visitor. There is no `hreflang`, so Google cannot route a German searcher to the German page.
- The blog index mixes every language into one list. A German visitor scrolls past English posts to find the three German ones.
- A visitor on the German page has no way to find the English one, and vice versa.
- A visitor arriving at the blog root sees the default language whatever their browser is set to.

The fix is small because the hard part (per-post `language`) already exists. Translations are peers linked by one nullable column; the renderer derives everything else.

## What this does, in one paragraph

An agent publishes a translation with `translationOf: "<slug>"`. Core links the two posts into a translation group. Every published member's page carries `<link rel="alternate" hreflang>` for its siblings and a small row of language names under the title. The blog gets one home page per language it publishes in: `/` for its root language, `/lang/<tag>/` for each other language, each listing only that language's posts, with its own `feed.xml`. On the hosted platform, a Pro blog's visitor requesting `/` is redirected once to `/lang/<tag>/` when their browser's `Accept-Language` prefers a language the blog publishes in. Linking translations and the root redirect are Pro on slopit.io; per-language home pages, the switcher and `hreflang` apply to any blog that publishes in more than one language, because they are rendering properties of content that already exists.

## Goals

1. `translationOf` on create and patch links posts into a group. One post per language per group, enforced.
2. Every published member's page emits `hreflang` alternates (plus `x-default`) and `og:locale:alternate`, and shows the sibling languages as links.
3. A blog that publishes in *k* languages gets *k* home pages, each in its language: posts, chrome, `lang`/`dir`, dates, feed. A monolingual blog's rendered pages change only by a `<link rel="canonical">` on its home page.
4. "More from this blog" on a post lists posts in that post's language.
5. The hosted platform picks a Pro blog's visitor's home page from `Accept-Language` on `/`, honours an explicit choice, and never redirects a post page.
6. Zero JavaScript, no cookies, no new data stored. The privacy policy's "no cookies set by SlopIt" on rendered blog pages stays true.

## Non-goals

- **IP geolocation.** Country is not language (Switzerland, Belgium, Canada, India, expats, VPNs). `Accept-Language` is the direct signal of "the visitor's system is set to X" and needs no database. Caddy terminates TLS directly on the box, so there is no CDN country header to read anyway. Not deferred: rejected.
- **Remembering an explicit language choice across visits.** Needs a cookie. `legal.html` promises "No cookies set by SlopIt" on rendered blog pages and `docs/solutions/privacy-policy-as-feature-contract.md` says the policy is the spec. An explicit choice lasts for the click and the navigation that follows it (see `?lang=` below); the visitor's browser language is the default every visit, which is the right default. Revisit only with an open policy change.
- **Redirecting post pages by language.** Google's guidance cautions against automatic language redirects; a redirect on `/` only is a deliberate product trade-off, and post pages never redirect so shared links and search landings stay stable. `hreflang` routes search traffic; the switcher covers the rest.
- **A "read this in English" suggestion banner on post pages.** Needs request-time HTML rewriting or JavaScript. Deferred; the switcher is one line below the title.
- **Translating chrome for languages beyond the eleven.** Unchanged: correct attributes and dates, English chrome.
- **Per-language `llms.txt`, a `translations:` list in `.md` frontmatter, a `?language=` filter on `list_posts`.** Each is cheap and none is needed to ship. Frontmatter already carries `language`; agents group `list_posts` by `translationGroup`.
- **Negotiating on `/b/:id/` (unnamed blogs).** Platform-only detail, listed in the companion spec.
- **Machine translation.** The agent translates. SlopIt links.

---

## Design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Translations are peer posts** with their own slug, linked by `posts.translation_group` (nullable opaque id), not a sub-resource of a "source" post. | Symmetric: no source to orphan on delete, no re-parenting. The API still reads naturally (`translationOf: "<slug>"` on create); the group id is what it resolves to. Every existing rendering rule (per-post `language`, `.md`, RSS) keeps working unchanged. |
| 2 | **Flat post URLs stay flat.** A German translation lives at `/<its-slug>/`, never `/de/<slug>/`. | 47 Russian posts on `en`-default hosted blogs already live at `/<slug>/`. A prefix for non-default languages would move them, or force the inconsistent "prefix only for grouped posts". Slugs are unique per blog already; an agent translating "Pricing" into Dutch picks `pricing-nl` or `prijzen`. |
| 3 | **Language home pages live under one reserved directory: `/lang/<tag>/`**, `tag` = lowercase canonical tag (`/lang/de/`, `/lang/pt-br/`). `/` stays the unprefixed home of the root language (decision 4). The single slug `lang` is reserved for new posts (`POST_SLUG_RESERVED`, checked in `createPost` after slug resolution so auto-derived slugs are covered). | Post slugs and language homes must not share a namespace: a legacy post at `/it/` and an Italian home would fight over one `index.html` (Codex round 1, #1). One reserved word gives an unambiguous namespace with no per-tag slug reservation, no ownership heuristic, and no legacy-collision logic; the analytics aggregator already collapses multi-segment paths to the home bucket. `lang` reads as a word to a human in a URL; `_lang` would be jargon. `/de/` was prettier and not worth three guards. |
| 4 | **Root language** = `blog.language` when at least one published post is in it, else the language with the most published posts (tie: alphabetical). `listBlogLanguages(store, blogId)` returns `[root, ...others alphabetical]`, and `[blog.language]` for a blog with no published posts. Everything that says "default" below means the root language. | Several hosted blogs are `en`-default with only Russian posts. Filtering `/` to the default language would render the "Nothing here yet" empty state on a live blog (Codex #7). Deriving the root from what is actually published makes `/` always the most useful page, keeps the empty state for genuinely empty blogs, and makes the operator's later `PATCH language: ru` a no-op on output rather than a repair. |
| 5 | **A language's home page lists only that language's posts.** No fallback to untranslated posts in other languages. A `/lang/<tag>/` page exists iff the blog has ≥1 published post in that language, so it is never empty. | Predictable, no mixed-language lists, symmetric between root and others. Every post is reachable from exactly one home page plus the switcher. |
| 6 | **Group members store their language explicitly.** Joining a group writes `language = <resolved>` on the joining post; if the target has `language IS NULL` it is written `blog.language` too. Patching `language: null` on a grouped post stores `blog.language` instead of `NULL`. Both rows are written in one transaction and both are restored by the compensation path on render failure. | Uniqueness "one post per language per group" must not depend on the blog default, which can change. Effective language is unchanged by the freeze, so no re-render is needed for it. A failed request must not leave the target frozen (that would silently change how a later blog-default change affects it) or visibly grouped (Codex #3). |
| 7 | **One post per language per group.** Preflight `SELECT` inside the write transaction → `TRANSLATION_CONFLICT` (409) with `details: { language, slug }` naming the existing member; a partial unique index `(blog_id, translation_group, language) WHERE translation_group IS NOT NULL` is the backstop. | Two German versions of one post is a mistake, and the most likely mistake (forgetting `language` on the translation) produces this error with the fix in it. The index makes the invariant hold even for a write path that forgets the preflight (Codex #4). |
| 8 | **`x-default`**: on home pages → the root home (`/`); on a post → the member in the root language, omitted when the group has none. `hreflang` links are emitted only for *published* members and only when ≥2 are published; the set always includes self. `renderAlternates` takes the root language explicitly. | Derived, no stored "source" flag. Drafts have no URL. The builder cannot infer the root from a non-root post's own data, so it is passed (Codex #9). |
| 9 | **Switcher = autonyms from `Intl.DisplayNames`** (`Deutsch`, `English`, `Français`, `Русский`, `Kiswahili`), first letter upper-cased with `toLocaleUpperCase(tag)`; each item `<a lang="de" hreflang="de" dir="auto" href="…">`, the current language a `<span aria-current="page" lang="…" dir="auto">`; `<nav class="translations" aria-label="{otherLanguages}">`. One new chrome string, `otherLanguages`, in the eleven languages. Every label, attribute and URL passes through `escapeHtml`. | A reader recognises their own language's name in their own language; no translation table to maintain; `Intl.DisplayNames` exists on Node 20 and 22 (prod) with full ICU. CLDR lower-cases some names in running text (`français`, `русский`); a row mixing cases reads as a typo, and every major switcher (Wikipedia included) capitalises, so we do too (Codex #10 suggested dropping it; kept). `dir="auto"` isolates an Arabic or Hebrew name inside an LTR row and vice versa. |
| 10 | **"More from this blog" filters to the post's effective language.** | Chrome and dates are already in that language; the links should be too. A one-post language renders no block, as today. |
| 11 | **Home links on multilingual blogs are language-aware:** a post in language L links home to `../lang/<l>/`; a root-language post links `../?lang=<root>`; the index switcher links `lang/<l>/` and `?lang=<root>` (relative). Monolingual blogs render `..` exactly as today. `?lang=` never appears in a canonical, `hreflang`, feed or sitemap URL. | `/` is where the platform negotiates. A visitor who chose the root language explicitly must reach `/` and stay on it while navigating (home link from a root-language post carries the marker). `?lang=` is a self-describing marker any static server ignores; a negotiating consumer treats it as "explicit, do not redirect". It does not survive a new visit, by design (no cookie). |
| 12 | **`/feed.xml` is the root language's feed; `/lang/<tag>/feed.xml` is each other language's.** Items filtered *then* capped at 20; `<language>` matches the items; `<link>` is that language's home. `sitemap.xml` adds a `<url>` per language home. `llms.txt` unchanged (all posts). | Symmetric with the home pages; the channel `<language>` finally matches every item. Only mixed blogs see their `/feed.xml` contents change, and for them the root language is the majority language (decision 4). |
| 13 | **Stale language homes are pruned last.** `Renderer.pruneLanguageHomes(blogId)`: `readdir(<blogDir>/lang)`, remove every **subdirectory** not in the current non-root language set (files are left alone), remove `lang/` itself only when nothing is left; ENOENT-tolerant. Called as the **final** step of every mutation's render sequence (`createPost`, both published branches of `updatePost`, `deletePost`, `updateBlog`), after every write has succeeded. | Deleting inside `renderBlog` would run before manifests and sibling renders; a later failure would compensate the DB but leave `/lang/de/` gone (Codex round 1, #2). Same destructive-last contract as `removePostFiles`. Exact, no heuristics: the subdirectories of `lang/` are only what we wrote; a pre-reservation post with slug `lang` owns `lang/index.html`, a *file*, which is why only directories are candidates (Codex round 2, #1). `createPost` prunes too because a publish can change the root language (decision 4) and so move a home from `lang/<tag>/` to `/` (Codex round 2, #2); the method therefore lives on the base `Renderer`, like `renderBlogPosts`. |
| 14 | **`translationPolicy?: (blog) => { ok: true } | { ok: false; reason: string }`** on `ApiRouterConfig`/`McpServerConfig`, same shape as `nameValidator`. Consulted for every write that carries a non-null `translationOf` (including re-linking a post that was grouped before a downgrade). Rejection → `TRANSLATIONS_DISABLED` (403) with the consumer's `reason` as the message. Default: allowed. Threaded to `createPost`/`updatePost` as an optional `opts` argument from the REST route and the MCP tool. | Core does not know plans exist; it knows a consumer may refuse a feature and say why. Leaving a group (`translationOf: null`) is never gated. Self-hosted passes nothing and gets everything. |
| 15 | **`Post` gains `translationGroup?: string`; `translationOf` is input-only.** `PostSchema` is built from `PostInputBaseSchema.omit({ translationOf: true })`. No computed `translations` list on responses. | Free (it is the row), enough for an agent to group `list_posts`, and it keeps `Post` a row. |
| 16 | **Core exports `listBlogLanguages(store, blogId): string[]`** (decision 4). | The renderer needs it for the home pages; the platform needs the same list to negotiate on `/`. One query, one definition. |
| 17 | **Migration 010:** `ALTER TABLE posts ADD COLUMN translation_group TEXT; CREATE UNIQUE INDEX idx_posts_translation_lang ON posts(blog_id, translation_group, language) WHERE translation_group IS NOT NULL;` | Nullable, no data rewrite. The partial unique index is decision 7's backstop and also serves group lookups. |

---

## Data model

```sql
-- 010_translations.sql
ALTER TABLE posts ADD COLUMN translation_group TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_translation_lang
  ON posts(blog_id, translation_group, language)
  WHERE translation_group IS NOT NULL;
```

`translation_group` is an opaque id (`generateShortId()`), shared by every post that is a translation of the same text. `NULL` = not part of any group. Members always have a non-null `language` (decision 6), which is what lets the unique index express "one post per language per group".

`Post` (schema + every SELECT in `posts.ts`) gains `translationGroup?: string` (`undefined` when NULL).

## API and MCP

`PostInputBaseSchema` gains:

```ts
translationOf: z.string().min(1).max(100)
  .describe('Slug of an existing post in this blog that this post translates. The two become a translation group: one post per language, cross-linked with hreflang. This post\'s `language` must differ from every other member\'s.')
  .optional()
```

(`min(1)`, not the explicit-slug schema's `min(2)`: an auto-derived slug from a one-letter title is one character, and `translationOf` names an existing slug — Codex round 2, #3.)

`PostPatchSchema` gains the same field, `.nullable()`: a slug joins the post to that post's group (creating one if needed); `null` leaves the group; omitted leaves membership unchanged.

`createPost(store, renderer, blogId, input, opts?)` and `updatePost(store, renderer, blogId, slug, patch, opts?)` take `opts?: { translationPolicy?: TranslationPolicy }`.

### Resolving membership and language on a write

Inputs: `membership` = `translationOf` (`string` | `null` | omitted), `langPatch` = `language` (`string` | `null` | omitted), `prior` (patch only), `blog`.

1. If `membership` is a slug: `opts.translationPolicy?.(blog)` → `{ ok: false }` → throw `TRANSLATIONS_DISABLED(reason)`. Nothing is read or written.
2. Resolve the target by `(blogId, slug)` (same blog only, by construction of the query) → missing → `POST_NOT_FOUND`. On patch, target `id === prior.id` → `BAD_REQUEST` ("a post cannot be a translation of itself").
3. Final group: slug → `target.translationGroup ?? generateShortId()`; `null` → none; omitted → `prior?.translationGroup`.
4. Final language: if the post ends up in a group, `langPatch` string → that; `null` or omitted-with-no-prior → `blog.language`; omitted-with-prior → `prior.language ?? blog.language`. Always explicit. If it ends up in no group, the existing rule applies (`null` clears to inherit, omitted keeps prior, string sets).
5. If in a group: preflight `SELECT slug FROM posts WHERE blog_id = ? AND translation_group = ? AND language = ? AND id != ?` → hit → `TRANSLATION_CONFLICT { language, slug }`.
6. One `db.transaction`: if the target had no group, `UPDATE posts SET translation_group = ?, language = COALESCE(language, ?) WHERE id = target.id`; then the post's own INSERT/UPDATE with `translation_group` and `language`. The unique index backs step 5.

`updatePost` today issues a bare `UPDATE`; it moves inside the transaction with the target write. Both compensation paths snapshot the target's `(translation_group, language)` before the transaction and restore them (and, for `updatePost`, the post's own two columns) if rendering fails.

Render side effects are the existing calls plus `pruneLanguageHomes` last (decision 13). `renderBlogPosts` already re-renders every published page on every mutation, so sibling `hreflang` links and switchers refresh with no new call sites.

New error codes: `POST_SLUG_RESERVED` (400), `TRANSLATION_CONFLICT` (409), `TRANSLATIONS_DISABLED` (403). Added to `SlopItErrorCode`, `CODE_TO_STATUS`, and the SKILL error table.

MCP: `create_post` and `update_post` pick the field up automatically from the shared base/patch schemas; the tool handlers pass `{ translationPolicy: config.translationPolicy }`. The `create_post` description gains one sentence on `translationOf`.

## Rendering

### Languages of a blog

```ts
export function listBlogLanguages(store: Store, blogId: string): string[]
```

One grouped query over published posts (`COALESCE(p.language, b.language)`, count per language). Ordering per decision 4. Never empty.

### Paths

| Output | Path | Notes |
|---|---|---|
| Root home | `/index.html` | root language (decision 4) |
| Home for language L | `/lang/<l>/index.html` | `l` = lowercase canonical tag |
| Root feed | `/feed.xml` | root-language posts only |
| Feed for L | `/lang/<l>/feed.xml` | |
| Post page / source | `/<slug>/index.html`, `/<slug>.md` | unchanged |
| `sitemap.xml`, `llms.txt` | unchanged paths | sitemap gains one `<url>` per language home |

`renderBlog(blogId)` writes every home page (creating `lang/<l>/` as needed). `renderManifests(blogId)` writes every feed (creating its own directories: `renderPost` calls it before `renderBlog`), plus sitemap and llms.txt. Both derive the language set from `listBlogLanguages`, so their relative order never matters. If `<blogDir>/lang.md` exists (a pre-reservation post with slug `lang`) and the blog has more than one language, `renderBlog` throws with a message naming the slug; the reservation makes this impossible for new posts.

One shared helper computes home URLs: `homeUrl(root, lang, rootLang)` → `root` or `root + 'lang/' + lower(lang) + '/'`, used by canonicals, `hreflang`, feed `<link>`/`atom:link`, sitemap and the switcher.

### Index page

`renderPostList(posts, locale, hrefPrefix)` — `hrefPrefix` is `''` on `/` and `'../../'` on `/lang/<l>/`. Template `index.html` gains `{{faviconHref}}` (`favicon.svg` / `../../favicon.svg`; `themeCssHref` already exists), `{{{alternates}}}` and `<link rel="canonical" href="{{canonicalUrl}}">` in `<head>`, and `{{{languageNav}}}` as its own block **below** the masthead (not inside the flex row, which does not wrap).

`renderAlternates(entries, self, rootLang)` (`@internal`) takes `[{ language, url }]` and returns, for ≥2 entries, one `<link rel="alternate" hreflang="…" href="…">` per entry, `hreflang="x-default"` for the entry whose language is `rootLang` when present, and one `<meta property="og:locale:alternate" content="…">` per entry other than `self`. `''` for fewer than 2.

`renderLanguageNav(entries, current, label)` (`@internal`) returns `''` for fewer than 2 entries, else the `<nav>` of decision 9, in the order given (root first), separators via CSS.

### Post page

`writePostHtml` computes `members = published.filter(p => p.translationGroup !== undefined && p.translationGroup === post.translationGroup)` (self included) and passes:

- `alternates` → `renderAlternates(members → { language: resolveLanguage(p, blog), url: canonicalFor(p.slug) }, self, rootLang)`.
- `translations` → `renderLanguageNav(members → { language, href: '../' + slug + '/' }, current = post's language, strings.otherLanguages)`, placed in the post `<header>` after `<time>`.
- `moreFrom` → `renderMoreFrom(post, published.filter(sameLanguage), heading)`.
- `blogHomeHref` → `'..'` when the blog has one language; else `'../lang/<l>/'` for a non-root post, `'../?lang=<root>'` for a root-language post.

Both templates keep `{{{…}}}` placeholders that render to `''` on monolingual blogs.

### Feeds and sitemap

`buildRssFeed` already takes `blog.language`; call it with `{ ...blog, language: l }`, `blogRoot: homeUrl(l)`, `feedUrl: homeUrl(l) + 'feed.xml'`, posts filtered to `l` then sliced to 20. `buildSitemap` gains `homes: [{ url, updatedAt }]` for the non-root language homes (root already present).

### CSS

`.translations` in `style.css`: a wrapping flex row (`gap: 4px 16px`) of muted small links, underlined with an offset so they read as links on touch screens, the current language plain in `--text`. No dot separators: a `::before` dot leads every wrapped line (Codex round 2 UX, #4–5). Same visual weight as `<time>`. Roughly 25 lines; RTL-safe via logical properties like the rest of the theme.

### Chrome strings

`ThemeStrings` gains `otherLanguages` ("Other languages", "Andere Sprachen", "Autres langues", "Otros idiomas", "Outros idiomas", "Altre lingue", "Другие языки", "他の言語", "其他语言", "لغات أخرى", "अन्य भाषाएँ"). Swahili joins the table as a twelfth language (`Zaidi kutoka blogu hii`, `Tovuti kuu`, `Lugha nyingine`): the first customers publish for East Africa, and a Swahili home page with English navigation is the wrong first impression (Codex round 2 UX, #2). The drift-guard test refuses a half-translated entry, as today.

`languageLabel(tag)` (`@internal`, `rendering/strings.ts`): `new Intl.DisplayNames([tag], { type: 'language' }).of(tag)`, first character `toLocaleUpperCase(tag)`; ICU returns the tag itself for unknown input, so no fallback branch.

## Theme README

Update: the home page section (one per language under `/lang/`), the post page list (add "Languages of this post, when it has translations"), the language section (`?lang=` marker, reserved slug `lang`), and the "explicitly not shipped" list (add "auto-redirecting post pages by language", "IP geolocation").

## SKILL.md

`## Language` gains a `### Translations` subsection: `translationOf` on create/patch, one post per language per group, `translationGroup` in responses, what the reader gets (`hreflang`, switcher, `/lang/<tag>/` home pages and feeds), the reserved slug, the three new error codes, and one line that a hosting consumer may gate `translationOf` (platform appends its Pro wording). Agent-readable outputs table gains `/lang/<tag>/` and `/lang/<tag>/feed.xml`.

## Tests (core)

`tests/translations.test.ts`, following `language.test.ts`:

- Schema: `translationOf` accepted on input and patch, `null` only on patch; `PostSchema` has no `translationOf`; `/schema` JSON still generates.
- `createPost` with `translationOf`: both rows share one group id, the target's `language` is made explicit, the new post's `language` is explicit; second German → `TRANSLATION_CONFLICT` naming the first; unknown target → `POST_NOT_FOUND`; a slug that exists only in *another* blog → `POST_NOT_FOUND` (tenant isolation); policy `{ ok: false }` → `TRANSLATIONS_DISABLED` with the reason and nothing written; policy not consulted without `translationOf`; a render failure after a join restores the target's `translation_group` and `language`.
- `updatePost`: join an existing post; move a post from one group to another; leave with `null` (not gated); self-reference → `BAD_REQUEST`; `language: null` on a member stores the blog default and conflicts if taken; explicit `language` change to a taken language → `TRANSLATION_CONFLICT`; render failure restores both rows.
- Reserved slug: explicit `slug: 'lang'` and title `"Lang"` both → `POST_SLUG_RESERVED`.
- Rendering, on a blog with `en` default and posts in `en`, `de`, `pt-BR`:
  - `/index.html` lists English only; `/lang/de/index.html` German only with `lang="de"`, German date, `../../style.css`, `../../favicon.svg`, post hrefs `../../<slug>/`; `/lang/pt-br/index.html` exists; each carries `hreflang` links for all three homes, `x-default` → root, a canonical, and a switcher with `Deutsch`, `English`, `Português (Brasil)` with the current one as `<span aria-current>`.
  - A grouped post page carries `hreflang` for each published sibling and itself, `x-default` → the English member, `og:locale:alternate` for the others, the switcher linking `../<sibling>/`, and its `moreFrom` lists only same-language posts; a draft sibling appears in none of it; a lone member (sibling unpublished) has no alternates and no switcher; a group with no root-language member emits no `x-default`.
  - Home links: German post → `../lang/de/`, English post → `../?lang=en`; monolingual blog → `..`.
  - `/feed.xml` has only English items and `<language>en</language>`; `/lang/de/feed.xml` German with `<language>de</language>` and `<link>…/lang/de/</link>`; `sitemap.xml` lists both language homes and no `?lang=`.
  - Unpublishing the last German post removes `/lang/de/` (both files) and the sitemap entry; deleting the last remaining non-root language removes `lang/` itself.
  - Root language: an `en` blog with only Russian posts renders `/` in Russian with Russian items, no `lang/` directory and no switcher; adding an English post makes `/` English and creates `/lang/ru/`; `PATCH blog { language: 'ru' }` then moves Russian to `/` and English to `/lang/en/`.
  - Monolingual blog: the post page has no `.translations`, no `hreflang`, home link `..`; the index has no `.translations` and one canonical.
  - Legacy URL preservation: a pre-existing non-root-language post keeps `/<slug>/` after becoming grouped.
- Transport: REST `POST` with `translationOf` on a router whose config has a refusing policy → 403 `TRANSLATIONS_DISABLED`; MCP `create_post` the same via the envelope; `/schema` documents the field.
- `generateSkillFile` mentions `translationOf` and `/lang/`.

## Rollout

1. Merge core to `dev`, then `dev → main`. Migration 010 applies on boot.
2. Platform PR (companion spec) lands after core is on `main`; the box's `deploy.sh` pulls core `origin/main` on every platform deploy.
3. Immediately after the platform deploy, re-render every blog that publishes in more than one language (`node dist/scripts/rerender-blog.js <blogId>`), so `/lang/<tag>/` exists before any visitor is routed there. Until then the platform serves `/` (it checks the destination exists). Then `PATCH language: "ru"` on the Russian-majority blogs (pending follow-up from the language release); with decision 4 this changes no output, it only makes the stored default honest.
4. Every other hosted blog is monolingual and changes by one `<link rel="canonical">` on its home page on its next render.

## 99% vs 1%

**Drives usage:** one root language plus one to three translation languages, with incomplete coverage (not every post translated); ordinary publish/edit/unpublish on members; agent publishes the source, then each translation with `translationOf` and `language`; readers arrive from search (routed by `hreflang`) or at `/` (routed by `Accept-Language` on the platform, script-compatible matching); the switcher covers everything else.

**Deferred (listed in the PR as NOT in this PR):** remembering an explicit choice (cookie → policy change), post-page suggestion banner, `translations:` in frontmatter, per-language `llms.txt`, `list_posts?language=`, negotiation on `/b/:id/`, Caddy agent-path classification for `/lang/<tag>/feed.xml`, regional ranking beyond exact → same-script-primary matching, chrome strings beyond eleven languages.

## Amendments — 2026-09-16 (Codex production audit)

Four findings from an independent audit of the shipped feature, folded in on `fix/translations-audit`. Where they change a decision above, the decision is superseded by this section.

1. **Public output is rolled back on a failed write (audit #1).** `createPost`, `updatePost` and `updateBlog` no longer stop at restoring the rows. After compensation they remove the files the failed write produced (or re-render the prior page of an edited post), then re-derive every blog-level page — homes, manifests and feeds, every post page, the language-home prune — from the restored rows (`rederiveBlogOutput`, `src/posts.ts`). A failed publish therefore leaves no readable page, `.md`, feed entry, sitemap entry or language home behind. `createPost` now takes a `MutationRenderer` (it needs `removePostFiles` and `deletePostMarkdown`). Still best-effort: a second failure needs operator cleanup, as before.
2. **Every language keeps a stable URL, the root language included (audit #2; supersedes the `?lang=` marker in decisions 11 and 12).** On a multilingual blog every language with published posts has `/lang/<tag>/index.html` and `/lang/<tag>/feed.xml`, including the root language, whose `lang/` copy carries `<link rel="canonical">` → `/` and no `hreflang` of its own; it is not listed in the sitemap. `/` and its alternates are unchanged. `/feed.xml` returns to its historical meaning — the 20 newest posts in every language, channel `<language>` = root language — so no existing subscription changes meaning when a root flips. Switcher links and post home links on multilingual blogs point at `lang/<tag>/` for every language and never at `/`, so an explicit choice is never re-negotiated and the `?lang=` marker is gone (core no longer emits it; the platform no longer looks for it). Pruning keeps every language with posts while the blog is multilingual and empties `lang/` entirely when it is back to one language. A root flip now changes only what `/` shows.
3. **Touch targets (audit #3).** Each switcher item is a 44px-tall target (`padding-block: 11px` on a 22px line); the surrounding margins take the padding back so the text sits where a plain line would, and wrapped rows abut without overlapping.
4. **Traditional Chinese chrome (audit #5).** `stringsFor` looks up `language-script` (from likely subtags) before `language`, and a `zh-Hant` entry supplies `其他語言`; `zh-TW` and `zh-HK` resolve to it, `zh`/`zh-CN`/`zh-Hans` keep the Simplified strings.

Platform companion: the Pro card bullet reads "Linked translations + automatic language selection" (audit #4; standalone multilingual posts and language homes are free). Monolingual blogs are unaffected by every item above.

### Amendment follow-ups (Codex review of the fixes, 2026-09-16)

- **Compensation steps are independent and loud.** `attemptAll` runs every recovery step even when one fails; `rethrowWithRecovery` rethrows the original error unchanged when recovery completed, and otherwise throws an error whose message carries both the original and the recovery failures (`cause` = original) after a `console.error`. Files are only removed once the row rollback actually succeeded; while the row exists, its files are what the rows describe.
- **`deletePost` cleans up whether or not the re-render succeeds.** The row is deleted first, so a retry could never reach the file removal; `deletePostMarkdown`, `removePostFiles` and `pruneLanguageHomes` now run in every case and any failure is reported with the render error.
- **Deliberately kept: `lang/` exists only while the blog publishes in two or more languages.** A blog that returns to a single language (every post of a language unpublished or deleted) loses `/lang/<tag>/`; its content is at `/`. Keeping the tree for ever would give a monolingual blog language homes it never asked for, and a failed multilingual publish would leave one behind. This is an owner's deliberate removal of a whole language, not the ordinary publish that audit #2 was about.
