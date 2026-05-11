# Self-Hosted SlopIt

Run a single-tenant SlopIt instance on your own server. One blog, one SQLite file, one Caddy, done.

> **Status:** scaffold only. `server.ts`, `Dockerfile`, `docker-compose.yml`, and `Caddyfile` arrive once core factories are wired up.

## Planned layout

```
examples/self-hosted/
├── server.ts           # ~30 lines: createStore → createRenderer → createApiRouter + createMcpServer, boot Hono
├── Dockerfile
├── docker-compose.yml  # app + Caddy + Litestream (optional)
└── Caddyfile           # single-host, auto HTTPS
```

## Reverse-proxy MIME types (when the `Caddyfile` lands)

The renderer emits four agent-facing files alongside `<slug>/index.html`: `<slug>.md`, `llms.txt`, `feed.xml`, `sitemap.xml`. Browsers and HTTP clients only render these correctly if the reverse proxy advertises the right `Content-Type` header. The future `Caddyfile` (and any equivalent nginx / Traefik / Apache config a self-hoster writes today) must set:

| Path | Content-Type |
|---|---|
| `*.md` | `text/markdown; charset=utf-8` |
| `/llms.txt` | `text/markdown; charset=utf-8` |
| `/feed.xml` | `application/rss+xml; charset=utf-8` |
| `/sitemap.xml` | `application/xml; charset=utf-8` |

Caddy syntax for reference:

```caddy
@markdown path *.md
header @markdown Content-Type "text/markdown; charset=utf-8"

@llmstxt path /llms.txt
header @llmstxt Content-Type "text/markdown; charset=utf-8"

@feed path /feed.xml
header @feed Content-Type "application/rss+xml; charset=utf-8"

@sitemap path /sitemap.xml
header @sitemap Content-Type "application/xml; charset=utf-8"
```

Without these rules the files still serve, but browsers may render `.md` as `text/plain` (no styling) and feed readers may reject `feed.xml` as `text/xml` instead of RSS.

## Philosophy

The self-hosted example is a contract, not a feature. Every core change must keep `docker compose up` working and a post publishable via `POST /blogs/:id/posts`. If it doesn't, the change doesn't merge.
