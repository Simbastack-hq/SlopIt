# Media Upload — Design

**Status:** Approved · **Date:** 2026-04-27 · **Scope:** `slopit` core (open-core MIT side); `slopit-platform` only inherits config.

## Goal

Let an agent publish a blog post that includes images the user attached to chat. Today `coverImage` accepts a URL and the markdown body can reference any external image, but SlopIt has no place to *put* bytes the agent holds. Adding upload closes the gap from "tell Claude to publish a post with these photos" to "live URL with images" in one conversation.

Non-goal: hosting arbitrary binary assets. This is image upload for blog posts. Video, audio, PDF, generic file storage are explicitly out.

## Architecture

Two-step upload, REST-primary, MCP-fallback. Bytes live on disk under each blog's static-output directory and are served through the same static handler that serves rendered HTML. Same API key auth and `crossBlogGuard` as posts. Same `_links` envelope on REST.

```
agent ──► POST /blogs/:id/media (multipart, raw bytes)  ─┐
                                                         ├─► uploadMedia()
agent ──► MCP upload_media (base64 fallback)            ─┘   ├─► validate (type, size)
                                                             ├─► transaction: quota check + INSERT
                                                             └─► mkdir + writeFileSync to <_media>/<id>.<ext>
                                                             returns { media: {id, url, …} }

agent ──► create_post / POST /blogs/:id/posts
            body markdown references the returned URL(s)
            optional coverImage = returned URL
```

## Open-core split

All of this lives in **core** (`slopit`). Self-hosters get media upload for free. Platform overrides per-file and per-blog caps via factory config; no platform-specific media code.

| Concern | Where |
|---|---|
| Upload primitive (`src/media.ts`) | core |
| REST endpoints | core (`createApiRouter`) |
| MCP tools | core (`createMcpServer`) |
| On-disk storage path | core (under blog output dir) |
| Default per-file cap (5 MB) | core |
| Default per-blog total cap (unlimited) | core |
| Plan-tier quotas (e.g. 500 MB free / unlimited Pro) | platform — passes config in |
| Static file serving | core's renderer outputs files; platform's `cachedStatic` (or self-hoster's Caddy) serves them |

## Storage layout

- Path: `<blog-output-dir>/_media/<id>.<ext>`
- `id` comes from existing `generateShortId()` in [src/ids.ts](../../../src/ids.ts) — global, like post `id`.
- `<ext>` is **derived from the validated content-type**, not from the original filename:
  - `image/jpeg` → `jpg`
  - `image/png` → `png`
  - `image/gif` → `gif`
  - `image/webp` → `webp`
- The `_` prefix avoids slug collisions: post slugs are `[a-z0-9][a-z0-9-]*[a-z0-9]`, so `_media` cannot ever conflict.
- Original filename is metadata only (stored in DB for display in `list_media`), never used to build the path.

### URL form

`url` is computed at read time, not stored:

```
url = renderer.baseUrl + '_media/' + id + '.' + ext
```

`renderer.baseUrl` is already the absolute public URL of the blog (e.g. `https://my-blog.slopit.io/` for tenant blogs, `https://slopit.io/b/<id>/` for the apex `/b/*` form). Returned `url` is therefore always absolute — agents reference it directly with `![alt](returned_url)`, never synthesise paths.

### Why not store `url` in the DB

It's a deterministic function of `(baseUrl, id, ext)`. Storing it duplicates state that would otherwise drift if a blog migrates hostnames. Compute on read.

## DB schema (one new table)

```sql
CREATE TABLE media (
  id           TEXT PRIMARY KEY,                         -- short id, also the filename stem
  blog_id      TEXT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,                            -- original filename, display only
  content_type TEXT NOT NULL,                            -- 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  bytes        INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_media_blog ON media(blog_id);
```

### Decisions

- **Global `id` PRIMARY KEY** (not composite `(blog_id, id)`). Consistent with `posts.id`. Routes are blog-scoped and cross-blog access is blocked at query level (`WHERE blog_id = ? AND id = ?`). Short-id collision is astronomically unlikely; if it happens, the `INSERT` raises `SQLITE_CONSTRAINT_UNIQUE` and bubbles as a 500 — same behaviour as posts. v1 accepts this.
- **`ON DELETE CASCADE`** cleans `media` rows when a blog row is deleted via SQL. **There is no `deleteBlog` primitive or `DELETE /blogs/:id` route in core today** — `removePostFiles` is the only file-cleanup hook on the renderer. So in v1 the cascade is the DB half only; disk cleanup of a deleted blog's `_media/` directory is **out of scope** for this spec. When a blog-delete path is later introduced, it will own removing `<outputDir>/<blogId>/` (which contains both `_media/` and rendered post directories) as a single rmSync — no media-specific code needs to change.
- **No `url` column** (see above).

## Module: `src/media.ts` (the primitive)

REST and MCP must not each implement file writes — they share a single primitive, mirroring how `src/posts.ts` is shared today.

### Renderer contract extension

`ApiRouterConfig` and `McpServerConfig` only expose `rendererFor(blog) → MutationRenderer`; the renderer is the existing source of truth for "where do this blog's files live." It owns `outputDir` internally and computes paths like `<outputDir>/<blogId>/<slug>`. Today's `MutationRenderer` does not surface that path — it only exposes `removePostFiles(blogId, slug)`.

This spec extends `MutationRenderer` with **one new method**:

```ts
interface MutationRenderer extends Renderer {
  removePostFiles(blogId: string, slug: string): void
  /**
   * Absolute path to the blog's media directory (`<outputDir>/<blogId>/_media`).
   * Pure path computation — does not create the directory. Callers mkdir on
   * first write.
   */
  mediaDir(blogId: string): string
}
```

The shipped `createRenderer` implements `mediaDir(blogId)` as `join(config.outputDir, blogId, '_media')` — one line, mirrors how `removePostFiles` is implemented today. Custom renderers that don't write to disk (e.g. an object-storage variant a future self-hoster might build) MUST implement this method even if they internally route the bytes elsewhere; the upload primitive treats the returned string as opaque file-system path. Object-storage renderers are out of scope for v1.

### Primitive shape

```ts
// src/media.ts

export interface MediaRow { id; blogId; filename; contentType; bytes; createdAt }
export interface MediaWithUrl extends MediaRow { url: string }

export interface MediaLimits {
  maxBytes:             number          // per-file cap, default 5_000_000
  maxTotalBytesPerBlog: number | null   // null = unlimited
}

export function uploadMedia(
  store: Store,
  renderer: MutationRenderer,           // provides baseUrl + mediaDir(blogId)
  limits: MediaLimits,
  blog: Blog,
  input: { filename: string; contentType: string; bytes: Uint8Array },
): MediaWithUrl

export function listMedia  (store: Store, renderer: MutationRenderer, blogId: string): MediaWithUrl[]
export function getMedia   (store: Store, renderer: MutationRenderer, blogId: string, id: string): MediaWithUrl
export function deleteMedia(store: Store, renderer: MutationRenderer, blogId: string, id: string): { deleted: true }
```

Both transports call into this module. All validation, quota checks, filename mapping, DB writes, and file cleanup live here. Per-blog `MediaLimits` is built from the factory config's `mediaMaxBytes` / `mediaMaxTotalBytesPerBlog`.

## Atomicity & compensation

`uploadMedia` has two durable side effects: a row in `media` and a file on disk. Order matches the convention already established in `createPost` ([src/posts.ts](../../../src/posts.ts)): DB first, then file. Compensation on file-write failure removes the orphan row.

```
1. validate inputs (content-type in allowed list, size ≤ maxBytes)
2. const tx = store.db.transaction(() => {
     const used = SELECT IFNULL(SUM(bytes), 0) FROM media WHERE blog_id = ?
     if (limits.maxTotalBytesPerBlog !== null
         && used + bytes.length > limits.maxTotalBytesPerBlog) throw MEDIA_QUOTA_EXCEEDED
     INSERT INTO media (...)
   })
   tx()
3. mkdirSync(renderer.mediaDir(blog.id), { recursive: true })
4. writeFileSync(<mediaDir>/<id>.<ext>, bytes)
```

Failure handling:

- Step 1 throws → no row, no file. Bubble.
- Step 2 throws (quota or any other DB error) → no row, no file. Bubble.
- Step 3 or 4 throws → DELETE FROM media WHERE id = ? (compensation), best-effort unlink of any partially-written file, bubble the original error.

Invariant after `uploadMedia` returns: **row and file both exist.** Weakened invariant on failure (mirroring posts.ts spec decision #6): if compensation DELETE itself fails after a file write failed, the row persists with no file; operator cleanup is needed. Astronomically rare, tolerable.

### Why DB-first, not file-first

posts.ts uses DB-first ordering and accepts "orphan row" as the rare-failure mode. Matching that convention keeps the codebase consistent and means readers/agents who already understand the post mutation pattern understand media too. File-first would shift the rare-failure mode to "orphan file on disk" — equivalent in pain, different in shape, and inconsistent.

### Why the quota check is inside the transaction

SlopIt runs as a single Node process with synchronous `better-sqlite3`, so two callers can't be inside the same transaction simultaneously. Wrapping the SELECT-SUM + INSERT in one transaction is for consistency, not concurrency: the unit of work either fully commits (row inserted, total updated) or fully aborts (quota throw, no row). This matches the slug-conflict preflight inside the post-create transaction in [src/posts.ts](../../../src/posts.ts).

### What we are NOT doing

- **No magic-byte sniffing.** v1 trusts the declared content-type. Rationale: agents in this product receive valid images from a user and forward them; mislabeling is an agent bug we'd see real reports of before it became a real problem. Adding signature checks now is YAGNI. Revisit if any actual report comes in.
- **No `.tmp` + atomic rename.** Single-process `writeFileSync` either completes or throws; readers can't observe a partial file at the final path because the URL isn't returned until after the write. The `.tmp` dance is defensive complexity for a multi-writer atomic-replace pattern that doesn't apply here.

`deleteMedia`:

```
1. SELECT row (throws MEDIA_NOT_FOUND)
2. DELETE FROM media (atomic)
3. unlink the file (ENOENT-tolerant — file already gone is fine)
```

Weakened invariant: if step 3 fails after step 2 succeeds, the row is gone but the file remains as an orphan (publicly addressable but unreferenced). Tolerable because the file is now unreachable via `list_media` / `get_media` and the row will not be re-created. Operator cleanup is possible by walking `_media/` and reconciling against `media` table — not built in v1.

## Validation

| Check | Rule | Error code |
|---|---|---|
| Content-type allowed | one of `image/jpeg`, `image/png`, `image/gif`, `image/webp` | `MEDIA_TYPE_UNSUPPORTED` (400) |
| Per-file size | `bytes.length ≤ maxBytes` (default 5 MB) | `MEDIA_TOO_LARGE` (413) |
| Per-blog total | `currentTotal + bytes.length ≤ maxTotalBytesPerBlog` (when not null) | `MEDIA_QUOTA_EXCEEDED` (413) |

The declared `content-type` is trusted. The "What we are NOT doing" subsection above explains the YAGNI call on signature sniffing; the YAGNI fence at the bottom of the spec restates it as a v1 commitment.

## REST endpoints

Mounted under the existing API router. Auth via existing bearer-token middleware. `_links` envelope per existing convention.

| Route | Body | Returns |
|---|---|---|
| `POST /blogs/:id/media` | multipart/form-data, single file field `file` | `{ media, _links }` |
| `GET  /blogs/:id/media` | — | `{ media: MediaWithUrl[], _links }` |
| `GET  /blogs/:id/media/:mid` | — | `{ media, _links }` |
| `DELETE /blogs/:id/media/:mid` | — | `{ deleted: true, _links }` |

Multipart parsing: Hono's `c.req.parseBody()`. Single file per request; multiple-file uploads are not supported in v1 (one round-trip per image keeps the contract simple and matches how the MCP fallback works).

### Boundary parse errors — explicit contract

The endpoint and tool surfaces have several "malformed transport" cases that are distinct from validation failures on otherwise-well-formed inputs. The spec names them so tests and `SKILL.md` agree:

| Case | Mapped to | HTTP |
|---|---|---|
| REST: no `file` field present in multipart body | `BAD_REQUEST` (`"multipart 'file' field required"`) | 400 |
| REST: more than one `file` field | `BAD_REQUEST` (`"only one file per request"`) | 400 |
| REST: `file` field present but not a `File` (e.g. plain string) | `BAD_REQUEST` (`"'file' must be a binary upload"`) | 400 |
| REST: file present but zero bytes | `BAD_REQUEST` (`"file is empty"`) | 400 |
| REST: missing `Content-Type: multipart/form-data` header | `BAD_REQUEST` (`"multipart/form-data required"`) | 400 |
| MCP: malformed base64 in `data_base64` | `ZOD_VALIDATION` (Zod base64 refinement at the tool boundary) | 400 |
| MCP: empty `data_base64` (decodes to 0 bytes) | `ZOD_VALIDATION` | 400 |
| MCP: missing or empty `filename` / `content_type` | `ZOD_VALIDATION` (existing pattern) | 400 |

These reuse the existing `BAD_REQUEST` and `ZOD_VALIDATION` codes — no new error codes for transport-level parse failures. Type/size/quota checks (the table earlier) get the dedicated `MEDIA_*` codes because those are domain-level rejections an agent might want to recover from differently.

## MCP tools

| Tool | Args | Notes |
|---|---|---|
| `upload_media` | `{ blog_id, filename, content_type, data_base64, idempotency_key? }` | Decodes base64, then same `uploadMedia()` call as REST. |
| `list_media`   | `{ blog_id }` | |
| `delete_media` | `{ blog_id, media_id, idempotency_key? }` | |

No `get_media` MCP tool — `list_media` already returns full metadata + URL; an extra round-trip isn't worth a tool slot.

Standard `wrapTool` flags apply: `auth: 'required'`, `crossBlogGuard: true`, `idempotent: true` on writers.

## Idempotency — fix the middleware, not the symptom

**Critical implementation note.** Today's `idempotencyMiddleware` ([src/api/idempotency.ts:38](../../../src/api/idempotency.ts#L38)) reads the request body via `await c.req.text()` and rebuilds the request with `body: rawBody` (a string). For multipart bodies that contain binary bytes, the UTF-8 round-trip corrupts the payload — uploaded images would be silently mangled when an `Idempotency-Key` header is present.

**Fix as part of this work, not workaround:**

1. Buffer the body as `await c.req.raw.arrayBuffer()` instead of `text()`.
2. Reconstruct the request with the `ArrayBuffer` (or `Uint8Array`) body.
3. Hash the bytes (not the decoded string) for `requestHash`.
4. Update tests for existing JSON endpoints to confirm no behavioural change (string body and bytes-of-string body hash deterministically; the storage shape is unchanged because we never persisted the body, only its hash).

A future binary endpoint (file uploads of any kind) hits the same issue — fixing once is the correct call. Per-endpoint opt-out would require every future binary route to remember to opt out, which is exactly the kind of hidden landmine SlopIt's design avoids.

## Auth & multi-tenant scoping

- Same bearer API key as posts. No new credential type.
- `crossBlogGuard` middleware (REST + MCP) blocks blog-A keys from touching blog-B media.
- `apiKeyHash` available in idempotency middleware for write tools.

## Lifecycle / orphans

- **Deleting a post does NOT delete media it referenced.** Media is independent. The same image might be embedded in multiple posts (markdown body has no tracked back-reference) or kept around for a future post. Cascade would be wrong.
- `delete_media` is the explicit, separate operation when the user/agent wants the bytes gone.
- **No orphan-cleanup job in v1.** If unreferenced media becomes a real problem, add a `find_orphan_media` later. Disk is cheap; premature reaping is not.
- Deleting a blog row at the SQL level cascades the `media` rows via FK. **Disk cleanup of `_media/` on blog delete is not covered by this spec** — see the schema section above. Core has no `deleteBlog` primitive today; when one is added, it will own removing `<outputDir>/<blogId>/` wholesale.

## Configuration additions

Both factory configs gain two fields:

```ts
interface ApiRouterConfig {
  // …existing…
  mediaMaxBytes?:            number          // default 5_000_000
  mediaMaxTotalBytesPerBlog?: number | null  // default null (unlimited)
}

interface McpServerConfig {
  // …existing…
  mediaMaxBytes?:            number
  mediaMaxTotalBytesPerBlog?: number | null
}
```

MCP must not bypass quotas — same defaults, same plan-tier overrides. Platform passes both into both factories.

## Errors (additions to existing table)

| Code | HTTP | Meaning |
|---|---|---|
| `MEDIA_NOT_FOUND` | 404 | Unknown media id (within the authenticated blog). |
| `MEDIA_TYPE_UNSUPPORTED` | 400 | `content_type` not in allowed list. `details.content_type` echoes input. |
| `MEDIA_TOO_LARGE` | 413 | File exceeds per-file cap. `details.max_bytes` returned. |
| `MEDIA_QUOTA_EXCEEDED` | 413 | Blog's total media quota exhausted. `details.{used_bytes, quota_bytes}` returned. |

## Agent discoverability — _links + tool descriptions

Two agent-facing surfaces need updates so an agent can find and use this without reading docs first:

### `_links` block ([src/api/links.ts](../../../src/api/links.ts))

`LinksBlock` is the HATEOAS index every authenticated 2xx REST response carries. Add two fields:

```ts
interface LinksBlock {
  view: string
  publish: string
  list_posts: string
  upload_media: string   // new — `/blogs/${blog.id}/media`
  list_media: string     // new — same path, GET
  dashboard?: string
  docs?: string
  bridge: string
}
```

An agent that has *any* prior response from the API now knows the upload endpoint exists and where to send bytes — no separate discovery call.

### MCP tool descriptions

Voice matches existing tools in [src/mcp/tools.ts](../../../src/mcp/tools.ts) — short, imperative, names the inputs, says what comes back. Examples to use verbatim:

- `upload_media`: `"Upload an image (JPEG/PNG/GIF/WebP, max 5MB) as base64 in `data_base64`. Returns a public URL — use it as ![alt](url) in post markdown or pass as coverImage."` (kept under the 240-char `tool-descriptions.test.ts` guard)
- `list_media`: `"List uploaded images for the blog. Returns each image's id, public URL, content type, and byte size."`
- `delete_media`: `"Permanently delete an uploaded image by id. The URL stops working immediately. Posts that referenced it will show a broken image until edited."`

The `upload_media` description is load-bearing: it tells the agent in one sentence what to send, what comes back, and what to do with the result. An agent that reads only this string should be able to use the tool correctly.

## Agent docs ([src/skill.ts](../../../src/skill.ts))

Update `generateSkillFile`:

1. **Endpoints table** — add four `/media` rows.
2. **MCP tools list** — add `upload_media`, `list_media`, `delete_media` (parity with REST).
3. **New section "Posts with images"** — show the two-step flow:

   ```
   1. Upload each image:
      POST /blogs/:id/media (multipart, file=<bytes>)
      → { media: { url: "https://my-blog.slopit.io/_media/abc123.jpg", … } }

   2. Create post referencing the returned URL(s):
      POST /blogs/:id/posts
      Content-Type: text/markdown

      # My trip to Lisbon
      ![View from the castle](https://my-blog.slopit.io/_media/abc123.jpg)
      …
   ```

   Explicitly state: the returned `url` is absolute. Use it as-is in `![alt](url)` and `coverImage`. Do not synthesise paths.

4. **Error codes table** — add the four new codes.

## Testing

Per [CLAUDE.md:111](../../../CLAUDE.md#L111): each REST endpoint and each MCP tool gets happy-path + one failure mode. Plus:

- **Cross-blog isolation:** key-A cannot read or delete key-B's media (separate test from the existing post-isolation test).
- **Quota exceeded:** inject a low `mediaMaxTotalBytesPerBlog` (e.g. 100 bytes) and confirm second upload rejects with `MEDIA_QUOTA_EXCEEDED` and accurate `used`/`quota` numbers.
- **Idempotency on binary upload:** same `Idempotency-Key` + same bytes → identical response. Same key + different bytes → `IDEMPOTENCY_KEY_CONFLICT`. (This is the regression test for the middleware fix.)
- **Atomicity / post-INSERT failure:** make `mkdirSync` or the file write fail (e.g. plant a regular file at the path that should become the media directory so `mkdirSync` hits `ENOTDIR`) → confirm DB row is rolled back via the compensation DELETE and no orphan file is left on disk. (Avoid `vi.spyOn(fs, 'writeFileSync')` — ESM named bindings are read-only after import, so namespace-level spies don't reach `media.ts`'s already-resolved binding.)
- **`ON DELETE CASCADE`:** delete a blog → assert `media` rows for that blog are gone.
- **Delete is ENOENT-tolerant:** pre-delete the file on disk, then call `deleteMedia` → DB row removed, no error.

## YAGNI fence — explicitly NOT in v1

- No resize, thumbnails, srcset, or responsive-image generation.
- No EXIF stripping or privacy scrubbing.
- No CDN, signed URLs, or hotlink protection.
- No video, audio, or PDF support — images only.
- No transformations API (`?w=800`-style URLs).
- No drag-drop UI in the dashboard. Read-only stays read-only.
- No object storage backend, no S3, no platform-specific storage path.
- No de-duplication.
- No per-user/per-day rate limiting beyond what platform-level rate limiting already provides.
- No orphan-media cleanup job.
- No multiple-file-per-request upload.
- No `get_media` MCP tool (REST `GET` exists; MCP has `list_media`).
- No magic-byte / signature sniffing — declared `content-type` is trusted.
- No `.tmp` + atomic-rename for uploads — DB-first ordering with compensation matches `posts.ts`.

If a real user hits one of these, we revisit. None of them block the core "tell my agent to publish a post with these photos" flow.

## Implementation order (rough)

1. Migration: `media` table + index.
2. Extend `MutationRenderer` with `mediaDir(blogId)`; implement in shipped `createRenderer`. Update any test doubles.
3. Add `MEDIA_NOT_FOUND`, `MEDIA_TYPE_UNSUPPORTED`, `MEDIA_TOO_LARGE`, `MEDIA_QUOTA_EXCEEDED` to `SlopItErrorCode` and to `CODE_TO_STATUS`. (TypeScript will force most of this if `SlopItErrorCode` is a union, but call it out explicitly so a missed entry doesn't silently default to 500.)
4. `src/media.ts` primitive + unit tests (validation, atomicity / compensation, in-transaction quota).
5. Idempotency middleware fix (`arrayBuffer()` instead of `text()`) + regression tests on existing JSON endpoints + new test for binary-safe replay.
6. REST endpoints + tests, including the boundary-parse-error contract above. Update `buildLinks` to include `upload_media` and `list_media` in the `_links` block; update its unit tests.
7. MCP tools + tests, including base64 boundary-parse contract. Tool descriptions match the agent-friendly voice spec'd in "Agent discoverability."
8. `src/skill.ts` updates + drift test (existing pattern).
9. Platform: pass `mediaMaxBytes` / `mediaMaxTotalBytesPerBlog` from plan tier into both `createApiRouter` and `createMcpServer`.
