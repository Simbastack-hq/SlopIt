---
title: Blog title — one display-name helper, manifests re-render, no \p{} in schema patterns
tags: [rendering, schema, mcp]
severity: p3
date: 2026-10-10
applies-to: [core, platform, self-hosted]
---

## Rules

1. **Every reader-facing blog name goes through `blogDisplayName`** (`src/rendering/seo.ts`): `title ?? name ?? id`. Masthead, page `<title>`, `og:site_name`, JSON-LD `isPartOf`, RSS channel title and the llms.txt `# ` heading all call it. Before the title existed, three files each spelled their own `name ?? id`; a fourth copy is how one surface ends up showing the slug.
2. **A title change re-renders the manifests, not just HTML.** `updateBlog` always rewrites every post page and home page; it adds `renderManifests` when the title or the language changed, because `feed.xml`, `lang/<tag>/feed.xml` and `llms.txt` carry the name. `.md` frontmatter has no blog name, so a title change skips the per-post `.md` loop that a language change needs.
3. **Schema regexes that ship to clients use explicit ranges, not Unicode property escapes.** The title's one-line rule is `/^[^\x00-\x1F\x7F-\x9F\u2028\u2029]*$/`, not `/^\P{Cc}*$/u`. zod copies the source into the JSON Schema `pattern` that MCP `tools/list` publishes, and a client compiling it with a non-Unicode regex engine (Python `re`, for one) fails on `\p{…}`.

## Why

- The house blogs rendered "blog", "simbastack" and "karibukit" as their site names, and most free blogs a random id, because the only name a blog had was its DNS slug.
- The title is free text, so it is the first blog field that needs escaping on every surface. `tests/blog-title.test.ts` renders a `<script>` title and checks HTML, attribute, JSON-LD and XML contexts.

## Pointers

- `src/db/migrations/011_blog_title.sql`, `src/schema/index.ts` (`blogTitle`), `src/blogs.ts` (`updateBlog`)
- The MCP `signup` description is capped at 900 characters by `tests/mcp/tool-descriptions.test.ts`; the title sentence there is deliberately short and the `title` param description carries the "Omit it and the URL name is shown" part.
