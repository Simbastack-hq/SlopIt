---
title: Agent-readable file outputs alongside HTML
tags: [rendering, themes, agents, seo]
severity: p3
date: 2026-05-01
applies-to: [core, platform, self-hosted]
---

## Rule

Every published post writes five files: `<slug>/index.html`, `<slug>.md`, plus the per-blog `llms.txt`, `feed.xml`, `sitemap.xml`. All emit at the same lifecycle moments (publish, update, unpublish, delete). All are static; Caddy serves them; Node never reads them.

## Lifecycle table

| Trigger | Files written | Files deleted |
|---|---|---|
| `createPost({ status: 'published' })` | `<slug>/index.html`, `<slug>.md`, `llms.txt`, `feed.xml`, `sitemap.xml` | — |
| `createPost({ status: 'draft' })` | — | — |
| `updatePost` (still published) | same as published create | — |
| `updatePost` (draft → published) | same as published create | — |
| `updatePost` (published → draft) | `llms.txt`, `feed.xml`, `sitemap.xml` (regen minus this post) | `<slug>/index.html`, `<slug>.md` |
| `deletePost` (was published) | `llms.txt`, `feed.xml`, `sitemap.xml` (regen minus this post) | `<slug>/index.html`, `<slug>.md` |
| `deletePost` (was draft) | — | — |

## Ordering invariant — manifests before destructive cleanup

In `updatePost` (published→draft) and `deletePost`, the renderer calls are deliberately sequenced:

1. `renderBlog` + `renderManifests` first — these read the DB *after* the row transition, so the post is already excluded. If either throws, the catch compensates DB back to its prior state and the per-post files are still on disk → consistent pre-call state.
2. `removePostFiles` + `deletePostMarkdown` last — these are destructive and cannot be undone from the catch.

Reversed ordering (destructive first, manifests after) would leave the DB compensated to "published" while the per-post HTML and `.md` were already gone — a state the renderer can't reconverge from without a separate `renderPost` call. Reviewer caught this in Phase 2 round 3; the fix lives at `src/posts.ts:482` and `:538`.

## Atomicity

All five file writes use `writeFileAtomic` (`src/rendering/generator.ts`): write to `<path>.tmp`, then `renameSync`. POSIX rename is atomic, so Caddy can race the renderer and never sees a partially-written file. Single helper, six call sites (per-post HTML, per-post `.md`, blog index, `llms.txt`, `feed.xml`, `sitemap.xml`).

## CDATA escape inside `<content:encoded>`

The literal sequence `]]>` in a post body breaks out of a CDATA section. Standard fix: replace `]]>` with `]]]]><![CDATA[>` — close one CDATA, embed the `>` in the next. Same idea as `<` for `</script>` in JSON-LD. Implementation: `escapeCdata` in `src/rendering/feeds.ts`.

## YAML frontmatter via JSON.stringify

YAML 1.2 §7.3.1 double-quoted scalars are a superset of JSON string literals for the JSON escape set (`\n`, `\r`, `\t`, `\\`, `\"`, `\uXXXX`). So `JSON.stringify(s)` produces a valid YAML double-quoted scalar for any input — multi-line titles, tabs in descriptions, CR/LF in body. A naive backslash-and-quote-only escape would produce frontmatter that can't round-trip through a standard YAML parser when the value contains newlines.

Implementation: `quote` helper in `src/rendering/frontmatter.ts`. Tests assert the round-trip for newline/tab/CR, embedded quotes, and control characters.

## URL encoding inside Markdown link `(url)`

`encodeURIComponent` does NOT encode `(` or `)` — they're reserved-but-allowed in URLs. But Markdown's link parser breaks on literal parens inside `(url)`. So `escapeMdUrl` percent-encodes them manually (`%28` / `%29`). Found while writing tests for `buildLlmsTxt` — the test for "URL containing parens" failed because `encodeURIComponent('(')` returned `(` unchanged.

## Why hand-rolled XML/YAML

Boring tech wins. Total lines for `feeds.ts` + `frontmatter.ts` is ~150. A YAML library (`yaml` or `js-yaml`) is ~10× that as a transitive dep with its own multi-version compatibility surface. Our schema is fixed: 8 frontmatter keys, a single RSS shape, a single sitemap shape. We control every byte.

CLAUDE.md red flag: "Adding a dependency for ~10 lines of logic." Our case is closer to ~30 lines per format. Same answer.

## Example / proof

- Helpers: `src/rendering/feeds.ts`, `src/rendering/frontmatter.ts`
- Wiring: `src/rendering/generator.ts` (`renderPostMarkdown`, `renderManifests`, `writeFileAtomic`)
- Lifecycle: `src/posts.ts` (`updatePost`, `deletePost` — see the manifests-before-destructive comments)
- Unit tests: `tests/feeds.test.ts` (23 tests), `tests/frontmatter.test.ts` (10 tests)
- Integration tests: `tests/rendering.test.ts` (Phase 2 lifecycle block, 8 tests covering publish/unpublish/delete)
