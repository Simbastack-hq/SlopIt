import { z } from 'zod'
import { generateSlug } from '../ids.js'

/**
 * A URL constrained to the http/https schemes. Plain `z.url()` also
 * accepts `javascript:`, `data:`, and `vbscript:` URLs — and when such a
 * value is later rendered into an `<a href>` (e.g. parentSiteUrl in the
 * masthead) it becomes a live stored-XSS link. Every caller-supplied URL
 * field uses this instead of bare `z.url()`.
 */
export const httpUrl = z.url({ protocol: /^https?$/ })

/**
 * Internal base schema shared across transports. Not re-exported from
 * src/schema/index.ts — consumers who need the shape use PostInputSchema.
 * Exists so REST's PostInputSchema and MCP's create_post tool schema
 * can share both the field shape and the slug/title refinement without
 * duplication.
 */
export const PostInputBaseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .optional(),
  body: z.string().trim().min(1),
  excerpt: z.string().max(300).optional(),
  tags: z.array(z.string()).default([]),
  status: z.enum(['draft', 'published']).default('published'),
  seoTitle: z.string().max(200).optional(),
  seoDescription: z.string().max(300).optional(),
  author: z.string().max(100).optional(),
  coverImage: httpUrl.optional(),
})

/**
 * Shared superRefine callback. If slug is omitted and the title has no
 * slug-compatible characters, the blog can't auto-derive a URL. Reject
 * at schema time with a clear message.
 */
export const slugTitleRefinement = (
  input: z.infer<typeof PostInputBaseSchema>,
  ctx: z.RefinementCtx,
): void => {
  if (input.slug === undefined && generateSlug(input.title) === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['title'],
      message: 'Title must contain slug-compatible characters, or provide an explicit slug',
    })
  }
}
