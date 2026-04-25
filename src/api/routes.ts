import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { PostInputSchema } from '../schema/index.js'
import { CreateBlogInputSchema } from '../schema/index.js'
import type { Blog, PostPatchInput } from '../schema/index.js'
import type { ApiRouterConfig } from './index.js'
import { SlopItError } from '../errors.js'
import { createBlog, createApiKey } from '../blogs.js'
import { generateOnboardingBlock } from '../onboarding.js'
import { buildLinks } from './links.js'
import { createPost, deletePost, getPost, listPosts, updatePost } from '../posts.js'
import { parseMarkdownBody } from './markdown-body.js'

const StatusQuerySchema = z.enum(['draft', 'published']).optional()

type Vars = { blog: Blog; apiKeyHash: string }

/**
 * Read a JSON body that is allowed to be empty. An empty body returns
 * {} (the caller-supplied nothing). A present-but-malformed body throws
 * SyntaxError, which errorMiddleware maps to a 400 BAD_REQUEST.
 *
 * Use this for endpoints where an empty body has legitimate semantics
 * (e.g. /signup with all-defaulted schema, PATCH as a no-op). For
 * endpoints that require a body, use c.req.json() directly — the same
 * SyntaxError path surfaces a 400.
 */
async function readJsonBodyOptional(c: Context): Promise<unknown> {
  const text = await c.req.text()
  if (text === '') return {}
  return JSON.parse(text)
}

export function mountRoutes(app: Hono<{ Variables: Vars }>, config: ApiRouterConfig): void {
  // Health probe. Hits the DB so the deploy script's retry gate actually
  // catches a missing data dir / unwritable volume / closed connection,
  // not just whether the process is up. Caught (not thrown) because the
  // job of this endpoint is to report DB state via HTTP status — exactly
  // the system-boundary case where catching is appropriate.
  app.get('/health', (c) => {
    try {
      config.store.db.prepare('SELECT 1').get()
      return c.json({ ok: true })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return c.json({ ok: false, error: message }, 503)
    }
  })

  // Schema — returns PostInput JSONSchema at top level
  app.get('/schema', (c) => {
    return c.json(z.toJSONSchema(PostInputSchema) as Record<string, unknown>)
  })

  // Bridge stub
  app.post('/bridge/report_bug', () => {
    throw new SlopItError(
      'NOT_IMPLEMENTED',
      'Bug reports are handled by the platform bridge, not core',
      config.bugReportUrl !== undefined ? { use: config.bugReportUrl } : {},
    )
  })

  // Signup — create blog + api key in one shot
  app.post('/signup', async (c) => {
    const raw = await readJsonBodyOptional(c)
    const parsed = CreateBlogInputSchema.parse(raw)
    const { blog } = createBlog(config.store, parsed)
    const { apiKey } = createApiKey(config.store, blog.id)
    const renderer = config.rendererFor(blog)
    const onboardingText = generateOnboardingBlock({
      blog,
      apiKey,
      blogUrl: renderer.baseUrl,
      baseUrl: config.baseUrl,
      schemaUrl: `${config.baseUrl}/schema`,
      mcpEndpoint: config.mcpEndpoint,
      dashboardUrl: config.dashboardUrl,
      docsUrl: config.docsUrl,
      skillUrl: config.skillUrl,
      bugReportUrl: config.bugReportUrl,
    })
    return c.json({
      blog_id: blog.id,
      blog_url: renderer.baseUrl,
      api_key: apiKey,
      ...(config.mcpEndpoint !== undefined ? { mcp_endpoint: config.mcpEndpoint } : {}),
      onboarding_text: onboardingText,
      _links: buildLinks(blog, config),
    })
  })

  // Read: blog info
  app.get('/blogs/:id', (c) => {
    return c.json({
      blog: c.var.blog,
      _links: buildLinks(c.var.blog, config),
    })
  })

  // Create a post
  app.post('/blogs/:id/posts', async (c) => {
    const contentType = c.req.header('Content-Type') ?? ''
    const renderer = config.rendererFor(c.var.blog)

    let input: Parameters<typeof createPost>[3]
    if (contentType.startsWith('text/markdown')) {
      const body = await c.req.text()
      const query = new URL(c.req.url).searchParams
      input = parseMarkdownBody({ body, query })
    } else {
      input = await c.req.json()
    }

    const { post, postUrl } = createPost(config.store, renderer, c.var.blog.id, input)
    return c.json({
      post,
      ...(postUrl !== undefined ? { post_url: postUrl } : {}),
      _links: buildLinks(c.var.blog, config),
    })
  })

  // List posts
  app.get('/blogs/:id/posts', (c) => {
    const status = StatusQuerySchema.parse(c.req.query('status'))
    const posts = listPosts(
      config.store,
      c.var.blog.id,
      status !== undefined ? { status } : undefined,
    )
    return c.json({ posts, _links: buildLinks(c.var.blog, config) })
  })

  // Single post
  app.get('/blogs/:id/posts/:slug', (c) => {
    const post = getPost(config.store, c.var.blog.id, c.req.param('slug'))
    return c.json({ post, _links: buildLinks(c.var.blog, config) })
  })

  // Patch post
  app.patch('/blogs/:id/posts/:slug', async (c) => {
    const renderer = config.rendererFor(c.var.blog)
    // updatePost() re-parses the body via PostPatchSchema.strict(), so
    // the cast here is honest — Zod is the source of truth for shape
    // validation, we only guarantee JSON-parse success at this layer.
    const raw = (await readJsonBodyOptional(c)) as PostPatchInput
    const { post, postUrl } = updatePost(
      config.store,
      renderer,
      c.var.blog.id,
      c.req.param('slug'),
      raw,
    )
    return c.json({
      post,
      ...(postUrl !== undefined ? { post_url: postUrl } : {}),
      _links: buildLinks(c.var.blog, config),
    })
  })

  // Delete post
  app.delete('/blogs/:id/posts/:slug', (c) => {
    const renderer = config.rendererFor(c.var.blog)
    const result = deletePost(config.store, renderer, c.var.blog.id, c.req.param('slug'))
    return c.json({ ...result, _links: buildLinks(c.var.blog, config) })
  })
}
