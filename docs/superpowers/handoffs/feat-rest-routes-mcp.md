# Handoff: `feat/rest-routes-mcp`

**Purpose:** next feature to build after `feat/create-post` merges to `dev`. Paste this into a fresh session to kick off the brainstorming → spec → plan → implementation loop.

---

## Context

SlopIt is an open-core MIT library (`@slopit/core`) for "instant blogs for AI agents." Strategy: agents call a handful of functions and get back a live URL with ~zero friction. No CMS UI, one theme (v1), minimal HTML templates, static file output, Caddy serves.

Public repo `Wipiway/SlopIt` (currently private). Private platform repo `Wipiway/slopit-platform`. Stack: TypeScript strict ESM, Hono, better-sqlite3, Zod v4, vitest, marked, `@modelcontextprotocol/sdk`. Node ≥22. pnpm + `feat/*` → `dev` → `main` workflow.

### Already on `dev` (after `feat/create-post` merges)

- `createStore` + migrations (`blogs`, `posts`, `api_keys`, `schema_migrations`)
- `createBlog(store, input) → { blog }`
- `createApiKey(store, blogId) → { apiKey }`
- `createPost(store, renderer, blogId, input) → { post, postUrl? }` with full render pipeline, `minimal` theme, 3-layer XSS defense (renderer.html override + hooks.preprocess for script/style/iframe + URL scheme allowlist)
- `createRenderer({ store, outputDir, baseUrl }) → Renderer` — sync, file-based templates, `{{var}}` / `{{{raw}}}` substitution, `ensureCss` before HTML writes
- `SlopItError` with `code` + `details` (`BLOG_NAME_CONFLICT` | `BLOG_NOT_FOUND` | `POST_SLUG_CONFLICT`)
- `@internal` helpers: `getBlogInternal`, `listPublishedPostsForBlog`, predicates, fragment renderers

### Stubs still throwing / empty

- `createApiRouter({ store, renderer })` in `src/api/index.ts` — the thing to build
- `createMcpServer({ store, renderer })` in `src/mcp/server.ts` — the thing to build
- Minimal read-only dashboard in `src/dashboard/index.ts` — likely in scope (see Tier 2 below)

---

## Feature scope

**Wire REST + MCP on top of the existing primitives.** Also pulls in read-side ops (`getBlog`, `listBlogs`, `getPost`, `listPosts`) since the router needs them. After this feature, SlopIt is end-to-end demonstrable.

### Tier 1 — must land (explicit design inputs, folded from Proof SDK research)

1. **`POST /signup` endpoint.** Composes `createBlog` + `createApiKey` + onboarding-block generator. Single call, returns `{ blog_id, blog_url, api_key, mcp_endpoint, dashboard_url, onboarding_text, _links }`.

2. **Onboarding-block generator in core.** Pure function `generateOnboardingBlock({ blog, apiKey, baseUrl, dashboardUrl }) → string`. Produces Proof-style imperative block:
   - Imperative opening ("Publish your first post right now to verify:")
   - Dual-path for each step (URL and direct HTTP)
   - Expected reply phrase ("Reply: Published my first post to SlopIt.")
   - Progressive disclosure (must-do steps first; docs and bug-report at the bottom)
   - Tokenized dashboard URL
   - Links to SKILL.md, agent-docs, bug-report endpoint
   Content-free at the generator level — platform provides the URLs. See `docs/superpowers/handoffs/proof-onboarding-reference.md` if we save Proof's literal block for comparison.

3. **`_links` HATEOAS block on every response.** Shape: `{ view, publish, list_posts, dashboard, docs, bridge }`. Agents discover follow-ups without reading docs first. One small helper, reused across signup + createPost + every read endpoint.

4. **`Content-Type: text/markdown` alternate body on `POST /posts`.** Agent sends raw markdown; metadata via query params (`?title=…&status=…&slug=…&tags=…`). Skips JSON wrapping. ~30 lines in the Hono route. Big DX win.

5. **`Idempotency-Key` header support on all mutations.** Core keeps a small `idempotency_keys` table: `(key, scope, response_hash, response_body, created_at)`. On a repeated key within the scope, replay the stored response instead of re-executing. Opt-in per request; omitted keys mean non-idempotent behavior (same as today).

6. **SKILL.md generator.** `generateSkillFile({ baseUrl }) → string` — standardized LLM-targeted instruction file. Core ships the function; platform serves at `slopit.io/slopit.SKILL.md`.

7. **Auth mode enum.** `createApiRouter({ store, renderer, authMode: 'api_key' | 'none' })`. Default `'api_key'`. Self-hosted Docker example sets `'none'` for localhost. Exposes an existing capability cleanly.

### Tier 2 — fold in if scope allows (cut if the feature bloats)

8. **Minimal read-only dashboard** (`GET /dashboard?key=…`). Server-rendered HTML listing the blog + its posts, human-readable. ~60 lines. Matches the tokenized-URL-in-onboarding-block pattern.

9. **Error response envelope with `request_id`.** Every error response includes a UUID so a later bug-report endpoint can correlate. Trivial addition; future-proofs the bug-report flow.

### Tier 3 — separate follow-up feature after this merges

10. **`AGENT_CONTRACT.md`** at repo root. Written once the REST + MCP contract is stable. Mirrors Proof's format — complete agent-facing HTTP + MCP flow in one doc.

11. **`docs/agent-docs.md`** — human-readable reference with curl examples. Platform serves at `slopit.io/agent-docs`.

### Platform territory (not core — out of scope here)

12. **`POST /bridge/report_bug`** — bug aggregation endpoint. Core exposes a stub that 501s with "use the platform bridge URL"; actual storage and dashboard live in `slopit-platform`.

13. **Hosting** of `slopit.io/slopit.SKILL.md` and `slopit.io/agent-docs` — platform static routes wrapping core generators.

---

## Things from Proof we deliberately don't copy

- **Two-token model** (ownerSecret + role-scoped accessToken). Solo-agent publishing doesn't need viewer/commenter/editor roles. One blog-scoped key, one implicit owner role.
- **Event polling + ack endpoints.** Blogs have no agent-observable state changes. YAGNI.
- **WebSocket collab / realtime presence.** Wrong product — we're publish-only, not collaborative.
- **Legacy route aliases.** Fresh repo, one canonical route per resource. No `/api/posts` + `/posts` + `/share/markdown` triple-naming.
- **Provenance tracking / authorship marks.** Static blog, single author per blog (the agent). No provenance UI.
- **Snapshot URLs separate from canonical URLs.** Our static files ARE the snapshot.

---

## Open design questions to brainstorm

1. REST path shape: `/blogs/:id/posts/:slug` vs `/posts/:id`? (Blog-scoped is more REST-idiomatic and maps cleaner to directory layout.)
2. Where does API-key auth live — Hono middleware at router level, or per-route? (Middleware. Skip for `/signup` and `/health`.)
3. Complete `SlopItError.code` → HTTP status table. Draft: 409 for `*_CONFLICT`, 404 for `*_NOT_FOUND`, 400 for `ZodError`, 401 for bad/missing key, 500 default.
4. MCP tool naming — verbatim from `strategy.md` (`create_post`, `signup`, etc.) or refined? (Verbatim unless there's a concrete reason.)
5. Shared Zod schemas for REST body parse + MCP tool input schema. (One source of truth. Zod → MCP schema converter, or hand-written MCP schemas that mirror Zod?)
6. JSON-only body parsing, or also form-encoded? (JSON only for v1. Plus `text/markdown` per Tier 1 item 4.)
7. Testing: Hono's `app.request()` helper for REST; MCP has its own test harness. Structure to share fixtures.
8. Observability — core logs nothing (consumer decides), or surface a pluggable logger interface?
9. Rate limiting — platform concern, confirm core is a no-op here.
10. Dashboard — in this feature or a separate one? (Tier 2 says in scope; reassess during brainstorming.)

---

## Starting state for the new session

Assumes `feat/create-post` has merged to `dev`. Verify first.

```bash
git fetch --all
git checkout dev
git pull
# Sanity: feat/create-post's work should be on dev
ls src/posts.ts src/ids.ts src/rendering/templates.ts src/themes/minimal/post.html

git checkout -b feat/rest-routes-mcp
pnpm install
pnpm typecheck            # must pass
pnpm test                 # must pass: ~176 tests
```

If any of that fails at the start, stop and ask — the baseline is wrong.

---

## Required reading before brainstorming

1. `CLAUDE.md` — non-negotiable philosophy + the new `feat → dev → main` git flow.
2. `ARCHITECTURE.md` — core/platform boundary, factory pattern. Rule #5 has the narrow `slopit.io` exception for the Powered-By link; otherwise no `slopit.io` strings in core.
3. `docs/superpowers/specs/2026-04-22-create-post-design.md` — reference pattern for how we structure specs, error handling, `@internal` visibility.
4. `src/blogs.ts`, `src/posts.ts`, `src/rendering/generator.ts` — reference patterns for `@internal` helpers, transactional DB ops, narrow-match error predicates, sync interfaces.
5. `strategy.md` in `Wipiway/slopit-platform` — the MCP tool list, the signup response shape, the onboarding-block spirit.
6. `https://github.com/EveryInc/proof-sdk/blob/main/AGENT_CONTRACT.md` — Proof's public agent-facing contract. Our inspiration for `_links`, `Idempotency-Key`, text/markdown body, auth modes, and the onboarding block structure.

---

## Workflow

1. Invoke `superpowers:brainstorming` → spec at `docs/superpowers/specs/<date>-rest-routes-mcp-design.md` on `feat/rest-routes-mcp`.
2. After spec review, invoke `superpowers:writing-plans` → plan at `docs/superpowers/plans/<date>-rest-routes-mcp-implementation.md` on the same branch.
3. Commit both; open PR from `feat/rest-routes-mcp` → `dev`. PR is docs-only at first.
4. Execute the plan via `superpowers:subagent-driven-development` (or hand to another session / human).
5. Commits land on the same branch; PR grows to include implementation.
6. Dev review; merge to `dev` when green.
7. Later, `dev → main` when we're ready to cut a release.

Keep TDD discipline. Keep scope narrow (Tier 1 required, Tier 2 optional, Tier 3 later). Previous features went through 3–5 review rounds; don't skip them.

---

## Contact

NJ (repo owner). When a design decision isn't obvious from the docs, surface it rather than guessing. When a Proof-sdk learning suggests a different shape than our current design, flag it in brainstorming so we can decide deliberately.
