---
title: SEO meta fallbacks and JSON-LD script-tag safety
tags: [rendering, seo, themes, security]
severity: p3
date: 2026-05-01
applies-to: [core, platform, self-hosted]
---

## Rule

Every published post emits a complete `<head>`: description, og:*, twitter:*, JSON-LD `BlogPosting`. Empty *or whitespace-only* author-set SEO fields fall back deterministically — never produce a blank social preview.

## "Blank" means absent

The schema permits `seoTitle: ''`, `seoDescription: '   '`, etc. (the optional SEO fields don't enforce `.trim().min(1)`). The renderer's contract treats blank or whitespace-only strings as absent for resolution purposes via a private `nonBlank(s)` helper. Naive `??` (nullish coalescing) would let `''` through; naive `if (s)` would let `'   '` through. Both bypass the fallback.

## Fallback chain

| Tag source | Fallback when absent / blank |
|------------|------------------------------|
| description, og:description, twitter:description | `post.seoDescription → post.excerpt → extractDescription(post.body)` — markdown stripped, whitespace collapsed, 160-char word-boundary truncation |
| og:title, twitter:title, JSON-LD headline | `resolveTitle(post)` = `nonBlank(post.seoTitle) ?? post.title` (post.title is schema-guaranteed non-empty via `.trim().min(1)`) |
| og:image, twitter:image, JSON-LD image | `resolveShareImages(post, canonicalUrl)`: `post.coverImage` → first YouTube embed's thumbnail → first body image → omitted (twitter:card drops to `summary`) |
| og:site_name | `nonBlank(blog.name) ?? blog.id` |
| article:author / JSON-LD author | omitted when blank |
| article:modified_time / JSON-LD dateModified | omitted when `updatedAt === publishedAt` |

Single source of truth: `resolveTitle(post)`, `resolveDescription(post)` and `resolveShareImages(post, canonicalUrl)` in `src/rendering/seo.ts`. Both `buildSeoMeta` and `buildJsonLd` call them; Phase 2's `.md`/RSS/`llms.txt` generators will too.

## Share image without a cover (2026-10-06)

- **Same tokens as the page.** `bodyMedia(md)` in `markdown.ts` walks the lexer tokens the renderer uses, so a YouTube URL counts only where it renders as a player (bare-URL paragraph) and nothing inside a code fence or raw HTML counts. A regex over the body would pick up both.
- **maxres isn't guaranteed.** `i.ytimg.com/vi/<id>/maxresdefault.jpg` (1280×720) 404s for some videos; `hqdefault.jpg` (480×360) always exists but is small enough that Facebook shows a small card. Rendering is offline, so we can't probe. We emit maxres then hq as two `og:image` tags (scrapers that skip a broken image take the next); `twitter:image` and JSON-LD get maxres. If a video has no HD thumbnail, set `coverImage`.
- **Body images resolve against the post URL**, because `og:image` must be absolute. Non-http(s) srcs are skipped.

## JSON-LD script-tag safety

User-controlled strings (title, author, tags) can contain `</script>`. HTML-escaping inside `<script>` is the wrong tool — it would corrupt the JSON. Instead, `escapeJsonForScript` does `JSON.stringify(...)` then replaces every `<` with the unicode escape `\u003c`. JSON.parse decodes `\u003c` back to `<`, so consumers see the original string; the literal byte sequence `</script>` never appears in HTML output, so the parser cannot be tricked into closing the script block.

## Trailing-slash baseUrl normalization

Platform passes named-blog base URLs as `https://${name}.slopit.io/` (with trailing slash); naive concatenation `baseUrl + '/' + slug + '/'` produces `https://${name}.slopit.io//slug/`. `normalizeBaseUrl(s)` strips one trailing slash, so the same `renderPost` call site works for both slashed and non-slashed input. Tested in `tests/rendering.test.ts` — both forms produce identical canonical/og:url/JSON-LD `mainEntityOfPage`.

## Why the SEO module is separate from generator.ts

`generator.ts` orchestrates file-system writes (`mkdirSync`, `writeFileSync`, CSS copy, blog index re-render). `seo.ts` is pure: takes a Post + Blog + canonical URL, returns strings. Mixing them coupled testable pure logic to a sync I/O surface for no reason. Splitting also keeps `generator.ts` from growing past ~200 lines and lets Phase 2's `.md`/RSS/`llms.txt` reuse the same helpers without dragging in disk I/O.

## Example / proof

- Implementation: `src/rendering/seo.ts`
- Pure-helper tests: `tests/seo.test.ts` (49 tests)
- Integration tests: `tests/rendering.test.ts` (3 new tests in `createRenderer — renderPost`)
- Plan: `docs/superpowers/plans/2026-05-01-blog-post-seo-phase-1-implementation.md`
- Spec: `docs/superpowers/specs/2026-05-01-blog-post-seo-phase-1-design.md`
