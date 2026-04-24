# createPost — Design Spec

**Status:** Design approved 2026-04-22 (through four rounds of review — three in brainstorming + one after plan review added Task 9.5 for XSS defense, trailing-slash canonical URLs, UTC-pinned dates, and `.trim()` on title/body). Spec now matches the revised plan.
**Scope:** `@slopit/core`, second feature pass. First "publish" primitive — the product.
**Branch:** `feat/create-post` (from `main @ 1d205a4`).

---

## Context

`createPost` is the publish primitive. An agent provides a title + markdown body and gets back a live URL — strategy.md's one-call-to-live-URL loop. It composes three concerns:

1. **Persistence.** Insert a row into `posts` with full schema (title, slug, body, excerpt, tags, status, seo, author, coverImage).
2. **Rendering.** For `status: 'published'`, markdown → HTML via `renderMarkdown` (which strips all raw HTML tokens as v1 XSS defense — see decision #13), wrapped in the `minimal` theme's `post.html`, written to disk. Blog index (`{outputDir}/{blogId}/index.html`) is re-rendered to include the new post. CSS is copied/refreshed.
3. **Return.** `{ post, postUrl? }` — `postUrl` computed from `renderer.baseUrl + '/' + post.slug + '/'` (trailing slash matches the directory-style layout on disk), only for published.

Core remains single-blog-scoped: `createPost` takes an already-resolved `blogId`. Multi-tenant routing + auth live in `slopit-platform`.

---

## Design decisions (resolved)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | End-to-end function — DB + render in one call. | "Publish a post" is inherently both. Splitting invites callers to forget the render step. ARCHITECTURE.md invariant: "Node only runs at write time." |
| 2 | Re-renders blog index on every publish. | `{blog}.slopit.io/` must show a list of posts from day one — not a 404. Blog without index isn't a blog. Cost: ~30 extra lines + one SELECT per publish. |
| 3 | Auto slug default, custom slug allowed, collisions throw `POST_SLUG_CONFLICT` with `details: { slug }`. | Strategy.md promises both modes. Fail-hard-fail-loud: silent `-2` suffixes hide state from agents. Returning the conflicting slug in `details` makes retry logic trivial. |
| 4 | File-based theme system; ship `minimal` only; narrow theme enum from `['minimal','classic','zine']` to `['minimal']` now. | Aspirational three-theme list was a design vocabulary, not a product commitment. Shipping one real theme beats three placeholders. Classic/zine re-expand later when we design what makes them distinct. |
| 5 | Sync end-to-end. `Renderer` interface is sync. | `better-sqlite3` and `renderMarkdown` are sync; `node:fs` has sync writers that work at our scale. Async adds microtask overhead for no benefit. |
| 6 | Weakened atomicity invariant: "`createPost` attempts compensation on render failure by DELETEing the inserted row; if that DELETE succeeds, no durable DB state change." If the compensation DELETE itself fails (extraordinarily rare — typically indicates DB corruption or I/O failure, a bigger problem than this one post), the inserted row persists and operator cleanup is needed. `createPost` always throws the original render error. Orphan files (post page without an index link, or a partially written pair where HTML succeeded but the subsequent render step failed) are acceptable; the expensive failure mode is committed rows that readers can discover via the blog index. | Temp-dir staging is overengineering at v1 scale. Being honest about double-failure is cheaper than pretending it can't happen. |
| 7 | `ensureCss` always overwrites. Not on the public `Renderer` interface. | Copy-if-missing makes package upgrades never refresh CSS. Idempotent overwrite is cheap and correct. Asset copy is a renderer implementation detail. |
| 8 | Renderer uses relative hrefs only (`../style.css`, `..`). `blog.name ?? blog.id` for display. | Templates must be routing-agnostic — same templates serve `{blog}.slopit.io/` and `slopit.io/b/:id/`. Unnamed blogs display their id rather than a generic "Untitled". |
| 9 | All `{{{...}}}` raw fragments are built by helpers that call `escapeHtml(...)` on every user-derived field. | The raw escape hatch trusts the helper's output. Escaping at the helper boundary keeps the guarantee intact. |
| 10 | Narrow-match at INSERT as well as preflight. Both paths throw the same `POST_SLUG_CONFLICT`. | Preflight is fast-path UX; INSERT-time match handles races. Both converge on one contract. |
| 11 | Use the existing `PostInputSchema`, enhance it — don't add a near-duplicate `CreatePostInputSchema`. | Scaffold already has it; deduplicate. |
| 12 | Promote `generateShortId` to `src/ids.ts`. | Second real call site. Shared helper, one module. |
| 13 | `renderMarkdown` strips all raw HTML tokens (block + inline) via a `marked` renderer override. No opt-in in v1. | Threat model: readers of a blog are untrusted recipients. Authored HTML — even from a trusted agent — becomes stored XSS the moment any reader lands on the post. Stripping everything is the safe default. Legitimate markdown (headings, emphasis, links, lists, code, blockquotes, images) passes through because `marked` treats those as non-`html` tokens. Zero new deps (uses `marked`'s built-in `renderer.html` override). v2 can add proper DOM-level sanitization with an opt-in for power users who want embeds. |
| 14 | `title` and `body` are `.trim().min(1)`. | Whitespace-only strings pass `.min(1)` by length but aren't meaningful input. Trim at the schema boundary so `'   '` fails validation and stored values have no leading/trailing whitespace. |
| 15 | `formatDate` is pinned to `timeZone: 'UTC'`. | Static HTML output must be deterministic regardless of where it was rendered. A body written on Jan 1 UTC must read "January 1, 2025" on every deploy, not "December 31, 2024" on LAX. |
| 16 | Canonical URL and `postUrl` include a trailing slash. | Files land in directory-style paths (`{slug}/index.html`) and index links use `href="slug/"`. Canonical + `postUrl` use the same form to avoid duplicate URLs for the same content. |

---

## Files

| File | New/Modified | Responsibility |
|---|---|---|
| `src/ids.ts` | NEW | Shared string-generation helpers: `generateShortId()` (promoted from `src/blogs.ts`) and `generateSlug(title)`. Neither has domain deps, so both can live in one tiny module and be imported by any layer. |
| `src/posts.ts` | NEW | `createPost`, `isPostSlugConflict` predicate, `autoExcerpt`, `listPublishedPostsForBlog`. All module-level exports; the latter four are marked `@internal` in JSDoc and NOT re-exported through `src/index.ts`. Tests and the renderer import them directly from `'./posts.js'`. |
| `src/rendering/templates.ts` | NEW | `loadTheme`, `render(template, vars)` with `{{var}}` + `{{{var}}}`, `escapeHtml`. |
| `src/rendering/generator.ts` | MODIFY | Sync `Renderer` interface; implement `renderPost` + `renderBlog` via `createRenderer` factory. Module-level `@internal` exports: `ensureCss`, `renderPostList`, `renderTagList`, `renderPoweredBy`, `renderSeoMeta`, `formatDate`. `createRenderer` is in the public barrel; the helpers are not, but are importable from `'./rendering/generator.js'` for tests. |
| `src/themes/minimal/post.html` | NEW | Post template (~20 lines). |
| `src/themes/minimal/index.html` | NEW | Blog-index template (~15 lines). |
| `src/themes/minimal/style.css` | NEW | ~70 lines, palette + typography from `DESIGN.md`. |
| `src/schema/index.ts` | MODIFY | Enhance `PostInputSchema` (slug regex/min/max, title constraints, superRefine for auto-slug non-empty). Narrow `theme` enum in `BlogSchema` + `CreateBlogInputSchema` to `['minimal']`. Export `PostInput = z.input<typeof PostInputSchema>`. |
| `src/blogs.ts` | MODIFY | Import `generateShortId` from `./ids.js`; remove the local helper. Update existing `createBlog` test expectations for theme enum change. |
| `src/errors.ts` | MODIFY | Add optional `details: Record<string, unknown>` (defaults `{}`) to `SlopItError` constructor. Add `'POST_SLUG_CONFLICT'` to `SlopItErrorCode` union. |
| `src/index.ts` | MODIFY | Export `createPost`, `PostInput`, updated types. |
| `package.json` | MODIFY | Add `&& cp -R src/themes dist/themes` to build script. |
| `src/themes/README.md` | MODIFY | Update "three themes" references to reflect minimal-only v1. |
| `ARCHITECTURE.md` | MODIFY | Two updates: (a) line 34 — "Theme system + 3 built-in themes" → minimal-only v1. (b) Boundary rule #5 ("No `slopit.io` strings in core") — add a narrow, documented exception: the "Powered by SlopIt" footer link. This is the one intentional branding hook in core's themes; platform strips/replaces it per plan (Pro tier). Everything else the rule covers (Stripe keys, Cloudflare tokens, marketing copy, platform env vars) stays forbidden. |
| `DESIGN.md` | MODIFY | Update line 3 ("three themes it ships") to reflect minimal-only v1. |
| `tests/posts.test.ts` | NEW | End-to-end createPost tests + `isPostSlugConflict` unit tests. |
| `tests/posts.id-collision.test.ts` | NEW | Safety-net: `posts.id` PK collision bubbles raw, not as `POST_SLUG_CONFLICT`. |
| `tests/rendering.test.ts` | NEW | Template loader + render + per-helper escaping tests. |

---

## Signature

```ts
export function createPost(
  store: Store,
  renderer: Renderer,
  blogId: string,
  input: PostInput,
): { post: Post; postUrl?: string }
```

`postUrl` is set only when the **parsed** status is `'published'` (i.e., `parsed.status === 'published'` after `PostInputSchema.parse(input)` runs — which also applies the `'published'` default when the caller omits `status`). Drafts return `{ post }`.

---

## Input schema (enhanced in `src/schema/index.ts`)

```ts
export const PostInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    slug: z
      .string()
      .min(2)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
      .optional(),
    body: z.string().trim().min(1),
    excerpt: z.string().max(300).optional(),
    tags: z.array(z.string()).default([]),
    status: z.enum(['draft', 'published']).default('published'),
    seoTitle: z.string().max(200).optional(),
    seoDescription: z.string().max(300).optional(),
    author: z.string().max(100).optional(),
    coverImage: z.url().optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.slug && generateSlug(input.title) === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['title'],
        message: 'Title must contain slug-compatible characters, or provide an explicit slug',
      })
    }
  })

export type PostInput = z.input<typeof PostInputSchema>
```

`generateSlug` is imported from `src/ids.ts` — no circular-import risk since `ids.ts` has zero domain dependencies (it's just string → string helpers).

---

## Renderer interface

```ts
export interface Renderer {
  readonly baseUrl: string
  renderPost(blogId: string, post: Post): void
  renderBlog(blogId: string): void
}
```

Both methods sync. `renderPost` writes `{outputDir}/{blogId}/{slug}/index.html` + ensures CSS. `renderBlog` re-renders `{outputDir}/{blogId}/index.html` + ensures CSS. Neither returns the URL — that's `createPost`'s responsibility via `renderer.baseUrl + '/' + post.slug + '/'` (trailing slash matches the directory layout).

---

## Flow (published path)

1. `PostInputSchema.parse(input)` — Zod throws on invalid input (including superRefine failures).
2. `SELECT 1 FROM blogs WHERE id = ?` — throw `SlopItError('BLOG_NOT_FOUND', ..., { blogId })` if missing.
3. Resolve slug: `parsed.slug ?? generateSlug(parsed.title)`.
4. Compute derived fields: `id = generateShortId()`, `excerpt = parsed.excerpt ?? autoExcerpt(parsed.body)`, `publishedAt = parsed.status === 'published' ? new Date().toISOString() : null`. (All references are to the Zod-parsed form, never the raw `input`.)
5. **DB transaction** `db.transaction(() => { ... })`:
   - Preflight `SELECT 1 FROM posts WHERE blog_id = ? AND slug = ?` — throw `SlopItError('POST_SLUG_CONFLICT', ..., { slug })` if found.
   - `INSERT INTO posts (id, blog_id, slug, title, body, excerpt, tags, status, published_at, seo_title, seo_description, author, cover_image)`. On `isPostSlugConflict(e)`, throw `SlopItError('POST_SLUG_CONFLICT', ..., { slug })`. Other errors bubble raw.
6. If `parsed.status === 'published'`:
   ```ts
   try {
     renderer.renderPost(blogId, post)   // ensureCss runs FIRST inside this call
     renderer.renderBlog(blogId)         // ensureCss runs FIRST inside this call too
   } catch (renderErr) {
     try { db.prepare('DELETE FROM posts WHERE id = ?').run(id) } catch { /* best-effort */ }
     throw renderErr
   }
   ```
7. Return `{ post, postUrl: renderer.baseUrl + '/' + post.slug + '/' }` (trailing slash — matches directory layout).

**Draft path:** steps 1–5 only. Return `{ post }` (no `postUrl`). `published_at` is null.

### Render sequencing within `renderPost` and `renderBlog`

Both methods call `ensureCss` **before** writing any HTML. This ordering matters for the failure story:

- If CSS copy fails → no HTML is written in this method. Caller catches, compensates via DELETE, clean rollback.
- If CSS succeeds but HTML write fails → at most the previous method's HTML file exists as an orphan (not linked from an index if the order is post-then-blog; not discoverable via a blog-root visit if renderBlog failed before writing). Caller catches, compensates, throws.
- If both methods fully succeed → commit is already durable; return with `postUrl`.

This keeps the weakened invariant honest: **we do not expose a post via the blog index while the API call is still in the process of failing**. Orphan post pages at their direct URL (a retry-accessible path, not discoverable from the index) remain acceptable.

---

## Slug generation (`generateSlug` in `src/ids.ts`)

```ts
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')                         // strip diacritics
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')               // non-[a-z0-9] → hyphen
    .replace(/^-+|-+$/g, '')                   // trim leading/trailing
    .slice(0, 100)
    .replace(/-+$/, '')                        // re-trim after slice
}
```

Examples:
- `"Why AI Slop is the Future!"` → `"why-ai-slop-is-the-future"`.
- `"AI & the Creator Economy"` → `"ai-the-creator-economy"`.
- `"日本語のタイトル"` → `""` (all non-ASCII after NFKD; caller must provide slug).
- `"!!!"` → `""` (superRefine rejects at Zod boundary).
- `"a"` → `"a"` — but `.min(2)` on custom slugs catches this if explicit; for auto, the only 1-char possibility is a single-alphanumeric-char title, in which case the post is probably junk. We accept 1-char auto-slugs since the regex on `slug` isn't applied to auto-generated values — only to user-provided ones. Flag: this is an intentional asymmetry.

---

## Excerpt auto-generation

```ts
function autoExcerpt(markdown: string): string {
  // Strip markdown syntax in a dumb-but-good-enough way:
  // remove inline code backticks, ![alt](url), [text](url) → text, #, *, _,
  // blockquote >, list dashes. Collapse whitespace.
  // Take first 160 chars; if truncated, append '…'.
}
```

Not perfect — a proper markdown-AST walk would be better, but YAGNI at v1. Well-formed posts produce reasonable excerpts; edge cases (embedded HTML, code blocks) produce noisy excerpts, which is acceptable.

---

## Template system (`src/rendering/templates.ts`)

```ts
export interface ThemeAssets {
  readonly post: string
  readonly index: string
  readonly cssPath: string
}

export function loadTheme(name: 'minimal'): ThemeAssets {
  const here = dirname(fileURLToPath(import.meta.url))
  const themeDir = join(here, '..', 'themes', name)
  return {
    post: readFileSync(join(themeDir, 'post.html'), 'utf8'),
    index: readFileSync(join(themeDir, 'index.html'), 'utf8'),
    cssPath: join(themeDir, 'style.css'),
  }
}

export function render(template: string, vars: Record<string, string>): string {
  // {{{var}}} (triple brace) first — raw
  // {{var}}   (double brace) — escaped
  // Throws on undefined var: "Missing template variable: <name>".
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
```

---

## Theme content

### `src/themes/minimal/post.html`

Variables: `{{blogName}}`, `{{postTitle}}`, `{{postPublishedAt}}` (ISO), `{{postPublishedAtDisplay}}` (human-readable), `{{themeCssHref}}`, `{{blogHomeHref}}`, `{{canonicalUrl}}`, `{{{seoMeta}}}`, `{{{postBody}}}`, `{{{tagList}}}`, `{{{poweredBy}}}`.

Final layout (DOCTYPE through closing `</html>`):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{postTitle}} — {{blogName}}</title>
  {{{seoMeta}}}
  <link rel="stylesheet" href="{{themeCssHref}}">
  <link rel="canonical" href="{{canonicalUrl}}">
</head>
<body>
  <nav><a href="{{blogHomeHref}}">{{blogName}}</a></nav>
  <article>
    <header>
      <h1>{{postTitle}}</h1>
      <time datetime="{{postPublishedAt}}">{{postPublishedAtDisplay}}</time>
    </header>
    {{{postBody}}}
    {{{tagList}}}
  </article>
  <footer>{{{poweredBy}}}</footer>
</body>
</html>
```

### `src/themes/minimal/index.html`

Variables: `{{blogName}}`, `{{themeCssHref}}`, `{{{postList}}}`, `{{{poweredBy}}}`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{blogName}}</title>
  <link rel="stylesheet" href="{{themeCssHref}}">
</head>
<body>
  <header><h1>{{blogName}}</h1></header>
  <main>{{{postList}}}</main>
  <footer>{{{poweredBy}}}</footer>
</body>
</html>
```

### `src/themes/minimal/style.css`

~70 lines; palette and typography straight from `DESIGN.md`. Key tokens: `--background #FAFAF9`, `--surface #F0EFEB`, `--border #E5E5E2`, `--text #1A1A1A`, `--text-muted #6B6B6B`, `--accent #FF4F00`, `--accent-dark #D34000`. Satoshi + JetBrains Mono via FontShare/Google Fonts `@import`. Reading column `max-width: 720px`.

---

## Fragment helpers (in `src/rendering/generator.ts`)

All module-level `@internal` exports. Produce HTML strings injected via `{{{...}}}`. All escape user-derived fields. Tests import them directly from `'../src/rendering/generator.js'`.

```ts
/** @internal */
export function renderPostList(posts: Post[], postBaseHref: string): string {
  // Each post: <article class="post-item">
  //   <h2><a href="${escapeHtml(p.slug)}/">${escapeHtml(p.title)}</a></h2>
  //   <time datetime="${escapeHtml(p.publishedAt)}">${escapeHtml(formatDate(p.publishedAt))}</time>
  //   ${p.excerpt ? `<p>${escapeHtml(p.excerpt)}</p>` : ''}
  // </article>
}

/** @internal */
export function renderTagList(tags: string[]): string {
  if (tags.length === 0) return ''
  // <div class="tags">${tags.map(t => `<span>#${escapeHtml(t)}</span>`).join('')}</div>
}

/** @internal */
export function renderPoweredBy(): string {
  // <a href="https://slopit.io">Powered by SlopIt</a>
  // Platform layer strips/replaces based on plan; core always emits it.
  // Documented exception to ARCHITECTURE.md rule #5 (see collateral doc updates).
}

/** @internal */
export function renderSeoMeta(seoTitle: string | undefined, seoDescription: string | undefined): string {
  // <meta name="description" content="${escapeHtml(seoDescription)}">
  // (Optionally og:title, og:description; keep minimal for v1.)
}
```

---

## Renderer implementation (`createRenderer` updated)

```ts
export function createRenderer(config: RendererConfig): Renderer {
  const theme = loadTheme('minimal')

  const ensureCss = (blogId: string) => {
    const dest = join(config.outputDir, blogId, 'style.css')
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(theme.cssPath, dest)   // always overwrite
  }

  const displayName = (blog: Blog) => blog.name ?? blog.id

  return {
    baseUrl: config.baseUrl,

    renderPost(blogId, post) {
      const blog = getBlogInternal(config.store, blogId)    // internal helper in blogs.ts
      ensureCss(blogId)                                     // BEFORE HTML write — see render sequencing
      const postDir = join(config.outputDir, blogId, post.slug)
      mkdirSync(postDir, { recursive: true })
      const html = render(theme.post, {
        blogName: displayName(blog),
        postTitle: post.title,
        postPublishedAt: post.publishedAt ?? '',
        postPublishedAtDisplay: formatDate(post.publishedAt),
        themeCssHref: '../style.css',
        blogHomeHref: '..',
        canonicalUrl: config.baseUrl + '/' + post.slug,
        seoMeta: renderSeoMeta(post.seoTitle, post.seoDescription),
        postBody: renderMarkdown(post.body),    // already HTML, raw
        tagList: renderTagList(post.tags),
        poweredBy: renderPoweredBy(),
      })
      writeFileSync(join(postDir, 'index.html'), html)
    },

    renderBlog(blogId) {
      const blog = getBlogInternal(config.store, blogId)
      ensureCss(blogId)                                     // BEFORE HTML write
      const posts = listPublishedPostsForBlog(config.store, blogId)
      const blogDir = join(config.outputDir, blogId)
      mkdirSync(blogDir, { recursive: true })
      const html = render(theme.index, {
        blogName: displayName(blog),
        themeCssHref: 'style.css',
        postList: renderPostList(posts, ''),
        poweredBy: renderPoweredBy(),
      })
      writeFileSync(join(blogDir, 'index.html'), html)
    },
  }
}
```

`getBlogInternal` and `listPublishedPostsForBlog` are module-level `@internal` exports in `src/blogs.ts` and `src/posts.ts` respectively. They are NOT in the public barrel (`src/index.ts`); the renderer imports them directly from `'../blogs.js'` and `'../posts.js'`, and tests do the same. The public `getBlog` / `listPosts` API lands in the REST+MCP feature.

---

## Error handling

### Updated `src/errors.ts`

```ts
export type SlopItErrorCode =
  | 'BLOG_NAME_CONFLICT'
  | 'BLOG_NOT_FOUND'
  | 'POST_SLUG_CONFLICT'

export class SlopItError extends Error {
  readonly code: SlopItErrorCode
  readonly details: Record<string, unknown>
  constructor(
    code: SlopItErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'SlopItError'
    this.code = code
    this.details = details
  }
}
```

Backward-compatible: existing two-arg throws still work.

### Error matrix for `createPost`

| Condition | Error | `details` |
|---|---|---|
| Zod validation fails (shape, regex, superRefine) | `ZodError` (not re-wrapped) | — |
| Blog does not exist | `SlopItError('BLOG_NOT_FOUND', ...)` | `{ blogId }` |
| Slug collision (preflight or INSERT narrow-match) | `SlopItError('POST_SLUG_CONFLICT', ...)` | `{ slug }` |
| File write fails (after DB commit) | Original OS error; compensates with `DELETE FROM posts WHERE id = ?` | — |
| Any other DB error | Raw bubble | — |

### Narrow-match predicate (`src/posts.ts`, `@internal` export)

```ts
/** @internal — exported for unit testing only. Not public API. */
export function isPostSlugConflict(err: unknown): boolean {
  return (
    err instanceof Error
    && (err as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE'
    && err.message.includes('posts.blog_id, posts.slug')
  )
}
```

Exact column-list match: won't false-match `posts.id` PK collisions or unrelated UNIQUE violations.

---

## Public surface added

```ts
// src/index.ts
export { createPost } from './posts.js'
export type { PostInput } from './schema/index.js'          // already re-exported via export *
// SlopItError, SlopItErrorCode types unchanged in public surface
```

`isPostSlugConflict`, `autoExcerpt`, `listPublishedPostsForBlog`, `getBlogInternal`, and all fragment helpers in `src/rendering/generator.ts` are module-level exports marked `@internal`. They are NOT re-exported through the public barrel (`src/index.ts`). Tests import them directly from source files; within the package, `src/rendering/generator.ts` imports `listPublishedPostsForBlog` from `'../posts.js'` and `getBlogInternal` from `'../blogs.js'`. `generateShortId` and `generateSlug` live in `src/ids.ts` with the same visibility: exported but not re-exported through the barrel.

---

## Testing

### `tests/posts.test.ts` (new)

**Happy paths:**
1. Publish post → DB row + file at `{outputDir}/{blogId}/{slug}/index.html` + blog index re-rendered with new post at top + `style.css` present + `postUrl` returned = `baseUrl + '/' + slug`.
2. Draft post → DB row only; no files; return shape `{ post }` (no `postUrl`); `published_at` is null.
3. Custom slug honored verbatim.
4. Auto slug from title: `"Why AI Slop is the Future!"` → `"why-ai-slop-is-the-future"`.
5. Tags stored as JSON array, retrievable as `string[]`.
6. Auto excerpt: ~160 chars stripped of markdown, appended `…` if truncated.
7. Author / coverImage / seoTitle / seoDescription pass through to DB.

**Conflict/error paths:**
8. Same blog + same slug → `SlopItError('POST_SLUG_CONFLICT')` with `details.slug === <slug>` (via preflight).
9. **Unit tests for `isPostSlugConflict`**: returns `true` for synthetic error with `code='SQLITE_CONSTRAINT_UNIQUE'` + message `'UNIQUE constraint failed: posts.blog_id, posts.slug'`; returns `false` for `posts.id`, `blogs.name`, `blogs.id`, non-UNIQUE, plain `Error`, `null`, `undefined`, non-Error, `{code:..., message:...}` plain object. Parallel to Task 2's `isBlogNameConflict` unit tests.
10. `createPost` on unknown `blogId` → `SlopItError('BLOG_NOT_FOUND')` with `details.blogId`.
11. Zod rejections: title >200 chars; slug regex violation; `.min(2)` slug; empty body; invalid status; title with no slug-compatible chars AND no explicit slug (superRefine rejects).
12. Non-Latin title WITH explicit slug → accepted; DB row stores original title.

**Compensation:**
13. Mock `writeFileSync` to throw on post path → assert `posts` table has no row (DELETE compensation ran) and original render error bubbles.

### `tests/posts.id-collision.test.ts` (new safety-net)

Parallel to Task 4's `blogs.id-collision.test.ts`. Uses `vi.mock('node:crypto')` to force `randomBytes` deterministic (all zeros → id `"aaaaaaaa"`).

14. First `createPost({ slug: 'first-slug' })` succeeds. Second `createPost({ slug: 'second-slug' })` — different slug (preflight passes) but same generated id (mock), hits `posts.id` PK violation at INSERT. Assert: raw error bubbles with message containing `posts.id`; error is `instanceof Error` but NOT `instanceof SlopItError`; `err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'`. Catches any regression where `createPost` widens its catch.

### `tests/rendering.test.ts` (new)

**Pure template functions:**
15. `render()` escapes `{{var}}` values (feeds `<script>` → HTML-escaped).
16. `render()` passes `{{{var}}}` raw.
17. `render()` throws on undefined variable: `"Missing template variable: ..."`.
18. `escapeHtml` covers `& < > " '`.
19. `loadTheme('minimal')` returns non-empty `post`, `index`, and an existing `cssPath`.

**Fragment helpers:**
20. `renderPostList` escapes post title, excerpt; produces newest-first order; handles zero posts (empty string).
21. `renderTagList` returns `''` for empty tags; escapes tag text (feed `<script>` tag, assert escaped).
22. `renderPoweredBy` contains a link to `https://slopit.io`.
23. `renderSeoMeta` escapes `seoDescription`; returns empty string if both `seoTitle` and `seoDescription` are undefined.

**Renderer end-to-end:**
24. **Routing-agnostic hrefs:** rendered post page contains `href="../style.css"` AND `href=".."` (nav); rendered index contains `href="style.css"` (and no nav-home link). Proves templates use only relative, blog-root-anchored paths.
25. `renderBlog(blogId)` writes blog index with published posts newest-first; excludes drafts.
26. `ensureCss` overwrites: write fixture CSS with old content, call `renderPost`, assert file content is replaced with theme's current `style.css`.
27. Unnamed blog (`blog.name = null`) → rendered page contains `blog.id` in `<title>` and nav.

**Coverage target:** 100% lines + branches on `src/posts.ts`, `src/rendering/templates.ts`, `src/rendering/generator.ts`, `src/ids.ts`.

---

## Out of scope (v1 protection)

Explicitly not in this feature:

- `updatePost` / `deletePost`. No way to promote a draft to published in v1 (use `createPost` again with `status: 'published'`).
- RSS / sitemap (stubs already in `src/rendering/feeds.ts`; implementation is a follow-up).
- `classic` / `zine` themes (enum narrowed to `minimal` in this feature).
- Image hosting (strategy v1.5 — agents pass URLs, we render them).
- SEO `<head>` meta beyond `seoTitle` / `seoDescription`.
- Full-text search.
- Public `getBlog` / `listPosts` API (internal-only here; public API lands in REST+MCP feature).
- Blog rename / theme change (`updateBlog`).
- Custom themes or per-blog theme variables.
- Template partials / includes / inheritance.
- Analytics, page views, agent identity tracking.

