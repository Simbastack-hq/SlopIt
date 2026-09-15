---
title: Translations — language homes live under /lang/, the root language follows the content, pruning is last and directories-only
tags: [rendering, i18n, schema, themes]
severity: p2
date: 2026-09-15
applies-to: [core, platform, self-hosted]
---

## Rules

1. **Per-language home pages live at `/lang/<lowercase-tag>/`, never `/<tag>/`.** On a multilingual blog the root language has one too (a duplicate of `/` with canonical → `/`), so a language's home and feed URL survive the root changing. Post slugs and language homes must not share a namespace: a legacy post at `/it/` and an Italian home page would fight over one `index.html`. One reserved slug (`lang`, `POST_SLUG_RESERVED`) is cheaper and safer than reserving every language code and guessing which directories are ours. The platform's analytics aggregator already collapses multi-segment paths to the home bucket, so `/lang/de/` counts as a home view for free.
2. **The root language is derived, not stored.** `listBlogLanguages` puts `blog.language` first only when at least one published post is in it; otherwise the most-published language (tie: alphabetical) is the root. Reason: hosted blogs whose stored default drifted from their content (all `en`, posts in Russian) must never render the "Nothing here yet" empty state on `/`. Consequence: a *publish* can change the root (a third French post on a 2 de / 2 fr blog), which changes what `/` shows; French keeps `/lang/fr/` and its feed (rule 1), so no URL breaks.
3. **Stale homes are pruned last, at every mutation site, directories only.** `Renderer.pruneLanguageHomes` runs after every render in `createPost`, `updatePost`, `deletePost` and `updateBlog` — after, because it is destructive and a render failure must leave the old home for the compensated DB state; every site, because of rule 2; directories only, because a pre-reservation post with slug `lang` owns `lang/index.html` (a file) and the `lang.md` guard in `renderBlog` only fires on multilingual blogs.
4. **Group members store an explicit `language`.** Joining a translation group writes `COALESCE(language, blog.language)` on the target and an explicit language on the joiner, in one transaction with the uniqueness preflight; compensation restores both rows. The partial unique index `(blog_id, translation_group, language) WHERE translation_group IS NOT NULL` is the backstop. Without the freeze, a blog-default change could make two members collide.
5. **No cookie, no IP.** The hosted root negotiates from `Accept-Language` (exact tag, else same language + same maximized script) and points every switcher and post home link at the language's stable `/lang/<tag>/` home (root language included), so an explicit choice is never re-negotiated. The privacy policy promises no cookies on rendered blog pages, so an explicit choice lasts for the click, by design.

## Why each was hard-won

- Codex plan review flagged the `/<tag>/` namespace as a blocker (overwrite, not just deletion, with the `.md`-sibling heuristic); `/lang/` removed three guards at once.
- The empty-state problem (rule 2) surfaced only when the Russian-on-`en` hosted blogs were considered; the first draft filtered `/` to the stored default.
- Rule 3's "directories only" and "createPost too" were both found in code review of a passing test suite: the tests had no legacy-`lang` case and no root-flip-by-publish case. Both exist now in `tests/translations.test.ts` ("code review round 2").

## Pointers

- `src/posts.ts` — `listBlogLanguages`, `resolveTranslationOf`, `adoptIntoGroup`/`unadopt`, `assertLanguageFree`
- `src/rendering/generator.ts` — `homeUrl`, `renderAlternates`, `renderLanguageNav`, `pruneLanguageHomes`
- `src/db/migrations/010_translations.sql`
- `docs/superpowers/specs/2026-09-15-translations-design.md`; platform companion `slopit-platform/docs/specs/2026-09-15-translations-pro-design.md`
