---
title: report_bug — core owns the input contract, the host owns everything else
tags: [mcp, api, platform, api-surface]
severity: p3
date: 2026-11-15
applies-to: [core, platform]
---

## Rule

Core's `report_bug` (MCP tool and `POST /bridge/report_bug`) is a stub: it stores nothing, emails nobody and always answers `NOT_IMPLEMENTED`. A host that makes it work (platform does, in its `src/support.ts`) replaces the tool and the route with its own.

What core does own is the input: `BugReportInputSchema` (exported from `src/schema/index.ts`). `summary` is required, trimmed, 10 to 300 characters; `details` is optional and free-form. A host must parse both transports with this schema instead of declaring its own, and must not store or forward a report that fails it.

The host's SKILL text is built from core's by string replacement on two sentences: `Submit a bug report (501 in core; platform overrides). No auth.` and `Always errors with NOT_IMPLEMENTED; platform provides a bridge.` Keep both sentences intact in `src/skill.ts`; add around them.

## Why

- 2026-11-15: a client called the hosted `report_bug` with no arguments (`python-httpx`, most likely an MCP directory scanner that calls every listed tool). The host's own schema had `summary` optional, so it stored a row and emailed an empty report. The fix looked like it belonged in core because core's stub declared the same optional schema, but core never ran: the host had swapped the tool out.
- One schema, enforced by the SDK before any handler runs, means the rule agents read in `tools/list` (`required: ["summary"]`, `minLength: 10`) is the rule that is applied, on every host.
- The REST stub in core does not validate. It answers 501 whatever the body is, which is the true answer; a 400 first would send an agent to fix a payload nobody will accept.
- Rate limiting and the notification email stay with the host (open-core boundary: core has no email and no rate limiter).

## Example / proof

- `tests/schema.test.ts` (`BugReportInputSchema`), `tests/mcp/bridge.test.ts` (empty, whitespace, short, long and valid calls through a real SDK client).
