---
title: Live facts — one lexer-based scanner, placeholders not substitution, a durable pending render
tags: [rendering, facts, api, mcp, db, recovery, templates]
severity: p2
date: 2026-10-21
applies-to: [core, platform, self-hosted]
---

## Rule

A blog's facts (`facts` table) are named current claims. Post bodies use them as `{{fact:name}}`. The stored body keeps the token, and every render shows the current value.

1. **One scanner, decided by marked's lexer.** `analyze` in `src/rendering/facts.ts` swaps each token match for a lowercase alphanumeric sentinel, absent from the source in any case because marked lowercases reference labels, and lexes the body the way a render does. A sentinel inside a `code` or `codespan` token is literal, and one in a heading, link, image or reference definition is a forbidden context. Validation, `used_by`, delete-in-use, dry-run lines and every output go through `scanFacts`/`analyze`. Never search bodies with a regex or `LIKE '%{{fact:%'`: a regex can't agree with markdown about code (multi-backtick spans, unclosed fences, indented code).
2. **Values never go back through markdown on the way to HTML or text.** `materializePost` swaps live tokens for placeholders: private-use characters around a per-render random nonce and an index, so author text can't spell one. It then renders (or excerpts, or extracts a description) and fills the placeholders with the value escaped for that output. Substituting values into the source first lets a value become a YouTube embed, an autolink, an entity or a table row, whatever characters you forbid.
3. **The `.md` twin is the one place a value is written into markdown**, as literal-equivalent text. Only values are escaped; author text is never rewritten. That means minimal backslash-escaping plus line-start rules, then a structure check against the placeholder version, with escaping of every ASCII punctuation character in the values as the fallback. Escaping the author's neighbouring punctuation instead destroyed unrelated links. `tests/facts-syntax.test.ts` renders the twin for a matrix of hostile values × contexts and requires byte-equal HTML to the page. Joins made only of author text around an alphanumeric value (`[{{fact:a}}]` matching a reference definition) can still differ in the twin; the page never does.
4. **Materialise inside the renderer, once.** Every renderer method that reads a post materialises it, loading the blog's facts once per public call. Callers pass stored posts, and so does a host's draft preview. A post without live tokens comes back as the same object, so its output is byte-identical to before. `tests/facts-golden.test.ts` holds a snapshot the pre-facts renderer wrote.
5. **The theme template expands in one pass** (`render` in `templates.ts`). Inserted values (a body, a title) are never read again as `{{var}}`. The old second pass turned post text like `{{x}}` into a template error.
6. **Excerpts of fact-using posts aren't stored.** A body that uses facts and has no excerpt of its own stores `NULL`, and rendering derives the excerpt from live tokens only. A stored excerpt would freeze a value, and the old stripper also mangled tokens (underscores) and dropped code provenance.

## Recovery model

`setFact` upserts the fact and a `fact_renders_pending` row in one transaction, then re-renders in the same request and deletes the row. A failure leaves the row:
- writes then fail with `FACT_RENDER_PENDING` (500, "saved, pages behind, retry")
- reads report `render_pending: true`

Several things drain a pending row:
- the next facts call
- a post write (`createPost`, `updatePost` and `deletePost` drain first)
- a retried `PUT`: a real write drains before it evaluates `expected_value`, so a compare-and-set retry repairs the pages and then reports the conflict with the current value
- hosts call `drainPendingFactRenders(store, rendererFor)` at boot to cover a crash (`examples/self-hosted` and the platform's `main.ts` do)

Caps are checked before the drain, so a capped request writes and renders nothing. A dry run drains nothing and stores no idempotency record: the REST middleware honours `skipIdempotencyRecord`, and `wrapTool` honours `recordIf`.

The re-render covers:
- every published post page, because the "More from" blurbs quote fact posts
- the home pages
- the `.md` of each fact-using post
- the manifests

When no published post uses a fact, it renders nothing.

**Ordering** is safe because each render reads the facts and writes its files with no `await` in between, and Node runs one request at a time between awaits. So an older value can't land after a newer one. An `await` inside a render path (async I/O, an async postprocess hook) breaks this, and would then need a per-blog lock.

## Why no pull, no freeze (v1)

- **No pull from URLs.** A fetcher needs SSRF guards, retries, failure states and a cron, and nobody has yet shown they reuse facts across posts. Push covers agents, CI jobs and other products. Pull, if it comes, is a host feature on top of `setFact`.
- **No freeze on delete.** Rewriting post bodies to the literal value needs the twin serialiser plus concurrent-edit protection and per-post timestamps. `FACT_IN_USE` with the slugs is the honest v1.
- **No `post_facts` table.** Usage is derived by scanning bodies, so it can't drift from them. `FACT_FANOUT` (200 published fact-using posts) bounds the scan and the render.

## Dates

- `updated_at` moves only when the value changes. It drives:
  - posts' `dateModified`
  - sitemap `lastmod`
  - `.md` `updated`
  - the feed item's `<atom:updated>` (fact-using posts only; other posts' feed items are unchanged)

  Re-confirming a value never moves it.
- `confirmed_at` is the publisher's claim. The note shows the oldest among a post's facts. It defaults to now, and an idempotent replay returns the stored response, so it isn't re-stamped.
- Post timestamps come in two spellings: ISO from JS, and `YYYY-MM-DD HH:MM:SS` from SQLite defaults. Use `instant()` to compare them, never string comparison.

## Example / proof

- `tests/facts-syntax.test.ts`: code via the lexer, hostile values on the page and in the twin (byte-equal), contexts with line numbers, previews, `materializePost`.
- `tests/facts.test.ts`:
  - every representation updates
  - `<atom:updated>`
  - confirm-only
  - a dry run writes nothing
  - CAS
  - CAS retry after a failed render
  - delete in use
  - caps
  - recovery paths
  - template literals
  - YouTube and `www.` values stay text
- `tests/api/facts.test.ts`, `tests/mcp/tool-metadata.test.ts`: statuses, cross-blog 404, idempotent replay, no record for dry runs, MCP output schemas.
- Spec with as-built notes: `docs/specs/2026-10-21-live-facts.md`.
