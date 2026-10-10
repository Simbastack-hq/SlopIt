---
title: MCP outputSchema — loose objects, optional success fields
tags: [mcp, schema, zod]
severity: p2
date: 2026-10-10
applies-to: [core, platform, self-hosted]
---

## Rule

Every tool's `outputSchema` (`src/mcp/output-schemas.ts`) is built from `z.looseObject`, at every depth, and every top-level success field is `.optional()`. Each schema also declares the `error` envelope.

## Why

- **Error results are validated too.** Business errors return `isError: true` with `structuredContent: { error: { code, message, details } }` (platform tests and SKILL.md rely on that shape). The MCP server SDK skips output validation when `isError` is set, but the TypeScript SDK client (1.29.0, `Client.callTool`) validates `structuredContent` whenever it is present. A required success field (`post`, `blog`, …) therefore turns every business error into `MCP error -32602: Structured content does not match the tool's output schema` thrown at the agent, and the agent never sees `POST_NOT_FOUND` or the fix it names.
- **Plain `z.object()` closes the schema.** The SDK converts zod with `io: 'output'`, and zod 4 emits `additionalProperties: false` for a non-loose object in output mode. Then the next response field we add fails validation in any client that checks. `z.looseObject` emits `additionalProperties: {}`.
- **No formats or refinements on outputs.** Output schemas use bare `z.string()`, not `httpUrl`/`languageTag`/slug regexes: the client validates formats (ajv with `ajv-formats`), and stored rows are not guaranteed to pass today's input rules.

## Example / proof

- `tests/mcp/tool-metadata.test.ts` calls every tool through `Client.callTool` after `listTools()` (which primes the client's validators) and validates success and error results against the listed schema. Making `PostOutput.post` required fails the `get_post` error case with the -32602 above.
- SDK-side input validation errors carry no `structuredContent`, so they never hit this.
