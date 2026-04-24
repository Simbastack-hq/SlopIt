import { z } from 'zod'
import { PostInputBaseSchema, slugTitleRefinement } from './post-input-base.js'

// NOT re-exported — stays internal. MCP imports from ./post-input-base.js directly.

// Blog — the top-level container. name is nullable because unnamed /b/:slug
// blogs are allowed (see strategy: "instant" tier, path-based URLs).
export const BlogSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  theme: z.enum(['minimal']),
  createdAt: z.string(),
})
export type Blog = z.infer<typeof BlogSchema>

// PostInput — what the API/MCP caller provides. The schema is opinionated
// and fixed in v1; do not grow it without a very good reason.
export const PostInputSchema = PostInputBaseSchema.superRefine(slugTitleRefinement)
export type PostInput = z.input<typeof PostInputSchema>

// Patch schema for updatePost — all PostInput fields become optional,
// slug is explicitly rejected (use delete+recreate for URL changes; see
// spec decision #2). No superRefine needed: an empty patch is valid.
// NOTE: we rebuild without defaults so absent fields stay undefined —
// the implementation uses Object.keys(parsed) to detect a no-op patch
// and `parsed.field ?? prior.field` to merge; inherited defaults would
// corrupt both checks.
export const PostPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).optional(),
    excerpt: z.string().max(300).optional(),
    tags: z.array(z.string()).optional(),
    status: z.enum(['draft', 'published']).optional(),
    seoTitle: z.string().max(200).optional(),
    seoDescription: z.string().max(300).optional(),
    author: z.string().max(100).optional(),
    coverImage: z.url().optional(),
  })
  .strict()
export type PostPatchInput = z.input<typeof PostPatchSchema>

// Post — what core stores and returns.
export const PostSchema = PostInputBaseSchema.extend({
  id: z.string(),
  blogId: z.string(),
  slug: z.string(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Post = z.infer<typeof PostSchema>

// Input for createBlog. `name` is DNS-subdomain-safe when provided:
// lowercase alphanumerics + hyphens, no leading/trailing hyphen, 2–63 chars.
// Same constraints whether the blog ends up on a subdomain or not, for
// consistency and so unnamed blogs can claim a subdomain later.
export const CreateBlogInputSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .optional(),
  theme: z.enum(['minimal']).default('minimal'),
})
export type CreateBlogInput = z.input<typeof CreateBlogInputSchema>
