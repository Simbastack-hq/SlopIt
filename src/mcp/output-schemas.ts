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

const PreviewUrl = z
  .string()
  .optional()
  .describe(
    'Private link to a rendered draft for the human to review: not indexed, not listed anywhere. Present only for drafts, on hosts with previews.',
  )

export const PostWriteOutput = toolOutput({
  post: PostShape.optional(),
  post_url: z
    .string()
    .optional()
    .describe('Live URL of the post. Present only when it is published.'),
  preview_url: PreviewUrl,
})

export const PostOutput = toolOutput({ post: PostShape.optional(), preview_url: PreviewUrl })

export const PostListOutput = toolOutput({ posts: z.array(PostShape).optional() })

export const BlogOutput = toolOutput({
  blog: BlogShape.optional(),
  blog_url: z
    .string()
    .optional()
    .describe(
      "The blog's public URL (its custom domain once one is verified). Posts live at {blog_url}{slug}/.",
    ),
})

export const DeletedOutput = toolOutput({ deleted: z.literal(true).optional() })

export const MediaOutput = toolOutput({ media: MediaShape.optional() })

export const MediaListOutput = toolOutput({ media: z.array(MediaShape).optional() })

const FactShape = z.looseObject({
  name: z.string().describe('Post bodies show it as {{fact:name}}.'),
  value: z.string(),
  note: z.string().nullable(),
  source_url: z.string().nullable(),
  confirmed_at: z
    .string()
    .describe(
      "ISO 8601. When the publisher last checked the value; a post shows the oldest of its facts' dates.",
    ),
  updated_at: z
    .string()
    .describe(
      'ISO 8601. When the value last changed; it is the modified time of posts that use it.',
    ),
  used_by: z
    .array(z.looseObject({ slug: z.string(), status: z.enum(['draft', 'published']) }))
    .describe('Every post whose body uses the fact, drafts included.'),
})

export const FactListOutput = toolOutput({
  facts: z.array(FactShape).optional(),
  render_pending: z
    .boolean()
    .optional()
    .describe(
      'true while some pages still show older values: a re-render failed and the next facts call retries it.',
    ),
})

export const SetFactOutput = toolOutput({
  fact: FactShape.optional().describe('The fact as it is now (or would be, on a dry run).'),
  changed: z
    .boolean()
    .optional()
    .describe(
      'true when the value is new or different; false when only confirmed_at or the note moved.',
    ),
  dry_run: z.boolean().optional().describe('true: nothing was written.'),
  affected_posts: z
    .array(
      z.looseObject({
        slug: z.string(),
        title: z.string(),
        status: z.enum(['draft', 'published']),
        url: z.string().optional().describe('Live URL; published posts only.'),
        lines: z
          .array(z.looseObject({ line: z.number(), before: z.string(), after: z.string() }))
          .describe('Each source line that uses the fact, before and after the change.'),
      }),
    )
    .optional()
    .describe('Every post that uses the fact. Drafts are listed but not rendered.'),
  rerendered: z.number().optional().describe('Published posts re-rendered by this call.'),
})

// report_bug always fails in core; the error envelope is its only output.
export const ReportBugOutput = toolOutput({})
