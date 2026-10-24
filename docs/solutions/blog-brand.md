---
title: Blog brand — accent lives in the per-blog style.css, readability is checked on write, hosts gate setting not clearing
tags: [themes, rendering, schema, policy]
severity: p3
date: 2026-10-24
applies-to: [core, platform, self-hosted]
---

## Rules

1. **The accent override is appended to the blog's own `style.css`, not inlined.** `ensureThemeAssets` writes `brandCss(themeCss, accentColor)` (theme CSS plus a trailing `:root { --accent; --accent-dark }`) and `brandFavicon(themeSvg, accentColor)` into `<outputDir>/<blogId>/`. Templates stay free of `<style>` blocks, and every page of the blog picks the color up from the file it already links. `null` writes the theme files byte for byte.
2. **Readability is a write-time refusal with a fix in hand.** `updateBlog` refuses an `accentColor` under 3:1 against the theme background `#fafaf9` with BAD_REQUEST and `details.suggestion`: the same color scaled darker just enough to pass. 3:1 because that is what the default coral reaches (3.2:1); a 4.5:1 floor would refuse colors more readable than our own.
3. **Hosts gate setting a brand field, never clearing one.** `brandPolicy` (REST + MCP config, same shape as `translationPolicy`) runs only when a patch changes `accentColor`, `logoUrl` or `faviconUrl` to a non-null value. A blog the host stops allowing keeps what it has and can always go back to the defaults; no render-time plan logic.
4. **The favicon recolor replaces the theme's literal `fill="#ff4f00"`.** `brandFavicon` throws if the theme favicon loses that marker; `tests/blog-brand.test.ts` pins it and the background color, so a theme edit can't silently break either.

## Why

- Pro sold "No SlopIt branding", but a Pro blog on its own domain still wore SlopIt's coral and coral favicon. Company blogs (the ones that stay) want to look like the company.
- The theme already ran on `--accent` / `--accent-dark` custom properties, so the override is two lines of CSS; the logo is the masthead name swapped for an `<img>` with the display name as alt text.

## Pointers

- `src/rendering/brand.ts`, `src/db/migrations/013_blog_brand.sql`, `src/blogs.ts` (`updateBlog`, `BrandPolicy`)
- Existing blogs only get the new `.masthead-logo` CSS on their next render (see `theme-css-per-blog-refresh.md`); setting a brand field re-renders the blog, so a branded blog always has it.
- The `update_blog` description is capped at 240 characters by `tests/mcp/tool-descriptions.test.ts`; the field descriptions carry the details.
