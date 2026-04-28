---
title: Theme CSS doesn't auto-refresh per blog after a deploy
tags: [themes, rendering, deployment]
severity: p3
date: 2026-04-28
applies-to: [core, platform]
---

## Rule

After changing the theme CSS in core, **existing blogs continue to serve the old `style.css` until they re-render organically.** To force-refresh a specific blog: PATCH any post on it (anything that triggers `renderPost`). All posts on that blog then pick up the new CSS at once because they share the same per-blog stylesheet.

## Why

`createRenderer` calls `ensureCss(theme.cssPath, blogDir)` inside both `renderPost` and `renderBlog`. That helper copies the theme's `style.css` into the blog's output dir (`<outputDir>/<blogId>/style.css`). The copy is what the static handler serves; the source in `dist/themes/<theme>/style.css` is never served directly.

So a theme change ships in the deploy and lands in `dist/`, but the `<outputDir>/<blogId>/style.css` files on existing blogs stay stale until the renderer next runs for that blog. If a blog hasn't published in weeks, its CSS stays at whatever was current at last publish.

This is a deliberate v1 trade-off. Per-blog CSS unlocks per-blog theme variants later (only `'minimal'` ships today, but the architecture allows it). Centralised theme serving would lose that flexibility, and SlopIt's architecture invariant is "static files on disk, no Node at read time" — we can't lazy-render at request time without violating it.

## Example

Surfaced in PR #25 (image-overflow CSS fix). After deploy, the new `article img { max-width: 100% }` rule was in core's `dist/themes/minimal/style.css`, but `https://slopit.io/b/<id>/style.css` (the per-blog copy) didn't have it, so existing posts still overflowed the column. Resolution was a no-op-ish PATCH on the post, which triggered `renderPost` → `ensureCss` → fresh copy.

A bare `update_post(blog_id, slug, patch={excerpt: "..."})` works. Empty patches don't — `updatePost` short-circuits and skips re-render when no fields change.

## When to build a real fix

Don't pre-build it. The "infrastructure before features" red flag in `CLAUDE.md` applies. Build a `rerender_blog(blog_id)` admin command when:

- A theme fix matters for >5 active blogs and they can't wait for their next organic publish, OR
- We add multiple selectable themes and theme switching has to take effect live, OR
- A "refresh on deploy" automation gets clunky enough that an explicit endpoint is cleaner.

Until any of those land, manual PATCH per affected blog is the right answer.

## Pointers

- `src/rendering/generator.ts` — `ensureCss` always overwrites; called by both `renderPost` and `renderBlog`.
- `src/posts.ts` — `updatePost` short-circuits the empty-patch path before re-render. PATCH must include at least one changed field.
- `tests/rendering.test.ts` — covers `ensureCss` overwrite behaviour on existing dirs.
