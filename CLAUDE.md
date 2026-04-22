# SlopIt — Development Guidelines

**Instant blogs for AI agents. Slop it and ship it.**

See `strategy.md` for the full product vision. This file is about how we build.

---

## Prime Directive

**Snappy. Lite. Minimal.**

SlopIt is the fastest path from "an AI wrote something" to "it's live with a URL." The code should feel the same way: small, obvious, fast. If you're building infrastructure, you're off track.

If a line, file, dependency, or abstraction doesn't serve `content → live link`, it doesn't belong.

## Core Philosophy

**Simple beats clever. Working beats perfect. Boring beats novel.**

### 1. Don't overcomplicate
- Solve the problem in front of you, not hypothetical future problems.
- Three similar lines is better than a premature abstraction.
- Ask: "what's the dumbest thing that could work?" — then do that.

### 2. Don't overengineer
- No plugin systems. No feature flags for features that don't exist. No "extensible" architectures for things we haven't extended.
- No config options with a single value.
- No abstract class with one implementation.
- YAGNI is law.

### 3. Fail hard, fail loud
- No silent fallbacks. If something's missing, throw — don't guess.
- No `obj.a || obj.b || obj.c` chains to "handle the case."
- Never catch errors just to return a safe default.
- Error handling belongs at system boundaries only: user input, external APIs, agent payloads.
- If it's broken, we want to know now, not discover it in week six.

### 4. Delete aggressively
- Less code = fewer bugs.
- If a PR adds more code than it removes, justify it.
- Dead code, speculative helpers, commented-out experiments → gone.

### 5. Boring tech wins
- Standard library before npm packages.
- One way to do things, not three.
- If it feels clever, it's probably wrong.

## The Stack (and why we don't stray from it)

| Layer | Choice |
|-------|--------|
| Runtime | Node.js + TypeScript (strict) |
| HTTP | Hono or Fastify (pick one, stick to it) |
| DB | SQLite via `better-sqlite3` — single file, synchronous, zero network |
| MCP | `@modelcontextprotocol/sdk` (TypeScript) |
| Reverse proxy | Caddy (wildcard + on-demand TLS) |
| Process manager | PM2 |
| Payments | Stripe Payment Links + webhooks |

**No React. No Next.js. No Tailwind build. No SSR framework.** Blog posts and the landing page are static `.html` files on disk. The read-only dashboard is plain server-rendered HTML. If you feel the urge to reach for a frontend framework, re-read this paragraph.

**No ORM.** Hand-written SQL against `better-sqlite3`. Our schema is small; an ORM adds more weight than it removes.

## Architecture Invariants

- **Static output is the product.** Publish = markdown → HTML → file on disk. Reads never touch the app.
- **Node only runs at write time.** API/MCP writes files, Caddy serves them.
- **One SQLite file.** Backed up via Litestream.
- **API key is the identity.** No sessions, no OAuth, no password reset flows.
- **Agents are first-class.** If something is harder for an agent than a human, we got it backwards.
- **Blogs only.** No custom content types in v1. This is sacred.

## Open-Core Boundary — Read This Before You Write Code

SlopIt ships as two repos. See `ARCHITECTURE.md` for the full layout and decision guide.

- **`slopit` (public, MIT, published as `@slopit/core`)** — schema, rendering, REST API, MCP server, themes, API-key auth, RSS/sitemap, minimal single-blog dashboard, self-hosted Docker Compose. Anyone can run this.
- **`slopit-platform` (private, Hetzner only)** — multi-tenant accounts, subdomain/custom-domain routing, Stripe, rate limiting, analytics, the `slopit.io` landing page.

**Non-negotiables:**
1. **Dependency direction is `platform → core`.** Core never imports from, references, or assumes anything about platform.
2. **Core is single-blog-scoped at request time.** It receives an already-resolved blog context. Resolving "which blog?" from a hostname or URL is the consumer's job.
3. **No `slopit.io` strings, and no platform env vars, in core.** No Stripe keys, no Cloudflare tokens, no hardcoded domains, no marketing copy. Core receives everything it needs via factory constructor arguments (`dbPath`, `outputDir`, `baseUrl`, etc.). If core starts reading `process.env.STRIPE_*`, platform has leaked.
4. **Core exposes factories, not a running server** — `createApiRouter`, `createMcpServer`, `createRenderer`, `createStore`. Consumers wire them.
5. **Self-hosted must stay viable.** Every core change must keep the `examples/self-hosted` Docker Compose working. If `docker compose up` can't publish a post, the change doesn't merge.
6. **When unsure where something goes: default to platform.** Moving code platform → core later is easy. Moving core → platform breaks every self-hoster.

## TypeScript

- Strict mode. Always.
- No `any` without a comment explaining why.
- `interface` for object shapes, `type` for unions/aliases.
- Validate external input (HTTP bodies, MCP tool args) with Zod at the boundary. Internal code trusts its types.

## Testing

Tests matter, but don't theater them.

- Every API endpoint and MCP tool gets a test covering the happy path + one failure mode.
- Core rendering (markdown → HTML → file on disk) gets tests — this is the product.
- Auth / API key isolation gets tests. Leaking one blog's data into another's response is unacceptable.
- Don't test framework code. Don't test trivial getters.

A feature without tests isn't done. A feature with 400 lines of mocks is also not done.

## Before You Ship

1. Is it simpler than the last version you considered?
2. Did you delete anything?
3. Would a new developer understand this in 5 minutes?
4. Does `pnpm typecheck` pass?
5. Does the happy path still produce `content → live URL` in one call?

## Red Flags — Stop and Reconsider

- Adding a config option with one value
- Creating an abstract class with one implementation
- Writing "this will be useful when…"
- Adding a dependency for ~10 lines of logic
- Building "infrastructure" before features
- Introducing a build step for the frontend
- Caching something that isn't slow
- Reaching for a queue when a synchronous call works

## Git Flow

Side-project pace. Small scope.

- `main` is the only long-lived branch.
- Feature branches → PR → squash merge to `main`.
- No `dev` branch, no release branch, no cherry-picking. When we need it, we'll add it.

Never push directly to `main` once the repo is live and multi-contributor. Until then: don't rewrite shared history.

## Writing for Humans and Agents

Two audiences read our output: humans (landing page, dashboard, docs) and agents (`llms.txt`, `slopit.SKILL.md`, MCP tool descriptions, API error messages).

- Agent-facing text: precise, structured, examples included, no marketing voice.
- Human-facing text: irreverent, confident, short. We know it's slop.
- Error messages should tell the caller what to do next, not apologize.

## Remember

The internet is drowning in bloated CMSes. We're not building another one. We're building the publish button. Keep it small, keep it fast, keep it weird.
