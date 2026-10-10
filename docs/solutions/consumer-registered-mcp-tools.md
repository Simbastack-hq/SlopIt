---
title: Consumer-registered MCP tools — register on the returned server, wrap with wrapTool
tags: [mcp, auth, platform, api-surface]
severity: p3
date: 2026-10-11
applies-to: [core, platform, self-hosted]
---

## Rule

A consumer adds its own MCP tool by calling `server.registerTool(...)` on the server `createMcpServer(config)` returns, before `server.connect(...)`, and wrapping the handler with the exported `wrapTool(config, name, opts, business)`. Pass the same `config` object you gave `createMcpServer`.

```ts
const server = createMcpServer(config)
server.registerTool(
  'my_tool',
  { inputSchema, outputSchema /* title, annotations */ },
  wrapTool(config, 'my_tool', { auth: 'required', crossBlogGuard: true }, (args, ctx) => ({
    // ctx.blog is the authenticated blog; ctx.store is core's store
  })),
)
```

- `auth: 'required'` + `crossBlogGuard: true` gives the core-tool behaviour: no or bad key → `UNAUTHORIZED`, a `blog_id` that isn't the key's blog → `BLOG_NOT_FOUND`, anything thrown → the `isError: true` envelope with `structuredContent.error`. Declare an optional `blog_id` in `inputSchema` like core's tools do.
- `outputSchema` follows `mcp-output-schemas.md`: `z.looseObject`, optional success fields, `error` declared. The client validates error results too.
- Name the tool in the `wrapTool` call exactly as registered; idempotency records are keyed on it.

## Why

- `wrapTool` is the one place auth, the cross-blog guard, idempotency and the error envelope live. A tool that hand-rolls them drifts, and the cross-blog guard is the one that leaks data if it's wrong.
- Rejected: an `extraTools` field on `McpServerConfig`. Same result, but it adds config surface core must keep stable, and it would make core model "tools it doesn't own" (registration order, name clashes, metadata shape). The SDK already has `registerTool`; exporting `wrapTool` is the whole hook, and core knows nothing about what consumers register.
- `ToolCtx` and `WrapToolOpts` are exported so consumers can type their handlers. The public surface is now whatever `wrapTool` does, so changes to its pipeline are changes to the consumer contract.

## Example / proof

- Test: `tests/mcp/consumer-tools.test.ts` (real SDK `Client` over `InMemoryTransport`: no key, valid key, other blog, listed).
- Exported from `src/index.ts`; implementation in `src/mcp/wrap-tool.ts`.
