---
title: Heading ids are public URLs; the contents rail is the theme's one script
tags: [rendering, themes, urls, javascript]
severity: p2
date: 2026-10-08
applies-to: [core]
---

## Rule

Every `##`–`######` heading on a post page has an `id` from `slugify` in `src/rendering/markdown.ts`. Once a post is live, people and search engines link to `/<slug>/#<heading-id>`. **Changing `slugify` silently breaks those links on every blog** the next time each post re-renders. Treat its output like a URL format: don't "improve" it without accepting that cost.

The contents rail (`src/rendering/toc.ts`) is the only JavaScript a theme ships. It is inline, emitted only with the rail, and the page must keep working without it. A new interactive feature does not get to point at it as precedent; see `DESIGN.md` "What we don't do".

## Why

- Ids are derived from heading text at render time, not stored. That keeps the schema unchanged, but it means the id is a pure function of (text, position among same-text headings). Editing a heading's text changes its id, which is expected. Changing the function changes every id, which is not.
- The script is inline instead of a sibling `toc.js` because theme assets are copied per blog and go stale until the blog re-renders (`theme-css-per-blog-refresh.md`). An inline script is always in step with the HTML around it.
- `type="module"` makes it run after the document is parsed, so it can sit before the body (rail first in reading and tab order) and still find the headings.

## Gotchas found building it

- A scroll container (`overflow: auto`) clips descendants painted over its own border. The rail's hairline is on the `<li>`s, not the `<ol>`, so the 2px marker isn't halved.
- The Claude desktop browser pane pauses `requestAnimationFrame` and smooth scrolling while hidden, so scroll-spy checks there look broken. Verify with `agent-browser` (a visible headless page) instead.

## Example / proof

- Code: `src/rendering/markdown.ts` (`slugify`, `headingIds`), `src/rendering/toc.ts`
- Tests: `tests/toc.test.ts`
- Spec: `docs/superpowers/specs/2026-10-08-contents-rail-design.md`
