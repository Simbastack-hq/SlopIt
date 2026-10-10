import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateSkillFile } from '../src/skill.js'
import { createStore } from '../src/db/store.js'
import { createRenderer } from '../src/rendering/generator.js'
import { createApiRouter } from '../src/api/index.js'

describe('generateSkillFile', () => {
  const text = generateSkillFile({ baseUrl: 'https://api.example' })

  it('starts with an h1 introducing SlopIt', () => {
    expect(text.split('\n')[0]).toMatch(/^# /)
    expect(text).toMatch(/SlopIt/)
  })

  it('has all required sections in fixed order', () => {
    const sections = [
      'What SlopIt is',
      'Auth',
      'Endpoints',
      'Schema',
      'Error codes',
      'Idempotency',
      'MCP tools',
    ]
    let lastIdx = -1
    for (const section of sections) {
      const idx = text.indexOf(`## ${section}`)
      expect(idx, `section "${section}" missing`).toBeGreaterThan(-1)
      expect(idx, `section "${section}" out of order`).toBeGreaterThan(lastIdx)
      lastIdx = idx
    }
  })

  it('documents Authorization: Bearer', () => {
    expect(text).toMatch(/Authorization:\s+Bearer/)
  })

  it('lists all REST routes as absolute URLs anchored on baseUrl', () => {
    const base = 'https://api.example'
    const expected = [
      `GET ${base}/health`,
      `POST ${base}/signup`,
      `GET ${base}/schema`,
      `POST ${base}/bridge/report_bug`,
      `GET ${base}/blogs/:id`,
      `PATCH ${base}/blogs/:id`,
      `POST ${base}/blogs/:id/posts`,
      `GET ${base}/blogs/:id/posts`,
      `GET ${base}/blogs/:id/posts/:slug`,
      `PATCH ${base}/blogs/:id/posts/:slug`,
      `DELETE ${base}/blogs/:id/posts/:slug`,
    ]
    for (const route of expected) {
      expect(text, `missing route ${route}`).toContain(route)
    }
  })

  it('lists all SlopItErrorCode values plus the envelope codes', () => {
    const codes = [
      // SlopItErrorCode values
      'BLOG_NAME_CONFLICT',
      'BLOG_NOT_FOUND',
      'POST_SLUG_CONFLICT',
      'POST_NOT_FOUND',
      'UNAUTHORIZED',
      'IDEMPOTENCY_KEY_CONFLICT',
      'NOT_IMPLEMENTED',
      // Envelope codes emitted by respondError (not SlopItError)
      'BAD_REQUEST',
      'ZOD_VALIDATION',
    ]
    for (const code of codes) expect(text).toContain(code)
  })

  it('includes the weakened-guarantee caveat in the Idempotency section', () => {
    const idemStart = text.indexOf('## Idempotency')
    expect(idemStart).toBeGreaterThan(-1)
    const section = text.slice(idemStart)
    // Must mention best-effort / crash / retry caveat
    expect(section.toLowerCase()).toMatch(/best-effort|not crash-safe|may re-execute/)
  })

  it('Idempotency section explicitly states /signup is NOT replayed (drift guard)', () => {
    // The middleware skips replay when apiKeyHash is empty (see
    // src/api/idempotency.ts). If SKILL.md claims otherwise, agents
    // will write retry logic that silently no-ops. Guard the claim.
    const idemStart = text.indexOf('## Idempotency')
    const section = text.slice(idemStart)
    // Must call out /signup specifically, not just mention it
    expect(section).toMatch(/\/signup is NOT replayed/i)
    // Must not list /signup in the "authenticated mutation" intro
    const intro = section.split('\n\n')[1] ?? ''
    expect(intro).not.toMatch(/POST \/signup/)
  })

  it('refers to GET <baseUrl>/schema for the machine-readable JSONSchema', () => {
    expect(text).toContain('GET https://api.example/schema')
  })

  it('documents the five agent-readable files as {blog_url} templates', () => {
    expect(text).toContain('## Agent-readable endpoints')
    for (const t of [
      '{blog_url}llms.txt',
      '{blog_url}{post-slug}.md',
      '{blog_url}feed.xml',
      '{blog_url}lang/{tag}/feed.xml',
      '{blog_url}sitemap.xml',
    ]) {
      expect(text, `missing template ${t}`).toContain(t)
    }
    // Reassures agents that these are read-only and unauthenticated
    expect(text).toMatch(/No authentication required/i)
    // Points at the real source of the blog URL
    expect(text).toContain('`blog_url` returned by signup')
    expect(text).toContain('`_links.view`')
  })

  it('never lists per-blog files as bare root paths (agents resolve them against the API host)', () => {
    const section = text.slice(
      text.indexOf('## Agent-readable endpoints'),
      text.indexOf('## Schema'),
    )
    expect(section).not.toMatch(/^\| \/(llms\.txt|feed\.xml|sitemap\.xml|<slug>\.md)/m)
    expect(section).not.toContain('relative to blog root')
  })

  it('never gives a per-blog URL as a bare root path anywhere in the doc', () => {
    // `/lang/…` and `/{post-slug}/` resolved against a /b/{id}/ blog drop its
    // prefix, and against the API host miss every named or custom-domain blog.
    expect(text).not.toMatch(/`\/lang\//)
    expect(text).not.toMatch(/`\/\{post-slug\}/)
    expect(text).not.toMatch(/`\/(llms\.txt|feed\.xml|sitemap\.xml)`/)
  })

  it('does not tell self-hosted instances their blog is off the API host', () => {
    expect(text).not.toContain('not at the root of the host serving this document')
    expect(text).not.toContain('not under the API base')
    expect(text).toContain('Always build them from `blog_url`')
  })

  it('keeps the per-language feed example templated (a real blog may have no such language)', () => {
    const hosted = generateSkillFile({
      baseUrl: 'https://svc.example/api',
      blogUrlForms: ['`https://{blog-name}.svc.example/` for a named blog'],
      example: { blogUrl: 'https://acme.svc.example/', postSlug: 'first-post' },
    })
    expect(hosted).not.toContain('https://acme.svc.example/lang/')
    expect(hosted).toContain('`{blog_url}lang/de/feed.xml`')
  })

  it('shows a concrete example before the table', () => {
    const section = text.slice(text.indexOf('## Agent-readable endpoints'))
    const example = section.indexOf('https://blog.example.com/hello-world.md')
    const table = section.indexOf('| URL template |')
    expect(example).toBeGreaterThan(-1)
    expect(example).toBeLessThan(table)
  })

  it('uses {curly} placeholders in URLs, never <angle> ones', () => {
    expect(text).not.toMatch(/<slug>|<tag>|<blog_id>|<media\.url>|<slug of/)
  })

  it('does not claim the API root is not a blog unless the host lists its blog URL forms', () => {
    expect(text).not.toContain('itself is not a blog')
  })

  it('lists host blog URL forms, the not-a-blog warning, and the host example when given', () => {
    const hosted = generateSkillFile({
      baseUrl: 'https://svc.example/api',
      blogUrlForms: [
        '`https://{blog-name}.svc.example/` for a named blog',
        '`https://svc.example/b/{blog_id}/` for an unnamed blog',
      ],
      example: { blogUrl: 'https://acme.svc.example/', postSlug: 'first-post' },
    })
    expect(hosted).toContain('- `https://{blog-name}.svc.example/` for a named blog')
    expect(hosted).toContain('- `https://svc.example/b/{blog_id}/` for an unnamed blog')
    expect(hosted).toContain('`https://svc.example/` itself is not a blog')
    expect(hosted).toContain('https://acme.svc.example/first-post.md')
    expect(hosted).not.toContain('blog.example.com')
  })

  it('documents the MCP Accept header that avoids 406', () => {
    const mcp = text.slice(text.indexOf('## MCP tools'))
    expect(mcp).toContain('Accept: application/json, text/event-stream')
    expect(mcp).toContain('406')
  })

  it('includes the MCP tools section with all tool names', () => {
    expect(text).toContain('## MCP tools')
    const tools = [
      'signup',
      'create_post',
      'update_post',
      'delete_post',
      'update_blog',
      'get_blog',
      'get_post',
      'list_posts',
      'report_bug',
    ]
    for (const tool of tools) {
      expect(text, `MCP section missing tool: ${tool}`).toContain(tool)
    }
  })

  it('documents the analytics field on Blog (Phase 3)', () => {
    expect(text).toMatch(/analytics/)
    // At least one of the three supported providers must be mentioned by name.
    expect(text).toMatch(/Umami|Plausible|Google Analytics|googleAnalytics/i)
    // And the canonical clearing pattern must be documented.
    expect(text).toMatch(/analytics.{0,10}null/)
  })

  it('documents the blog title: set at signup, PATCH to change, null to clear', () => {
    expect(text).toContain("- `title` — the blog's display name")
    expect(text).toContain('Set it whenever you know the project or person the blog is for')
    expect(text).toContain('{ "title": null }')
    expect(text).toMatch(/PATCH .*\/blogs\/:id \| Patch blog metadata: `title`/)
  })

  it('documents the YouTube embed: bare URL on its own line, raw HTML stripped', () => {
    expect(text).toContain('## Posts with a YouTube video')
    expect(text).toContain('https://youtu.be/')
    expect(text).toContain('youtube.com/shorts/')
    expect(text).toMatch(/own line/)
    expect(text).toMatch(/Raw HTML is stripped.{0,40}<iframe>/)
  })

  it('documents section anchors and when the contents list appears', () => {
    expect(text).toContain('## Sections and the contents list')
    expect(text).toContain('{blog_url}{post-slug}/#why-it-works')
    expect(text).toMatch(/at least 3 `##` sections and about 1,000 words/)
  })

  it('documents removing a cover with coverImage: null, and the link-preview fallback', () => {
    expect(text).toContain('### Cover image and link previews')
    expect(text).toContain('{ "coverImage": null }')
    expect(text).toContain('thumbnail of its first YouTube video')
  })

  it('documents language on blog and post, with the null-clears rule', () => {
    expect(text).toContain('## Language')
    expect(text).toMatch(/BCP-47/)
    expect(text).toMatch(/pt-BR/)
    expect(text).toMatch(/null/)
    expect(text).toContain('`language`')
  })

  it('keeps self-hosted signup guidance unchanged when policy args are absent', () => {
    expect(text).toContain('all fields are optional')
    expect(text).toContain('Optional. Pass it through')
    expect(text).not.toContain('## Terms')
    expect(text).not.toContain('EMAIL_REQUIRED')
  })

  it('documents required email, terms acceptance, abuse rules, and name release when configured', () => {
    const hosted = generateSkillFile({
      baseUrl: 'https://api.example',
      requireEmail: true,
      termsUrl: 'https://operator.example/legal',
    })

    expect(hosted).toContain('The `email` field is required; all other fields are optional')
    expect(hosted).toContain('`email` — REQUIRED')
    expect(hosted).toContain('EMAIL_REQUIRED')
    expect(hosted).toContain('## Terms')
    expect(hosted).toContain('https://operator.example/legal')
    expect(hosted).toMatch(/creating a blog constitutes acceptance/i)
    expect(hosted).toContain('Slop is welcome. Spam is not')
    expect(hosted).toContain('coordinated link networks')
    expect(hosted).toContain('keyword-spun SEO farms')
    expect(hosted).toContain('KYC/financial-control-evasion content')
    expect(hosted).toContain('sexually explicit content')
    expect(hosted).toContain('illegal content')
    expect(hosted).toContain('names released')
  })
})

describe('SKILL.md endpoint parity with createApiRouter', () => {
  it('every route mounted by createApiRouter appears in the SKILL.md endpoints table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slopit-skill-parity-'))
    const store = createStore({ dbPath: join(dir, 'p.db') })
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })

    // Extract Hono's routes list. Each has method + path. SKILL.md
    // emits these as absolute URLs anchored on baseUrl, so prefix each
    // path with baseUrl when matching.
    const baseUrl = 'https://api.example'
    const routes = app.routes
      .filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${baseUrl}${r.path}`)

    const skill = generateSkillFile({ baseUrl })
    for (const route of new Set(routes)) {
      expect(skill, `SKILL.md missing route ${route}`).toContain(route)
    }

    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
