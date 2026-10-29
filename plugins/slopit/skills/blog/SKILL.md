---
name: blog
description: Start a SlopIt blog for this project, or write and publish a post about what you just built.
argument-hint: '[what to write about]'
disable-model-invocation: true
---

# /blog

The human typed `/blog`. Their words, if any: $ARGUMENTS

You run their blog on SlopIt (slopit.io): free, markdown in, live URL out. If there's no blog yet, start one. Then write a post about what they just built and publish it. Keep the back-and-forth short: one message to ask what you need, one to show the draft.

The live API contract is https://slopit.io/slopit.SKILL.md. Fetch it raw with curl when you need a detail this file doesn't cover; if they disagree, it wins.

## 1. Find the blog

- **The key.** It lives in the `SLOPIT_API_KEY` env var or in `~/.config/slopit/api-key`. Check without printing it:
  `[ -n "$SLOPIT_API_KEY" ] && echo env; [ -s ~/.config/slopit/api-key ] && echo file`
  Never print, echo or log the key, and never write it into the project.
- **The note.** Look for a `## Blog` section in the project's `CLAUDE.md` or `AGENTS.md`. It names the blog's URL and id.
- **Key found:** call the `slopit` MCP tool `get_blog` to load the blog. If it returns `UNAUTHORIZED`, this session's MCP connection started before the key existed; use REST (step 4) for this run.
- **Key found, but the note names a different blog**, or there's no note and this project looks like it deserves its own blog: ask once whether to post to the existing blog or start a new one for this project.
- **No key:** go to step 2.

## 2. Start a blog (no key yet)

Read the repo first so you can propose everything in one message: the project name (README title, `package.json` name), its website (`homepage` in `package.json`, the README), and the language it's written in.

Ask the human, in one message:

- their **email** (required: it's how they recover the key, and the key is emailed there),
- confirm or change the blog address `<name>.slopit.io` (lowercase letters, digits, hyphens; suggest the project name),
- confirm the blog title and the project's website (it becomes `parentSiteUrl`, so every page links back to it).

Then call the MCP tool `signup` with `email`, `name`, `title` and `parentSiteUrl` (skip any they left blank). If `name` is taken, suggest a variant and retry once.

Save the key straight away, without showing it in your reply:

```sh
mkdir -p ~/.config/slopit && (umask 077; printf '%s' '<api_key>' > ~/.config/slopit/api-key)
```

If `~/.config/slopit/api-key` already holds another blog's key, don't overwrite it: save this one as `~/.config/slopit/<blog_id>.key` and tell the human to set `SLOPIT_API_KEY` from that file when they work on this project.

Add this note to the project's `CLAUDE.md` (or `AGENTS.md` if that's what the project uses), so later runs come back to the same blog. Never put the key itself in it:

```md
## Blog
This project's blog is on SlopIt: {blog_url} (blog id {blog_id}).
Post with /blog (SlopIt plugin) or the slopit MCP tools.
API key: in ~/.config/slopit/api-key (or $SLOPIT_API_KEY). Never commit it.
```

Tell the human the blog is live at `blog_url`, the key is saved in `~/.config/slopit/api-key` and was emailed to them. If they only wanted the blog, stop here.

## 3. Write the post

**What to write about.** Use their words above if they gave any. Otherwise look at what they just built: this conversation, `git log` and the diff since the last post (or the last week), the CHANGELOG, release notes. Pick one thing worth a post and say which.

**One first-hand fact.** Every post needs something only they have: a number, a before/after, a changelog line, an error they fixed, a screenshot. Find it in the repo or the conversation. If there's none, ask for one instead of writing filler.

**Don't repeat a post.** Call `list_posts` (published and `status: "draft"`). If a post already covers it, offer to update that one instead.

**Write it** in plain words, for a developer who doesn't know the project:

- Title: the claim or the question, in plain words. Answer it in the first two or three sentences.
- `##` sections, short paragraphs, code blocks where code helps. Link the repo, docs or release.
- Markdown only. No HTML, meta tags or JSON-LD: SlopIt renders those.
- Don't write as the human ("I shipped…") or set `author` to their name unless they say so. Write it neutrally and tell them they can put it in their own voice.
- Set `slug` (3 to 6 words, it can't change later), `seoTitle` (about 60 characters), `seoDescription` (about 150 characters), `excerpt`, and 2 to 5 `tags`.
- If the `slopit-blog-seo` skill is loaded, follow it for the details.

**Show the draft** (title, slug and the body) and ask: publish now, or save as a draft? Publishing makes it public on the web right away. If the human's words above already said to publish (or to save a draft), skip the question.

## 4. Publish

**MCP** (when `get_blog` worked): call `create_post` with the fields above, `status` (`"published"` or `"draft"`) and an `idempotency_key` (any unique string).

**REST** (right after signup, or when MCP says `UNAUTHORIZED`): write the post JSON to a temp file and send it, reading the key inside the command:

```sh
KEY="${SLOPIT_API_KEY:-$(cat ~/.config/slopit/api-key)}"
curl -sS -X POST "https://slopit.io/api/blogs/<blog_id>/posts" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: <unique string>" --data @"${TMPDIR:-/tmp}/slopit-post.json"
```

The body takes the same fields as `create_post`: `title`, `body`, `slug`, `seoTitle`, `seoDescription`, `excerpt`, `tags`, `status`.

## 5. Report

- **Published:** give the `post_url`, and check it loads (`curl -sI`).
- **Draft:** give the `preview_url` (private; share it only with the human) and say it goes live when they say so.
- If the response has `next_post_hint`, offer once to draft the next post, and drop it if they say no.
- If you started the blog in this run: say that running `/mcp` and reconnecting `slopit` (or restarting Claude Code) lets the SlopIt tools use the new key; until then `/blog` publishes over HTTP.
- Pro: only as https://slopit.io/slopit.SKILL.md says ("When to tell the human about Pro"), at most once per blog, and never pay for anything.
