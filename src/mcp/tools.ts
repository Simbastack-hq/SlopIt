import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { updateBlog } from '../blogs.js'
import { SlopItError } from '../errors.js'
import { uploadMedia, listMedia, deleteMedia } from '../media.js'
import type { MediaLimits } from '../media.js'
import { createPost, deletePost, getPost, listPosts, updatePost } from '../posts.js'
import { BlogPatchSchema, CreateBlogInputSchema, PostPatchSchema } from '../schema/index.js'
import { PostInputBaseSchema, slugTitleRefinement } from '../schema/post-input-base.js'
import { signupBlog } from '../signup.js'
import {
  BlogOutput,
  DeletedOutput,
  MediaListOutput,
  MediaOutput,
  PostListOutput,
  PostOutput,
  PostWriteOutput,
  ReportBugOutput,
  SignupOutput,
} from './output-schemas.js'
import type { McpServerConfig } from './server.js'
import { wrapTool } from './wrap-tool.js'

// Behaviour hints for clients, by OpenAI's app-review definitions
// (developers.openai.com/plugins/deploy/app-review): a tool that publishes
// to the public blog, or emails someone, is open-world; one that can
// overwrite or delete is destructive. Reads only see the caller's own
// blog, so they stay closed-world.
const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
// Each call creates something new and public (an image).
const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
}
// Creates something new and public, and can also do something that can't
// be undone: signup emails the owner; create_post with `translationOf`
// rewrites the source post's translation group and language.
const CREATE_IRREVERSIBLE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}
// Overwrites what's live; the same patch twice leaves the same state.
const UPDATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
}
// Permanent; a repeat finds nothing left to delete.
const DELETE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
}

/** `title` + `annotations` for registerTool; spec puts the title in both. */
function meta(title: string, hints: ToolAnnotations) {
  return { title, annotations: { title, ...hints } }
}

// The API key already names exactly one blog, so blog_id is optional on
// every bearer tool: omitted → the key's blog; given → still checked by
// the cross-blog guard. Connector clients (ChatGPT, Claude.ai) hold a key
// but never saw a signup response, so they have no blog_id to pass.
// authMode 'none' has no key to fall back on and still requires it
// (wrapTool enforces that).
const BlogId = z
  .string()
  .optional()
  .describe(
    "Your blog's id, as returned by signup. Optional with an API key: it defaults to the key's blog, and any id you pass must be that blog. Required when the server runs without API keys.",
  )

const PostSlug = z
  .string()
  .describe('Slug of the post, e.g. "hello-world", as returned by create_post or list_posts.')

const IdempotencyKey = z
  .string()
  .describe(
    'Optional retry key, any unique string (e.g. a UUID). Retrying with the same key and identical arguments returns the first result instead of writing again; the same key with different arguments fails with IDEMPOTENCY_KEY_CONFLICT. Scoped to your API key and this tool.',
  )
  .optional()

export function registerTools(server: McpServer, config: McpServerConfig): void {
  // Descriptions for the three tools an agent meets first say when to use
  // the tool, what to tell the human afterwards, and how to recover from
  // the likely failures. Every claim maps to behaviour in signup.ts /
  // posts.ts; keep them in step.
  const signupDescription = [
    'Create a SlopIt blog and get an API key, live URL, and onboarding text.',
    'Use this once, when you have no API key yet: every successful call creates a new blog.',
    "Set `title` to the blog's display name, e.g. the project or person's name.",
    config.requireEmail === true
      ? 'Email is required and is the only API-key recovery channel.'
      : "Pass the human's email when you have it: it is the only way to recover the key.",
    ...(config.termsUrl !== undefined
      ? [`Creating a blog accepts the operator's terms: ${config.termsUrl}.`]
      : []),
    'Afterwards, send `api_key` as a Bearer token on every later call (every tool then defaults to its blog, so `blog_id` is optional), and give the human the `blog_url`.',
    "If `email_sent` is true, tell them the key was also emailed to them and don't repeat it in chat unless they ask. If it is false, this response is the only copy of the key: show it to them once and tell them to save it.",
    config.requireEmail === true
      ? 'On BLOG_NAME_CONFLICT or BLOG_NAME_RESERVED, retry with another `name`. On EMAIL_REQUIRED, ask the human for their email and call again.'
      : 'On BLOG_NAME_CONFLICT or BLOG_NAME_RESERVED, retry with another `name`.',
  ].join(' ')

  // 1. signup — create a blog + API key in one call.
  // Schema: exactly CreateBlogInputSchema — idempotency_key is deliberately
  // absent so SDK validation rejects it at the schema layer (decision #22
  // parity, decision #15 explains the SDK-shaped error that results).
  server.registerTool(
    'signup',
    {
      ...meta('Create blog (sign up)', CREATE_IRREVERSIBLE),
      description: signupDescription,
      inputSchema: CreateBlogInputSchema.strict(),
      outputSchema: SignupOutput,
    },
    wrapTool<z.input<typeof CreateBlogInputSchema>>(
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
          ...(config.termsUrl !== undefined ? { terms_url: config.termsUrl } : {}),
          onboarding_text: result.onboardingText,
          email_sent: result.emailSent,
        }
      },
    ),
  )

  // 2. create_post — publish a new post.
  const CreatePostInputSchema = z
    .object({ blog_id: BlogId })
    .extend(PostInputBaseSchema.shape)
    .extend({ idempotency_key: IdempotencyKey })
    .strict()
    .superRefine(slugTitleRefinement)

  server.registerTool(
    'create_post',
    {
      ...meta('Create post', CREATE_IRREVERSIBLE),
      description: [
        "Publish a post to the blog. Needs `title` and `body` (markdown). Returns the published post's live URL.",
        'Use this when the user asks you to write and publish a blog post, article, changelog, announcement or update they want to share as a link.',
        '`status: "draft"` saves it without publishing.',
        "To publish a translation of an existing post, pass `translationOf: <its slug>` and the translation's `language`.",
        'Afterwards, always give the user the returned `post_url` (drafts have none).',
        'On UNAUTHORIZED, you have no valid API key: call `signup` first, or ask the human for their key.',
        'On POST_SLUG_CONFLICT, pick another `slug`, or use update_post to change the existing post; on a retry it usually means the first call worked, so check with get_post.',
        'Pass an `idempotency_key` to make retries safe.',
      ].join(' '),
      inputSchema: CreatePostInputSchema,
      outputSchema: PostWriteOutput,
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
        const { post, postUrl } = createPost(config.store, renderer, ctx.blog!.id, postInput, {
          translationPolicy: config.translationPolicy,
        })
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
      blog_id: BlogId,
      slug: PostSlug,
      patch: PostPatchSchema.describe(
        'Fields to change; omitted fields stay as they are. Same fields as create_post except `slug`, which cannot change.',
      ),
      idempotency_key: IdempotencyKey,
    })
    .strict()

  server.registerTool(
    'update_post',
    {
      ...meta('Update post', UPDATE),
      description: [
        "Edit an existing post. Pass the post's `slug` and a `patch` of fields to change; `coverImage: null` removes the cover.",
        'Use this when the user wants a published post or draft changed.',
        '`patch: { status: "draft" }` takes a live post offline and `"published"` puts a draft live.',
        "Slug itself can't change; delete and republish if you need a new URL.",
        'Afterwards, give the user the returned `post_url` when the post is published.',
        'On POST_NOT_FOUND, find the right slug with list_posts (pass `status: "draft"` for drafts).',
      ].join(' '),
      inputSchema: UpdatePostInputSchema,
      outputSchema: PostWriteOutput,
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
          { translationPolicy: config.translationPolicy },
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
      blog_id: BlogId,
      slug: PostSlug,
      idempotency_key: IdempotencyKey,
    })
    .strict()

  server.registerTool(
    'delete_post',
    {
      ...meta('Delete post', DELETE),
      description: "Remove a post permanently. This can't be undone.",
      inputSchema: DeletePostInputSchema,
      outputSchema: DeletedOutput,
    },
    wrapTool<{ blog_id?: string; slug: string; idempotency_key?: string }>(
      config,
      'delete_post',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      (args, ctx) => {
        const renderer = config.rendererFor(ctx.blog!)
        return deletePost(config.store, renderer, ctx.blog!.id, args.slug)
      },
    ),
  )

  // 5. update_blog — patch the authenticated blog: title, analytics,
  // parentSiteUrl, language. theme/name/id stay immutable through this
  // entry point. crossBlogGuard rejects mismatched blog_id.
  const UpdateBlogInputSchema = z
    .object({
      blog_id: BlogId,
      patch: BlogPatchSchema.describe('Blog settings to change; omitted fields stay as they are.'),
      idempotency_key: IdempotencyKey,
    })
    .strict()

  server.registerTool(
    'update_blog',
    {
      ...meta('Update blog settings', UPDATE),
      description:
        'Edit blog settings: `title`, `language` (BCP-47, e.g. "ru"), `parentSiteUrl`, `analytics`; null clears any but `language`. Set `title` to the blog\'s display name, e.g. the project or person\'s name; otherwise the URL name is shown.',
      inputSchema: UpdateBlogInputSchema,
      outputSchema: BlogOutput,
    },
    wrapTool<z.infer<typeof UpdateBlogInputSchema>>(
      config,
      'update_blog',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      (args, ctx) => {
        const renderer = config.rendererFor(ctx.blog!)
        const blog = updateBlog(config.store, renderer, ctx.blog!.id, args.patch)
        return { blog }
      },
    ),
  )

  // 6. get_blog — return the authenticated blog's metadata.
  server.registerTool(
    'get_blog',
    {
      ...meta('Get blog', READ),
      description: "Get the blog's current metadata.",
      inputSchema: z.object({ blog_id: BlogId }).strict(),
      outputSchema: BlogOutput,
    },
    wrapTool<{ blog_id?: string }>(
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
      ...meta('Get post', READ),
      description: 'Get a single post by its slug.',
      inputSchema: z.object({ blog_id: BlogId, slug: PostSlug }).strict(),
      outputSchema: PostOutput,
    },
    wrapTool<{ blog_id?: string; slug: string }>(
      config,
      'get_post',
      { auth: 'required', crossBlogGuard: true },
      (args, ctx) => ({ post: getPost(config.store, ctx.blog!.id, args.slug) }),
    ),
  )

  // 7. list_posts — published by default; ?status=draft flips.
  const ListPostsInputSchema = z
    .object({
      blog_id: BlogId,
      status: z
        .enum(['draft', 'published'])
        .describe(
          '"published" (default) lists live posts, newest published first; "draft" lists drafts, newest created first.',
        )
        .optional(),
    })
    .strict()

  server.registerTool(
    'list_posts',
    {
      ...meta('List posts', READ),
      description:
        "List posts on the blog. Defaults to published posts. Pass `status: 'draft'` for drafts.",
      inputSchema: ListPostsInputSchema,
      outputSchema: PostListOutput,
    },
    wrapTool<{ blog_id?: string; status?: 'draft' | 'published' }>(
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
      ...meta('Report a bug', READ),
      description: 'Report a bug or something unexpected. Returns a link to submit the report.',
      inputSchema: z.object({
        summary: z.string().describe('One line on what went wrong.').optional(),
        details: z
          .unknown()
          .describe(
            'Anything that helps reproduce it, e.g. the tool you called, its arguments and the error you got.',
          )
          .optional(),
      }),
      outputSchema: ReportBugOutput,
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
    .describe(
      'The image bytes as standard base64 (A-Z, a-z, 0-9, +, / with = padding). No "data:" prefix, no line breaks. Max 5 MB decoded unless the host sets another cap.',
    )

  const UploadMediaInputSchema = z
    .object({
      blog_id: BlogId,
      filename: z
        .string()
        .min(1)
        .max(255)
        .describe(
          'Original file name, e.g. "castle.jpg". Kept for reference; the public URL uses a generated id.',
        ),
      content_type: z
        .string()
        .min(1)
        .describe('Image type: "image/jpeg", "image/png", "image/gif" or "image/webp".'),
      data_base64: Base64Schema,
      idempotency_key: IdempotencyKey,
    })
    .strict()

  server.registerTool(
    'upload_media',
    {
      ...meta('Upload image', CREATE),
      description:
        'Upload an image (JPEG/PNG/GIF/WebP, max 5MB) as base64 in `data_base64`. Returns a public URL — use it as ![alt](url) in post markdown or pass as coverImage.',
      inputSchema: UploadMediaInputSchema,
      outputSchema: MediaOutput,
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
      ...meta('List images', READ),
      description:
        "List uploaded images for the blog. Returns each image's id, public URL, content type, and byte size.",
      inputSchema: z.object({ blog_id: BlogId }).strict(),
      outputSchema: MediaListOutput,
    },
    wrapTool<{ blog_id?: string }>(
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
      blog_id: BlogId,
      media_id: z
        .string()
        .describe('Id of the image (`media.id` from upload_media or list_media).'),
      idempotency_key: IdempotencyKey,
    })
    .strict()

  server.registerTool(
    'delete_media',
    {
      ...meta('Delete image', DELETE),
      description:
        'Permanently delete an uploaded image by id. The URL stops working immediately. Posts that referenced it will show a broken image until edited.',
      inputSchema: DeleteMediaInputSchema,
      outputSchema: DeletedOutput,
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
