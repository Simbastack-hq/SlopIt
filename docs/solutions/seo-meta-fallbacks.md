---
title: SEO meta fallbacks and JSON-LD script-tag safety
tags: [rendering, seo, themes, security]
severity: p3
date: 2026-05-01
applies-to: [core, platform, self-hosted]
---

## Rule

Every published post emits a complete `<head>`: description, og:*, twitter:*, JSON-LD `BlogPosting`. Empty author-set SEO fields fall back deterministically — never produce a blank social preview.

## Fallback chain

| Tag source | Fallback when absent |
|------------|----------------------|
| description, og:description, twitter:description | `post.seoDescription → post.excerpt → extractDescription(post.body)` — markdown stripped, whitespace collapsed, 160-char word-boundary truncation |
| og:title, twitter:title | `post.seoTitle ?? post.title` |
| og:image, twitter:image | omitted (no default image; YAGNI for v1) |
| og:site_name | `blog.name ?? blog.id` |
| article:modified_time | omitted when `updatedAt === publishedAt` |

Single source of truth: `resolveDescription(post)` in `src/rendering/seo.ts`. Both `buildSeoMeta` and `buildJsonLd` call it; Phase 2's `.md`/RSS/`llms.txt` generators will too.

## JSON-LD script-tag safety

User-controlled strings (title, author, tags) can contain `</script>`. HTML-escaping inside `<script>` is the wrong tool — it would corrupt the JSON. Instead, `escapeJsonForScript` does `JSON.stringify(...)` then replaces `<` with `<`. JSON.parse decodes `<` back to `<`, so consumers see the original string; the literal `</script>` byte sequence never appears in HTML output.

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
