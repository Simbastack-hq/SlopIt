import { z } from 'zod'
import {
  httpUrl,
  languageTag,
  PostInputBaseSchema,
  slugTitleRefinement,
} from './post-input-base.js'

// NOT re-exported — stays internal. MCP imports from ./post-input-base.js directly.

// Phase 3 — bring-your-own analytics. Each provider is its own optional
// sub-object so a single blog can configure multiple (e.g. Umami for live
// ops + GA for marketing reporting). NULL on the blog row means "no
// analytics configured". Strict outer object rejects unknown provider
// keys at the boundary so a typo'd `googleanalytics` (lowercase) doesn't
// silently no-op.
//
// No provider takes a caller-supplied script URL. The consumer hardcodes
// the official cloud endpoint per provider (same as GA derives its URL
// from `measurementId`). A free-form `scriptUrl` was an arbitrary-script
// injection vector — a caller pointed it at an attacker-controlled file
// and the renderer injected it as `<script src>`. Don't re-add it.
export const BlogAnalyticsSchema = z
  .object({
    umami: z
      .object({
        siteId: z.string().min(1).max(100).describe('Umami Cloud website id.'),
      })
      .strict()
      .describe('Umami Cloud analytics.')
      .optional(),
    plausible: z
      .object({
        domain: z
          .string()
          .min(1)
          .max(253)
          .describe('Site domain as registered in Plausible Cloud, e.g. "blog.example.com".'),
      })
      .strict()
      .describe('Plausible Cloud analytics.')
      .optional(),
    googleAnalytics: z
      .object({
        measurementId: z
          .string()
          .regex(/^G-[A-Z0-9]+$/)
          .describe('GA4 measurement id, e.g. "G-ABC123".'),
      })
      .strict()
      .describe('Google Analytics 4.')
      .optional(),
  })
  .strict()
  .optional()
export type BlogAnalytics = z.infer<typeof BlogAnalyticsSchema>

// A blog's display title. It lands in the masthead, <title>, og:site_name,
// the RSS channel and the llms.txt `# ` heading, so it must be one line:
// control characters (C0, DEL, C1; newlines included) and the Unicode
// line/paragraph separators are rejected rather than stripped. Explicit
// ranges, not `\p{Cc}`: the pattern ships in the JSON Schema clients see,
// and not every client's regex engine knows Unicode property escapes.
// Trimmed before the length check, so "  " is too short, not empty.
const blogTitle = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[^\x00-\x1F\x7F-\x9F\u2028\u2029]*$/,
    'Title must be one line with no control characters',
  )

// Blog — the top-level container. name is nullable because unnamed /b/:slug
// blogs are allowed (see strategy: "instant" tier, path-based URLs).
// `analytics` is optional and undefined for blogs that haven't configured
// any third-party analytics — back-compat with pre-Phase-3 rows where the
// column is NULL.
export const BlogSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  // Human-readable display name. NULL = the renderer shows `name`, then `id`.
  title: z.string().nullable(),
  theme: z.enum(['minimal']),
  createdAt: z.string(),
  analytics: BlogAnalyticsSchema,
  // Optional link back to the blog author's main site (e.g. a custom-
  // domain blog at blog.example.com pointing to example.com). NULL =
  // omit the link in rendered output. httpUrl (not bare z.url()) — this
  // is rendered into an `<a href>`, so a `javascript:` scheme would be a
  // live XSS link.
  parentSiteUrl: httpUrl.nullable(),
  // Default language for every page and feed on the blog (BCP-47,
  // canonical). Always present — the column is NOT NULL DEFAULT 'en'.
  // Posts may override it individually via `Post.language`.
  language: z.string(),
})
export type Blog = z.infer<typeof BlogSchema>

// Patch schema for updateBlog. Allows `title`, `analytics`,
// `parentSiteUrl` and `language` — theme is immutable (no theme switcher
// UI yet), name changes have their own flow (TBD), id is permanent.
// Strict rejects unknown keys at the boundary.
//
// `title: null`, `analytics: null` and `parentSiteUrl: null` are the
// documented ways to clear those columns; the PATCH body distinguishes
// "omit field from patch" (no-op) vs "set field to null" (clear column)
// via Object.keys(parsed) in updateBlog, same pattern as PostPatchSchema.
export const BlogPatchSchema = z
  .object({
    title: blogTitle
      .nullable()
      .describe(
        "Display name shown as the blog's heading and in browser tabs, feeds and link previews, e.g. the project or person's name. 1–80 characters, one line. null removes it and the URL name is shown again.",
      )
      .optional(),
    analytics: BlogAnalyticsSchema.unwrap()
      .nullable()
      .describe(
        'Analytics added to every page: any of `umami`, `plausible`, `googleAnalytics`. Replaces the whole analytics config; null removes it.',
      )
      .optional(),
    parentSiteUrl: httpUrl
      .nullable()
      .describe(
        "URL (http/https) of the author's main site, linked from the blog. null removes it.",
      )
      .optional(),
    // Not nullable: a blog always has a language. "Reset" is `'en'`.
    language: languageTag
      .describe('Default language for the blog as a BCP-47 tag, e.g. "en", "ru", "pt-BR".')
      .optional(),
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
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('New title, 1–200 characters. The slug stays the same.')
      .optional(),
    body: z
      .string()
      .trim()
      .min(1)
      .describe('New markdown body. Replaces the whole body.')
      .optional(),
    excerpt: z
      .string()
      .max(300)
      .describe('New summary shown under the title in the post list, up to 300 characters.')
      .optional(),
    tags: z
      .array(z.string())
      .describe('New tag list, e.g. ["ai"]. Replaces all tags; [] removes them.')
      .optional(),
    status: z
      .enum(['draft', 'published'])
      .describe('"published" puts the post live; "draft" takes it offline.')
      .optional(),
    seoTitle: z
      .string()
      .max(200)
      .describe('New title for search results and link previews, up to 200 characters.')
      .optional(),
    seoDescription: z
      .string()
      .max(300)
      .describe('New description for search results and link previews, up to 300 characters.')
      .optional(),
    author: z.string().max(100).describe('New author name, up to 100 characters.').optional(),
    // `null` removes the cover; omitting the key leaves it unchanged.
    coverImage: httpUrl
      .nullable()
      .describe('Cover image URL (http/https). Send null to remove the cover.')
      .optional(),
    // `null` clears a per-post override so the post follows the blog's
    // language again; omitting the key leaves it unchanged.
    language: languageTag
      .nullable()
      .describe(
        'Language of this post as a BCP-47 tag, e.g. "en", "ru", "pt-BR". Send null to clear the override and inherit the blog\'s language.',
      )
      .optional(),
    // A slug joins this post to that post's translation group (creating
    // the group if needed); `null` leaves the group; omitting the key
    // leaves membership unchanged.
    translationOf: z
      .string()
      .min(1)
      .max(100)
      .nullable()
      .describe(
        'Slug of a post in this blog to link as a translation of this one. Send null to unlink this post from its translation group.',
      )
      .optional(),
  })
  .strict()
export type PostPatchInput = z.input<typeof PostPatchSchema>

// Post — what core stores and returns. `translationOf` is input-only:
// the write path resolves it to the shared `translationGroup` id, which
// is what reads expose. Posts with the same `translationGroup` are the
// same text in different languages.
export const PostSchema = PostInputBaseSchema.omit({ translationOf: true }).extend({
  id: z.string(),
  blogId: z.string(),
  slug: z.string(),
  translationGroup: z.string().optional(),
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
    .describe(
      'Blog name, e.g. "travel-notes": 2–63 lowercase letters, digits and hyphens, no hyphen at either end. The host may use it in the blog URL. Omit for an unnamed blog. A taken name fails with BLOG_NAME_CONFLICT.',
    )
    .optional(),
  title: blogTitle
    .describe(
      "Display name shown as the blog's heading and in browser tabs, feeds and link previews, e.g. \"Jane's Travel Notes\" or the project's name. 1–80 characters, one line. Omit it and the URL name is shown.",
    )
    .optional(),
  email: z
    .preprocess((val) => {
      if (typeof val !== 'string') return val
      const normalized = val.trim().toLowerCase()
      return normalized === '' ? undefined : normalized
    }, z.email().optional())
    .describe(
      "The blog owner's email address. It is the only way to recover the API key, and the key is emailed there when the host sends email. Some hosts require it. Pass it whenever the human gives one.",
    )
    .optional(),
  theme: z
    .enum(['minimal'])
    .describe('Blog theme. Only "minimal" exists today.')
    .default('minimal'),
  language: languageTag
    .describe(
      'Default language for the blog as a BCP-47 tag, e.g. "en", "ru", "pt-BR". Defaults to "en". Individual posts may override it.',
    )
    .default('en'),
})
export type CreateBlogInput = z.input<typeof CreateBlogInputSchema>
