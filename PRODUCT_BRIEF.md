# SlopIt — Product Brief for Developers

*Hand this to any dev or agent working on SlopIt. It's the north star.*

---

## What SlopIt Is

The fastest way to go from AI-generated content to a live URL. An instant blog publishing platform where the AI agent is the user.

## Who It's For

**In order of priority:**

1. **Non-technical people using AI conversationally.** Someone tells Claude or ChatGPT "write me a blog post about X and publish it." They don't know what MCP is. They don't know what an API is. They just want a link they can share. This is the biggest audience and the one we optimize for.

2. **Indie hackers and vibe-coders.** People who can copy-paste a curl command or a config snippet but aren't building infrastructure. They want to set up a blog for their side project in 5 minutes, not 5 hours.

3. **Developers building AI content pipelines.** They're wiring up agents to publish at scale. They care about the API, the MCP tools, idempotency, error codes. They'll read the docs.

**Critical implication:** The product, the landing page, and the docs should be approachable for audience #1 and detailed enough for audience #3 — but audience #1 comes first. If something only makes sense to developers, it belongs in the docs, not on the landing page.

## Language Rules

**On the landing page and in any user-facing copy:**

- Say "connect your AI" not "configure your MCP endpoint"
- Say "publish" not "POST to the API"
- Say "your blog is live" not "static HTML is generated and served by Caddy"
- Say "works with Claude, ChatGPT, or any AI" not "MCP-native with REST fallback"
- Say "start a blog" not "get an API key"
- Say "custom domain" not "CNAME to custom.slopit.io"

**In the docs, SKILL.md, and developer-facing materials:** Be as technical as you want. Exact endpoints, curl examples, MCP tool schemas, error codes, idempotency semantics. Developers will find this. Don't dumb it down.

**The line:** If a human who's never written code would read it and feel confused or intimidated, it doesn't belong on the landing page. Put it in docs.

## The North Star Experience

A person opens Claude and says:

> "Write a blog post about why remote work is better and publish it on SlopIt"

Claude publishes the post and replies:

> "Done. Here's your post: https://my-blog.slopit.io/why-remote-work-is-better"

The person clicks the link. The blog post is live, looks clean, and loads fast. They share it on Twitter. That's the whole product.

Everything we build should serve this experience. If a feature doesn't make this flow faster, simpler, or better — question whether it belongs in v1.

## The Technical Truth (for devs only)

Under the hood, SlopIt is:

- A Node.js/TypeScript app running on a Hetzner server
- SQLite for storage, Caddy for reverse proxy and TLS
- REST API + MCP server as the two interfaces
- Pre-rendered static HTML served from disk
- Stripe Payment Links for custom domain upgrades
- Open-core: `@slopit/core` (MIT, public) + `slopit-platform` (private, hosted)

But none of this is user-facing. Users see: a clean landing page, a blog that loads fast, and a URL they can share.

## Brand Voice

Irreverent, self-aware, minimal. We know AI content is called slop. We lean into it. But we're not edgy for the sake of it — the humor is warm, not cynical.

- "Slop it and ship it"
- "Good enough for your first 50 slops"
- "Built for agents, by humans (for now)"
- "Your agent is the CMS. We're just the publish button."

## What We DON'T Build (v1)

- No human editing UI (agents edit via API)
- No custom themes (three built-in, pick one)
- No analytics dashboard (later, as a paid feature)
- No comments, newsletters, or social features
- No approval workflows

## Decision Framework

When in doubt about a feature or design decision, ask:

1. Does this make the "tell Claude to publish a blog post" flow better?
2. Would a non-technical person understand this?
3. Is this the simplest version that works?

If the answer to any of these is no, reconsider.
