import { z } from 'zod'

// Blog — the top-level container. name is nullable because unnamed /b/:slug
// blogs are allowed (see strategy: "instant" tier, path-based URLs).
export const BlogSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  theme: z.enum(['minimal', 'classic', 'zine']).default('minimal'),
  createdAt: z.string(),
})
export type Blog = z.infer<typeof BlogSchema>

// PostInput — what the API/MCP caller provides. The schema is opinionated
// and fixed in v1; do not grow it without a very good reason.
export const PostInputSchema = z.object({
  title: z.string().min(1),
  slug: z.string().optional(),
  body: z.string(),
  excerpt: z.string().optional(),
  tags: z.array(z.string()).default([]),
  status: z.enum(['draft', 'published']).default('published'),
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
  author: z.string().optional(),
  coverImage: z.url().optional(),
})
export type PostInput = z.infer<typeof PostInputSchema>

// Post — what core stores and returns.
export const PostSchema = PostInputSchema.extend({
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
  theme: z.enum(['minimal', 'classic', 'zine']).default('minimal'),
})
export type CreateBlogInput = z.infer<typeof CreateBlogInputSchema>
