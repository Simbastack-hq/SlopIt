# "More from this blog" — Related Posts Design Spec

**Status:** Approved 2026-09-02 (Codex plan review round 1 folded in).
**Scope:** `@slopit/core` rendering + theme. Adds a short "More from this blog" list at the end of every post page: the blog's three newest published posts, excluding the one being read. Pure rendering. No schema change. No data collection. Self-hosters get it automatically.

**Branch:** `feat/related-posts` (from `dev`).

---

## Why

Readers arrive at a post from search, a share, or the link an agent returned. On SEO-style blogs (the persona that actually activated on slopit.io: 48 posts in a week from one pipeline user) most search traffic lands on *older* posts. Today the page ends at the tags and the reader has nowhere to go but the masthead. A three-item list of the newest posts:

- gives the reader the freshest thing to click and signals the blog is alive;
- gives every new post an inbound internal link from every existing post the moment it's published, which speeds up discovery and indexing;
- costs nothing at read time: static HTML, zero JavaScript.

The theme README lists "related posts" under *explicitly not shipped in v1*. This spec overrules that for the narrowest possible version. The README is updated in this PR.

## Goals

1. Every post page ends with a "More from this blog" block listing the blog's **3 newest published posts, excluding itself**, newest first.
2. Each item: title (link) + the post's resolved one-line description. Nothing else.
3. Zero JavaScript. Plain HTML + a few lines of CSS in the `minimal` theme.
4. After any **successful** mutation (publish, update, unpublish, delete, blog patch) every post page on the blog reflects the current published set, titles, and descriptions. Partial render failure keeps the repo's existing weakened invariant: the DB is compensated, files may be momentarily inconsistent until the next successful mutation.
5. A blog with fewer than two published posts renders no block at all (no empty heading).

## Non-goals

- **Author-keyed "more from this author".** `author` is empty on ~90% of prod posts. On SlopIt the blog *is* the publisher (the key is the blog's). Blog-level it is.
- **Tag affinity / relatedness scoring.** Not now. Noted as the one obvious follow-up: prefer posts sharing a tag, same function, one extra sort key.
- **Thumbnails, dates, read time, author avatars.** Restraint is the point.
- **Configurable count or opt-out.** No config option with one value. Three is the number.
- **Index-page changes.** The blog index already lists every post.
- **Platform changes.** None required. The free-tier CTA injector keeps working unchanged (see decision 8).

---

## Design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Newest 3 excluding self**, not "the 3 published before this one". | Search traffic lands on old posts; "earlier" would show them even older content. Newest-first also gives each new post inbound links from day one. |
| 2 | **New required method `renderBlogPosts(blogId)` on `Renderer`**: re-renders `<slug>/index.html` for every published post in the blog (HTML only; `.md` and manifests do not depend on sibling posts). `renderBlog` keeps its meaning (index only). Called explicitly from the four lifecycle sites in `posts.ts` and from `updateBlog`. | Post pages now embed blog-wide state, so they are blog-level derived output like the index. An explicit method makes that visible at the type level; a custom `Renderer` that ignores it fails to compile instead of going stale. (Codex round 1, #1.) |
| 3 | `renderPost(blogId, post)` keeps its contract: that post's HTML + `.md` + manifests. `renderPost` and `renderBlogPosts` share one private `writePostHtml(blog, blogDir, post, published)` helper. | One template render path, not two. |
| 4 | On publish/update, the mutated post is written twice (once by `renderPost`, once inside `renderBlogPosts`). **Accepted.** `postprocessHtml` is documented as deterministic: it already re-runs on every re-render today (`updateBlog` loop, platform rerender scripts). | Identical content, atomic write, ~1 ms. An `exceptSlug` knob has one caller. (Codex #3: doc contract, no code.) |
| 5 | **`updateBlog` drops its per-post `renderPost` loop and calls `renderBlogPosts` + `renderBlog`.** | `analytics` and `parentSiteUrl` affect HTML only. Net code deletion. |
| 6 | Cost: every mutation is now O(n) markdown renders over the blog. Core is **uncapped**; the hosted platform caps posts per tier. Measured in this PR (see Benchmarks) and stated in the PR body. | A render is a few ms. Burst publishing (13 posts/min observed) stays trivial. Bonus: every publish now also refreshes stale template markup on old posts, which today needs a manual PATCH per post (`docs/solutions/theme-css-per-blog-refresh.md`). |
| 7 | Item description = `resolveDescription(post)` (the existing `seoDescription → excerpt → body-extract` chain). Empty → omit the `<p>`. Long descriptions are clamped to two lines in CSS. | Single source of truth for descriptions; no second truncation helper. |
| 8 | Markup is `<nav class="more-from">` + `<h2>` + `<ul><li>`, placed **inside `<article>`, after the tag list**. No `<article>` element, no `post-item` class inside it. | Platform's CTA injector (`cta-injection.ts`) inserts before the single `</article>` and bails if it sees `<article … class="…post-item…">`. Keeping the block inside the article and free of those markers means the reading order on free blogs is body → tags → more-from → SlopIt CTA, and the injector needs no change. Core tests assert the injector's exact guards: exactly one `</article>`, the marker regex does not match a post page, and `.more-from` precedes `</article>`. |
| 9 | Links are relative (`../<slug>/`), matching the existing `blogHomeHref: '..'` convention. | Works on subdomains, `/b/:id/` paths, and custom domains without knowing the base URL. |
| 10 | Heading is the **fixed copy "More from this blog"**, `aria-labelledby` the `<h2>`. No blog name in the heading. | The masthead already shows the name; unnamed blogs would otherwise print an opaque id; fixed copy needs no interpolation when the i18n PR translates it. (Codex #6.) |
| 11 | Title and description are HTML-escaped at the fragment builder, same as `renderPostList`. Slug is escaped in the `href`. | Same boundary discipline as every other fragment. |
| 12 | `listPublishedPostsForBlog` orders by `published_at DESC, rowid DESC`. | Same-millisecond bursts get a deterministic newest-first (insertion order). (Codex #8.) |

## Rendering

New fragment builder in `src/rendering/generator.ts`, exported `@internal` like its siblings:

```ts
export function renderMoreFrom(self: Post, published: Post[]): string
```

- `published` is the blog's published posts in the renderer's newest-first order.
- Filters out `self` by `id`, takes the first 3.
- Returns `''` when the result is empty.
- Output shape:

```html
<nav class="more-from" aria-labelledby="more-from-heading">
  <h2 id="more-from-heading">More from this blog</h2>
  <ul>
    <li><a href="../{slug}/">{title}</a><p>{description}</p></li>
    ...
  </ul>
</nav>
```

`post.html` gains `{{{moreFrom}}}` after `{{{tagList}}}`, inside `<article>`.

`style.css` gains a scoped `.more-from` block that overrides the inherited `article h2 / p / ul / li` rules: top border, 14px muted uppercase-tracked heading, list without bullets or padding, title link in text colour turning accent on hover, description in muted 15px clamped to two lines. Mobile-first; nothing wider than the column.

## Renderer changes

- `Renderer` interface gains `renderBlogPosts(blogId: string): void`.
- `createRenderer`: extract the post-HTML build (currently inline in `renderPost`) into `writePostHtml(blog, blogDir, post, published)`. `renderPost` loads the published list once, calls it for `post`, then does `.md` + manifests as today. `renderBlogPosts` loads the blog and published list once, runs `ensureThemeAssets` once, then calls `writePostHtml` for each published post.
- `postprocessHtml` fires for every HTML write, as today. Its JSDoc states it must be deterministic for a given `(html, blogId)`.
- `posts.ts` call sites:
  - `createPost` (published): `renderPost`, `renderBlog`, `renderBlogPosts`.
  - `updatePost` (→ published): same.
  - `updatePost` (published → draft): `renderBlog`, `renderManifests`, `renderBlogPosts`, then `removePostFiles`, `deletePostMarkdown` (destructive last, as today).
  - `deletePost` (was published): `renderBlog`, `renderManifests`, `renderBlogPosts`, then `removePostFiles`.
- `blogs.ts` `updateBlog`: `renderBlogPosts` + `renderBlog` replace the loop.

## Store / API / MCP

No schema change. No migration. No new fields. One SQL ordering tiebreak (decision 12).

## Tests

- `renderMoreFrom`: empty when no siblings; excludes self; caps at 3; newest first; escapes title/description/slug; omits `<p>` for empty description; relative href shape.
- Generator (temp dir, real store), lifecycle: publish 5 → each page links to the 3 newest *other* posts, the newest page lists 2–4, the oldest lists 1–3; 0 and 1 posts → no block; exactly 2 → one item each way; drafts never appear as candidates; delete → no sibling links to it; unpublish → same; title change and excerpt change propagate to sibling pages; `updateBlog` (parentSiteUrl) → every post page reflects it via `renderBlogPosts` alone.
- Injector invariants on a rendered post page: exactly one `</article>`; the regex `/<article\b[^>]*\bclass="[^"]*\bpost-item\b/` does not match; `class="more-from"` index < `</article>` index.
- Failure injection: a `renderBlogPosts` that throws during `createPost` leaves no row behind; during `updatePost` restores the prior row.
- `updateBlog` unit: `renderBlogPosts` called once, `renderBlog` once, `renderPost` never.
- Ordering: two posts with identical `published_at` → later insert first.
- `loadTheme` placeholder test updated for `{{{moreFrom}}}`.

## Benchmarks (filled in during implementation)

`renderBlogPosts` wall time on a temp SQLite store with ~1 KB markdown bodies, this machine: see PR body. Recorded for 50, 200, 1000 posts.

## Docs

- `src/themes/README.md`: move "related posts" from the not-shipped list to the post-page anatomy, with the three-item rule.
- `docs/solutions/theme-css-per-blog-refresh.md`: note that any publish now refreshes every post page on the blog (the manual-PATCH workaround still applies to blogs that never publish).
- `docs/solutions/post-pages-are-blog-level-output.md` (new): the invariant that post pages embed blog-wide state, why `renderBlogPosts` exists, the O(n) cost, the deterministic-hook contract.

## Platform follow-ups (not in this PR)

- `rerender-blog.ts` / `rerender-free-blogs.ts` loop `renderPost` then `renderBlog`; after this change they still produce correct output but should call `renderBlogPosts` + `renderBlog` once the platform bumps core. Also: `rerenderBlog` in `custom-domains.ts`.

## MVP vs deferred

- **MVP:** blogs of any size publishing one at a time or in bursts; readers landing on any post see up to three fresh links; deletes, unpublishes, title and description edits propagate on the next successful mutation.
- **Deferred:** tag-affinity ordering; an opt-out (no one has asked); bounding the O(n) re-render for very large self-hosted blogs (measure first, see Benchmarks).
