# MCP Tools — Design Spec

**Status:** Design draft v1 (2026-04-24).
**Scope:** `@slopit/core`, fourth feature pass. Wires the MCP server on top of the REST primitives shipped in `feat/rest-routes-mcp` (PR #3). After this feature, an agent connected over MCP can sign up, publish, read, update, and delete posts with the same semantics as REST.
**Branch:** `feat/mcp-tools` (from `dev @ 90b540f`).
**Follows:** `2026-04-23-rest-routes-mcp-design.md`. MCP is a second transport, not a second data model — schemas, error codes, and idempotency semantics mirror REST unless explicitly noted.

---

## Context

`createMcpServer` is a stub that throws. The core primitives (`createBlog`, `createApiKey`, `createPost`, `updatePost`, `deletePost`, `getBlog`, `getPost`, `listPosts`, `verifyApiKey`, `hashApiKey`) already exist, are validated by 308 tests, and have 100% line coverage on `src/api/*`. This feature is almost entirely wiring — plus three new transport-agnostic helpers lifted out of the existing REST code (`mapErrorToEnvelope`, `lookupIdempotencyRecord` / `recordIdempotencyResponse`, and `resolveBearer`). The REST code is refactored to call those helpers; external REST behavior is unchanged.

Design inputs folded in up front:

- `slopit-platform/strategy.md` — canonical MCP tool list (post-REST-spec, 8 tools).
- `docs/superpowers/specs/2026-04-23-rest-routes-mcp-design.md` — REST spec. Error envelope, idempotency contract, cross-blog guard, signup-idempotency exclusion (decision #22), weakened-durability guarantee (decision #20).
- `docs/superpowers/handoffs/feat-mcp-tools.md` — scope tiers, open design questions, REST-parity requirements.
- `PRODUCT_BRIEF.md` — tool descriptions are audience-#1-facing (the LLM renders them to a non-technical user); agent-facing text in SKILL.md is audience-#3.

MCP is configured through the same shape as REST: `createMcpServer(config)` takes fields that are a strict subset / superset overlap with `ApiRouterConfig`. The platform passes the same config object to both factories.

---

## Design decisions (resolved in brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Per-connection bearer auth.** `authMode: 'api_key'` reads the bearer from two sources, first-hit wins: `extra.authInfo?.token` (transport-native — used by `InMemoryTransport.send({ authInfo })` and OAuth HTTP) and `extra.requestInfo?.headers` case-insensitively (HTTP transports' `Authorization: Bearer <key>` header). Stdio uses `authMode: 'none'` (single-tenant self-host). Per-call `apiKey` tool argument is NOT supported. | Real MCP clients configure one bearer per connection. Per-call `apiKey` clutters every tool's schema. Reading both sources keeps the test harness clean (InMemoryTransport's native `authInfo`) AND supports real HTTP headers. |
| 2 | **Error envelope = `content` text + `structuredContent`.** Every error returns `{ isError: true, content: [{ type: 'text', text: '${code}: ${message}' }], structuredContent: { error: { code, message, details } } }`. | Text content keeps older MCP clients rendering a readable message; `structuredContent` matches REST's envelope 1:1 so agents can dispatch on `code`. |
| 3 | **Extract a shared idempotency helper** (`src/idempotency-store.ts`) called by both REST's Hono middleware and MCP's `wrapTool`. Same `idempotency_keys` table, same scope-tuple semantics, same weakened-durability guarantee (decision #20 from REST spec). | Two callers with identical invariants (scope tuple, hash, same DB table) is exactly the threshold where extraction beats duplication. Idempotency semantics are the one thing that must not diverge silently between transports. |
| 4 | **`wrapTool` higher-order function** wraps each tool's business logic in the auth → cross-blog guard → idempotency → error-envelope pipeline. The 8 tool registrations each pass a `WrapToolOpts` + a thin business handler. | Keeps per-tool logic readable and greppable while ensuring the cross-cutting plumbing lives in one place. Prevents silent divergence (e.g. forgetting the cross-blog guard on a single tool). |
| 5 | **Config mirrors `ApiRouterConfig` 1:1.** Same field names, same types, same defaults. | Platform passes a single config object to both `createApiRouter` and `createMcpServer` without renames. |
| 6 | **`signup` tool rejects `idempotency_key` at the schema layer.** `CreateBlogInputSchema` is already `.strict()`-compatible and does not include `idempotency_key`. Any such arg fails SDK-level Zod validation and surfaces as the SDK's standard `{ isError: true, content: [{ text: 'Input validation error: ...' }] }` — no `structuredContent`. See decision #15 for why MCP validation errors do not carry the `ZOD_VALIDATION` envelope. | MCP mirror of REST decision #22. The arg is rejected, not silently dropped — that's the security invariant. The SDK-shaped error is still a discoverable signal for the regression guard test. |
| 7 | **Cross-blog guard mirrors REST decision #18.** `args.blog_id !== ctx.blog.id` → `BLOG_NOT_FOUND` (same envelope as a genuinely-missing blog). | Don't leak existence of other blogs. |
| 8 | **Idempotency scope uses `method = "MCP"`, `path = toolName`.** Namespaces MCP idempotency keys away from REST so the same key reused on REST `POST /blogs/:id/posts` and MCP `create_post` does not collide. | Prevents cross-transport replay ambiguity. The `method` column is already in the existing `idempotency_keys` primary key; no schema change needed. |
| 9 | **Canonical-JSON hashing for MCP idempotency.** `request_hash = sha256("MCP" + "\0" + toolName + "\0" + canonicalJson(args without idempotency_key))` where canonicalJson sorts object keys and emits no whitespace. | MCP args arrive JSON-parsed; there is no "raw body bytes" to hash. Canonical-key-sorted serialization gives agents stability across JSON library differences. Differs from REST's bytewise hash — documented in SKILL.md. |
| 10 | **Tool descriptions are non-technical.** Short imperative sentences. Banned vocabulary enforced by a test: `endpoint`, `MCP`, `middleware`, `primitive`, `bridge`. | Descriptions are rendered by an LLM for audience #1 (non-technical users). `PRODUCT_BRIEF.md` language rules apply. |
| 11 | **Zod schemas passed directly to `registerTool`.** No pre-conversion via `z.toJSONSchema()`. The MCP SDK's `registerTool` accepts a Zod schema as `inputSchema` and converts it to JSON Schema internally for the `tools/list` response. The SDK also uses it to validate args *before* our callback runs — see decision #15 for the consequence on error shape. | One less step. The handoff's "`z.toJSONSchema()` from existing Zod schemas" language predates full Zod support in the SDK. Behavior is equivalent on the wire. |
| 12 | **`createMcpServer` returns an unattached `McpServer`.** The consumer calls `await server.connect(transport)` themselves. Core does not bundle a transport. | Matches ARCHITECTURE rule #4 (factories, not servers) and the REST pattern (`createApiRouter` returns a Hono app). |
| 13 | **Tier 2 examples: stdio + HTTP.** `examples/self-hosted/mcp-stdio.ts` pairs with `authMode: 'none'`. `examples/self-hosted/mcp-http.ts` mounts `WebStandardStreamableHTTPServerTransport` alongside REST under the same Hono instance, pairing with `authMode: 'api_key'`. | Stdio is the local-dev / single-tenant path; HTTP is the shape the platform PR will mirror. |
| 14 | **No MCP resources, prompts, or progress notifications.** Tools only. | Publishing is fast and atomic; no progress to report. `generateOnboardingBlock` output lives in the `signup` tool's result field; no MCP `prompts/` surface needed. |
| 15 | **SDK-shaped validation errors, not REST-parity validation envelopes.** Input-schema failures in MCP SDK 1.29 are validated *before* the tool callback runs (see `server/mcp.js:125` — `validateToolInput` throws `McpError(InvalidParams)`, caught and wrapped into `{ isError: true, content: [{ type: 'text', text: 'Input validation error: ...' }] }` without `structuredContent`). `wrapTool`'s catch block never sees them. Accepted as-is rather than bypassing SDK validation. | Bypassing SDK validation would mean not publishing `inputSchema` on `tools/list`, which regresses LLM tool-calling UX (the LLM can't see the arg shape from the manifest). Validation errors are a rare/adversarial path — REST parity matters for the common business errors (`BLOG_NOT_FOUND`, `POST_SLUG_CONFLICT`, `IDEMPOTENCY_KEY_CONFLICT`, `UNAUTHORIZED`, etc.) which all flow through `wrapTool` and get the unified envelope. |
| 16 | **Idempotency is api_key-mode only.** `authMode: 'none'` skips idempotency storage and replay entirely (`ctx.apiKeyHash === ''` → pipeline step 3 is a no-op). This mirrors the REST middleware's existing behavior (decision #22 from REST spec: empty api_key_hash → no idempotency). Self-host stdio agents are single-caller; retries produce the same observable outcomes as the REST crash window (decision #20). | Synthetic self-host scopes (`authMode:none:<blog_id>`) add code for no real benefit: a self-host stdio user running one agent against one process doesn't need replay — the agent can inspect state before retrying. Documented in SKILL.md. |

---

## Files

| File | New/Modified | Role |
|---|---|---|
| `src/mcp/server.ts` | MODIFY | `createMcpServer(config)` factory. Constructs an SDK `McpServer`, calls `registerTools(server, config)`, returns the server. No transport attached. |
| `src/mcp/tools.ts` | NEW | `registerTools(server, config): void`. The 8 tool registrations + their business handlers. |
| `src/mcp/wrap-tool.ts` | NEW | `wrapTool(config, name, opts, business): ToolCallback`. Auth + cross-blog + idempotency + error-envelope pipeline in one place. |
| `src/mcp/auth.ts` | NEW | `resolveBearer(extra, config): string \| null`. Tries `extra.authInfo?.token` first (transport-native — set by `InMemoryTransport.send({ authInfo })` or OAuth middleware), then `extra.requestInfo?.headers` case-insensitively (the SDK's `IsomorphicHeaders` is a plain record, not a `Headers` instance); `null` under `authMode: 'none'`. |
| `src/idempotency-store.ts` | NEW | Transport-agnostic. `lookupIdempotencyRecord(store, scope): { status: 'miss' } \| { status: 'hit-match', body: string, responseStatus: number } \| { status: 'hit-mismatch' }` + `recordIdempotencyResponse(store, scope, body, responseStatus): void`. Shared `idempotency_keys` table. |
| `src/envelope.ts` | NEW | `mapErrorToEnvelope(err): Envelope` where `Envelope = { code, message, details, statusHint }`. Deterministic but has one side effect — `console.error` on unhandled errors so a single log line fires regardless of transport. |
| `src/api/errors.ts` | MODIFY | `respondError` delegates to `mapErrorToEnvelope`. External shape unchanged; `errorMiddleware` signature unchanged. Also strips `statusHint` from the wire envelope. |
| `src/api/idempotency.ts` | MODIFY | Hono middleware delegates the DB-touching parts (`SELECT` / `INSERT` + scope-tuple lookup) to `src/idempotency-store.ts`. Keeps Hono-specific request/response handling (body re-expose, `c.res` capture). |
| `src/skill.ts` | MODIFY (Tier 2) | Append "## MCP tools" section listing the 8 tools + "signup is not idempotent" caveat + "canonical-JSON hash for MCP" caveat. |
| `src/index.ts` | MODIFY | Swap `createMcpServer` stub body. Update `McpServerConfig` shape. No new barrel exports — the `PostInputBaseSchema` + `slugTitleRefinement` primitives needed by MCP live in an internal submodule (`src/schema/post-input-base.ts`) that's not re-exported from the barrel. |
| `tests/mcp/signup.test.ts` | NEW | Happy path; `BLOG_NAME_CONFLICT`; regression guard that `idempotency_key` in args is rejected by the schema. |
| `tests/mcp/posts-create.test.ts` | NEW | Happy path; cross-blog guard; idempotency replay + `IDEMPOTENCY_KEY_CONFLICT` on mismatch; `POST_SLUG_CONFLICT`; missing-title returns SDK-shaped validation error (decision #15). |
| `tests/mcp/posts-update.test.ts` | NEW | Each row of the REST render matrix; slug-in-patch rejected; no-op empty patch. |
| `tests/mcp/posts-delete.test.ts` | NEW | Happy path; same-key retry replays `{ deleted: true }` (hit-match); no-key retry (or crash-window case) returns `POST_NOT_FOUND` envelope (mirrors REST decision #20); cross-blog guard. |
| `tests/mcp/posts-read.test.ts` | NEW | `get_blog`, `get_post`, `list_posts` default + status filter. |
| `tests/mcp/bridge.test.ts` | NEW | `report_bug` returns `isError: true` + envelope; `details.use` present when configured, absent when not. |
| `tests/mcp/auth.test.ts` | NEW | No header → `UNAUTHORIZED`; invalid token → `UNAUTHORIZED`; cross-blog `blog_id` → `BLOG_NOT_FOUND`; `authMode: 'none'` skips bearer entirely. |
| `tests/mcp/wrap-tool.test.ts` | NEW | Envelope parity: same `SlopItError` thrown on both REST and MCP produces matching `structuredContent.error` vs REST `{ error: ... }` (minus `statusHint`). |
| `tests/mcp/tool-descriptions.test.ts` | NEW | Structural assertions on all 8 descriptions: length < 240 chars, banned vocabulary absent. |
| `tests/mcp/skill-parity.test.ts` | NEW (Tier 2) | Set of tools in a fresh `McpServer` matches the set of tools documented in `generateSkillFile` output. |
| `tests/idempotency-store.test.ts` | NEW | `miss` / `hit-match` / `hit-mismatch` dispatch; scope isolation; defensive assert on empty `apiKeyHash`. |
| `src/schema/post-input-base.ts` | NEW | Internal module (not re-exported via `src/schema/index.ts` barrel). Owns `PostInputBaseSchema` (currently a private const in `src/schema/index.ts`) and `slugTitleRefinement` — a named export of the `superRefine` callback currently inlined in `PostInputSchema`'s definition. Both `src/schema/index.ts` (for building `PostInputSchema`) and `src/mcp/tools.ts` (for `create_post`) import from here. |
| `src/schema/index.ts` | MODIFY | Replace the inline `PostInputBaseSchema` const + inline `superRefine` callback with imports from `./post-input-base.js`. No change to the barrel's public surface — `PostInputSchema`, `PostPatchSchema`, `PostSchema`, `CreateBlogInputSchema`, and their inferred types stay exported exactly as before. |
| `examples/self-hosted/mcp-stdio.ts` | NEW (Tier 2) | ~30 lines. `createMcpServer({ ..., authMode: 'none' })` + `StdioServerTransport`. |
| `examples/self-hosted/mcp-http.ts` | NEW (Tier 2) | ~60 lines. `createMcpServer({ ..., authMode: 'api_key' })` + `WebStandardStreamableHTTPServerTransport` mounted under Hono at `/mcp` alongside REST. |

---

## Public API

```ts
// src/mcp/server.ts — stays exported via src/index.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface McpServerConfig {
  store: Store
  rendererFor: (blog: Blog) => MutationRenderer
  baseUrl: string
  authMode?: 'api_key' | 'none'       // default 'api_key'
  mcpEndpoint?: string                 // for onboarding_text in signup result
  docsUrl?: string
  skillUrl?: string
  bugReportUrl?: string                // surfaced in report_bug envelope details.use
  dashboardUrl?: string
}

export function createMcpServer(config: McpServerConfig): McpServer
```

Field-for-field parity with `ApiRouterConfig`. Platform wires both factories from one config object.

`rendererFor` MUST return a `MutationRenderer` (not just `Renderer`) — mutation tools (`create_post`, `update_post`, `delete_post`) require file-cleanup. Matches REST's type.

---

## `wrapTool` pipeline

```ts
// src/mcp/wrap-tool.ts
interface WrapToolOpts {
  auth: 'required' | 'public'         // 'public' = signup, report_bug
  idempotent?: boolean                 // create_post / update_post / delete_post
  crossBlogGuard?: boolean             // tools that accept blog_id
}

interface ToolCtx {
  store: Store
  config: McpServerConfig
  blog?: Blog                          // set iff auth === 'required'
  apiKeyHash?: string                  // set iff auth === 'required'
}

type ToolBusiness<A> = (args: A, ctx: ToolCtx) => unknown | Promise<unknown>

export function wrapTool<A>(
  config: McpServerConfig,
  name: string,
  opts: WrapToolOpts,
  business: ToolBusiness<A>,
): ToolCallback
```

Pipeline steps inside the returned callback (executed in order):

1. **Auth** — `if (opts.auth === 'required')`:
   - `config.authMode === 'none'` and `opts.crossBlogGuard`: resolve `ctx.blog` from `args.blog_id` via `getBlogInternal(store, args.blog_id)` (throws `BLOG_NOT_FOUND` on miss — returned to client as envelope). Set `ctx.apiKeyHash = ''`.
   - `config.authMode === 'none'` and not cross-blog (shouldn't happen for any of the 8 tools; guard with an `assert` for defensive correctness): `UNAUTHORIZED`.
   - `config.authMode === 'api_key'`: `const bearer = resolveBearer(extra, config)`. Missing/malformed → throw `UNAUTHORIZED`. `verifyApiKey(store, bearer)` — null → `UNAUTHORIZED`. Set `ctx.blog = blog`, `ctx.apiKeyHash = hashApiKey(bearer)`.
2. **Cross-blog guard** — `if (opts.crossBlogGuard && 'blog_id' in args && ctx.blog && args.blog_id !== ctx.blog.id)` → throw `BLOG_NOT_FOUND` (details: `{ blog_id: args.blog_id }`).
3. **Idempotency lookup** — `if (opts.idempotent && 'idempotency_key' in args && args.idempotency_key && ctx.apiKeyHash)`:
   - Compute `scope = { key, apiKeyHash, method: 'MCP', path: name, requestHash: canonicalHash(name, args) }` where `canonicalHash` strips `idempotency_key` from args, sorts keys, serializes without whitespace, hashes with SHA-256 (prefixed with `'MCP\0' + name + '\0'` for domain separation).
   - `lookupIdempotencyRecord(store, scope)`:
     - `miss` → continue.
     - `hit-match` → return parsed body directly (skip business handler, skip record step) wrapped in the standard success envelope below.
     - `hit-mismatch` → throw `IDEMPOTENCY_KEY_CONFLICT` (details: `{ key, method: 'MCP', path: name }`).
4. **Business** — `const result = await business(args, ctx)`.
5. **Idempotency record** — same condition as step 3; `recordIdempotencyResponse(store, scope, JSON.stringify(result), 200)`. The `200` is a fixed status for MCP (MCP has no HTTP status; REST uses the actual response status). On success only. Weakened-durability per REST decision #20 (record after success, crash window tolerated).
6. **Success return** — `{ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }`.
7. **Catch** (wraps the entire pipeline) — `mapErrorToEnvelope(err)` → `{ isError: true, content: [{ type: 'text', text: '${code}: ${message}' }], structuredContent: { error: { code, message, details } } }`. `statusHint` is stripped from the wire envelope (MCP has no HTTP status to hint at).

---

## Error envelope — shared helper

```ts
// src/envelope.ts
export interface Envelope {
  code: string
  message: string
  details: Record<string, unknown>
  statusHint: number
}

export function mapErrorToEnvelope(err: unknown): Envelope
```

Mapping table:

| Input | `code` | `statusHint` | `details` |
|---|---|---|---|
| `ZodError` | `ZOD_VALIDATION` | 400 | `{ issues: err.issues }` (REST-only — SDK validates MCP args before `wrapTool` runs, per decision #15) |
| `SyntaxError` | `BAD_REQUEST` | 400 | `{ message: err.message }` (REST-only reach; MCP args arrive pre-parsed) |
| `SlopItError` | `err.code` | `CODE_TO_STATUS[err.code] ?? 500` | `err.details` |
| other | `INTERNAL_ERROR` | 500 | `{}`, and `console.error(err)` side effect |

The `console.error` is intentional and lives inside `mapErrorToEnvelope` so both transports log exactly once per unhandled error — centralizing the side effect avoids a "who logs?" disagreement between REST and MCP wrappers.

REST: `respondError(c, err)` → `const e = mapErrorToEnvelope(err); return c.json({ error: { code: e.code, message: e.message, details: e.details } }, e.statusHint)`.

MCP: see `wrapTool` step 7. `ZodError` is effectively unreachable via `wrapTool`'s catch under MCP (SDK validates first); business handlers that throw `ZodError` explicitly (e.g., if `updatePost`'s internal re-parse fails at some depth) still map correctly.

No new `SlopItErrorCode` is added for MCP. Agents debugging across both transports see the same code on the same underlying business condition. Input-validation errors are an explicit exception (decision #15) — REST returns `ZOD_VALIDATION`; MCP returns the SDK's own shape.

---

## Idempotency — shared helper

```ts
// src/idempotency-store.ts
export interface IdempotencyScope {
  key: string
  apiKeyHash: string                   // MUST be non-empty; callers enforce
  method: string                       // 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'MCP'
  path: string                         // REST: request path; MCP: tool name
  requestHash: string                  // sha256 of canonical request form
}

export type IdempotencyLookup =
  | { status: 'miss' }
  | { status: 'hit-match'; body: string; responseStatus: number }
  | { status: 'hit-mismatch' }

export function lookupIdempotencyRecord(store: Store, scope: IdempotencyScope): IdempotencyLookup
export function recordIdempotencyResponse(store: Store, scope: IdempotencyScope, body: string, responseStatus: number): void
```

- `responseStatus` in the row stays for REST's replay (it re-emits the original HTTP status). MCP always records `200` (MCP has no status); replay body is JSON-parsed and returned as the tool success envelope.
- Shared `idempotency_keys` table. No schema change from what REST shipped. The existing primary key `(key, api_key_hash, method, path)` already namespaces REST vs MCP via the `method` column.
- Caller enforces the non-empty `apiKeyHash` guard (decision #22 equivalent). Callers that pass empty hash trigger an `assert` — defensive, not reachable via the 8 MCP tools.

**Scope-column values** — reserved strings:

| Transport | `method` | `path` |
|---|---|---|
| REST | `'POST'` / `'PATCH'` / `'DELETE'` | Request path (e.g., `/blogs/blog_x/posts/hello-world`) |
| MCP | `'MCP'` | Tool name (e.g., `'create_post'`) |

**Hash canonicalization** — differs by transport, same uniqueness guarantee:

- **REST** (existing): `sha256(method + '\0' + path + '\0' + content_type + '\0' + sorted_query_string + '\0' + raw_body_bytes)`.
- **MCP** (new): `sha256('MCP' + '\0' + tool_name + '\0' + canonical_json(args_minus_idempotency_key))` where canonical JSON = recursively-sorted object keys, no whitespace, standard JS `JSON.stringify` over the sorted tree.

The difference (bytewise for REST, canonical-JSON for MCP) is unavoidable: REST hashes the wire form because it has raw bytes; MCP hashes a canonical projection because args arrive pre-parsed. Documented in SKILL.md.

---

## The 8 tools

All input schemas are Zod. `z.strict()` is applied at the top level to reject extraneous fields (defense in depth — e.g., ensures `signup` rejects `idempotency_key` even if an agent passes it).

| # | Name | Auth | Idem. | CrossBlog | Input schema | Output |
|---|------|------|-------|-----------|--------------|--------|
| 1 | `signup` | public | ❌ | — | `CreateBlogInputSchema.strict()` | `{ blog_id, blog_url, api_key, mcp_endpoint?, onboarding_text }` |
| 2 | `create_post` | required | ✅ | ✅ | `z.object({ blog_id: string }).extend(PostInputBaseSchema.shape).extend({ idempotency_key: z.string().optional() }).strict().superRefine(slugTitleRefinement)` (both imported from `src/schema/post-input-base.ts`) | `{ post, post_url? }` |
| 3 | `update_post` | required | ✅ | ✅ | `z.object({ blog_id, slug, patch: PostPatchSchema, idempotency_key? }).strict()` | `{ post, post_url? }` |
| 4 | `delete_post` | required | ✅ | ✅ | `z.object({ blog_id, slug, idempotency_key? }).strict()` | `{ deleted: true }` |
| 5 | `get_blog` | required | — | ✅ | `z.object({ blog_id }).strict()` | `{ blog }` |
| 6 | `get_post` | required | — | ✅ | `z.object({ blog_id, slug }).strict()` | `{ post }` |
| 7 | `list_posts` | required | — | ✅ | `z.object({ blog_id, status: z.enum(['draft','published']).optional() }).strict()` | `{ posts }` |
| 8 | `report_bug` | public | — | — | `z.object({ summary: z.string().optional(), details: z.unknown().optional() })` (permissive — no `.strict()`) | — (always `isError: true`, envelope `NOT_IMPLEMENTED`, `details.use = config.bugReportUrl` when configured) |

### Notes per tool

- **`signup`** — Calls `createBlog` → `createApiKey` → `generateOnboardingBlock` with `blogUrl = rendererFor(blog).baseUrl`. Result field `onboarding_text` carries the imperative onboarding string (matches REST). `mcp_endpoint` field included when `config.mcpEndpoint` is set. `idempotency_key` is rejected at the SDK's schema validation layer (`CreateBlogInputSchema.strict()` does not include it); the client receives an SDK-shaped validation error before `wrapTool` runs (decision #15).
- **`create_post`** — Input is `{ blog_id }` plus every `PostInputBaseSchema` field plus optional `idempotency_key`. Reuses `PostInputBaseSchema.shape` + `slugTitleRefinement` (both from the new internal `src/schema/post-input-base.ts`), which is the exact same refinement `PostInputSchema` uses — no duplication. The handler call is `createPost(store, renderer, ctx.blog.id, args)` after dropping `blog_id` and `idempotency_key` from args.
- **`update_post`** — Wraps `PostPatchSchema` in a `patch` field. An empty `patch: {}` is a valid no-op (matches REST). Calls `updatePost(store, renderer, ctx.blog.id, args.slug, args.patch)`.
- **`delete_post`** — Calls `deletePost(store, renderer, ctx.blog.id, args.slug)`. Returns `{ deleted: true }`. Idempotent-retry behavior: after a successful delete, a retry with the same `idempotency_key` replays the stored `{ deleted: true }` response (hit-match). A retry WITHOUT the same `idempotency_key` produces `POST_NOT_FOUND` (which is semantically equivalent — the post is already gone). Mirrors REST decision #20.
- **`get_blog`** — Returns `{ blog: ctx.blog }`. (We could `getBlog(store, args.blog_id)` but `ctx.blog` is already fully loaded from the auth path; re-fetching adds a query for nothing.)
- **`get_post`** — `getPost(store, ctx.blog.id, args.slug)` wrapped in `{ post }`.
- **`list_posts`** — `listPosts(store, ctx.blog.id, args.status ? { status: args.status } : undefined)` wrapped in `{ posts }`. Default (no status) is published-only — matches REST.
- **`report_bug`** — Always throws `NOT_IMPLEMENTED` with `details = config.bugReportUrl ? { use: config.bugReportUrl } : {}`. The wrapper converts to the standard error envelope. Tool description tells the agent it gets a pointer back.

### Tool descriptions (final copy)

Structural tests enforce: length < 240 chars, no banned vocabulary (`endpoint`, `MCP`, `middleware`, `primitive`, `bridge`).

- `signup` — "Create a SlopIt blog and get an API key. Use this once, before anything else. Returns a live URL, the API key, and onboarding text to follow."
- `create_post` — "Publish a post to the blog. Needs `title` and `body` (markdown). Returns the published post's live URL."
- `update_post` — "Edit an existing post. Pass the post's `slug` and a `patch` of fields to change. Slug itself can't change; delete and republish if you need a new URL."
- `delete_post` — "Remove a post permanently. This can't be undone."
- `get_blog` — "Get the blog's current metadata."
- `get_post` — "Get a single post by its slug."
- `list_posts` — "List posts on the blog. Defaults to published posts. Pass `status: 'draft'` for drafts."
- `report_bug` — "Report a bug or something unexpected. Returns a link to submit the report."

---

## Auth resolution

```ts
// src/mcp/auth.ts
export function resolveBearer(
  extra: RequestHandlerExtra,
  config: Pick<McpServerConfig, 'authMode'>,
): string | null
```

- `config.authMode === 'none'`: return `null`. Callers that need a bearer in this mode throw `UNAUTHORIZED` — but of the 8 tools, only those with `crossBlogGuard` reach the auth path in `'none'` mode, and they resolve via `getBlogInternal(store, args.blog_id)` instead of a bearer.
- `config.authMode === 'api_key'`: try two sources in order, first non-null wins:
  1. **`extra.authInfo?.token`** — populated by transports that carry auth natively. `InMemoryTransport.send({ authInfo })` is the practical path for in-process tests (no monkey-patching needed); OAuth-aware HTTP transports also set `authInfo` when tokens authenticate successfully.
  2. **`extra.requestInfo?.headers`** — HTTP transports' header map. Lookup is **case-insensitive**: `IsomorphicHeaders` is a plain record, not a `Headers` instance, so `.authorization` hits under Streamable HTTP (lowercased today) but isn't guaranteed across transports. Implementation: iterate entries and match `key.toLowerCase() === 'authorization'`. If the value is a non-empty string whose prefix is `bearer ` (case-insensitive — compare with `.toLowerCase().startsWith('bearer ')`), return the trimmed remainder.

Both paths return `null` on miss; `wrapTool` maps `null` to `UNAUTHORIZED`. Defensive: `extra.requestInfo` and `extra.authInfo` may both be `undefined` on stdio or other transports that don't produce request metadata. Stdio users are expected to set `authMode: 'none'`; an `api_key` call arriving without either source fails with `UNAUTHORIZED` rather than crashing.

---

## Testing

Target: `pnpm test` passes with all existing 308 tests plus the new ones. New modules ≥95% line coverage.

### Required coverage areas

- **Signup** (`tests/mcp/signup.test.ts`):
  - Happy path: returns `blog_id`, `blog_url`, `api_key`, `onboarding_text`; `mcp_endpoint` present iff configured.
  - `BLOG_NAME_CONFLICT` on duplicate name → envelope with `code = BLOG_NAME_CONFLICT`.
  - Regression guard (decision #22 parity): calling `signup` with `idempotency_key` in args returns the SDK-shaped validation error (`isError: true`, `content[0].text` begins with `'Input validation error:'`, no `structuredContent`). Confirms the arg is rejected at the schema layer, not silently dropped. See decision #15 for why this is the SDK shape rather than our `ZOD_VALIDATION` envelope.

- **`create_post`** (`tests/mcp/posts-create.test.ts`):
  - Happy path: post created, returned `post_url` matches `rendererFor(blog).baseUrl + '/<slug>/'` (trailing slash — matches REST; see `src/posts.ts` `postUrl` construction).
  - Missing title: SDK-shaped validation error (no `structuredContent`; text starts with `'Input validation error:'`). See decision #15.
  - Cross-blog guard: call with `blog_id` that doesn't match bearer's blog → `BLOG_NOT_FOUND` envelope.
  - Idempotency replay: two identical calls with the same `idempotency_key` return identical `structuredContent`.
  - Idempotency mismatch: same key, different `body` field → `IDEMPOTENCY_KEY_CONFLICT` envelope (422-equivalent code).
  - `POST_SLUG_CONFLICT`: two creates with the same explicit `slug` without idempotency → second one gets the envelope.

- **`update_post`** (`tests/mcp/posts-update.test.ts`):
  - Each row of the REST status-matrix from the REST spec (draft→draft, draft→published, published→published, published→draft) — verify file/DB side effects match REST.
  - Slug in patch → SDK-shaped validation error (`PostPatchSchema` is `.strict()` and excludes slug; validation fires at the SDK layer). See decision #15.
  - Empty patch → no-op, returns current post unchanged.

- **`delete_post`** (`tests/mcp/posts-delete.test.ts`):
  - Happy path: row + file + index all cleaned.
  - Idempotent retry with same key → hit-match replay returns `{ deleted: true }`.
  - Retry WITHOUT idempotency key after successful delete → `POST_NOT_FOUND` envelope (REST decision #20 parity).
  - Cross-blog guard.

- **`get_blog` / `get_post` / `list_posts`** (`tests/mcp/posts-read.test.ts`):
  - `get_blog` returns `{ blog }`.
  - `get_post` happy path; `POST_NOT_FOUND` on miss.
  - `list_posts` default (published only), `status: 'draft'`, `status: 'published'`.

- **`report_bug`** (`tests/mcp/bridge.test.ts`):
  - Call with `bugReportUrl` configured → `isError: true`, envelope `code = NOT_IMPLEMENTED`, `details.use` present.
  - Call without `bugReportUrl` → same envelope, no `details.use`.

- **Auth** (`tests/mcp/auth.test.ts`):
  - `authMode: 'api_key'`, no header → `UNAUTHORIZED` envelope.
  - Malformed header (`Basic ...`) → `UNAUTHORIZED`.
  - Valid token but cross-blog `blog_id` → `BLOG_NOT_FOUND`.
  - `authMode: 'none'`: no bearer required; tools with `blog_id` resolve the blog from args.

- **`wrapTool` parity** (`tests/mcp/wrap-tool.test.ts`):
  - Throw each `SlopItErrorCode` from a trivial business handler; assert MCP envelope's `structuredContent.error` is identical (minus `statusHint`) to REST's `{ error }` body on the same error.

- **Tool descriptions** (`tests/mcp/tool-descriptions.test.ts`):
  - All 8 tools have descriptions.
  - Each description length < 240 chars.
  - No banned substring: `endpoint`, `MCP`, `middleware`, `primitive`, `bridge` (case-insensitive).

- **Idempotency store** (`tests/idempotency-store.test.ts`):
  - `miss` / `hit-match` / `hit-mismatch` dispatch.
  - Scope isolation: same key, different `method` columns → independent records.
  - Assertion failure on empty `apiKeyHash` (defensive guard).

- **Envelope parity** — covered jointly by `wrap-tool.test.ts` (MCP side) + existing `errors.test.ts` (REST side). No new standalone test; both call `mapErrorToEnvelope` under the hood.

### Test harness — injecting the bearer via InMemoryTransport

The SDK's `InMemoryTransport` supports `send({ authInfo })` natively: the `authInfo` option propagates to `extra.authInfo` on the server side. `resolveBearer` reads `extra.authInfo?.token` first, so tests don't need monkey-patching — they wrap the client transport's `send` in a small helper (~5–10 lines) that injects `{ token: apiKey, clientId: 'test', scopes: [] }` on every outgoing request. Production HTTP header delivery is exercised by the Tier 2 HTTP example.

---

## Tier 2 (fold in if scope allows)

- `examples/self-hosted/mcp-stdio.ts` — ~30 lines. Boots core, calls `createMcpServer({ ..., authMode: 'none' })`, awaits `server.connect(new StdioServerTransport())`. README note: stdio implies single-tenant; pair with `authMode: 'none'`.
- `examples/self-hosted/mcp-http.ts` — ~60 lines. Mounts `WebStandardStreamableHTTPServerTransport` on a Hono route (`/mcp`) alongside the REST router (`/`) under one process. `authMode: 'api_key'`. This is the shape the platform PR will mirror after core merges to `main`.
- `src/skill.ts` — append `## MCP tools` section listing the 8 tools + description + these caveats:
  - **Validation errors are SDK-shaped** (no `structuredContent`); match on `content[0].text.startsWith('Input validation error')`. Business errors preserve full REST-parity envelope shape.
  - **Idempotency is api_key-mode only.** Under `authMode: 'none'`, retries re-execute — same behavior as REST's crash window (decision #20). Self-hosters using stdio should not rely on `idempotency_key` for replay semantics.
  - **`signup` is not idempotent** (mirror of REST decision #22). Passing `idempotency_key` fails schema validation.
  - **Canonical-JSON hash for MCP idempotency** (vs REST's bytewise). Sending the same args with different key orders hashes identically, unlike REST.
  Add drift-guard test (`tests/mcp/skill-parity.test.ts`): the tools registered on a fresh `McpServer` match the tools documented in `generateSkillFile({ baseUrl })` output.

If execution runs long, Tier 2 lands in a follow-up feature (`feat/mcp-examples`). The minimum to call this feature done is Tier 1 with all its tests green.

---

## Tier 3 (explicit follow-up, not this feature)

- `AGENT_CONTRACT.md` at repo root (doc-only PR after MCP merges).
- Platform PR: `createApiRouter({ ..., mcpEndpoint: ${BASE_URL}/mcp })` + mount `createMcpServer` via `WebStandardStreamableHTTPServerTransport` at `/mcp`. Tracked in `slopit-platform/LAUNCH.md`.

---

## Out of scope (this feature)

- Hosting of the MCP endpoint at `mcp.slopit.io` — platform.
- MCP connection analytics — platform.
- MCP resources / prompts / progress notifications (decision #14).
- Per-tool custom error codes beyond `SlopItErrorCode` — reuse verbatim.
- Rate limiting — platform.
- Pre-conversion of Zod schemas via `z.toJSONSchema()` (decision #11 — SDK handles it).
- Batch tool calls / streaming tool responses.
- MCP auth modes other than `api_key` / `none` (e.g., per-call `apiKey` arg — explicitly rejected in brainstorming).
- Stdio transport with `authMode: 'api_key'` — stdio gets `authMode: 'none'` by convention; HTTP is the mode where api_key makes sense.
- REST-parity envelope shape for MCP *validation* errors (decision #15). Business-error parity is preserved via `wrapTool`; schema-validation errors surface in the SDK's shape.
- Idempotency under `authMode: 'none'` (decision #16). Mirrors REST's "no caller identity → no replay" behavior.

---

## Open questions for the plan phase (not blocking spec review)

1. Exact mechanism for injecting headers into `InMemoryTransport` in test setup — likely a patched transport wrapper or a monkey-patched `request` method; picked in the plan after a small spike.
2. Whether `getBlog` should re-fetch via `getBlog(store, args.blog_id)` or reuse `ctx.blog` from the auth path. Probably reuse; leave the plan to confirm no edge case where `ctx.blog` is stale.
3. Whether `wrapTool`'s `'public'` auth opts should still accept `bearer` for diagnostic purposes (currently: no — public tools don't look at auth). Confirm in plan.
4. Exact signature of `canonicalHash` — probably a 10-line helper in `src/idempotency-store.ts` shared with REST's Hono middleware eventually, but not required for this feature (REST keeps its bytewise hash).
5. Whether `tests/mcp/skill-parity.test.ts` lives in `tests/mcp/` or `tests/` root (matches the REST parity test's location).
