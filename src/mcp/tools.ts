import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SlopItError } from '../errors.js'
import { uploadMedia, listMedia, deleteMedia } from '../media.js'
import type { MediaLimits } from '../media.js'
import { createPost, deletePost, getPost, listPosts, updatePost } from '../posts.js'
import { CreateBlogInputSchema, PostPatchSchema } from '../schema/index.js'
import { PostInputBaseSchema, slugTitleRefinement } from '../schema/post-input-base.js'
import { signupBlog } from '../signup.js'
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
    wrapTool<{ name?: string; theme?: 'minimal'; email?: string }>(
      config,
      'signup',
      { auth: 'public' },
      async (args) => {
        const result = await signupBlog(config, args)
        return {
          blog_id: result.blog.id,
          blog_url: result.blogUrl,
          api_key: result.apiKey,
          ...(config.mcpEndpoint !== undefined ? { mcp_endpoint: config.mcpEndpoint } : {}),
          onboarding_text: result.onboardingText,
          email_sent: result.emailSent,
        }
      },
    ),
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

  // 9. upload_media — accepts base64 bytes, returns public URL.
  // base64 validated via Zod refine; full size/type/quota check happens
  // inside uploadMedia().
  const Base64Schema = z
    .string()
    .min(1)
    .refine((s) => /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0, {
      message: 'data_base64 must be valid standard base64',
    })

  const UploadMediaInputSchema = z
    .object({
      blog_id: z.string(),
      filename: z.string().min(1).max(255),
      content_type: z.string().min(1),
      data_base64: Base64Schema,
      idempotency_key: z.string().optional(),
    })
    .strict()

  server.registerTool(
    'upload_media',
    {
      description:
        'Upload an image (JPEG/PNG/GIF/WebP, max 5MB) as base64 in `data_base64`. Returns a public URL — use it as ![alt](url) in post markdown or pass as coverImage.',
      inputSchema: UploadMediaInputSchema,
    },
    wrapTool<z.infer<typeof UploadMediaInputSchema>>(
      config,
      'upload_media',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      (args, ctx) => {
        const renderer = config.rendererFor(ctx.blog!)
        const blog = ctx.blog!
        const maxBytes =
          typeof config.mediaMaxBytes === 'function'
            ? config.mediaMaxBytes(blog)
            : (config.mediaMaxBytes ?? 5_000_000)
        const maxTotalBytesPerBlog =
          typeof config.mediaMaxTotalBytesPerBlog === 'function'
            ? config.mediaMaxTotalBytesPerBlog(blog)
            : (config.mediaMaxTotalBytesPerBlog ?? null)
        const limits: MediaLimits = { maxBytes, maxTotalBytesPerBlog }
        const bytes = Buffer.from(args.data_base64, 'base64')
        if (bytes.length === 0) {
          throw new SlopItError('BAD_REQUEST', 'data_base64 decoded to zero bytes', {})
        }
        const media = uploadMedia(config.store, renderer, limits, ctx.blog!, {
          filename: args.filename,
          contentType: args.content_type,
          bytes: new Uint8Array(bytes),
        })
        return { media }
      },
    ),
  )

  // 10. list_media
  server.registerTool(
    'list_media',
    {
      description:
        "List uploaded images for the blog. Returns each image's id, public URL, content type, and byte size.",
      inputSchema: z.object({ blog_id: z.string() }).strict(),
    },
    wrapTool<{ blog_id: string }>(
      config,
      'list_media',
      { auth: 'required', crossBlogGuard: true },
      (_args, ctx) => {
        const renderer = config.rendererFor(ctx.blog!)
        return { media: listMedia(config.store, renderer, ctx.blog!.id) }
      },
    ),
  )

  // 11. delete_media
  const DeleteMediaInputSchema = z
    .object({
      blog_id: z.string(),
      media_id: z.string(),
      idempotency_key: z.string().optional(),
    })
    .strict()

  server.registerTool(
    'delete_media',
    {
      description:
        'Permanently delete an uploaded image by id. The URL stops working immediately. Posts that referenced it will show a broken image until edited.',
      inputSchema: DeleteMediaInputSchema,
    },
    wrapTool<z.infer<typeof DeleteMediaInputSchema>>(
      config,
      'delete_media',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      (args, ctx) => {
        const renderer = config.rendererFor(ctx.blog!)
        return deleteMedia(config.store, renderer, ctx.blog!.id, args.media_id)
      },
    ),
  )
}
