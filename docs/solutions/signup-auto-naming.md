---
title: Signup auto-names unnamed blogs in signupBlog, not createBlog
tags: [api, mcp, db, signup]
severity: p2
date: 2026-11-20
applies-to: [core, platform, self-hosted]
---

## Rules

1. **Auto-naming lives in `signupBlog`** (`createAutoNamedBlog` in `src/signup.ts`, candidates in `src/blog-name.ts`). Every blog-creating path goes through it: REST `/signup`, MCP `signup`, and the platform's OAuth connect and Stripe paid-before-signup, which both call core's `signupBlog`. `createBlog` itself still makes unnamed blogs, because the `nameValidator` hook lives on `SignupConfig` and `createBlog` never sees it.
2. **A picked name passes the same checks as a chosen one**: `BlogNameSchema`, then `nameValidator`. A rejection skips to the next candidate instead of throwing. A chosen name that's rejected or taken still throws (`BLOG_NAME_RESERVED` / `BLOG_NAME_CONFLICT`). Never rename what the caller asked for.
3. **Collisions are settled by the UNIQUE index, not a lookup.** It tries `acme`, `acme-2` … `acme-9`, then 5 random `blog-xxxxx`, catching only `BLOG_NAME_CONFLICT`. A check-then-insert would let two concurrent signups both see `acme` free.
4. **Names are immutable.** `BlogPatchSchema` has no `name`, and subdomains, custom-domain routing and output dirs key off it. So the onboarding text says "can't be changed later" and points to a fresh signup with `name`. If rename ever ships, update that line, the `name` schema description, SKILL and the `name_auto_assigned` output description.
5. **`foundVia` is echoed back as `found_via` and never stored by core.** The platform reads it from the signup response. Blank after cleaning means omitted, so it never blocks a signup; over 200 characters is a normal validation error.

## Why

On 2026-11-20, 19 of 112 outside blogs had no name. They lived at `/b/<id>/`, which nothing links to.

## Proof

- `tests/blog-name.test.ts`: candidate order and each host rule.
- `tests/signup-auto-name.test.ts`: validator skip, suffix, random fallback, chosen-name path, `foundVia`.
- `tests/api/signup.test.ts`, `tests/mcp/signup.test.ts`: the response fields.
