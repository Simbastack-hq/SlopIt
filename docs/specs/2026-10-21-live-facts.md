# Live facts: v1 spec

> **Review history.** Written as a proposal, then reviewed twice by an outside model reviewer ("Astra" below): round 1 argued for a private-script pilot instead of a core feature; the owner decided to build it into core, and round 2 reviewed the revised design. This spec takes round 2's must-fixes, with the deviations listed at the end. The debate itself (proposal, both reviews, the author's response) lives in the maintainer's notes, not in this repo. Implemented 2026-10-21; where the build had to depart from this text, see "As built" at the end. Operating notes: `docs/solutions/live-facts.md`.

## What it is

A blog keeps named **facts** (current claims: prices, versions, limits, counts). A post body references one inline as `{{fact:name}}`. Changing a fact re-renders every post that uses it: page, `.md` twin, RSS, sitemap `lastmod`, JSON-LD `dateModified`. Posts that use facts show one honest line saying the publisher keeps those figures current, with the oldest confirmation date. Push-only (the agent, a CI job or another product sets values). Core, MIT, free. No pulling from URLs in v1.

## 1. One syntax and context contract

One module (`src/facts.ts` or `src/rendering/facts.ts`) owns a single scanner used for **validation, dependency listing, dry-run preview and substitution**. No separate substring searches anywhere else.

- Token: `\{\{fact:([a-z][a-z0-9_]{0,39})\}\}` exactly. Anything else (wrong case, spaces, missing braces) is ordinary literal text and never an error.
- Code is never scanned: fenced blocks (``` and ~~~), indented code is out of scope (same trade-off as `stripDangerousBlocks`), inline code spans. Reuse the same code-protecting split as `stripDangerousBlocks` so both agree on what code is.
- Facts are allowed in body text, list items, blockquotes, table cells, emphasis, link text and image alt text.
- Facts are **rejected** (400, specific codes, with the offending line number) in:
  - headings (ATX `#…` lines, and a line directly followed by a setext `===`/`---` underline): `FACT_IN_HEADING`. Anchors and the contents rail must not change when a value changes.
  - link or image destinations `](…)`, reference definitions `[x]: …`, autolinks `<…>`: `FACT_IN_URL`.
  - any post field other than `body` (title, excerpt, seoTitle, seoDescription, tags, slug, coverImage, author): `FACT_NOT_ALLOWED_HERE`.
- Unknown names: rejected when creating or updating a **published** post, and when publishing a draft (`FACT_NOT_FOUND`, `details.names`). Allowed in drafts; the draft preview renders the literal token.
- Existing posts: prod has no `{{` anywhere (checked 2026-10-21), so nothing is reinterpreted.

## 2. Values and substitution

- Value: 1–120 chars after trim, one line, no control characters, and none of `` [ ] < > * _ ` | \ { } ``. Reject with `FACT_VALUE_INVALID` naming the character. This makes a value inert in every allowed markdown context (no links, emphasis, code, HTML, table breaks).
- Substitution happens on the markdown source before parsing, through the scanner, outside code only. If the token starts a line, escape a leading `#`, `-`, `+`, `>`, `=` or a leading `\d+[.)]` with a backslash so the value can't become a heading/list/quote.
- Because every representation is derived from the same substituted markdown, the page, twin and feed always agree, and HTML escaping is marked's normal text escaping.
- `note` (≤200 chars) and `source_url` (https, ≤500 chars) are stored and returned by list/get only. Not rendered in v1.

## 3. Storage (core migration `012_facts.sql`)

- `facts(blog_id TEXT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE, name TEXT NOT NULL, value TEXT NOT NULL, note TEXT, source_url TEXT, confirmed_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (blog_id, name))`.
  - `updated_at`: when the value last changed.
  - `confirmed_at`: the publisher's own claim of when they last checked it (see §5).
- `fact_renders_pending(blog_id TEXT PRIMARY KEY REFERENCES blogs(id) ON DELETE CASCADE, since TEXT NOT NULL)`: durable "this blog's fact-using posts need re-rendering".
- Caps: 100 facts per blog (`FACT_LIMIT`).

## 4. Writes, rendering and recovery

- `PUT` (set) in one SQLite transaction: upsert the fact **and** insert/refresh the blog's `fact_renders_pending` row. Then, in the same request, run the blog's pending fact render; on success delete the pending row.
- Pending render = re-render every **published** post that uses any fact (not just the changed one; simple and self-healing), then the blog's manifests once (llms.txt, feeds, sitemap). Cap: if more than 200 published posts use facts, 413 `FACT_FANOUT` before any write.
- **Recovery without the caller:** any later facts call (get, list, set, delete) and any post write for that blog first drains a pending row if one exists. Export a `drainPendingFactRenders(store, renderer)` that a host can call at boot; the platform calls it on start. A same-value set also drains, so a retry always repairs.
- Ordering: rendering is synchronous and Node is single-threaded, so one request reads the DB and writes every file before another request runs; an older render can't land after a newer one. Keep it that way (no awaits between reading facts and writing files). Note this in a comment.
- Post writes (create/update/publish) render the post with facts applied (the existing render path, materialised; §6).

## 5. Confirmation and dates

- `PUT` accepts optional `confirmed_at` (ISO 8601 date or date-time). Reject future values beyond 5 minutes of skew and anything before 2000 (`FACT_CONFIRMED_AT_INVALID`). Default: now. An idempotent replay returns the stored response unchanged (existing idempotency layer), so a retry never re-stamps it.
- New value → `updated_at` = now and `confirmed_at` as given. Same value → only `confirmed_at` changes.
- Both kinds re-render (the visible line shows a date). Only a value change moves the post's effective modified time.
- Effective modified time of a post = max(`post.updatedAt`, `updated_at` of each fact it uses). Use it for JSON-LD `dateModified`, sitemap `lastmod`, feed dates and the "updated" line, wherever `post.updatedAt` is used today. RSS `guid` unchanged.
- Visible line, only on posts that use ≥1 fact, after the body: **"Some figures on this page are kept current by the publisher. Least recently confirmed: 21 October 2026."** (date = oldest `confirmed_at` among the post's facts, formatted in the post's language like other dates; string goes through `strings.ts` like other chrome strings, English fallback). Page: a theme slot with a muted, small style and a hairline above, matching the theme. Twin and feed: the same sentence as a plain paragraph at the end.

## 6. Materialising posts for rendering

Add one function, e.g. `materializePost(post, facts) → { post: Post (body substituted, updatedAt = effective), factsNote?: { oldestConfirmedAt } }`. The renderer applies it at every place it reads a post: `renderPost`, the published-post list it builds for index/more-from/translations, manifests (llms.txt, feeds, sitemap) and the `.md` twin. Load the blog's facts once per render call. Draft preview uses it too (unknown tokens stay literal). The stored `posts.body` never changes.

## 7. API and MCP

REST (key-scoped like every blog route; 404 `BLOG_NOT_FOUND` for another blog's id):
- `GET /blogs/:id/facts` → `{ facts: [{ name, value, note, source_url, confirmed_at, updated_at, used_by: [{ slug, status }] }], render_pending: boolean }`.
- `GET /blogs/:id/facts/:name` → one fact with `used_by`.
- `PUT /blogs/:id/facts/:name` body `{ value, note?, source_url?, confirmed_at?, expected_value?, dry_run? }`.
  - `expected_value` (optional compare-and-set): if present and the current value differs (or the fact doesn't exist and it isn't `null`), 409 `FACT_CONFLICT` with the current value.
  - `dry_run: true`: **no writes at all**; returns what would happen.
  - Response: `{ fact, changed: boolean, dry_run, affected_posts: [{ slug, title, status, url?, lines: [{ line, before, after }] }], rerendered: number }`. `lines` are whole source lines (paragraph line, list item, table row) containing the token, with the value substituted before/after. Drafts are listed (status) but not rendered.
- `DELETE /blogs/:id/facts/:name`: 409 `FACT_IN_USE` with `details.posts` (slugs, drafts included) if any post references it; otherwise deletes. No freeze in v1.
- Idempotency-Key supported on PUT/DELETE like post routes.

MCP: `set_fact`, `list_facts`, `delete_fact` (get one via `list_facts` or add `get_fact` if it's cheap). Follow the conventions in `docs/solutions/mcp-output-schemas.md` (titles, annotations, outputSchema with optional success fields and the error envelope, param descriptions). Annotations: `list_facts` readOnly; `set_fact` not readOnly, idempotent, **destructiveHint false is wrong** (it changes live pages) — follow the repo's existing choices for `update_post`; `delete_fact` destructive.

Tool descriptions and SKILL.md must say, plainly:
- A fact is a short current claim used in post bodies as `{{fact:name}}`. Use facts only for things that should stay current (prices, versions, limits, counts). Write history ("we launched at $9") as plain text, or it will change when the fact changes.
- Put units and qualifiers inside the value when they can change together (`$12/mo`, `v2.4.1`), because surrounding words never update.
- `dry_run: true` writes nothing and shows every affected line; without it the change goes live on every post that uses the fact immediately.
- Set `confirmed_at` only to when you actually checked the value; re-sending a value doesn't mean it was checked.
- Facts can't go in headings, links, titles or excerpts. A fact used by any post can't be deleted until those posts stop using it.

## 8. Tests (vitest, in core)

Hostile values (each forbidden char; leading `#`/`-`/`1.` at line start), tokens inside code fences/spans left literal, headings/URLs/ref-defs/autolinks/other fields rejected with line numbers, unknown names (draft ok, publish rejected), set → page + twin + feed + sitemap + JSON-LD updated, same-value set moves confirmed date only (note changes, dateModified doesn't), dry_run writes nothing (DB and files untouched), expected_value conflict, delete in use (draft-only use too) → 409, fan-out cap → 413 with no writes, pending render row survives a simulated render failure and is drained by the next call / by `drainPendingFactRenders`, idempotent replay returns the stored response, cross-blog access 404, MCP tools list/annotations/outputSchema, SKILL.md section present, posts without tokens render byte-identical to before.

## 9. Docs

- SKILL.md (`src/skill.ts`): a "Live facts" section with the rules above and one end-to-end example (set → use in a post → change → what updates).
- `docs/solutions/live-facts.md`: the contract, the recovery model, and why no pull/freeze in v1.
- Commit this spec as `docs/specs/2026-10-21-live-facts.md` with a short "review history" note.

## Deviations from Astra's round 2 (and why)

- **No revision tokens for previews.** `expected_value` compare-and-set covers the stale-preview race for a single-value fact at far less API surface.
- **Substitution before parsing instead of an inline extension**, made safe by an inert value charset plus line-start escaping. It gives one substituted source for page, twin and feed, which is Astra's "derive both representations from the same parsed references" in its simplest form.
- **Recovery via a durable pending row drained on the next touch and at boot**, not a background worker. Synchronous single-threaded rendering already prevents older-over-newer writes.
- **Facts banned from headings** rather than making anchors fact-stable.

## As built (2026-10-21, revised after code review)

Departures from the text above. Each is the smallest sound call where the spec turned out wrong or underspecified. The second group came from an outside code review of the first implementation.

**Substitution and syntax**

- **Values never go back through markdown on the way to HTML.** §2's "substitute on the markdown source before parsing" lets a value become a YouTube embed (a URL alone in a paragraph), an autolink (URL, `www.`, email), an entity (`&#49;`) or a table row, whatever the charset. Instead each live token becomes an inert placeholder (private-use characters around a per-render random nonce and an index), the markdown is rendered, and the placeholders are filled with `escapeHtml(value)`. Excerpts and descriptions are derived the same way, with plain values. Line-start escaping is no longer needed for HTML.
- **The `.md` twin is the one place a value is written into markdown.** It is serialised as literal-equivalent markdown with minimal escaping: `&`, `@`, `<`, `>`, `|`, the `:` of `://`, the `.` after a word-start `www`, an entity the author started right before a token (`&#`), plus the line-start rules (container markers, back-to-back tokens, the author's text around them, a `#`/`-`/`=` run typed right before). The result is checked against the parsed structure of the placeholder version. If a value still joins the author's text into syntax (`https:{{fact:a}}` with `//x`, `[{{fact:a}}]` matching a reference), strict escaping is used: every ASCII punctuation character of the value, plus the author's punctuation next to it. A test renders the twin with the page's parser for a matrix of hostile values × contexts and requires byte-equal HTML to the page.
- **Values may not be only `-`, `:`, `=` and spaces**, nor contain `~` (a `~~~` at a line start opens a fence; `~` pairs into strikethrough). The rest of the charset is as specified.
- **Code is decided by marked's lexer, not the split regex.** Tokens are swapped for alphanumeric sentinels and the body is lexed as a render lexes it. That covers multi-backtick spans, inline code over several lines, unclosed fences that run to the end, a 4-backtick fence holding ```` ``` ````, and indented code (the spec's indented-code exception is gone). The same pass classifies contexts: a sentinel in a heading is `FACT_IN_HEADING`, and one in a link or image address or title, or a reference definition's label, address or title, is `FACT_IN_URL`. `<…>` is checked on the source. `\{{fact:name}}` is literal, as markdown escaping says it is.
- **`render()` (the theme template) expands in one pass** and never re-reads inserted values. Two passes made any post text holding `{{x}}` expand or throw. A value could complete one (`{{{{fact:a}}}}`), leaving the fact pending and every later post write failing.

**Excerpts and dates**

- **A post whose body uses facts and has no excerpt of its own stores none.** Rendering derives it from the body each time, live tokens only, values as text (`autoExcerpt` on the placeholder version). A blank excerpt's description fallback is derived the same way and carried in `seoDescription`, the first link of `resolveDescription`'s chain and read nowhere else. A body edit moves a derived excerpt along: to none when the new body uses facts, back to a stored auto-excerpt when it stops. A hand-written excerpt is never replaced, and posts without facts behave as before.
- **Feed items of fact-using posts carry `<atom:updated>`** (the channel already declares the Atom namespace) when the effective modified time is later than publication. `pubDate` and the guid are unchanged, and confirmations never move it. Other posts' items are unchanged, so every existing feed stays byte-identical.

**Writes and recovery**

- **The pending render re-renders every published post page and the home pages**, not only the fact-using posts, because the "More from this blog" blurbs and the home list quote fact-using posts' excerpts. Then the `.md` twins of fact-using posts and the manifests. It renders nothing when no published post uses a fact.
- **A non-dry-run `PUT` drains a pending render before evaluating `expected_value`.** Retrying a compare-and-set whose render failed then repairs the pages, and reports the conflict with the current value. Caps (`FACT_LIMIT`, `FACT_FANOUT`) are still checked first and reject before anything is written or rendered.
- **A dry run writes nothing at all**: no fact, pending row or files, and no idempotency record in either REST or MCP.
- **`drainPendingFactRenders(store, rendererFor)`** takes the per-blog renderer factory (a multi-blog host renders each blog at its own base URL) and returns `{ drained, failed }`.
- **A failed render is `FACT_RENDER_PENDING` (500)** on writes ("saved, pages behind: retry"). Reads (`list`, `get`) report `render_pending: true` instead of failing.

**API**

- **Status codes.** `FACT_NOT_FOUND` is 404 both for a missing fact and for a post write naming one (one code, one status; `translationOf` to a missing slug is already a 404). `FACT_LIMIT` is 413, like the media quota. Invalid names are `FACT_NAME_INVALID` (400).
- **No `get_fact` MCP tool**: `list_facts` returns at most 100 facts. REST has `GET /blogs/:id/facts/:name`, which returns `{ fact, render_pending }`.
- **On `PUT`, `note` and `source_url`**: omitted keeps the stored value, `null` clears it.
- **Tool and schema descriptions use no price examples**, because connector app directories bar prices in an app. SKILL.md keeps its pricing example.
