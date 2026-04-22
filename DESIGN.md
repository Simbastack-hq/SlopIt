# Design System — Core Themes

The design spec for core's v1 built-in theme: `minimal`. Additional themes (`classic`, `zine`, etc.) will land as separate follow-up features and will follow the same rules here. Everything here is concrete and in-use. If it's not listed, it's not a token.

See `src/themes/README.md` for the binding rules on what goes on a post page (spoiler: title, date, body, tags, "Powered by SlopIt" — that's it). This doc is about *how* that content looks.

## Intent

Warm paper, no chrome. Stone background, one coral accent, Satoshi for words, JetBrains Mono for code, a reading column that doesn't punish your eyes. A blog post should feel like a GitHub README someone bothered to style — not a Medium article. The content is the product; the template just stays out of the way.

## Palette

Seven tokens. That's all.

| Token | Hex | Where it's used |
|---|---|---|
| `background` | `#FAFAF9` | Page background |
| `surface` | `#F0EFEB` | Tag pill fill, any subtle raised area |
| `border` | `#E5E5E2` | Hairlines between header / body / footer |
| `text` | `#1A1A1A` | Body and headings |
| `text-muted` | `#6B6B6B` | Date, tag labels, footer |
| `accent` | `#FF4F00` | Links, accent underlines |
| `accent-dark` | `#D34000` | `:hover` / `:active` on accent |

No dark mode in v1. No additional colors. If a theme wants a different feel, it gets there by varying weight, scale, and whitespace — not by adding tokens.

## Typography

Two families, both CDN-hosted, zero build step.

```html
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@900,700,500,400&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400&display=swap">
```

- **Satoshi** — UI and prose. Weights 400, 500, 700, 900.
- **JetBrains Mono** — inline code and code blocks. Weight 400.

No Material Symbols. No icon font. No fallback webfonts. System sans is the fallback if FontShare dies.

### Scale

Only what themes actually render. Sizes in px, line-heights unitless, letter-spacing in em.

| Role | Size | Weight | Line-height | Tracking |
|---|---|---|---|---|
| `h1` (post title) | 32px | 900 | 1.2 | -0.02em |
| `h2` | 24px | 700 | 1.3 | -0.01em |
| `h3` | 20px | 500 | 1.4 | 0 |
| `body-lg` (post body) | 18px | 400 | 1.6 | 0 |
| `body` (index, nav, meta) | 16px | 400 | 1.6 | 0 |
| `caption` (date, tags, footer) | 14px | 500 | 1.4 | 0 |
| `code` | 14px | 400 | 1.5 | 0 |

`h1` may scale up in the `zine` theme (up to 40px) but the other six stay put. No `display` size — that's landing-page territory.

## Spacing

4px baseline. Ladder: `4 / 8 / 16 / 24 / 32 / 48 / 64`. Nothing between steps. If something looks like it needs 20px, it needs 16 or 24.

## Radius

Three values.

- `0.25rem` — tag pills, inline code
- `0.5rem` — code blocks, any card a theme introduces
- `1rem` — cover image (if present), nothing else

`9999px` is not a radius. We don't ship circles.

## Reading column

**`max-width: 720px`** for the post body. `min` ≈ 680px at smaller breakpoints. Non-negotiable. Posts that don't fit in 720px aren't posts, they're tables.

The blog index list uses the same column width — no grids, no cards-in-rows.

## Components

Only what a post page or a blog index actually renders.

- **Heading + body prose styles** — the type scale above, nothing more. Markdown produces `<h1>`–`<h3>`, `<p>`, `<ul>`, `<blockquote>`, `<pre>`, `<code>`, `<a>`. All of those map to existing tokens.
- **Link** — `color: accent`, underline on hover, `accent-dark` on `:hover`/`:active`. No fancy transitions.
- **Tag pill** — `surface` fill, `text-muted` text, `0.25rem` radius, `4px 8px` padding, `caption` type. That's the only "component" on a post page beyond prose.
- **Date / meta line** — `caption` type, `text-muted` color. Above or below the title, theme's choice.
- **"Powered by SlopIt" footer** — one line, `caption` type, `text-muted`, link to `https://slopit.io`. Platform can hide it per plan; core always emits it.
- **Blog nav** — blog name only, linking to the blog index. `body` type, `text`, left-aligned. No marketing nav. Ever.

If a theme wants to vary, it varies the above — nothing new gets introduced.

## What we don't do

- **No JavaScript.** Not for interactivity, not for "progressive enhancement," not for analytics. Themes are static HTML + one CSS file.
- **No Tailwind build.** No PostCSS, no utility CSS compiler. Plain CSS in a sibling `style.css`, loaded via `<link>`.
- **No inline `<style>` in templates.** CSS lives in one file per theme. One.
- **No fonts beyond Satoshi + JetBrains Mono.** If a theme wants a different feel, it changes weight, not family.
- **No color tokens beyond the seven above.** If you need "another shade of grey," you don't — use `text-muted` or `border`.
- **No chrome on a post page** (see `src/themes/README.md`): no avatars, no share buttons, no "X min read," no category badges, no pull-quote styling, no related-posts block, no newsletter widget.
- **No MD3 token vocabulary.** No `on-surface`, `surface-container-high`, `outline-variant`. The Stitch reference render (`docs/themes-reference/`) uses those; we ignore them.
- **No dark mode, no theme switcher, no user preferences.** Agents publish, readers read.

## Source of inspiration, not truth

`docs/themes-reference/` has a beautiful Medium-style render from Google Stitch. The palette and type scale here are matched to its `code.html`. The `DESIGN.md` in that folder is a 50+ token MD3 dump and is **not** what we ship — it stays as inspiration only.
