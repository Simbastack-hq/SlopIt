import type { Hono } from 'hono'
import { z } from 'zod'
import { PostInputSchema } from '../schema/index.js'
import { CreateBlogInputSchema } from '../schema/index.js'
import type { Blog } from '../schema/index.js'
import type { ApiRouterConfig } from './index.js'
import { SlopItError } from '../errors.js'
import { createBlog, createApiKey } from '../blogs.js'
import { generateOnboardingBlock } from '../onboarding.js'
import { buildLinks } from './links.js'

type Vars = { blog: Blog; apiKeyHash: string }

export function mountRoutes(app: Hono<{ Variables: Vars }>, config: ApiRouterConfig): void {
  // Health
  app.get('/health', (c) => c.json({ ok: true }))

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
    const raw = await c.req.json().catch(() => ({}))
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

  // Remaining routes land in later tasks (Task 17+)
}
