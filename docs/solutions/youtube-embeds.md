---
title: YouTube embeds — the one exception to "no raw HTML"
tags: [rendering, xss, embeds, feeds]
severity: p2
date: 2026-10-06
applies-to: [core, platform]
---

## Rule

A paragraph holding nothing but a YouTube URL renders as a `youtube-nocookie.com` player. The `<iframe>` is built in `renderMarkdown` from the validated 11-char id and a numeric start time, never from author HTML. Raw `<iframe>` (YouTube's own embed snippet included) is still stripped. Feeds render with `renderMarkdown(body, { embeds: false })`, so the URL stays a plain link there; `<slug>.md` is the raw body, so it never changes.

## Why

- **Allowlist by construction, not by sanitizing.** Parsing author HTML and keeping "safe" iframes would reopen the XSS surface decision #13 (`2026-04-22-create-post-design.md`) closed. Rebuilding the tag from a regex-validated id means no author byte reaches an attribute.
- **The player needs a Referer.** YouTube refuses to play an embed that sends none (error 153). The iframe carries `referrerpolicy="strict-origin-when-cross-origin"`, and a host must not serve blog pages with `Referrer-Policy: no-referrer`. As of 2026-10-06 the platform Caddyfile sets no Referrer-Policy and no CSP. If either is added, keep the referrer and allow `frame-src https://www.youtube-nocookie.com`.
- **Feed readers drop iframes**, so a player in `content:encoded` would show up as a blank gap. A link is the better fallback.
- **The first embed is also the share image** when the post has no cover (its thumbnail becomes `og:image`). See `seo-meta-fallbacks.md`.
- **A markdown link stays a link** (`[watch](https://youtu.be/…)`). Only a bare URL embeds. That gives authors a way to link a video without a player.

## Example / proof

- Code: `src/rendering/markdown.ts` (`youtubeVideo`, `youtubeEmbeds`, `bodyMedia`), feed call in `src/rendering/generator.ts`
- CSS: `article iframe` in `src/themes/minimal/style.css`. Existing blogs get it on their next render (see `theme-css-per-blog-refresh.md`)
- Tests: `tests/rendering.test.ts` → "renderMarkdown — YouTube embeds" and "embeds a bare YouTube URL on the page; feed.xml and <slug>.md keep a plain link"
- Agent contract: "Posts with a YouTube video" in `src/skill.ts`
