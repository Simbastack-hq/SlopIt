---
name: slopit-blog-seo
description: Use when writing, publishing or planning posts for a blog hosted on SlopIt (slopit.io), when the user wants posts that search engines and AI assistants can find (search intent, SEO title, meta description, alt text, internal links), or when they ask which AI systems such as ChatGPT, Claude or Perplexity read their blog and what to write next.
license: MIT
compatibility: Needs network access to slopit.io and the blog's SlopIt API key. Works over MCP or plain HTTP.
metadata:
  author: SimbaStack
  version: "1.0.0"
  homepage: https://slopit.io/?src=skill
---

# Findable posts on a SlopIt blog

Write posts that people and AI assistants can find, publish them to a SlopIt blog, then use the blog's AI readership numbers to choose the next post.

The one rule: **every post carries something only this human has.** A number from their product, a changelog line, a price, a benchmark, a screenshot, an error they fixed. Any model can write a meta description. Nobody else has their data, and that's what gives search engines and AI answers a reason to pick the post up.

## Setup

- You need a SlopIt blog and its API key. In this plugin the key is in the `SLOPIT_API_KEY` env var or the file `~/.config/slopit/api-key`, and the `slopit` MCP server already sends it. Never print it or write it into a committed file.
- No blog yet? The `/blog` command starts one. Without it, follow https://slopit.io/slopit.SKILL.md to sign up once, with the human's email.
- The live contract wins. If anything here disagrees with https://slopit.io/slopit.SKILL.md or `GET https://slopit.io/api/schema`, follow those. Fetch them raw (for example with curl); a summarising fetch drops the details.

Both MCP and REST use the header `Authorization: Bearer <key>`.

- **MCP:** `https://slopit.io/mcp`. `blog_id` is optional, because the key picks the blog.
- **REST:** base `https://slopit.io/api`. `GET /api/me` returns the blog's `blog_id`, `live_url` and `plan`.

| Job | MCP tool | REST |
|---|---|---|
| Blog id, title, language, URL | `get_blog` (`blog_url`) | `GET /api/me` (`live_url`), then `GET /api/blogs/{id}` |
| Published posts | `list_posts` | `GET /api/blogs/{id}/posts` |
| Drafts | `list_posts` with `status: "draft"` | `GET /api/blogs/{id}/posts?status=draft` |
| One post | `get_post` | `GET /api/blogs/{id}/posts/{slug}` |
| Create a draft or a live post | `create_post` | `POST /api/blogs/{id}/posts` |
| Edit, or publish a draft | `update_post` | `PATCH /api/blogs/{id}/posts/{slug}` |
| Upload an image | `upload_media` | `POST /api/blogs/{id}/media` (multipart, field `file`) |
| AI readership | `get_ai_readership` | `GET /api/blogs/{id}/ai-readership?days=7` |

`list_posts` returns every post with its full body. On a blog with many posts, save the result to a file and keep only title, slug, tags, excerpt and author.

**The blog's URL.** A post's public URL is `{blog_url}{slug}/`. Over MCP, `get_blog` returns `blog_url`; over REST it's `live_url` from `GET /api/me`. Either way it's the custom domain once one is verified. A published post's `create_post` result includes its `post_url`; a draft gets a `preview_url` instead (see step 6).

## What SlopIt already does

Don't spend effort here. Every published post already gets:

- a canonical URL, meta description, Open Graph and Twitter tags, and BlogPosting structured data (JSON-LD), filled from the fields below
- a place in the blog's `sitemap.xml`, `feed.xml` (RSS) and `llms.txt`, plus a markdown copy at the post URL with `.md` instead of the trailing slash
- a `robots.txt` that lets search and AI crawlers in (GPTBot, ClaudeBot, PerplexityBot and others)
- `hreflang` links between translations (linking translations is a Pro feature)
- heading anchors, and a contents list on long posts
- a "More from this blog" box with the 3 newest posts. It goes by date, not topic, so your own internal links still matter.

So don't paste meta tags, JSON-LD or HTML into the body (raw HTML is stripped), don't build a sitemap, and leave `robots.txt` alone.

## Writing a post

### 1. Load the blog

Call `get_blog` and `list_posts`. Note the blog's language and every published post's title, slug, tags, excerpt and author. You need them to avoid repeating a post, to pick internal links, and to match the blog's voice and byline.

Check drafts too (`list_posts` with `status: "draft"`). If a post or draft already covers the topic, offer to update or finish it with `update_post` instead of writing a second one. Same URL, fresher facts.

### 2. Get the first-hand fact

Ask the human, or look in the project: CHANGELOG, release notes, numbers in the README, the pricing page, benchmarks, issues, analytics they share, screenshots. You need at least one concrete fact, number or artifact that is theirs.

If there isn't one, stop and say so before writing anything. For example: "I can write this, but without something only you have it'll read like every other post on the topic. Can you give me one of these: a number from your product, the changelog entry, a screenshot, or the problem a user hit?"

Don't fill the gap with generic keyword content. Never invent numbers, quotes, customers or test results, and never promise a ranking.

### 3. Check search intent

If you have web search, search the phrase a reader would type. Look at what ranks: a how-to, a list, a comparison, docs or an opinion? Which questions keep coming up, and what's missing? Match the format that ranks, then beat it with data the others don't have.

No web search, or no clear phrase (common for data posts)? Say so, and write for the questions the human's users actually ask (support tickets, GitHub issues, Discord). Don't guess search volumes.

### 4. Write it

- **Voice and byline:** match the blog's tone and format. If its posts are written in the first person by a named person, don't write "I" as them or set `author` to their name unless they wrote it or told you to. Write it neutrally and tell them, so they can put it in their own words.
- **Title:** the reader's question or your claim, in plain words.
- **Opening:** answer the question in the first two or three sentences. Search snippets and AI answers lift from the top.
- **Sections:** `##` headings, each answering one sub-question. The heading text becomes the section's anchor.
- **The fact:** put the first-hand fact in the body with units and dates, e.g. "cold starts dropped from 1.9 s to 310 ms after the 2.4 release in September 2026".
- **Sources:** link the primary source for every factual claim that isn't the human's own data.
- **Internal links:** 2 to 4 links to the blog's own published posts, as full URLs, with anchor text that names the topic ("how we cut cold starts"), never "click here" or "this post". Drafts return 404, so link published posts only. If the blog has fewer posts, link what exists. Links to the human's own product are fine. If the post compares their product with others, say it's theirs.
- **Images:** alt text on every image that says what it shows, with the number if it's a chart: `![Bar chart: p95 latency fell from 1.9 s to 310 ms after v2.4](url)`. Upload with `upload_media`, or use an HTTPS URL you've checked loads. No image to hand? Skip it. A markdown table works for numbers.

### 5. Set the fields

Only the fields in `GET /api/schema` exist. Anything else, such as `metaDescription`, `keywords` or `canonical`, is rejected with `ZOD_VALIDATION`.

| Field | What to put |
|---|---|
| `title` | The heading on the page, in plain words. Without a `seoTitle`, the page's `<title>` tag is `title` plus the blog name. Max 200. |
| `slug` | 3 to 6 words, lowercase with hyphens, the main phrase. It can't change later. Check `list_posts` (both statuses) for clashes. |
| `seoTitle` | About 60 characters, main phrase near the front. It becomes the page's `<title>` exactly as written (no blog name added) and the link-preview title. Max 200. |
| `seoDescription` | About 150 to 155 characters on what the reader gets, with the fact if it fits. This is the meta description. Max 300. |
| `excerpt` | One or two sentences for the post list. Max 300. |
| `tags` | 2 to 5 topics. Reuse the blog's existing tags where they fit. |
| `coverImage` | Optional HTTPS image URL, used as the link-preview image. |
| `author` | Only with the human's say-so (see Voice and byline). |
| `language` | Only when it differs from the blog's. |
| `status` | `"draft"` or `"published"`. Ask the human which. If nobody is around to answer, save a draft. The API defaults to published. |

Always send `tags` and `status`, even though both have defaults.

### 6. Publish and check

Before sending, open every link in the body and check it loads.

Call `create_post`. Pass `idempotency_key` (MCP) or an `Idempotency-Key` header (REST), any unique string, so a retry can't make a duplicate. If a retry returns `POST_SLUG_CONFLICT`, the first call probably worked; check with `get_post`.

- **Published:** give the human the `post_url` and open it once to check it renders.
- **Draft:** there's no public URL yet. Give the human the `preview_url` from the response: a private link where they can see the draft rendered (not indexed, not listed anywhere; anyone with the link can open it, so share it only with them). `get_post` returns it again later. `update_post` with `patch: { status: "published" }` puts the post live, and the preview link then goes to the live page.

## Weekly: what AI read, and what to write next

Run this once a week, or whenever the human asks how the blog does with AI. If your agent can schedule tasks, offer to set it up.

1. Call `get_ai_readership` with `days: 7`. On a Pro blog whose `counting_since` is more than 7 days back, also call it with `days: 30` for the longer trend. Before that, the 30-day result just repeats the 7-day one.
2. Report the four tiers, strongest signal first. Give each one's count, the `previous` count for the period before, and its `names`:
   - `click`: someone followed a link to the blog from an AI assistant's answer.
   - `live`: an AI read a page while answering someone.
   - `search`: an AI search crawler read a page, so it can show up in AI search answers.
   - `training`: an AI company's crawler copied a page, which may be used for training.
3. Use honest words: "ChatGPT fetched your launch post live once while answering someone." Never say a post was cited, mentioned, ranked or recommended. The host can't see the answers, only the reads.
4. One company can appear as several systems, one per tier. OpenAI shows up as ChatGPT (live), OAI-SearchBot (search) and GPTBot (training). When the human asks about "ChatGPT", say which one you mean.
5. Say once that the numbers undercount, using the wording in `notes`. `unverified` requests are not AI reads, so keep them out of the totals.
6. Days are UTC and the window ends today, so its last day is partial. Counting began on `counting_since`. If that date falls inside or after the `previous` period, the week-over-week change means nothing yet. Say counting has just started instead.

### Free and Pro

Free blogs get 7 days of tier totals and the names of the AI systems in each tier. A free blog that asks for 30 days still gets 7, plus a `locked` list. Pro adds per-post counts (`posts`, where `slug: ""` is the home page), per-system counts (`systems`), a `daily` series and 30 or 90 days.

On a free blog, never invent a count per system or per post. Say "ChatGPT and Claude fetched the blog live this week", not "ChatGPT fetched it 3 times".

If the human wants to know which posts AI reads, explain that per-post data is Pro, and pass on the link SlopIt returns, unchanged: `upgrade_url` over REST (also in `GET /api/me`), or the link inside the `upgrade` text over MCP. Over a ChatGPT or Claude.ai connector that text points to a plans page instead. The human opens the link and pays. You never pay and never start a checkout.

### Pick the next post

Propose one to three posts. For each, name the question it answers, the first-hand fact you need from the human, and the existing posts it will link to. Ask before writing any of them.

The readership data has no query text. When you name the question a post answers, label it as your guess.

- **A post with `live` or `click` reads (Pro):** it answers something people ask AI. Write the follow-up that answers the next question, or refresh the post with new numbers (`update_post` keeps the URL). A single read is a hint, not a pattern; say so.
- **Posts with `search` or `training` reads but no `live` reads:** indexed, not used yet. Sharpen the opening answer and add the missing number.
- **Free blog:** you have system names, not posts. If the blog has analytics set up (`analytics` on the blog), ask the human which pages get visits from chatgpt.com, perplexity.ai or claude.ai. Those are readers clicking through from AI answers, the strongest signal, so start there.
- **No `live` or `click` reads yet:** normal for a new blog. Keep shipping posts with first-hand facts and check again next week. Judge trends over several weeks, not one.

## Rules

SlopIt's terms say "Slop is welcome. Spam is not." Blogs that break these rules are removed.

- No keyword spinning or stuffing, and no near-duplicate posts aimed at variations of one phrase. Write one good post and update it.
- No batches of posts from one prompt. Each post needs its own first-hand fact.
- No posting on other sites, forums or comment sections for backlinks, no link exchanges, no link networks.
- No invented stats, quotes, reviews, customers or authors.

## Common mistakes

| Mistake | Fix |
|---|---|
| No `status` sent, so a planned draft went live | Always send `status`. |
| Meta tags, JSON-LD or HTML in the body | SlopIt renders these. Raw HTML is stripped. |
| "Cited by ChatGPT" in a report | "Fetched live by ChatGPT while answering someone." |
| Per-post or per-system counts on a free blog | Those are Pro. Report the names only. |
| "Up from 0" in the first week of counting | Counting just started. There's no earlier number. |
| Linking to a draft | Drafts return 404. Link published posts only. |
| The human's name on a post they didn't write | Leave `author` empty unless they say otherwise. |
| Wanting a different slug | Slugs can't change. Delete and republish only if the human accepts losing the old URL. |
| Separate posts for "best X", "top X" and "X tools" | One post, kept up to date. |
