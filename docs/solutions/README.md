# docs/solutions/ — Compound Memory

When you (human or agent) solve something non-obvious, drop a short file here so the next agent doesn't re-learn it. This is how SlopIt gets smarter over time instead of just older.

## What goes here

Things that are **surprising, non-obvious, or recurring**:

- Bugs whose root cause wasn't where you first looked
- Invariants that aren't enforced by types or tests (and why)
- Patterns that work well in this codebase, with a concrete example
- Workarounds for external constraints (SQLite quirks, MCP SDK behavior, filesystem atomics, Hono middleware ordering)
- Decisions made and alternatives rejected, with the reasoning

## What does **not** go here

- Things obvious from reading the code
- Happy-path how-tos (put those in the README or `SKILL.md`)
- Ephemeral task notes (use PR descriptions or commit messages)
- Anything already in `CLAUDE.md`, `ARCHITECTURE.md`, or `DESIGN.md`

If removing the file wouldn't confuse a future contributor, don't write it.

## File format

One file per learning. Name it after the topic, not the symptom:

- ✅ `cross-blog-url-isolation.md`
- ✅ `sqlite-busy-timeout-default.md`
- ❌ `bug-fix-2026-04-23.md`
- ❌ `fixing-auth-stuff.md`

Every file starts with YAML frontmatter:

```yaml
---
title: Short descriptive title
tags: [auth, rendering, mcp, migrations, api, db, themes]
severity: p1 | p2 | p3
date: 2026-04-23
applies-to: [core, platform, self-hosted]
---
```

Body: lead with the **rule**, then **why** (the reason or incident behind it), then a **minimal example** or a pointer to the commit/test that locks it down.

```md
## Rule

API-key auth MUST be checked before the route is matched, not after.

## Why

See commit 0c32368. Mount-prefix auth skipped the check when the prefix matched
but the route didn't — two blogs sharing a prefix could read each other's data.

## Example / proof

- Test: `tests/api/multi-blog-renderer.test.ts`
- Enforced in: `src/api/auth.ts:42`
```

Keep each file under ~100 lines. If it's longer, it's probably two files.

## How agents use this

Agents (especially `ce-learnings-researcher` from the compound-engineering plugin) scan this directory by frontmatter **before starting work**. Tags are the retrieval key — use them.

After resolving a non-obvious issue, running `/ce-compound` will offer to write a file here for you. Accept if it captures something the next agent wouldn't find by reading the code.
