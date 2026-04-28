import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { PostInputSchema } from '../schema/index.js'
import type { Blog, PostPatchInput } from '../schema/index.js'
import type { ApiRouterConfig } from './index.js'
import { SlopItError } from '../errors.js'
import { buildLinks } from './links.js'
import { createPost, deletePost, getPost, listPosts, updatePost } from '../posts.js'
import { parseMarkdownBody } from './markdown-body.js'
import { signupBlog } from '../signup.js'
import { uploadMedia, listMedia, getMedia, deleteMedia } from '../media.js'
import type { MediaLimits } from '../media.js'

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

// Multipart MIME inference. Many clients (default cURL, browsers when
// the user drag-drops, etc.) tag a file part as application/octet-stream
// or with no type at all. The spec disallows magic-byte sniffing, but
// inferring from the filename extension when the client didn't declare
// a useful MIME closes the gap unambiguously. Keys mirror the four
// extensions we accept in src/media.ts; widening this map implies
// widening the allowlist there, which is a separate change.
const EXT_TO_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

function inferContentTypeFromFilename(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return undefined
  return EXT_TO_TYPE[name.slice(dot + 1).toLowerCase()]
}

function resolveMediaLimits(config: ApiRouterConfig, blog: Blog): MediaLimits {
  const maxBytes =
    typeof config.mediaMaxBytes === 'function'
      ? config.mediaMaxBytes(blog)
      : (config.mediaMaxBytes ?? 5_000_000)
  const maxTotalBytesPerBlog =
    typeof config.mediaMaxTotalBytesPerBlog === 'function'
      ? config.mediaMaxTotalBytesPerBlog(blog)
      : (config.mediaMaxTotalBytesPerBlog ?? null)
  return { maxBytes, maxTotalBytesPerBlog }
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

  // Signup — create blog + api key in one shot. Orchestration lives in
  // src/signup.ts so REST and MCP cannot drift on validation, the
  // onSignup hook, or onboarding text.
  app.post('/signup', async (c) => {
    const raw = await readJsonBodyOptional(c)
    const result = await signupBlog(config, raw)
    return c.json({
      blog_id: result.blog.id,
      blog_url: result.blogUrl,
      api_key: result.apiKey,
      ...(config.mcpEndpoint !== undefined ? { mcp_endpoint: config.mcpEndpoint } : {}),
      onboarding_text: result.onboardingText,
      email_sent: result.emailSent,
      _links: buildLinks(result.blog, config),
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

  // Media: upload (multipart)
  app.post('/blogs/:id/media', async (c) => {
    const renderer = config.rendererFor(c.var.blog)
    const limits = resolveMediaLimits(config, c.var.blog)
    const ct = c.req.header('Content-Type') ?? ''
    if (!ct.startsWith('multipart/form-data')) {
      throw new SlopItError('BAD_REQUEST', 'multipart/form-data required', { content_type: ct })
    }
    const form = await c.req.parseBody({ all: true })
    const fileField = form['file']
    if (fileField === undefined) {
      throw new SlopItError('BAD_REQUEST', "multipart 'file' field required", {})
    }
    if (Array.isArray(fileField)) {
      throw new SlopItError('BAD_REQUEST', 'only one file per request', {})
    }
    if (typeof fileField === 'string') {
      throw new SlopItError('BAD_REQUEST', "'file' must be a binary upload", {})
    }
    const file = fileField
    if (file.size === 0) {
      throw new SlopItError('BAD_REQUEST', 'file is empty', {})
    }
    const declared = file.type
    const effectiveContentType =
      declared !== '' && declared !== 'application/octet-stream'
        ? declared
        : (inferContentTypeFromFilename(file.name) ?? declared)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const media = uploadMedia(config.store, renderer, limits, c.var.blog, {
      filename: file.name,
      contentType: effectiveContentType,
      bytes,
    })
    return c.json({ media, _links: buildLinks(c.var.blog, config) })
  })

  app.get('/blogs/:id/media', (c) => {
    const renderer = config.rendererFor(c.var.blog)
    const media = listMedia(config.store, renderer, c.var.blog.id)
    return c.json({ media, _links: buildLinks(c.var.blog, config) })
  })

  app.get('/blogs/:id/media/:mid', (c) => {
    const renderer = config.rendererFor(c.var.blog)
    const media = getMedia(config.store, renderer, c.var.blog.id, c.req.param('mid'))
    return c.json({ media, _links: buildLinks(c.var.blog, config) })
  })

  app.delete('/blogs/:id/media/:mid', (c) => {
    const renderer = config.rendererFor(c.var.blog)
    const result = deleteMedia(config.store, renderer, c.var.blog.id, c.req.param('mid'))
    return c.json({ ...result, _links: buildLinks(c.var.blog, config) })
  })
}
