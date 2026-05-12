---
title: Blog analytics field and the render-postprocess hook
tags: [rendering, schema, analytics, open-core]
severity: p3
date: 2026-05-12
applies-to: [core, platform]
---

## Rule

Per-blog analytics config lives in a single nullable JSON column (`blogs.analytics_json`), validated by `BlogAnalyticsSchema` (Umami / Plausible / GA discriminated providers). Mutation goes through `updateBlog(store, renderer, blogId, patch)` which mirrors `updatePost`'s shape: Zod-validated patch, transactional UPDATE with reverse-update compensation, and a re-render trigger that fires only when the analytics column actually changes.

## Why one JSON column, not a sibling table

The schema is tiny (3 providers × ~2 fields each) and the access pattern is one-row-at-a-time — the renderer reads it during `postprocessHtml`. A sibling table would force JOIN-or-second-query overhead per render with zero schema-evolution benefit; adding a future provider is one Zod entry, no migration. Phase 3 design decision row #8.

## Why a render-time hook, not a serve-time middleware

SlopIt's architecture invariant: "Caddy serves static files; Node only runs at write time." A serve-time middleware would put Node on every HTML pageview's hot path. A build-time hook adds ~200 bytes per page to disk (negligible) and runs only at publish/update. Phase 3 design decision row #10.

## The hook contract

`postprocessHtml?: (html: string, blogId: string) => string` on `RendererConfig`. Called from `renderPost` (per-post HTML) and `renderBlog` (per-blog index HTML). NOT called for `.md`, `llms.txt`, `feed.xml`, or `sitemap.xml` — those aren't HTML and shouldn't be touched by a `</head>`-replace transform. Identity is the default; self-hosted callers pass nothing and get unchanged behavior. Platform's Phase 3c wrapper plugs in here to inject `<script>` tags for whichever provider(s) the blog has configured.

## Re-render on analytics change

When `updateBlog` writes a new `analytics_json` value, it iterates `listPublishedPostsForBlog` and calls `renderer.renderPost` for each one, then `renderer.renderBlog` once. Without this trigger, the rendered HTML on disk would still carry the old (or absent) analytics tags until the next user-initiated publish. The implementation short-circuits in three no-op cases:

1. Empty patch — `Object.keys(parsed).length === 0`.
2. Explicit `{ analytics: undefined }` — Zod's `.optional()` preserves the key with an undefined value, but it semantically means "no change", not "clear". The guard is `'analytics' in parsed && parsed.analytics !== undefined`.
3. Same-value re-apply — serialize prior and new analytics to JSON and compare; identical JSON means functionally a no-op.

Case (2) matters because without the guard, `JSON.stringify(undefined)` would produce the literal string `"undefined"` (not valid JSON), or the column would silently get cleared on every undefined patch — wiping a configured blog's analytics. Same pattern as `PostPatchSchema`'s explicit-undefined cases.

## Example / proof

- Migration: `src/db/migrations/006_blog_analytics.sql`
- Schema: `src/schema/index.ts` (`BlogAnalyticsSchema`, `BlogPatchSchema`)
- Function: `src/blogs.ts` (`updateBlog`)
- Hook: `src/rendering/generator.ts` (`RendererConfig.postprocessHtml`)
- REST: `src/api/routes.ts` (`PATCH /blogs/:id`)
- MCP: `src/mcp/tools.ts` (`update_blog`)
- Tests: `tests/schema.test.ts`, `tests/blogs.test.ts`, `tests/rendering.test.ts`, `tests/api/blogs.test.ts`, `tests/mcp/blogs.test.ts`
