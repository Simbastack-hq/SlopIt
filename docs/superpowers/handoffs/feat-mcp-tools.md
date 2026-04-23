# Handoff: `feat/mcp-tools`

**Purpose:** next feature to build in `@slopit/core` after PR #3 (REST routes) merged to `dev`. Paste this into a fresh session to kick off the brainstorming → spec → plan → implementation loop.

> **Read `PRODUCT_BRIEF.md` at the repo root first.** Audience priority is non-technical users → indie hackers → developers. MCP work is developer-facing (audience #3), so technical language is fine *inside code and tests* — but any user-visible output (tool descriptions shown to an LLM, error messages that surface to an agent's user, the SKILL.md section we update) must stay in the brief's language register. Tool descriptions in particular land in front of agents that explain back to humans — keep them plain.

---

## Context

SlopIt is an open-core MIT library (`@slopit/core`) for "instant blogs for AI agents." Strategy: agents call a handful of functions and get back a live URL with ~zero friction. No CMS UI, three themes max in v1, minimal HTML templates, static file output, Caddy serves.

Public repo `Wipiway/SlopIt`. Private platform repo `Wipiway/slopit-platform`. Stack: TypeScript strict ESM, Hono, better-sqlite3, Zod v4 (with `z.toJSONSchema()`), vitest, marked, `@modelcontextprotocol/sdk`. Node ≥22. pnpm + `feat/*` → `dev` → `main` workflow. `pnpm check` (typecheck + lint + format:check + test) is the pre-commit gate.

### Already on `dev` (merged via PR #3 — REST routes)

- `createApiRouter({ store, rendererFor, baseUrl, authMode?, ... })` — full REST router: `/health`, `/signup`, `/schema`, `/bridge/report_bug`, `GET /blogs/:id`, full CRUD on `/blogs/:id/posts[/:slug]`
- Auth middleware (Bearer + cross-blog guard; mount-prefix-safe via `c.req.routePath` stripping)
- Idempotency middleware — scope `(key, api_key_hash, method, path)`; **skipped for unauthenticated callers** per spec decision #22 (`/signup` leak fix)
- Error envelope middleware — `SlopItError` / `ZodError` / `SyntaxError` all mapped; `BAD_REQUEST` and `ZOD_VALIDATION` are response-envelope codes (not `SlopItErrorCode` values)
- Core primitives: `createBlog`, `createApiKey`, `createPost`, `updatePost`, `deletePost`, `getBlog`, `getPost`, `listPosts`, `verifyApiKey`
- Shared Zod schemas: `PostInputSchema`, `PostPatchSchema`, `CreateBlogInputSchema`, `BlogSchema`, `PostSchema`
- `Renderer` / `MutationRenderer extends Renderer` interfaces (mutation primitives require `removePostFiles`)
- `generateOnboardingBlock`, `generateSkillFile` pure generators
- `_links` HATEOAS helper (`buildLinks`)
- 308 tests green; 100% line coverage on `src/api/*`

### Stubs still throwing / empty

- `createMcpServer({ store, renderer })` in `src/mcp/server.ts` — **the thing to build in this feature**
- Minimal read-only dashboard in `src/dashboard/index.ts` — deferred; separate future feature

### Public barrel export (must not regress)

`src/index.ts` already exports `createMcpServer` + `McpServerConfig` as stubs that throw. References in `README`, `ARCHITECTURE.md`, `CLAUDE.md`, and `examples/self-hosted/README.md`. This feature swaps the body but keeps the export surface. Do not remove either name.

---

## Feature scope

**Wire MCP on top of the existing REST primitives.** Reuse Zod schemas and the `SlopItError` → envelope mapping; MCP is a second transport, not a second data model.

### Tier 1 — must land

1. **`createMcpServer({ store, rendererFor, baseUrl, authMode?, mcpEndpoint?, docsUrl?, skillUrl?, bugReportUrl?, dashboardUrl? })`** — factory returning an `@modelcontextprotocol/sdk` `Server` instance. Config mirrors `ApiRouterConfig` 1:1 (same `rendererFor(blog): MutationRenderer` callback, same auth model).

2. **8 MCP tools** (verbatim names from `slopit-platform/strategy.md`'s MCP tool list):
   - `signup` — wraps the `/signup` route's logic (`createBlog` + `createApiKey` + onboarding block)
   - `create_post` — wraps `createPost`
   - `update_post` — wraps `updatePost`
   - `delete_post` — wraps `deletePost`
   - `get_blog` — wraps `getBlog`
   - `get_post` — wraps `getPost`
   - `list_posts` — wraps `listPosts`
   - `report_bug` — wraps `/bridge/report_bug` (501 stub with `use:` pointer)

   Tool input schemas derive from the existing Zod schemas via `z.toJSONSchema()`. No hand-written parallel schemas.

3. **Auth model parity.** `authMode: 'api_key' | 'none'`, default `'api_key'`. In `'api_key'` mode every tool call requires an `apiKey` argument (or a connection-level header — see design questions below). Same cross-blog guard as REST (blog_id in args must match the api_key's blog → else `BLOG_NOT_FOUND`).

4. **Error parity.** MCP tool errors use the same envelope shape as REST: `{ error: { code, message, details } }`. `SlopItError` passes through with its code + HTTP-equivalent status mapped to an MCP error. `ZodError` → 400-equivalent. Agents debugging across REST + MCP should see the same codes.

5. **Idempotency parity for authenticated tools.** `create_post`, `update_post`, `delete_post` accept an optional `idempotency_key` argument. Reuse the same `idempotency_keys` table and scope tuple `(key, api_key_hash, method, tool_name)`. `signup` does NOT support idempotency (same reason as REST — no pre-auth caller identity; see spec decision #22).

6. **Tool descriptions written for the agent, not for humans.** Short imperative descriptions with example arguments. Avoid "endpoint", "middleware", "primitive" vocabulary — the description will be rendered by an LLM for a non-technical user. Example style:

   > `create_post` — "Publish a new post to the user's blog. Requires `title` and `body` (markdown). Returns the live URL of the published post."

### Tier 2 — fold in if scope allows

7. **Stdio + HTTP transport factories.** Core ships `createMcpServer` returning an SDK `Server`. Transport wiring (stdio for local dev, HTTP/SSE for hosted) is consumer territory. This feature includes example wiring in `examples/self-hosted/` so Docker Compose can serve MCP over HTTP alongside REST.

8. **Update `generateSkillFile` with an MCP section.** Same drift-guard test style as the REST endpoint-parity test. Lists the 8 tools, links the JSONSchema, mentions the "idempotency not for signup" caveat.

### Tier 3 — follow-up

9. **`AGENT_CONTRACT.md`** at repo root. Written once the REST + MCP contract is stable across both transports.

### Platform territory (not core — out of scope here)

- Hosting the MCP server (Caddy routing `mcp.slopit.io`, auth token exchange, rate limiting)
- MCP connection analytics
- Per-blog MCP endpoint URLs in the onboarding block (platform already has `mcpEndpoint` config; core just passes it through)

---

## Design inputs already folded in

- **`slopit-platform/strategy.md`** — canonical MCP tool list (8 tools above). Tool naming is verbatim.
- **Shared Zod schemas** — `PostInputSchema`, `PostPatchSchema`, `CreateBlogInputSchema` already exist and are used by REST. MCP reuses them via `z.toJSONSchema()`.
- **Error envelope** — `src/api/errors.ts`'s `respondError` produces the shape MCP will also return. Extract the pure mapping function (input: `unknown` error, output: `{ code, message, details, statusHint }`) so both transports share it without Hono-specific coupling.
- **Spec decision #22 (post-implementation P1 fix)** — `/signup` idempotency is security-sensitive. Mirror the skip in MCP: `signup` tool ignores any `idempotency_key` argument and documents why.

## Things we deliberately don't copy from other MCP projects

- **Per-tool custom error codes.** Use `SlopItErrorCode` verbatim. Agents already know them from REST.
- **Progress/streaming events.** Publishing is fast and atomic; no progress to report. YAGNI.
- **Resource protocol.** We don't need `mcp://` resource URIs — the tools return post URLs directly in their response.
- **Prompt templates.** The onboarding block from `generateOnboardingBlock` is the prompt; MCP doesn't need a separate `prompts/` surface.

---

## Open design questions to brainstorm

1. **Authentication transport.** MCP connections can carry auth at the transport layer (HTTP header on SSE connect, env var on stdio) OR per-tool-call (`apiKey` argument on every tool). Proof SDK uses per-call; `@modelcontextprotocol/sdk` supports both. Per-call is stateless and simpler to test; per-connection is lower-overhead for high-throughput agents. Lean: per-call argument, named `apiKey`, consistent across all authenticated tools.

2. **Response shape parity with REST.** REST `POST /blogs/:id/posts` returns `{ post, post_url?, _links }`. Should MCP `create_post` return the same structure? `_links` inside an MCP response is a REST-ism; agents on MCP discover tools via the tool list, not HATEOAS. Lean: drop `_links` from MCP responses, keep `post` + `post_url`.

3. **`signup` tool return shape.** REST returns `{ blog_id, blog_url, api_key, onboarding_text, _links }`. The `onboarding_text` is imperative and written for the agent — do we return it via the tool result, or via a separate MCP `prompt` surface? Lean: tool result field `onboarding_text`; simpler.

4. **Idempotency argument naming.** REST uses the `Idempotency-Key` header. MCP tool arguments can't have dashes. `idempotency_key` (snake_case) is consistent with the tool names. Confirm.

5. **Cross-blog guard wording.** REST returns `BLOG_NOT_FOUND` (spec decision #18) to avoid leaking existence. MCP should do the same. Confirm the envelope is identical.

6. **Testing approach.** `@modelcontextprotocol/sdk` ships an in-memory test client. Use that for tool-call tests. Shape of fixtures should mirror `tests/api/*` so the two test suites are visually similar.

7. **Logging.** Core logs nothing (consumer decides). MCP SDK has its own logger hook — wire it to no-op by default; consumer can swap.

8. **`report_bug` on MCP.** REST returns 501 with a platform-bridge URL pointer. MCP equivalent: tool call returns an error with `details.use = bugReportUrl` so the agent can relay the URL to the user. No fancy UI.

---

## Starting state for the new session

```bash
git checkout dev
git pull
# Sanity: PR #3 is on dev
ls src/api/routes.ts src/api/auth.ts src/api/idempotency.ts
test -f src/mcp/server.ts || { echo "stub missing"; exit 1; }

git checkout -b feat/mcp-tools
pnpm install
pnpm check            # must pass: typecheck + lint + format + 308 tests
```

If any of that fails at the start, stop and ask — the baseline is wrong.

---

## Required reading before brainstorming

1. **`PRODUCT_BRIEF.md`** — non-negotiable. Especially the Language Rules and Who It's For sections. Tool descriptions land in front of audience #1 (via the LLM rendering them).
2. `CLAUDE.md` — development philosophy + `pnpm check` gate + `docs/solutions/` convention.
3. `ARCHITECTURE.md` — core/platform boundary. Rule #5's narrow `slopit.io` exception applies to the Powered-By link; otherwise no `slopit.io` strings in core. MCP endpoints are platform-supplied via `config.mcpEndpoint`.
4. `docs/superpowers/specs/2026-04-23-rest-routes-mcp-design.md` — REST spec. Decision #22 (signup idempotency skip) must mirror on MCP. Error envelope, `_links`, HATEOAS — reference for what to reuse and what to drop.
5. `src/api/errors.ts`, `src/api/idempotency.ts`, `src/api/auth.ts` — pull these patterns into transport-agnostic helpers before wiring MCP.
6. `src/api/routes.ts` — each route maps 1:1 to a tool; use it as the reference for what the tool wrapper needs to do.
7. `strategy.md` in `Wipiway/slopit-platform` — canonical MCP tool list + signup response shape.
8. `docs/solutions/` — check for any learnings that apply; add new ones as you discover non-obvious things (per CLAUDE.md).

---

## Workflow

1. Invoke `superpowers:brainstorming` → spec at `docs/superpowers/specs/<date>-mcp-tools-design.md` on `feat/mcp-tools`.
2. After spec review, invoke `superpowers:writing-plans` → plan at `docs/superpowers/plans/<date>-mcp-tools-implementation.md` on the same branch.
3. Commit both; open PR from `feat/mcp-tools` → `dev`. PR is docs-only at first.
4. Execute the plan via `superpowers:subagent-driven-development`.
5. Commits land on the same branch; PR grows to include implementation.
6. Dev review; merge to `dev` when `pnpm check` green.

Keep TDD discipline. Keep scope narrow (Tier 1 required, Tier 2 optional, Tier 3 later). Previous features went through 3–5 review rounds; don't skip them.

---

## Contact

NJ (repo owner). When a design decision isn't obvious from the docs, surface it rather than guessing.
