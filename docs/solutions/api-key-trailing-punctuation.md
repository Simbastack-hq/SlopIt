---
title: API key body is base62, not base64url
tags: [auth, onboarding, api]
severity: p2
date: 2026-05-01
applies-to: [core, platform, self-hosted]
---

## Rule

`generateApiKey()` MUST produce keys whose body is alphanumeric only:
`/^sk_slop_[A-Za-z0-9]{32}$/`. The body is sampled from a base62 alphabet
using `randomInt`. base64url's `-` and `_` are forbidden in keys.

## Why

The onboarding credential block we hand to humans and agents looks like:

```
----- SLOPIT BLOG -----
Blog URL:     https://blog.slopit.io/
API key:      sk_slop_XyBL4vV4rG8fDoM_-1V5-Bpf654DbX2-
Blog id:      8995kuea
-----------------------
```

base64url's alphabet `[A-Za-z0-9_-]` includes two characters — `-` and `_` —
that are visually ambiguous next to the dashed separators above. A trailing
`-` is indistinguishable from the start of the closing `-----` line, and
even an internal `-` next to a line wrap can blur in chat UIs. Humans
copy-pasting the block, and agents parsing it, silently drop these chars
and produce a malformed key. The server returns a clean
`401 UNAUTHORIZED — Invalid API key` for the truncated key, giving the
caller no signal that one character is missing. Failure mode is silent and
frustrating; observed in the wild (2026-05-01).

Considered alternatives:

- **Quote the key in the email** — fixes one surface but leaves agents
  that re-emit credentials still vulnerable.
- **Length hint in the email** (`API key (40 chars):`) — relies on every
  consumer checking it.
- **Different separator (`===`) in the email** — fixes the email but the
  key is still ambiguous if any future surface uses dashed separators.
- **Reroll only the trailing char** (the first attempt at this fix) —
  leaves internal `-`/`_` in the key, which can still confuse readers at
  line wraps; also creates a hidden invariant ("last char must be
  alphanumeric") that future maintainers wouldn't think about.

Restricting the alphabet at the source fixes every consumer of the key
forever. 32 chars × log2(62) ≈ 190 bits of entropy — well above the
128-bit target. Existing keys still verify (verification is hash-based,
format-agnostic), so this is a no-migration change.

## Example / proof

- Generation site: `src/auth/api-key.ts` (single source of truth; both
  `blogs.createApiKey()` and `recovery` rotation route through it)
- Test: `tests/smoke.test.ts` — generates 1000 keys and asserts each
  body matches `/^[A-Za-z0-9]{32}$/`
- Implementation note: uses `crypto.randomInt(0, 62)` per character to
  avoid the modulo bias `randomBytes(N)[i] % 62` would introduce
