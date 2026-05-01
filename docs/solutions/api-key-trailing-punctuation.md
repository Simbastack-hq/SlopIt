---
title: API keys must not end in non-alphanumeric characters
tags: [auth, onboarding, api]
severity: p2
date: 2026-05-01
applies-to: [core, platform, self-hosted]
---

## Rule

`generateApiKey()` MUST reroll until the body's last character is in
`[A-Za-z0-9]`. Keys ending in `-` or `_` are forbidden.

## Why

The onboarding credential block we hand to humans and agents looks like:

```
----- SLOPIT BLOG -----
Blog URL:     https://blog.slopit.io/
API key:      sk_slop_XyBL4vV4rG8fDoM_-1V5-Bpf654DbX2-
Blog id:      8995kuea
-----------------------
```

base64url's alphabet is `[A-Za-z0-9_-]`, so ~3% of generated keys end in `-`
or `_`. When the trailing character is `-`, it is visually indistinguishable
from the `-----` separator on the line below. Humans copy-pasting the block,
and agents parsing it, silently drop the trailing `-` and produce a 39-char
key from a 40-char one.

The server returns a clean `401 UNAUTHORIZED — Invalid API key` for the
truncated key, which gives the caller no signal that one character is
missing. Failure mode is silent and frustrating; observed in the wild
(2026-05-01).

Considered alternatives:

- **Quote the key in the email** — fixes one source but leaves agents that
  re-emit credentials to other agents still vulnerable.
- **Length hint in the email** — relies on every consumer checking it.
- **Different separator (`===`)** — fixes the email but the key is still
  ambiguous if any future surface uses dashed separators.

Rerolling at generation time fixes every consumer of the key forever, costs
~3% extra `randomBytes(24)` calls, and keeps the key's entropy unchanged
(still 23.94 bits per char × ~31.94 expected chars ≈ same bits as before).

## Example / proof

- Generation site: `src/auth/api-key.ts` (single source of truth; both
  `blogs.createApiKey()` and `recovery` rotation route through it)
- Statistical test: `tests/smoke.test.ts` — generates 1000 keys and asserts
  the last char of each is alphanumeric
