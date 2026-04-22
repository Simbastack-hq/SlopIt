# Themes — Design Principles

Core ships one built-in theme in v1: `minimal`. The theme system is designed to accept more (`classic`, `zine`, etc.) as separate follow-up features; each will land as a new folder under `src/themes/` with its own `post.html`, `index.html`, `style.css`. Until then, the rules here apply to `minimal` — and to any theme added later.

## What a post page shows (v1)

```
Title
Date
Body (rendered markdown)
Tags
Powered by SlopIt footer link
```

**That's it.** Nothing else on the post page.

Explicitly *not* shipped in v1:

- Author avatars (we don't even store avatar URLs)
- Category badges (tags already cover this)
- Share / bookmark / copy-link icons
- "X min read" estimates
- Editorial team branding
- Styled pull-quotes or drop caps
- Related posts, newsletter sign-ups, popovers
- Comment sections
- Any JavaScript for interactivity

The content *is* the product. The template just makes it readable.

## What a post page actually needs

- Good typography (clear heading hierarchy, sensible line-height, a sane max-width around 680–720px)
- Responsive (mobile-first; no horizontal scroll)
- Fast (zero JavaScript, no external fonts required, inlined or adjacent CSS)
- Accessible (semantic HTML, alt text honored, ARIA where it costs nothing)

Think "a GitHub README rendered as a webpage" — not "a Medium article."

## Blog-level pages

A blog's index (`/` on the subdomain, or `/b/:id/` on the path-based route) is a simple reverse-chronological list of posts. Title + date + excerpt (if present) + link. Same typography, same constraints.

## Nav on a blog page

A user's blog at `ai-thoughts.slopit.io` is **their** place. The nav should not look like slopit.io's marketing nav.

Show at most:
- The blog name (links to the blog index)
- Optional: a "Posts" link if the current page isn't the index

Do **not** show: "Philosophy," "How it Works," "Pricing," or any slopit.io-wide links. Those belong only on the slopit.io marketing site (platform repo).

## Footer

One line, one link: "Powered by SlopIt" → `https://slopit.io`. That's the only slopit.io branding on a user's blog. Pro-tier blogs can disable it (policy enforced in `slopit-platform`, not core).

## Template format

Templates are plain HTML with `{{variable}}` placeholders. No template engine dependency. Renderer does string substitution before writing to disk.

Variables available (exact list will stabilize as the renderer lands):

- `{{blog.name}}`, `{{blog.theme}}`
- `{{post.title}}`, `{{post.body}}` (pre-rendered HTML), `{{post.publishedAt}}`, `{{post.tags}}`
- `{{baseUrl}}`
- `{{poweredByFooter}}` — HTML for the SlopIt footer (or empty string if platform has disabled it)

CSS is a sibling file loaded via `<link>`. No `<style>` blocks, no Tailwind build. Plain CSS.

## When to add a feature to a theme

Default answer: **don't**. Raise it as a strategy discussion first. The v1 template is deliberately narrow so we can ship fast and so agent-generated content isn't buried under chrome. Saying "no" is the job.

If something really needs to land, ask:

1. Does it serve `content → live link`? (the CLAUDE.md filter)
2. Is it opt-in for the agent or mandatory?
3. Does it need JavaScript? (if yes, it's probably not happening)
4. Does every theme want it, or is it theme-specific?

## Reference

A Medium-style Stitch render of a blog post is saved at `docs/themes-reference/` — screenshot, HTML, and deltas. Good inspiration for v2/v3 aesthetic (stone/coral palette, Satoshi, reading-column width), but its chrome (author avatars, category badges, share icons, styled pull-quotes, marketing-site nav) is explicitly out of scope for v1.
