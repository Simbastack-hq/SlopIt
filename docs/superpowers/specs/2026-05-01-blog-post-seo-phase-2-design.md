# Agent-Readable File Outputs — Phase 2 Design Spec

**Status:** Design draft 2026-05-01.
**Scope:** `@slopit/core` rendering. **Phase 2** of the agent-readable blogs feature series. Adds four file outputs the renderer emits alongside the existing per-post HTML: per-post `<slug>.md`, per-blog `llms.txt`, `feed.xml`, `sitemap.xml`. Pure rendering. **No data collection.** Trivially compliant with the Phase 0 privacy contract.

**Phases:**

- **Phase 0** — Privacy contract (slopit-platform PR #52).
- **Phase 1** — `<head>` meta + JSON-LD (slopit core PR #33).
- **Phase 2** — _this spec._ Static file outputs from the renderer.
- **Phase 3a/3b/3c** — Analytics (separate spec).

**Branch:** `plan/agent-readable-blogs-phase-2` (from `dev`).

---

## Why this is one phase, not four

`.md`, `llms.txt`, `feed.xml`, `sitemap.xml` look like four features. They're actually one shape — files written next to the existing HTML at publish time, regenerated when the post or blog metadata changes — with four content templates. Splitting them into four PRs would mean four nearly-identical copies of the file-emission plumbing, each with its own test fixture. One PR with one plumbing change and four template implementations is the cleaner unit of work.

Phase 1's `<link rel="alternate">` placeholders (decision 13a in the Phase 1 spec) point at the targets created here. Phase 1 and Phase 2 should ship in tight succession to minimize the window where those alternate links 404.

---

## Goals

1. **Every published post is available as raw markdown at `<slug>.md`** with YAML frontmatter capturing canonical metadata.
2. **Every blog has a `/llms.txt` manifest** at its root listing all published posts newest-first, with one description line per post.
3. **Every blog has an RSS 2.0 feed at `/feed.xml`** with the 20 most recent published posts.
4. **Every blog has a `sitemap.xml`** listing every published post URL with `lastmod`.
5. All four files are static. **Caddy serves them; Node never reads them.**
6. Files are written at publish/update time, deleted at unpublish/delete time. The renderer's existing post-write sequencing covers them.

## Non-goals

- **Per-blog `robots.txt`.** Defer. Caddy can serve a default site-wide `robots.txt` that allows everything; per-blog overrides aren't valuable until users complain.
- **Atom feed format.** RSS 2.0 only. Wider reader support; one less template.
- **OPML output for blog discovery.** Out of scope.
- **Generated cover images for OG cards.** Out of scope.

---

## Description resolution (shared across all four file types)

Every output that needs a one-line post description uses the **same chain established in Phase 1**:

1. `post.seoDescription` if set
2. else `post.excerpt` if set
3. else `extractDescription(post.body)` — the markdown-stripped, 160-char word-boundary-truncated body excerpt
4. else `''` (omit the description, use the title alone)

This logic is already implemented in Phase 1's `src/rendering/seo.ts`. Phase 2 imports and reuses it. **No second resolution helper.**

For blog-level descriptions in `llms.txt`, no schema change in Phase 2 — `blog.name` plus a static one-liner is the manifest header (decision per the brainstorming round). If `blog.description` is added later, the `llms.txt` template picks it up automatically.

---

## Design decisions (resolved)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | All four outputs are emitted from the renderer's existing `renderPost`/`renderBlog` flow, not a separate cron or queue. | "Node only runs at write time" (CLAUDE.md). Outputs are derived state of the published-posts table; deriving them at write time keeps everything sync, on-disk, and Caddy-servable. |
| 2 | `.md` files are written to `{outputDir}/{blogId}/{slug}.md` — sibling to `{slug}/index.html`. Caddy maps `/<slug>.md` to that path. | Same hierarchy the renderer already uses. No new output directory layout. |
| 3 | `llms.txt`, `feed.xml`, `sitemap.xml` are written to `{outputDir}/{blogId}/llms.txt` (etc.) — at the blog root, sibling to the existing `index.html`. | Caddy serves `*.slopit.io/llms.txt` directly from this path. Same pattern as `index.html`. |
| 4 | Re-emit `llms.txt`, `feed.xml`, `sitemap.xml` on **every publish/update/unpublish/delete** of any post in the blog. | Same trigger that already re-renders `index.html`. Cost is small (4 small files) and the alternative (incremental updates) is more code for no real win. |
| 5 | Re-emit `<slug>.md` on every publish/update of that single post, and **delete it** on unpublish or post deletion. | Mirrors HTML lifecycle. |
| 6 | RSS feed caps at the 20 most recent published posts. `llms.txt` and `sitemap.xml` include all published posts (no cap). | RSS readers expect a manageable feed; agents and search engines benefit from the full inventory. |
| 7 | `<content:encoded>` in RSS contains the **already-rendered HTML body** (the same body markup that lands in `<slug>/index.html`). CDATA-wrapped. | Reuses the existing markdown-to-HTML output; readers like NetNewsWire show the full post inline. Adds the `xmlns:content="http://purl.org/rss/1.0/modules/content/"` namespace declaration to `<rss>`. |
| 8 | `.md` frontmatter is YAML with these keys: `title`, `slug`, `date` (ISO 8601 from `publishedAt`), `updated` (only if `updatedAt !== publishedAt`), `author` (if set), `description` (resolved per chain), `canonical`, `tags` (only if non-empty array). | Mirrors what the HTML head exposes. Agents reading the markdown source get the same metadata. |
| 9 | `.md` body is `post.body` verbatim — the raw markdown the author submitted, not the rendered HTML. | The whole point: agents that want the source get the source. |
| 10 | All four file types use the existing `render(template, vars)` machinery. Templates ship in `src/themes/minimal/` alongside `post.html` / `index.html`. Filenames: `post.md.template`, `llms.txt.template`, `feed.xml.template`, `sitemap.xml.template`. | One templating system to learn, one set of test patterns. |
| 11 | YAML frontmatter is hand-built via a tiny `buildFrontmatter()` helper in `src/rendering/frontmatter.ts`. **No new YAML library.** Schema is fixed (8 keys), all values escape to YAML-safe strings. | Boring tech wins. CLAUDE.md "Adding a dependency for ~10 lines of logic" is a red flag. |
| 12 | RSS XML is hand-built via `buildRssFeed()` in `src/rendering/feeds.ts`. **No new XML library.** All user-controlled strings escape via a small `escapeXml()` helper (5 chars: `& < > " '`). HTML body for `<content:encoded>` is CDATA-wrapped; the existing renderer already produces XHTML-clean output (no unescaped `&`). | Same boring-tech argument. The `feeds.ts` filename matches the pre-existing stub stash referenced in older spec docs. |
| 13 | `sitemap.xml` lists `<url>` entries with `<loc>`, `<lastmod>` (ISO 8601 from `updatedAt`), and `<changefreq>weekly</changefreq>`. No `<priority>`. | Google explicitly says priority is ignored; weekly changefreq is the honest default for blogs. Drafts excluded. |
| 14 | `llms.txt` manifest format: `# <blog name>\n\n> An agent-first blog. Read the markdown source by appending `.md` to any post URL.\n\n## Posts\n\n- [<title>](<canonical>): <description>\n- ...` | Matches the brief's format. The static one-liner under the heading gives consuming agents a useful instruction without requiring a `blog.description` schema field today. |
| 15 | Posts in `llms.txt` are **sorted by `publishedAt` descending** (newest first). Same as the blog `index.html`. | Consistency with what humans see. |
| 16 | Drafts are excluded from all four outputs. | Drafts aren't published; they have no canonical URL; they'd break `feed.xml`. |
| 17 | All file writes are **atomic via a new `writeFileAtomic(path, content)` helper** — write to `${path}.tmp`, then `rename`. Phase 2 introduces this helper; the current `generator.ts` does direct `writeFileSync` (lines 195 and 214). The first task in the implementation plan adds the helper and migrates the two existing HTML writes; subsequent tasks have `<slug>.md`, `llms.txt`, `feed.xml`, `sitemap.xml` use it. | Avoids partial reads if Caddy serves mid-write. The reviewer caught the misclaim that this pattern already exists; introducing it now is the cheapest moment because we're touching the renderer's write path anyway. |
| 18 | The renderer's `MutationRenderer` interface gains three methods: `renderPostMarkdown(blogId, post)`, `deletePostMarkdown(blogId, slug)`, and `renderManifests(blogId)` (the last emits `llms.txt` + `feed.xml` + `sitemap.xml` together — they share the same per-blog post list, so one method per file would force three identical queries). Implementation lives in the same `createRenderer` factory. Self-hosters override nothing; existing behavior is preserved. | Minimal interface growth. The methods exist for testability; they're called internally by the existing `renderPost` flow and the published→draft / `deletePost` cleanup paths, not by external callers. |
| 19 | Caddy file-server config in `slopit-platform`'s `Caddyfile` needs one extra rule to serve `.md` files with `Content-Type: text/markdown; charset=utf-8`. `llms.txt` and `feed.xml` get explicit Content-Type rules too. **Caddyfile change is platform-side**, not core, but documented here so the platform PR doesn't get missed. | Cross-cutting concern; flag it once, ship it together. |

---

## Files

| File | New/Modified | Responsibility |
|---|---|---|
| `src/rendering/frontmatter.ts` | NEW | `buildFrontmatter(record)` — emits YAML for the fixed 8-key schema. ~25 lines including escape rules for strings, lists, and nullable keys. |
| `src/rendering/feeds.ts` | NEW | `buildRssFeed(input)`, `buildSitemap(input)`, `buildLlmsTxt(input)`, `escapeXml(s)`. Pure helpers. ~120 lines total. |
| `src/rendering/generator.ts` | MODIFY | Add `writeFileAtomic(path, content)` private helper; migrate the two existing direct `writeFileSync` calls (lines ~195, ~214). Extend `MutationRenderer` interface with four methods. Wire emission into `renderPost` and cleanup into the published→draft transition inside `updatePost` (`src/posts.ts:376`) plus `deletePost`. |
| `src/themes/minimal/post.md.template` | NEW | YAML frontmatter + raw body. ~15 lines. |
| `src/themes/minimal/llms.txt.template` | NEW | Heading + intro line + post list. ~10 lines. |
| `src/themes/minimal/feed.xml.template` | NEW | RSS 2.0 envelope + per-item template. ~30 lines. |
| `src/themes/minimal/sitemap.xml.template` | NEW | Standard sitemap envelope + per-url template. ~10 lines. |
| `src/posts.ts` | MODIFY | The published→draft transition inside `updatePost` (`src/posts.ts:376`) and `deletePost` (`src/posts.ts:519`) invoke the cleanup methods on the renderer. There is no `unpublishPost` function in core; the unpublish flow is `updatePost(blogId, slug, { status: 'draft' })`. |
| `tests/feeds.test.ts` | NEW | Unit tests for `buildRssFeed`, `buildSitemap`, `buildLlmsTxt`, `escapeXml`. |
| `tests/frontmatter.test.ts` | NEW | Unit tests for `buildFrontmatter`. |
| `tests/rendering.test.ts` | MODIFY | Add integration tests asserting all four outputs are written / removed at the right lifecycle points. |
| `src/skill.ts` | MODIFY | Document the four agent-facing endpoints in `SKILL.md`. Mention in `<head>` alternate-link description. |
| `tests/skill.test.ts` | MODIFY | Drift tests for the new SKILL content. |
| `examples/self-hosted/Caddyfile` | MODIFY | Add Content-Type rules for `.md`, `llms.txt`, `feed.xml`, `sitemap.xml`. |
| `slopit-platform` repo's `Caddyfile` | MODIFY (separate PR) | Same Content-Type rules. Flagged here, opened as a follow-up PR after Phase 2 lands in core. |
| `docs/solutions/agent-readable-file-outputs.md` | NEW | Capture: temp-then-rename atomicity, why `feeds.ts` is hand-rolled, the lifecycle table for all four file types. |

---

## Output shapes

### `<slug>.md`

```markdown
---
title: "The launch post for this very product"
slug: "this-blog-post-is-slop"
date: "2026-04-28T14:00:00Z"
updated: "2026-04-29T09:30:00Z"
author: "NJ"
description: "We just launched SlopIt. Here's why we built it."
canonical: "https://blog.slopit.io/this-blog-post-is-slop/"
tags: ["launch", "ai", "agents"]
---

[the raw markdown body the author submitted, verbatim]
```

### `llms.txt`

```markdown
# blog.slopit.io

> An agent-first blog. Read the markdown source by appending `.md` to any post URL.

## Posts

- [The launch post for this very product](https://blog.slopit.io/this-blog-post-is-slop/): We just launched SlopIt. Here's why we built it.
- [Earlier post title](https://blog.slopit.io/earlier-post/): Earlier description...
```

### `feed.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>blog.slopit.io</title>
    <link>https://blog.slopit.io/</link>
    <description>An agent-first blog hosted on SlopIt.</description>
    <atom:link href="https://blog.slopit.io/feed.xml" rel="self" type="application/rss+xml" xmlns:atom="http://www.w3.org/2005/Atom" />
    <item>
      <title>The launch post for this very product</title>
      <link>https://blog.slopit.io/this-blog-post-is-slop/</link>
      <guid isPermaLink="true">https://blog.slopit.io/this-blog-post-is-slop/</guid>
      <pubDate>Tue, 28 Apr 2026 14:00:00 GMT</pubDate>
      <author>NJ</author>
      <description>We just launched SlopIt. Here's why we built it.</description>
      <content:encoded><![CDATA[<p>...rendered HTML body...</p>]]></content:encoded>
    </item>
    <!-- ... up to 20 items ... -->
  </channel>
</rss>
```

### `sitemap.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://blog.slopit.io/</loc>
    <lastmod>2026-04-29T09:30:00Z</lastmod>
    <changefreq>weekly</changefreq>
  </url>
  <url>
    <loc>https://blog.slopit.io/this-blog-post-is-slop/</loc>
    <lastmod>2026-04-29T09:30:00Z</lastmod>
    <changefreq>weekly</changefreq>
  </url>
  <!-- ... -->
</urlset>
```

---

## Lifecycle table

| Trigger | Files written | Files deleted |
|---|---|---|
| `createPost(status: 'published')` | `<slug>/index.html`, `<slug>.md`, `llms.txt`, `feed.xml`, `sitemap.xml` | — |
| `createPost(status: 'draft')` | — | — |
| `updatePost` (still published) | `<slug>/index.html`, `<slug>.md`, `llms.txt`, `feed.xml`, `sitemap.xml` | — |
| `updatePost` (draft → published) | Same as createPost(published) | — |
| `updatePost` (published → draft) | `llms.txt`, `feed.xml`, `sitemap.xml` (regenerated minus this post) | `<slug>/index.html`, `<slug>.md` |
| `deletePost` | `llms.txt`, `feed.xml`, `sitemap.xml` (regenerated minus this post) | `<slug>/index.html`, `<slug>.md` |

Blog deletion is out of scope: core has no `deleteBlog` function or `DELETE /blogs/:id` route today. When that surface lands (separate scope), its lifecycle row will need to remove the entire `{outputDir}/{blogId}/` tree. Phase 2 does not assume or test it.

---

## Edge cases

| Case | Behavior |
|------|----------|
| Blog with zero published posts | `llms.txt` shows the heading + intro line + an empty `## Posts` section. `feed.xml` emits a valid RSS envelope with zero `<item>` elements. `sitemap.xml` lists only the blog root. |
| Post with characters that need XML-escaping (`<`, `&`, `"`) | All user-controlled strings pass through `escapeXml`. |
| Post with `</script>` or `]]>` in body | Body is CDATA-wrapped in `<content:encoded>`. The CDATA-end sequence `]]>` in body is split as `]]]]><![CDATA[>` — same standard pattern as `escapeJsonForScript` in Phase 1. |
| YAML special chars in title (`:`, `#`, multi-line) | `buildFrontmatter` always quotes string values with double quotes and escapes `\` and `"`. |
| Post with very long title (200 chars) | YAML quoted strings handle any length; RSS `<title>` capped at no length limit by spec; sitemap `<loc>` is bounded by URL length (which is bounded by the slug). |
| `publishedAt === updatedAt` | `.md` frontmatter omits `updated:`. RSS `<pubDate>` only. Sitemap `<lastmod>` uses `updatedAt` (which equals publishedAt). |
| Custom domain blog | `canonicalUrl` already resolves correctly (Phase 1 wiring). All four templates use the same `canonicalUrl` source. |

---

## Testing strategy

**`tests/frontmatter.test.ts`:**
- Quotes string values; escapes `\` and `"`; emits ISO 8601 dates verbatim; emits empty arrays as omitted; emits null/undefined keys as omitted.

**`tests/feeds.test.ts`:**
- `escapeXml` covers the five canonical chars.
- `buildRssFeed` produces parseable XML; W3C Feed Validator passes (manual check before merge).
- `buildSitemap` produces parseable XML; Google sitemap-format validator passes.
- `buildLlmsTxt` matches the documented format byte-for-byte for a known fixture.
- All three handle empty post arrays gracefully.

**`tests/rendering.test.ts` integration tests (additions):**
- `createPost(published)` writes `.md`, `llms.txt`, `feed.xml`, `sitemap.xml` at expected paths.
- `updatePost(..., { status: 'draft' })` from a published post removes `.md` and regenerates manifest/feed/sitemap minus the post.
- `deletePost` removes `.md`, `<slug>/index.html`, and regenerates manifest/feed/sitemap.

**`tests/skill.test.ts`:** drift assertions for the new agent-endpoint documentation.

---

## Acceptance criteria

- `curl https://blog.slopit.io/llms.txt` returns the manifest, newest post first, with one description line per entry.
- `curl https://blog.slopit.io/this-blog-post-is-slop.md` returns YAML frontmatter + raw markdown body.
- `curl https://blog.slopit.io/feed.xml` returns valid RSS 2.0; W3C Feed Validator passes.
- `curl https://blog.slopit.io/sitemap.xml` returns a valid sitemap; Google sitemap-format validator passes.
- View-source on any post page (Phase 1) shows the `<link rel="alternate">` tags, both targets resolve.
- Same files exist on disk for every other hosted blog after their next publish (`/var/slopit/blogs/<host>/llms.txt`, etc.).
- All four endpoints respond in <50ms (static via Caddy).
- `SKILL.md` and `/agent-docs` mention the four new agent-facing endpoints.
- `pnpm check` passes (typecheck, lint, format, all tests).

---

## Out of scope (for follow-up PRs)

- **Caddyfile updates in `slopit-platform`** for `Content-Type` headers on the new file types. Will land as a follow-up PR after this lands in core.
- **`blog.description` schema field** — flagged as optional future work. Today's `llms.txt` template has a static intro line; if/when `blog.description` lands, the template picks it up.
- **Phase 3a/3b** request logging on these new endpoints. Specified separately.

---

## Open questions

None. Every decision is intended as final. Implementation surprises update this doc and link the change in the PR.
