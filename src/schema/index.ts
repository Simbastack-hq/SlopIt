import { z } from 'zod'
import { PostInputBaseSchema, slugTitleRefinement } from './post-input-base.js'

// NOT re-exported — stays internal. MCP imports from ./post-input-base.js directly.

// Phase 3 — bring-your-own analytics. Each provider is its own optional
// sub-object so a single blog can configure multiple (e.g. Umami for live
// ops + GA for marketing reporting). NULL on the blog row means "no
// analytics configured". Strict outer object rejects unknown provider
// keys at the boundary so a typo'd `googleanalytics` (lowercase) doesn't
// silently no-op.
export const BlogAnalyticsSchema = z
  .object({
    umami: z
      .object({
        scriptUrl: z.url(),
        siteId: z.string().min(1).max(100),
      })
      .strict()
      .optional(),
    plausible: z
      .object({
        scriptUrl: z.url(),
        domain: z.string().min(1).max(253),
      })
      .strict()
      .optional(),
    googleAnalytics: z
      .object({
        measurementId: z.string().regex(/^G-[A-Z0-9]+$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional()
export type BlogAnalytics = z.infer<typeof BlogAnalyticsSchema>

// Blog — the top-level container. name is nullable because unnamed /b/:slug
// blogs are allowed (see strategy: "instant" tier, path-based URLs).
// `analytics` is optional and undefined for blogs that haven't configured
// any third-party analytics — back-compat with pre-Phase-3 rows where the
// column is NULL.
export const BlogSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  theme: z.enum(['minimal']),
  createdAt: z.string(),
  analytics: BlogAnalyticsSchema,
  // Optional link back to the blog author's main site (e.g. a custom-
  // domain blog at blog.example.com pointing to example.com). NULL =
  // omit the link in rendered output.
  parentSiteUrl: z.url().nullable(),
})
export type Blog = z.infer<typeof BlogSchema>

// Patch schema for updateBlog. v1 allows mutation of `analytics` and
// `parentSiteUrl` — theme is immutable (no theme switcher UI yet), name
// changes have their own flow (TBD), id is permanent. Strict rejects
// unknown keys at the boundary.
//
// `analytics: null` and `parentSiteUrl: null` are the documented ways to
// clear those columns; the PATCH body distinguishes "omit field from
// patch" (no-op) vs "set field to null" (clear column) via
// Object.keys(parsed) in updateBlog, same pattern as PostPatchSchema.
export const BlogPatchSchema = z
  .object({
    analytics: BlogAnalyticsSchema.unwrap().nullable().optional(),
    parentSiteUrl: z.url().nullable().optional(),
  })
  .strict()
export type BlogPatchInput = z.input<typeof BlogPatchSchema>

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
//
// `email` is optional and private — recovery channel only. It's persisted
// on the blog row but never returned in BlogSchema or surfaced through any
// public read path. Normalized via preprocess (trim + lowercase, empty
// string → undefined) so casing/whitespace differences don't break the
// recovery lookup.
export const CreateBlogInputSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .optional(),
  email: z
    .preprocess((val) => {
      if (typeof val !== 'string') return val
      const normalized = val.trim().toLowerCase()
      return normalized === '' ? undefined : normalized
    }, z.email().optional())
    .optional(),
  theme: z.enum(['minimal']).default('minimal'),
})
export type CreateBlogInput = z.input<typeof CreateBlogInputSchema>
