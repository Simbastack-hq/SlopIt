---
title: Stateless MCP over HTTP needs a fresh transport per request
tags: [mcp, self-hosted]
severity: p1
date: 2026-10-10
applies-to: [core, platform, self-hosted]
---

## Rule

With `sessionIdGenerator: undefined` (stateless mode), build a new
`WebStandardStreamableHTTPServerTransport` **and** a new
`createMcpServer(config)` inside the `/mcp` handler, connect them, then
`return transport.handleRequest(req)`. Never connect one transport at
startup and route every request to it.

## Why

`@modelcontextprotocol/sdk` 1.29.0 throws on the second request to a
reused stateless transport: "Stateless transport cannot be reused across
requests. Create a new transport per request." (JSON-RPC ids from
different clients would collide.) The first request works, so a quick
`initialize` check passes and the bug only shows on the next call
(`signup`, `create_post`), as a bare 500.

`examples/self-hosted/mcp-http.ts` shipped the single-transport shape from
April to 2026-10-10; the platform's `/mcp` handler already did it right.

The per-request cost is small: `createMcpServer` only registers tool
handlers, with no I/O, and every instance shares the same `store` and
renderer through `config`.

## Example / proof

- `examples/self-hosted/mcp-http.ts`: the `app.all('/mcp', ...)` handler.
- Repro: three separate POSTs to `/mcp` (`initialize`, `tools/call signup`,
  `tools/call create_post` with the Bearer key), each with
  `Accept: application/json, text/event-stream`. All three must return 200.
