import { z } from 'zod'

// `outputSchema` for every MCP tool. Clients validate `structuredContent`
// against these, so a mismatch fails a real agent's call. Two rules
// (docs/solutions/mcp-output-schemas.md):
//
// 1. Loose objects only. Zod's output-mode JSON Schema adds
//    `additionalProperties: false` to a plain z.object(), which would make
//    every new response field a validation failure.
// 2. Success fields are optional. Business errors return
//    `structuredContent: { error }` with `isError: true`, and the
//    TypeScript SDK client (1.29) validates structuredContent against the
//    schema even on error results: a required success field turns every
//    business error into a -32602 thrown at the agent. `error` is declared
//    so the envelope is documented too.

const ErrorShape = z
  .looseObject({
    code: z.string().describe('Error code, e.g. "POST_NOT_FOUND".'),
    message: z.string().describe('What went wrong and what to do next.'),
    details: z.record(z.string(), z.unknown()).describe('Extra context. Keys depend on the code.'),
  })
  .describe('Present only on failure (isError: true). Success fields are absent then.')

function toolOutput<T extends z.ZodRawShape>(shape: T) {
  return z.looseObject({ ...shape, error: ErrorShape.optional() })
}

const PostShape = z.looseObject({
  id: z.string(),
  blogId: z.string(),
  slug: z.string().describe("The post's page is {blog_url}{slug}/."),
  title: z.string(),
  body: z.string().describe('Markdown body.'),
  excerpt: z.string().optional(),
  tags: z.array(z.string()),
  status: z.enum(['draft', 'published']),
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
  author: z.string().optional(),
  coverImage: z.string().optional(),
  language: z
    .string()
    .optional()
    .describe("The post's own BCP-47 language tag. Absent: it uses the blog's language."),
  translationGroup: z.string().optional().describe('Shared by every translation of the same post.'),
  publishedAt: z.string().nullable().describe('ISO 8601 publish time. null for drafts.'),
  createdAt: z.string().describe('ISO 8601.'),
  updatedAt: z.string().describe('ISO 8601.'),
})

const BlogShape = z.looseObject({
  id: z.string(),
  name: z.string().nullable().describe('null for an unnamed blog.'),
  title: z
    .string()
    .nullable()
    .optional()
    .describe('Display name shown on the blog. null: the blog shows its name (or id) instead.'),
  theme: z.string(),
  createdAt: z.string().describe('ISO 8601.'),
  analytics: z
    .looseObject({
      umami: z.looseObject({ siteId: z.string() }).optional(),
      plausible: z.looseObject({ domain: z.string() }).optional(),
      googleAnalytics: z.looseObject({ measurementId: z.string() }).optional(),
    })
    .optional()
    .describe('Absent when no analytics is configured.'),
  parentSiteUrl: z.string().nullable(),
  language: z.string().describe("The blog's default BCP-47 language tag."),
})

const MediaShape = z.looseObject({
  id: z.string().describe('Pass as media_id to delete_media.'),
  blogId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  bytes: z.number(),
  createdAt: z.string().describe('ISO 8601.'),
  url: z
    .string()
    .describe('Absolute public URL of the image. Use it verbatim in markdown or as coverImage.'),
})

export const SignupOutput = toolOutput({
  blog_id: z.string().optional().describe('Pass as blog_id to every other tool.'),
  blog_url: z.string().optional().describe('Live URL of the blog.'),
  api_key: z
    .string()
    .optional()
    .describe('Send as "Authorization: Bearer <api_key>". Shown once; save it.'),
  mcp_endpoint: z.string().optional(),
  terms_url: z.string().optional(),
  onboarding_text: z
    .string()
    .optional()
    .describe('Next steps addressed to you, the agent. Contains the API key.'),
  email_sent: z
    .boolean()
    .optional()
    .describe('True only when an email was given and the welcome email went out.'),
})

export const PostWriteOutput = toolOutput({
  post: PostShape.optional(),
  post_url: z
    .string()
    .optional()
    .describe('Live URL of the post. Present only when it is published.'),
})

export const PostOutput = toolOutput({ post: PostShape.optional() })

export const PostListOutput = toolOutput({ posts: z.array(PostShape).optional() })

export const BlogOutput = toolOutput({ blog: BlogShape.optional() })

export const DeletedOutput = toolOutput({ deleted: z.literal(true).optional() })

export const MediaOutput = toolOutput({ media: MediaShape.optional() })

export const MediaListOutput = toolOutput({ media: z.array(MediaShape).optional() })

// report_bug always fails in core; the error envelope is its only output.
export const ReportBugOutput = toolOutput({})
