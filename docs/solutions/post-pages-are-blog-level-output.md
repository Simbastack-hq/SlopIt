---
title: Post pages are blog-level derived output (renderBlogPosts)
tags: [rendering, themes, performance]
severity: p3
date: 2026-09-02
applies-to: [core, platform, self-hosted]
---

## Rule

A post page embeds blog-wide state: the "More from this blog" block lists the blog's three newest published posts. So `<slug>/index.html` is derived from the *whole* published set, not just its own row, and must be re-written whenever that set changes or any post's title/description changes. `Renderer.renderBlogPosts(blogId)` does exactly that (HTML only). Every mutation path calls it:

| Trigger | Calls |
|---|---|
| `createPost` (published) | `renderPost`, `renderBlog`, `renderBlogPosts` |
| `updatePost` (→ published) | same |
| `updatePost` (published → draft) | `renderBlog`, `renderManifests`, `renderBlogPosts`, then the destructive removals |
| `deletePost` (was published) | `renderBlog`, `renderManifests`, `renderBlogPosts`, then `removePostFiles` |
| `updateBlog` (any field changed) | `renderBlogPosts`, `renderBlog` (replaced the old per-post `renderPost` loop) |

`.md` files and the manifests do not depend on sibling posts, so `renderBlogPosts` leaves them alone.

## Why an explicit method, not a broader `renderBlog`

`Renderer` is a public interface. Widening `renderBlog`'s meaning would leave a custom renderer type-correct but stale. A required method fails to compile instead. (Codex plan review, round 1.)

## Cost

`renderBlogPosts` is O(n) markdown renders per mutation. Measured on a temp SQLite store with ~1 KB markdown bodies (Apple Silicon, 2026-09-02):

| Published posts | One `renderBlogPosts` call |
|---|---|
| 50 | 26 ms |
| 200 | 104 ms |
| 1000 | 700 ms |

Core is uncapped; the hosted platform caps posts per tier. Burst publishing (13 posts in a minute has been observed) stays trivial. If a self-hosted blog ever grows large enough for this to matter, the fix is to bound the sibling re-render to the pages whose top-3 actually changed — don't build it before someone hits it.

## The double write on publish

`createPost`/`updatePost` call `renderPost` (self HTML + `.md` + manifests) and then `renderBlogPosts` (all HTML, self included). The self page is written twice with identical content. Accepted: ~1 ms, atomic rename, and an `exceptSlug` knob would have one caller. Consequence: `postprocessHtml` must be deterministic for a given `(html, blogId)`, which it already had to be — the same page was already re-rendered by `updateBlog` and the platform's ops scripts.

## Markup invariants for `postprocessHtml` consumers

A hook that post-processes HTML tells a post page from an index page by two markers core guarantees: *exactly one `</article>`* on a post page, and `<article … class="…post-item…">` only on the index. The block is a `<nav class="more-from">` inside the article, after the tags, so anything a hook inserts before `</article>` (the hosted platform's CTA card, for example) lands after it: body → tags → more from → hook content. `tests/related-posts.test.ts` asserts both markers and the ordering.

## Pointers

- `src/rendering/generator.ts` — `renderMoreFrom`, `writePostHtml`, `renderBlogPosts`
- `src/posts.ts` — the four call sites; `listPublishedPostsForBlog` orders by `published_at DESC, rowid DESC` so same-millisecond bursts have a deterministic newest-first
- `src/blogs.ts` — `updateBlog`
- `docs/superpowers/specs/2026-09-02-related-posts-design.md`
