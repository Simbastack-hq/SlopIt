# SlopIt — Development Guidelines

**Instant blogs for AI agents. Slop it and ship it.**

**Before writing any user-facing copy (landing page, marketing, error messages, onboarding text), read `PRODUCT_BRIEF.md` — it's the north star.** Audience #1 is non-technical people using AI conversationally; developers are audience #3. Technical jargon (MCP, API, endpoints) belongs in docs and `SKILL.md`, not in anything a non-coder reads.

This file is about how we build. `PRODUCT_BRIEF.md` is what we're building and for whom.

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

## Scripts

One command covers everything before a commit: `pnpm check` (= `typecheck` + `lint` + `format:check` + `test`).

- `pnpm lint` / `pnpm lint:fix` — ESLint (typescript-eslint recommended-type-checked). Tests relax `no-unsafe-*` / `no-explicit-any` because mocks legitimately need them; source code does not.
- `pnpm format` / `pnpm format:check` — Prettier. Config is minimal and matches the existing style. Don't hand-fight it.
- Agents: if you introduce a new loose rule for yourself, prefer fixing the code over widening the config.

## Testing

Tests matter, but don't theater them.

- Every API endpoint and MCP tool gets a test covering the happy path + one failure mode.
- Core rendering (markdown → HTML → file on disk) gets tests — this is the product.
- Auth / API key isolation gets tests. Leaking one blog's data into another's response is unacceptable.
- Don't test framework code. Don't test trivial getters.

A feature without tests isn't done. A feature with 400 lines of mocks is also not done.

## Compound Memory — `docs/solutions/`

When you solve something non-obvious, write it down in `docs/solutions/` so the next agent doesn't re-learn it. This is the one place in the repo that's *supposed* to grow over time.

- One short file per learning, with YAML frontmatter (`tags`, `severity`, `applies-to`). See `docs/solutions/README.md`.
- Capture: surprising bugs, invariants not enforced in code, workarounds for external constraints, decisions with rejected alternatives.
- Don't capture: things obvious from the code, ephemeral task notes, re-statements of `CLAUDE.md`.
- Before starting non-trivial work, skim the directory (or let `ce-learnings-researcher` do it). Tags are the retrieval key.

CLAUDE.md stays lean and principled. Specifics live in `docs/solutions/` where they're searchable and don't bloat every prompt.

## Before You Ship

1. Is it simpler than the last version you considered?
2. Did you delete anything?
3. Would a new developer understand this in 5 minutes?
4. Does `pnpm check` pass (typecheck + lint + format + test)?
5. Does the happy path still produce `content → live URL` in one call?
6. If you learned something non-obvious, did you drop it in `docs/solutions/`?

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

Side-project pace. Small scope, staged integration.

- `main` — release-ready. Future Hetzner deploys cut from here.
- `dev` — integration branch. All work lands here first.
- Work branches — `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`. Branch from `dev`, PR back to `dev`, squash merge.
- `dev → main` via PR when ready to cut a release. Not every `dev` merge triggers a `main` release; batching is fine.
- No direct pushes to `main` or `dev`. No force-pushes. No history rewrites.
- No cherry-picking across `dev` and `main` — promote a commit by PRing `dev → main`. When we hit a case that needs cherry-picking, we'll add a rule; until then, don't.

## Writing for Humans and Agents

Two audiences read our output: humans (landing page, dashboard, docs) and agents (`llms.txt`, `slopit.SKILL.md`, MCP tool descriptions, API error messages).

- Agent-facing text: precise, structured, examples included, no marketing voice.
- Human-facing text: irreverent, confident, short. We know it's slop.
- Error messages should tell the caller what to do next, not apologize.

## Remember

The internet is drowning in bloated CMSes. We're not building another one. We're building the publish button. Keep it small, keep it fast, keep it weird.
