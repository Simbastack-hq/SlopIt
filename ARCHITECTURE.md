# SlopIt — Architecture & Repo Layout

*Status: Sketch (April 22, 2026). Refine before first commits; do not drift after.*

---

## Two Repos, One Dependency Direction

```
┌──────────────────────────────┐       ┌──────────────────────────────┐
│   slopit-platform (private)  │ ───▶  │      @slopit/core (npm)      │
│   runs on Hetzner            │       │   public repo: slopit (MIT)  │
│   slopit.io, billing, multi- │       │   engine + self-hosted SKU   │
│   tenant routing, analytics  │       │                              │
└──────────────────────────────┘       └──────────────────────────────┘
```

- **`slopit`** — public GitHub repo, MIT, published to npm as `@slopit/core`.
- **`slopit-platform`** — private repo, imports `@slopit/core` as a normal npm dep.
- **Platform depends on core. Core never imports from or knows about the platform.** This is the single most important rule.

---

## What Goes Where

The test: *"Could someone run this as a personal single-tenant blog on their laptop?"*
- **Yes →** core.
- **No, it's specific to hosting thousands of agents on slopit.io →** platform.

| Concern | Core | Platform |
|---|---|---|
| Blog + post schema (SQLite migrations) | ✅ | |
| Markdown → HTML rendering | ✅ | |
| Theme system + built-in themes (v1: `minimal` only) | ✅ | |
| Static file output to configurable dir | ✅ | |
| REST API routes (CRUD on posts/blogs) | ✅ (as factory) | |
| MCP server + tools | ✅ (as factory) | |
| API-key auth (generate, hash, verify) | ✅ | |
| RSS, sitemap, SEO meta | ✅ | |
| Minimal single-blog dashboard | ✅ | |
| Docker Compose for self-hosting | ✅ (`examples/`) | |
| `llms.txt` + `slopit.SKILL.md` schemas | ✅ (generators) | ✅ (hosted instances) |
| Multi-tenant account model | | ✅ |
| Wildcard subdomain routing | | ✅ |
| Custom domain provisioning + on-demand TLS | | ✅ |
| Stripe Payment Links + webhooks | | ✅ |
| Rate limiting, abuse prevention | | ✅ |
| Analytics / usage tracking | | ✅ |
| `slopit.io` landing page | | ✅ |
| Caddy production config | | ✅ |
| PM2 / deploy pipeline | | ✅ |
| Multi-blog dashboard under an account | | ✅ |

---

## Core Design: Factories, Not Servers

Core never boots an HTTP server on import. It exports **factories** that the consumer wires:

```ts
import { createApiRouter, createMcpServer, createStore, createRenderer } from '@slopit/core'

const store = createStore({ dbPath: './slopit.db' })
const renderer = createRenderer({ outputDir: '/var/slopit/blogs', themes: 'default' })
const api = createApiRouter({ store, renderer })
const mcp = createMcpServer({ store, renderer })

// consumer owns the server:
new Hono().route('/api', api).route('/mcp', mcp).fire()
```

This is what lets both the self-hosted Docker Compose and the multi-tenant platform use the same core — each one wraps it differently. Core is a library, not a framework.

**Corollary:** core's rendering function takes a `blogId` and writes files. It does not know about hostnames, subdomains, or custom domains. Mapping `hostname → blogId` is the consumer's job. Platform does it via a subdomain/domain router; self-hosted does it by just having one blog.

---

## Core: Repo Layout (`slopit`, public, MIT)

```
slopit/
├── package.json                    # "@slopit/core", published to npm
├── README.md                       # self-hosted quickstart
├── LICENSE                         # MIT
├── CLAUDE.md                       # dev philosophy
├── ARCHITECTURE.md                 # this file
├── src/
│   ├── index.ts                    # public exports — keep minimal
│   ├── schema/                     # Zod schemas for blog, post, etc.
│   ├── db/
│   │   ├── migrations/             # numbered .sql files, run on boot
│   │   └── store.ts                # createStore() — better-sqlite3 wrapper
│   ├── auth/
│   │   └── api-key.ts              # generate/hash/verify keys
│   ├── api/
│   │   ├── blogs.ts
│   │   ├── posts.ts
│   │   └── index.ts                # createApiRouter({ store, renderer })
│   ├── mcp/
│   │   ├── tools/                  # create_post, list_posts, get_schema...
│   │   └── server.ts               # createMcpServer({ store, renderer })
│   ├── rendering/
│   │   ├── markdown.ts             # md → html (marked or markdown-it)
│   │   ├── templates.ts            # render template with {{vars}}
│   │   ├── feeds.ts                # rss + sitemap
│   │   └── generator.ts            # createRenderer() — writes static files
│   ├── themes/
│   │   ├── minimal/
│   │   │   ├── post.html
│   │   │   ├── index.html
│   │   │   └── style.css
│   │   ├── classic/
│   │   └── zine/
│   └── dashboard/                  # minimal read-only HTML (single blog)
├── examples/
│   └── self-hosted/
│       ├── docker-compose.yml
│       ├── Dockerfile
│       ├── Caddyfile               # minimal single-host config
│       └── server.ts               # ~30 lines wiring core together
├── tests/
└── docs/
    ├── self-hosting.md
    ├── api.md
    └── mcp.md
```

**Exports (`src/index.ts`) — kept deliberately small:**
```ts
export { createStore } from './db/store'
export { createRenderer } from './rendering/generator'
export { createApiRouter } from './api'
export { createMcpServer } from './mcp/server'
export { createDashboard } from './dashboard'
export * from './schema'
export type { Store, Renderer, Blog, Post, ApiKey } from './types'
```

If we need to export something else later, we add it later.

---

## Platform: Repo Layout (`slopit-platform`, private)

```
slopit-platform/
├── package.json                    # depends on "@slopit/core": "^0.x"
├── src/
│   ├── server.ts                   # boots Hono, mounts core routers
│   ├── tenancy/
│   │   ├── accounts.ts             # account model (layered on top of core)
│   │   ├── api-key-resolver.ts     # key → account → blog scope
│   │   └── middleware.ts           # injects resolved blog scope into core
│   ├── routing/
│   │   ├── subdomains.ts           # *.slopit.io → blogId
│   │   ├── paths.ts                # slopit.io/b/:slug → blogId
│   │   └── custom-domains.ts       # custom domain → blogId lookup
│   ├── provisioning/
│   │   ├── subdomain.ts            # reserve slug, allocate output dir
│   │   └── custom-domain.ts        # Caddy on-demand TLS, DNS check
│   ├── billing/
│   │   ├── stripe-payment-link.ts
│   │   └── webhooks.ts             # payment success → flip pro flag
│   ├── limits/                     # rate limiting, quota enforcement
│   ├── analytics/                  # usage + page views
│   ├── dashboard/                  # multi-blog dashboard
│   ├── landing/                    # slopit.io marketing (static HTML)
│   └── discovery/                  # slopit.io/llms.txt, /slopit.SKILL.md
├── migrations/                     # platform-only tables (accounts, etc.)
├── caddy/
│   └── Caddyfile                   # production config, wildcard + on-demand
├── ecosystem.config.js             # PM2
└── .github/workflows/deploy.yml    # → Hetzner
```

---

## Boundary Rules (Non-Negotiable)

1. **Dependency direction.** `platform → core`. Ever.
2. **Core is single-blog-scoped at the request level.** Every core handler receives an already-resolved blog context. Core does not resolve "which blog is this request for." That's the consumer's job.
3. **Core owns its tables.** `blogs`, `posts`, `api_keys`, etc. Platform never writes to core tables directly — it calls core's store API. Platform migrations add its own tables only (`accounts`, `subscriptions`, `custom_domains`, etc.) with foreign keys *into* core tables.
4. **Core writes to a configurable output directory.** Platform chooses the path per blog. Core never assumes `/var/slopit/...`.
5. **No `slopit.io` strings, and no platform env vars, in core — with one documented exception:** the "Powered by SlopIt" footer link emitted by `renderPoweredBy` in `src/rendering/generator.ts` points to `https://slopit.io`. This is the single branding hook in core; platform strips/replaces it per plan (Pro tier). Everything else this rule covers — Stripe keys, Cloudflare tokens, marketing copy, platform env vars, other hardcoded domains — stays forbidden. Core emits relative URLs or takes a `baseUrl` parameter.
6. **Core ships themes. Platform does not.** Adding a theme = PR to the public repo. If we ever want private/premium themes, we cross that bridge then.
7. **Self-hosted must stay viable.** Every core PR runs the self-hosted example in CI. If you can't `docker compose up` and publish a post, the PR doesn't merge.
8. **Platform private features are flags layered on top of core responses.** E.g., core returns a post; platform middleware strips/adds "Powered by SlopIt" footer based on the account's plan. Core doesn't know plans exist.
9. **Core has zero platform-specific environment variables.** No `STRIPE_KEY`, no `CLOUDFLARE_TOKEN`, no `SLOPIT_DOMAIN`, no feature flags. Everything core needs arrives via factory constructor arguments (`createStore({ dbPath })`, `createRenderer({ outputDir, baseUrl })`, etc.). A self-hoster running the Docker Compose example should not need to set more than a handful of obvious vars (DB path, output dir, port). If core starts demanding env vars, we're leaking platform into it.

---

## Open Questions (Decide Before First Commit)

- **npm org name.** `@slopit/core`? Need to claim the org.
- **Do we publish to npm from day one, or vendor core into platform via git submodule for the first few weeks?** npm from day one is cleaner but slower to iterate. I'd vote: develop core locally via `npm link` or pnpm workspaces during early dev, publish once the API shape is stable.
- **SQLite schema migrations across the boundary.** *Resolved:* shared DB file, numeric prefix convention. Core owns `001_core_*.sql` through `099_core_*.sql`. Platform owns `100_platform_*.sql` onward. Migrations run in filename order. Core never touches `100+`; platform never touches `001–099`. (If we ever hit 100 core migrations we have bigger problems.)
- **Does core ship a CLI?** `npx @slopit/core init` to scaffold a self-hosted setup would be nice. Not v1.

---

## Decision Guide for "Where Does This Go?"

Before adding code, ask in order:

1. Would a self-hosted user want this? → **core**
2. Is it specific to multi-tenant, billing, subdomains, or slopit.io branding? → **platform**
3. Both? → put the generic primitive in core, the policy/wiring in platform.
4. Unclear? → default to **platform**. Pulling from platform → core later is easy. Pulling from core → platform is a breaking change for self-hosted users.
