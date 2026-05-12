# Blog Post SEO Meta — Phase 1 Design Spec

**Status:** Design draft 2026-05-01.
**Scope:** `@slopit/core` rendering. **Phase 1** of the agent-readable blogs feature series. `<head>` meta + JSON-LD `BlogPosting`. Pure rendering. No data collection.

**Phases:**

- **Phase 0** — Privacy policy contract (slopit-platform; PR #52). Binding contract for Phases 3a/3b/3c.
- **Phase 1** — _this spec._ `<head>` meta + JSON-LD.
- **Phase 2** — Per-post `.md`, per-blog `llms.txt`, `feed.xml`, `sitemap.xml`. Static file outputs from the renderer. No data collection.
- **Phase 3a** — Agent-traffic measurement (Layer 1) — Caddy access log capture for agent endpoints. Platform.
- **Phase 3b** — Anonymous human pageview counters (Layer 2). Platform.
- **Phase 3c** — Bring-your-own analytics escape hatch (Layer 3). Core schema + platform injection.

**Branch:** `plan/blog-post-seo` (from `dev @ 5d1d79b`).

---

## Context

Today, blog posts ship with a near-empty `<head>`:

```html
<title>{post} — {blog}</title>
<meta charset="utf-8" />
<meta name="viewport" content="..." />
<link rel="canonical" href="..." />
<!-- Conditional, only if author explicitly set them: -->
<meta name="description" content="...">
<meta property="og:title" content="...">
<meta property="og:description" content="...">
```

`renderSeoMeta()` in `src/rendering/generator.ts` returns an empty string when both `seoTitle` and `seoDescription` are absent — which is the common case for posts created by AI agents that don't think about SEO. Result: blank social previews on Slack/X/LinkedIn/Discord, no Google rich results, no structured data.

The `Post` schema already has every field we need (`tags`, `seoTitle`, `seoDescription`, `coverImage`, `author`, `publishedAt`, `updatedAt`). The bug is that the renderer doesn't use them.

This spec closes that gap with a single rendering-only PR (no schema migrations, no API changes). Backwards-compatible: every existing post re-renders correctly on the next publish without any author intervention.

---

## Goals

1. **Every published post has complete OG, Twitter Card, and JSON-LD `BlogPosting` metadata.** Even posts with empty `seoTitle`/`seoDescription`/`coverImage`.
2. **Fallbacks are deterministic and automatic.** No author input required. Empty SEO fields fall back to post content via documented rules.
3. **Zero new runtime deps.** Hand-rolled. Boring beats novel (CLAUDE.md).
4. **Self-hosted parity.** Same HTML for slopit.io and self-hosters. Works with any `baseUrl`.

## Non-goals (later phases)

- **Phase 2:** RSS feed (`/feed.xml`), sitemap (`/sitemap.xml`), per-blog `llms.txt`, per-post `<slug>.md` source endpoint. Phase 1 emits the `<link rel="alternate">` placeholders pointing at these (forward-compat); Phase 2 ships the actual files.
- **Out of scope entirely (later, if at all):** Per-blog `robots.txt`. Auto-generated cover image cards. Twitter handle / `twitter:site`. Schema.org organization profile. Per-blog favicons.

---

## Design decisions (resolved)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Always emit `og:*`, `twitter:*`, and JSON-LD. Never conditionally on whether author set SEO fields. | Today's "if user set it" gate produces blank previews for the dominant case (agents not setting SEO). The whole point of fallbacks is to cover that case. |
| 2 | `seoTitle` falls back to `post.title`. `seoDescription` falls back to **`post.excerpt`** if set, then to a body-derived excerpt. | Author intent wins when present. The schema already has `excerpt: z.string().max(300).optional()` for human-curated short summaries — use it before falling back to algorithmic extraction. |
| 3 | Algorithmic body excerpt = `extractDescription(body)` — markdown stripped to plain text, whitespace collapsed, truncated to 160 chars on a word boundary, append `…` if truncated. Always returns a non-empty string for any non-empty body. | 160 chars matches Google's display limit for meta descriptions. Word-boundary truncation avoids ugly mid-word cuts. |
| 4 | Markdown stripping for the excerpt is a focused subset: drop ATX/Setext headings, fenced/inline code, link/image syntax (keep the visible text), bold/italic markers, blockquote markers, list markers. NO HTML parsing — `renderMarkdown` already strips raw HTML at publish (decision #13 of `2026-04-22-create-post-design.md`), so excerpt input is markdown-only. | YAGNI. We don't need a full CommonMark stripper; we need "produces a clean sentence." |
| 5 | `og:image` is `post.coverImage` if set; omitted otherwise. No fallback image in v1. | YAGNI. A "default OG image" implies generating per-post cards (Tier 2+). Omitting is correct — Slack/X/etc. handle missing images gracefully. |
| 6 | `twitter:card` is `"summary_large_image"` when `coverImage` is set, else `"summary"`. | Standard pattern. `summary_large_image` requires an image; using it without one shows nothing on X. |
| 7 | `og:type` is always `"article"`. `og:site_name` is `blog.name ?? blog.id`. `og:url` equals `canonicalUrl` (already computed for `<link rel=canonical>`). | One source of truth for the post's URL. |
| 8 | Article-namespace tags: `article:published_time`, `article:author` (if `post.author` set), `article:tag` (one per `post.tags[]`). `article:modified_time` only emitted when `updatedAt !== publishedAt`. | Indexers (LinkedIn especially) read these. Suppressing identical `modified_time` keeps the head terse. |
| 9 | JSON-LD `BlogPosting` ships in a `<script type="application/ld+json">` block in `<head>`. Required keys: `@context`, `@type`, `headline`, `datePublished`, `mainEntityOfPage`. Optional: `dateModified`, `author`, `image`, `description`, `keywords`. | Google's documented requirement set for `BlogPosting` rich results. Optional keys emitted only when source data is present. |
| 10 | JSON-LD content is escaped against `</script>` injection by replacing `<` with `<` in the JSON output (NOT by HTML-escaping). HTML-escaping inside `<script>` would corrupt the JSON. | Standard `<script>`-block hardening. `escapeHtml` is the wrong tool here — different context. |
| 11 | All `<meta content="...">` user-derived values pass through `escapeHtml`. | Same convention as the rest of the renderer (decision #9 of `2026-04-22-create-post-design.md`). |
| 12 | `renderSeoMeta` is replaced (signature change) by a richer `buildSeoMeta({ post, blog, canonicalUrl })`. The new function lives in a new module `src/rendering/seo.ts`, not in `generator.ts`. `generator.ts` calls into it. | Generator is already 200+ lines and growing. SEO is its own concern; lives in its own file. Files that change together live together — SEO meta + JSON-LD + description fallback are one unit. |
| 13 | All output is concatenated with `\n` between tags for HTML readability. The rendered output is static; size cost (~200 bytes per post) is negligible against the gzip baseline. | Debuggable view-source matters. Self-hosters and curious readers will look. |
| 13a | Phase 1 emits `<link rel="alternate" type="text/markdown" href="<slug>.md">` and `<link rel="alternate" type="application/rss+xml" title="<blog name>" href="/feed.xml">` in the post `<head>`, even though the targets don't exist until Phase 2 lands. The cost is ~140 bytes per post; Phase 2 lights them up automatically without re-rendering Phase 1's posts. | Forward-compat: when Phase 2 ships, every existing post gets functional alternate links on the next publish. Saves a re-render pass. Cheap to add now. |
| 13b | **`canonicalUrl` is computed once in `generator.ts:renderPost` and lifted into a named local const.** Currently inlined at `generator.ts:187` (`config.baseUrl + '/' + post.slug + '/'`). Phase 1 introduces `const canonicalUrl = ...` so the same value passes to the template var, `buildSeoMeta`, and `buildJsonLd` without recomputation. | The reviewer caught the inlining. Three callers using a single const beats three call sites recomputing the same string. Mechanical refactor. |
| 13c | **`baseUrl` is normalized — trailing slash stripped — before concatenation with `'/' + slug + '/'`.** Adds `normalizeBaseUrl(s: string): string` to `src/rendering/seo.ts` (sibling of `extractDescription`). Tests assert `normalizeBaseUrl('https://x.com')`, `normalizeBaseUrl('https://x.com/')`, and `normalizeBaseUrl('https://x.com/path/')` produce identical canonical URLs once `'/'+slug+'/'` is appended. | Platform passes named-blog base URLs with a trailing slash (`https://${name}.slopit.io/`) but the existing inline concatenation (`config.baseUrl + '/' + post.slug + '/'`) appends another `/` — producing `https://${name}.slopit.io//slug/`. Currently broken; the reviewer caught it. Fixing in Phase 1 because every URL-bearing tag (canonical, og:url, JSON-LD mainEntityOfPage) depends on it. |
| 14 | Pro/free tiers receive identical SEO output. The "Powered by SlopIt" footer link is the only Pro-vs-free distinction in core. | SEO is not a paywallable feature; making it one would harm free-tier discoverability and bring no upsell value. |
| 15 | Drafts (`status: 'draft'`) are not rendered to disk today (`generator.ts` only writes for `status: 'published'`). This spec doesn't change that. SEO concerns are by definition published-only. | No-op. |
| 16 | No new dependencies. JSON-LD is hand-built via a typed `Record<string, unknown>` and `JSON.stringify` with the script-tag-safe replacement. | Boring tech. CLAUDE.md "No abstract class with one implementation." |

---

## Files

| File | New/Modified | Responsibility |
|---|---|---|
| `src/rendering/seo.ts` | NEW | Pure helpers: `buildSeoMeta(input)`, `buildJsonLd(input)`, `extractDescription(body, max?)`, `escapeJsonForScript(json)`. No I/O. No `node:fs`. |
| `src/rendering/generator.ts` | MODIFY | Remove `renderSeoMeta`. Call `buildSeoMeta` and `buildJsonLd` from `renderPost`. Pass `seoMeta` and `jsonLd` to template. Re-export `escapeHtml` is unchanged. |
| `src/themes/minimal/post.html` | MODIFY | Add `{{{jsonLd}}}` placeholder in `<head>` after `{{{seoMeta}}}`. |
| `tests/seo.test.ts` | NEW | All SEO meta + JSON-LD + extractDescription tests. |
| `tests/rendering.test.ts` | MODIFY | Replace existing `renderSeoMeta` tests (5 cases) with two integration tests asserting the new pipeline produces the expected `<head>` output. |
| `docs/solutions/seo-meta-fallbacks.md` | NEW | Capture: the description-fallback algorithm; the `</script>` escape rule; why we replaced rather than augmented `renderSeoMeta`. |

No schema, migration, or public API changes. The `Post` and `Blog` shapes are unchanged.

---

## Public surface

```ts
// src/rendering/seo.ts (new)

export interface SeoInput {
  post: Post
  blog: Blog
  canonicalUrl: string
}

/**
 * Returns a string of `<meta>` tags joined by `\n`. Always non-empty
 * (we always emit at least description, og:title, og:type, og:url,
 * og:site_name, twitter:card).
 */
export function buildSeoMeta(input: SeoInput): string

/**
 * Returns a `<script type="application/ld+json">` block containing the
 * BlogPosting JSON-LD. Always non-empty.
 */
export function buildJsonLd(input: SeoInput): string

/**
 * Resolve a post's description via the documented chain:
 *   post.seoDescription → post.excerpt → extractDescription(post.body)
 * Returns '' if all three are empty. Used by both buildSeoMeta and
 * buildJsonLd so the chain is implemented once. Phase 2 (.md, RSS,
 * llms.txt) re-uses the same helper.
 */
export function resolveDescription(post: Post): string

/**
 * Markdown-stripped, whitespace-collapsed, word-boundary-truncated
 * excerpt. Returns '' for empty input. Default max=160.
 */
export function extractDescription(body: string, max?: number): string

/**
 * JSON.stringify with `<` → `<` so the result is safe to embed
 * inside a `<script>` block.
 */
export function escapeJsonForScript(value: unknown): string
```

`buildSeoMeta` and `buildJsonLd` are pure and synchronous. They take Post + Blog + canonicalUrl by value. They don't touch the DB, don't read files, don't import from `generator.ts`. This makes them trivially testable.

---

## Output shape

For a fully-populated post:

```html
<!-- in <head>, after <link rel="canonical"> -->
<link rel="alternate" type="text/markdown" href="my-post.md">
<link rel="alternate" type="application/rss+xml" title="My Blog" href="/feed.xml">
<meta name="description" content="...">
<meta name="author" content="Jane Doe">
<meta property="og:title" content="My Post">
<meta property="og:description" content="...">
<meta property="og:type" content="article">
<meta property="og:url" content="https://blog.slopit.io/my-post/">
<meta property="og:site_name" content="My Blog">
<meta property="og:image" content="https://blog.slopit.io/_media/abc.png">
<meta property="og:image:alt" content="My Post">
<meta property="article:published_time" content="2026-05-01T12:34:56Z">
<meta property="article:modified_time" content="2026-05-02T08:00:00Z">
<meta property="article:author" content="Jane Doe">
<meta property="article:tag" content="ai">
<meta property="article:tag" content="agents">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="My Post">
<meta name="twitter:description" content="...">
<meta name="twitter:image" content="https://blog.slopit.io/_media/abc.png">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BlogPosting","headline":"My Post","datePublished":"2026-05-01T12:34:56Z","dateModified":"2026-05-02T08:00:00Z","mainEntityOfPage":"https://blog.slopit.io/my-post/","author":{"@type":"Person","name":"Jane Doe"},"image":"https://blog.slopit.io/_media/abc.png","description":"...","keywords":"ai,agents"}
</script>
```

For a minimal post (no seoTitle, seoDescription, excerpt, coverImage, author, tags; updatedAt == publishedAt):

```html
<link rel="alternate" type="text/markdown" href="post-title.md">
<link rel="alternate" type="application/rss+xml" title="My Blog" href="/feed.xml">
<meta name="description" content="The body excerpt, derived automatically.">
<meta property="og:title" content="Post Title">
<meta property="og:description" content="The body excerpt, derived automatically.">
<meta property="og:type" content="article">
<meta property="og:url" content="https://blog.slopit.io/post-title/">
<meta property="og:site_name" content="My Blog">
<meta property="article:published_time" content="2026-05-01T12:34:56Z">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Post Title">
<meta name="twitter:description" content="The body excerpt, derived automatically.">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BlogPosting","headline":"Post Title","datePublished":"2026-05-01T12:34:56Z","mainEntityOfPage":"https://blog.slopit.io/post-title/","description":"The body excerpt, derived automatically."}
</script>
```

> **Note on alternate links:** until Phase 2 ships, `<slug>.md` and `/feed.xml` will 404. The link tags are inert in that interim; nothing in the rendered page depends on them resolving. Phase 2 lights them up.

---

## Description fallback algorithm

```
extractDescription(body, max=160):
  1. Remove fenced code blocks (```…``` and ~~~…~~~) entirely.
  2. Remove ATX headings (# … through ###### …) — keep the heading text.
  3. Remove Setext underlines (=== / --- on their own line).
  4. Remove blockquote markers (leading `>`).
  5. Remove list markers (leading `-`, `*`, `+`, `1.`–`9.`).
  6. Replace image markdown ![alt](url) with the alt text.
  7. Replace link markdown [text](url) with the text.
  8. Remove emphasis markers: `**`, `__`, `*`, `_`, ``` ` ```.
  9. Collapse all whitespace runs to a single space.
  10. Trim.
  11. If length ≤ max, return as-is.
  12. Else: truncate to max - 1 chars, walk back to last space, append "…".
```

Each step is a single regex. Total ~25 lines.

---

## Edge cases (with explicit handling)

| Case | Behavior |
|------|----------|
| Empty body | `extractDescription('') === ''`. Description meta omitted. og:description and twitter:description omitted. JSON-LD `description` key omitted. |
| `excerpt` set, `seoDescription` empty | `resolveDescription` returns `excerpt` verbatim. Phase 2's `.md`/RSS/`llms.txt` re-uses the same helper; same value everywhere. |
| `seoDescription` set, `excerpt` set | `seoDescription` wins. Author intent over auto-curated. |
| `seoDescription` empty, `excerpt` empty, `body` non-empty | Falls through to `extractDescription(body)`. |
| `baseUrl` ends in trailing slash | `normalizeBaseUrl` strips it; concatenation produces single-slash canonical URLs. |
| `baseUrl` has a path component (`https://x.com/blog/`) | `normalizeBaseUrl` strips only the final slash, preserving the path. Resulting canonical: `https://x.com/blog/<slug>/`. |
| Body that's only code blocks / headings markers | After stripping, may produce empty string. Same handling as empty body. |
| Author set, no tags | Emits `meta name="author"`, `article:author`, JSON-LD `author`. No `article:tag` lines. JSON-LD `keywords` omitted. |
| Tags set, no author | Emits `article:tag` per tag. JSON-LD `keywords` is comma-joined. No `author` keys. |
| `coverImage` is a relative path | Schema field is `z.url()`, so it's always absolute — no normalization needed. |
| `coverImage` containing `"` or `<` | Passes through `escapeHtml` for `<meta>` attributes. JSON-LD uses `escapeJsonForScript`. |
| Title or description containing `</script>` | `escapeJsonForScript` replaces `<` with `<`; the JSON-LD block stays valid. |
| `publishedAt === updatedAt` | `article:modified_time` and JSON-LD `dateModified` omitted. |
| `blog.name` null | og:site_name uses `blog.id`. Same convention as `<title>` already does. |
| Self-hosted with custom `baseUrl` | `canonicalUrl` is computed by `generator.ts` from `baseUrl`; we just pass it through. og:url, JSON-LD mainEntityOfPage match. |

---

## Testing strategy

**`tests/seo.test.ts` (new file):**

| Test | Asserts |
|------|---------|
| `extractDescription` strips markdown, collapses whitespace, truncates on word boundary, appends ellipsis | Description fallback correctness |
| `extractDescription` returns `''` for empty / whitespace-only / pure-code-block input | Empty handling |
| `escapeJsonForScript` replaces `<` with `<` and produces parseable JSON for round trip | Script-tag injection defense |
| `buildSeoMeta` with all fields populated → output contains every expected `<meta>` | Happy path |
| `buildSeoMeta` with no SEO fields → fallbacks produce description, og:title, twitter:title, etc. | Fallback path |
| `buildSeoMeta` with `coverImage` → twitter:card is `summary_large_image`, og:image present | Card type selection |
| `buildSeoMeta` without `coverImage` → twitter:card is `summary`, og:image absent | Card type selection |
| `buildSeoMeta` with `publishedAt === updatedAt` → no `article:modified_time` | Modified-time suppression |
| `buildSeoMeta` with HTML-y title (`<script>x</script>`) → output contains `&lt;script&gt;` not raw `<` | XSS in attribute |
| `buildJsonLd` minimal post → JSON-LD contains exactly the required keys | Required-only |
| `buildJsonLd` full post → JSON-LD contains all optional keys | Full payload |
| `buildJsonLd` post with `</script>` in title → output contains `</script>` and JSON parses | Injection defense |
| `buildJsonLd` output is valid JSON when extracted from the `<script>` wrapper | Round-trip JSON validity |

**`tests/rendering.test.ts` (modify):**

Replace the 5 existing `renderSeoMeta` tests with 2 integration tests that render a full post and assert the rendered `<head>` contains:
- `<link rel="canonical">`
- `<meta property="og:title">` (always, even with empty SEO fields)
- `<script type="application/ld+json">` containing `"@type":"BlogPosting"`

Total new test cases: ~13. Total replaced: 5. Net coverage delta: heavily positive.

---

## Decision log — why these choices over the obvious alternatives

**Why not "just augment `renderSeoMeta` in place"?**
The function already had a tight signature (two strings) and its scope grows from "3 conditional tags" to "~18 tags + JSON-LD." That's a 6× behavior expansion, plus a new fallback layer, plus structured data. New file makes the testing surface clean and the diff readable. Generator.ts stays focused on file-system orchestration.

**Why not use a library like `meta-tags` or `schema-dts`?**
- `meta-tags`: 200+ lines for what we need to express in ~80. Adds a dep. No.
- `schema-dts`: TypeScript types for schema.org. Useful if we were building a schema-heavy product. We have one type (`BlogPosting`) and need 6 keys. YAGNI.
- Hand-written code reads better and we control the wire format.

**Why JSON-LD instead of microdata or RDFa?**
Google's documented preferred format. Doesn't pollute the rendered HTML body. Single `<script>` block is easier to test and version. Microdata would require rewiring the `<article>` template; not worth it.

**Why not auto-generate an OG card image?**
Tier 2. Requires either a runtime image generator (canvas/skia/satori — all heavy deps) or a static template at publish-time (still 200+ lines + image pipeline + storage). Worth doing, not worth doing now. Plain "no og:image" is correctly handled by every social platform.

**Why not extract `<title>` enhancements (e.g., template the title format) here?**
The existing `<title>{post} — {blog}</title>` is fine. Authors who want a different format can override seoTitle. Tweaking `<title>` is its own design decision (and breaks every existing post's title structure). Out of scope.

---

## Open questions

None. Every decision above is intended to be the final choice. If implementation surfaces a contradiction, update this doc and link the change in the PR.
