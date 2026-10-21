---
title: Live facts — one scanner, inert values, a durable pending render
tags: [rendering, facts, api, mcp, db, recovery]
severity: p2
date: 2026-10-21
applies-to: [core, platform, self-hosted]
---

## Rule

A blog's facts (`facts` table) are named current claims; post bodies use them as `{{fact:name}}`. The stored body keeps the token. Every rendered representation substitutes the current value at render time.

1. **One scanner.** `scanFacts` in `src/rendering/facts.ts` is the only code that finds tokens. Validation, `used_by`, dry-run lines, the auto-excerpt and substitution all go through it. It skips code with `splitCode`, the same split `stripDangerousBlocks` uses, so "code" means one thing. Don't add a regex or `LIKE '%{{fact:%'` search anywhere else.
2. **Materialise at read, inside the renderer.** Every renderer method that reads a post runs it through `materializePost` (body and auto-excerpt substituted, `updatedAt` = max(post, facts' `updated_at`)), loading the blog's facts once per public call. Callers pass raw posts, and so does a host's draft preview (`renderPost` on a draft). Never materialise twice: the second pass finds no tokens and drops the facts note.
3. **A post without tokens comes back as the same object.** Its output is byte-identical to before live facts. `tests/facts-golden.test.ts` holds a snapshot the old renderer wrote.
4. **Values are inert.** `checkFactValue` forbids `` [ ] < > * _ ~ ` | \ { } `` and control characters, so a value can't make a link, tag, emphasis, strikethrough, code, table cell or theme variable (`render()` would throw on `{{x}}`). Inline that leaves only block syntax at a line start, which `substituteOccurrences` escapes (`\#`, `\-`, `5\.`…), looking at container markers, back-to-back tokens and the author's text around them together.
5. **Where tokens may sit is decided by the page's lexer.** `validatePostFacts` swaps tokens for alphanumeric sentinels, lexes, and rejects a sentinel in a heading (`FACT_IN_HEADING`: anchors and the contents rail must not move) or in a link, image or definition address or title (`FACT_IN_URL`). `<…>` is checked on the source: the lexer reads `<sentinel>` as a tag, but `<https:…>` as an autolink.

## Recovery model

`setFact` upserts the fact and a `fact_renders_pending` row in one transaction, then re-renders in the same request and deletes the row. A failure leaves the row: writes then fail with `FACT_RENDER_PENDING` (500, "saved, pages behind, retry"); reads report `render_pending: true`. The next facts call or post write (`createPost`, `updatePost`, `deletePost` drain first) finishes it, and so does a same-value retry. Hosts call `drainPendingFactRenders(store, rendererFor)` at boot to cover a crash. The platform does it in `main.ts`; `examples/self-hosted` does it too.

The re-render is all published post pages + home pages (the "More from" blurbs and home list quote fact-using posts' excerpts), the `.md` of each fact-using post, and the manifests. When no published post uses a fact it renders nothing.

**Ordering** is safe because every render reads the facts and writes its files with no `await` in between, and Node runs one request at a time between awaits: an older value can't land after a newer one. Adding an await inside a render path (async I/O, an async postprocess hook) breaks this. Then it needs a per-blog lock, or a re-check of the facts after writing.

## Why no pull, no freeze (v1)

- **No pull from URLs.** A fetcher means SSRF guards, retries, failure states and a cron, all before anyone has shown they reuse facts across posts. Push covers agents, CI jobs and other products. Pull, if it comes, is a host feature on top of `setFact`.
- **No freeze on delete.** Rewriting post bodies to the literal value needs context-aware literal serialisation, concurrent-edit protection and per-post timestamps. `FACT_IN_USE` with the slugs is the honest v1: the agent edits the posts, then deletes.
- **No `post_facts` table.** Usage is derived by scanning bodies (a few hundred posts per blog), so it can't drift from the bodies. `FACT_FANOUT` (200 published fact-using posts) bounds it.

## Dates

- `updated_at` moves only when the value changes, and it is what moves posts' `dateModified`, sitemap `lastmod` and `.md` `updated`. Re-confirming a value never does.
- `confirmed_at` is the publisher's claim. The note shows the oldest among a post's facts, and the wording says "kept current by the publisher", not "verified". It defaults to now. An idempotent replay returns the stored response, so a retry doesn't re-stamp it.
- Post timestamps come in two spellings (ISO from JS, `YYYY-MM-DD HH:MM:SS` from SQLite defaults). `materializePost` compares instants, never strings.

## Example / proof

- `tests/facts-syntax.test.ts`: scanner, hostile values, contexts with line numbers, previews, `materializePost`, auto-excerpt.
- `tests/facts.test.ts`: every representation updates, confirm-only, dry run writes nothing, `expected_value`, delete in use, caps, recovery (failing renderer → pending → drained by a read, a retry, a post write, or `drainPendingFactRenders`).
- `tests/api/facts.test.ts`, `tests/mcp/tool-metadata.test.ts`: REST statuses, cross-blog 404, idempotent replay, MCP output schemas.
- Spec and as-built deviations: `docs/specs/2026-10-21-live-facts.md`.
