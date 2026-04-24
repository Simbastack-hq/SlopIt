import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createApiKey, createBlog } from '../blogs.js'
import { SlopItError } from '../errors.js'
import { generateOnboardingBlock } from '../onboarding.js'
import { createPost, deletePost, getPost, listPosts, updatePost } from '../posts.js'
import { CreateBlogInputSchema, PostPatchSchema } from '../schema/index.js'
import { PostInputBaseSchema, slugTitleRefinement } from '../schema/post-input-base.js'
import type { McpServerConfig } from './server.js'
import { wrapTool } from './wrap-tool.js'

export function registerTools(server: McpServer, config: McpServerConfig): void {
  // 1. signup — create a blog + API key in one call.
  // Schema: exactly CreateBlogInputSchema — idempotency_key is deliberately
  // absent so SDK validation rejects it at the schema layer (decision #22
  // parity, decision #15 explains the SDK-shaped error that results).
  server.registerTool(
    'signup',
    {
      description:
        'Create a SlopIt blog and get an API key. Use this once, before anything else. Returns a live URL, the API key, and onboarding text to follow.',
      inputSchema: CreateBlogInputSchema.strict(),
    },
    wrapTool<{ name?: string; theme?: 'minimal' }>(config, 'signup', { auth: 'public' }, (args) => {
      const { blog } = createBlog(config.store, args)
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
      return {
        blog_id: blog.id,
        blog_url: renderer.baseUrl,
        api_key: apiKey,
        ...(config.mcpEndpoint !== undefined ? { mcp_endpoint: config.mcpEndpoint } : {}),
        onboarding_text: onboardingText,
      }
    }),
  )

  // 2. create_post — publish a new post.
  const CreatePostInputSchema = z
    .object({ blog_id: z.string() })
    .extend(PostInputBaseSchema.shape)
    .extend({ idempotency_key: z.string().optional() })
    .strict()
    .superRefine(slugTitleRefinement)

  server.registerTool(
    'create_post',
    {
      description:
        "Publish a post to the blog. Needs `title` and `body` (markdown). Returns the published post's live URL.",
      inputSchema: CreatePostInputSchema,
    },
    wrapTool<z.infer<typeof CreatePostInputSchema>>(
      config,
      'create_post',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      (args, ctx) => {
        const renderer = config.rendererFor(ctx.blog!)
        // Destructure routing/idempotency keys; remaining fields are PostInput
        const { blog_id: _blogId, idempotency_key: _idem, ...postInput } = args
        void _blogId
        void _idem
        const { post, postUrl } = createPost(config.store, renderer, ctx.blog!.id, postInput)
        return {
          post,
          ...(postUrl !== undefined ? { post_url: postUrl } : {}),
        }
      },
    ),
  )

  // 3. update_post — patch an existing post.
  const UpdatePostInputSchema = z
    .object({
      blog_id: z.string(),
      slug: z.string(),
      patch: PostPatchSchema,
      idempotency_key: z.string().optional(),
    })
    .strict()

  server.registerTool(
    'update_post',
    {
      description:
        "Edit an existing post. Pass the post's `slug` and a `patch` of fields to change. Slug itself can't change; delete and republish if you need a new URL.",
      inputSchema: UpdatePostInputSchema,
    },
    wrapTool<z.infer<typeof UpdatePostInputSchema>>(
      config,
      'update_post',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      (args, ctx) => {
        const renderer = config.rendererFor(ctx.blog!)
        const { post, postUrl } = updatePost(
          config.store,
          renderer,
          ctx.blog!.id,
          args.slug,
          args.patch,
        )
        return {
          post,
          ...(postUrl !== undefined ? { post_url: postUrl } : {}),
        }
      },
    ),
  )

  // 4. delete_post — hard-delete by slug.
  const DeletePostInputSchema = z
    .object({
      blog_id: z.string(),
      slug: z.string(),
      idempotency_key: z.string().optional(),
    })
    .strict()

  server.registerTool(
    'delete_post',
    {
      description: "Remove a post permanently. This can't be undone.",
      inputSchema: DeletePostInputSchema,
    },
    wrapTool<{ blog_id: string; slug: string; idempotency_key?: string }>(
      config,
      'delete_post',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      (args, ctx) => {
        const renderer = config.rendererFor(ctx.blog!)
        return deletePost(config.store, renderer, ctx.blog!.id, args.slug)
      },
    ),
  )

  // 5. get_blog — return the authenticated blog's metadata.
  server.registerTool(
    'get_blog',
    {
      description: "Get the blog's current metadata.",
      inputSchema: z.object({ blog_id: z.string() }).strict(),
    },
    wrapTool<{ blog_id: string }>(
      config,
      'get_blog',
      { auth: 'required', crossBlogGuard: true },
      (_args, ctx) => ({ blog: ctx.blog! }),
    ),
  )

  // 6. get_post — single post by slug.
  server.registerTool(
    'get_post',
    {
      description: 'Get a single post by its slug.',
      inputSchema: z.object({ blog_id: z.string(), slug: z.string() }).strict(),
    },
    wrapTool<{ blog_id: string; slug: string }>(
      config,
      'get_post',
      { auth: 'required', crossBlogGuard: true },
      (args, ctx) => ({ post: getPost(config.store, ctx.blog!.id, args.slug) }),
    ),
  )

  // 7. list_posts — published by default; ?status=draft flips.
  const ListPostsInputSchema = z
    .object({
      blog_id: z.string(),
      status: z.enum(['draft', 'published']).optional(),
    })
    .strict()

  server.registerTool(
    'list_posts',
    {
      description:
        "List posts on the blog. Defaults to published posts. Pass `status: 'draft'` for drafts.",
      inputSchema: ListPostsInputSchema,
    },
    wrapTool<{ blog_id: string; status?: 'draft' | 'published' }>(
      config,
      'list_posts',
      { auth: 'required', crossBlogGuard: true },
      (args, ctx) => ({
        posts: listPosts(
          config.store,
          ctx.blog!.id,
          args.status !== undefined ? { status: args.status } : undefined,
        ),
      }),
    ),
  )

  // 8. report_bug — always errors with NOT_IMPLEMENTED + optional pointer.
  server.registerTool(
    'report_bug',
    {
      description: 'Report a bug or something unexpected. Returns a link to submit the report.',
      inputSchema: z.object({
        summary: z.string().optional(),
        details: z.unknown().optional(),
      }),
    },
    wrapTool(config, 'report_bug', { auth: 'public' }, () => {
      throw new SlopItError(
        'NOT_IMPLEMENTED',
        'Bug reports are handled by the platform, not core',
        config.bugReportUrl !== undefined ? { use: config.bugReportUrl } : {},
      )
    }),
  )
}
