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
 * True when `tag` is a well-formed BCP-47 tag whose language the runtime
 * has locale data for, with no extension subtags. Standard library only:
 *   - `Intl.getCanonicalLocales` throws RangeError on malformed input
 *     ("not a tag", "", 40 chars of junk);
 *   - `baseName !== canonical` catches `-u-`/`-x-`/`-t-` extensions
 *     (`ru-u-ca-islamic`) that would otherwise leak into `<html lang>`;
 *   - `Intl.DateTimeFormat.supportedLocalesOf` rejects tags ICU has no
 *     data for — `xx`, and also `Russian`, which is *syntactically* a
 *     legal 7-letter language subtag — so a page never ends up tagged
 *     with a language we cannot format dates in.
 *
 * Only the language is checked against locale data. Script and region
 * subtags are validated for shape, not existence: `en-XX` passes because
 * ICU's lookup falls back to `en`. That is deliberate — regions and
 * scripts are open lists, and a wrong region still yields a correctly
 * tagged, correctly dated page.
 */
export function isSupportedLanguage(tag: string): boolean {
  let canonical: string | undefined
  try {
    canonical = Intl.getCanonicalLocales(tag)[0]
  } catch {
    return false
  }
  if (canonical === undefined) return false
  if (new Intl.Locale(canonical).baseName !== canonical) return false
  return Intl.DateTimeFormat.supportedLocalesOf(canonical).length > 0
}

/** Canonical form of an already-validated tag: `EN-us` → `en-US`. */
export function canonicalLanguage(tag: string): string {
  return Intl.getCanonicalLocales(tag)[0]
}

/**
 * A BCP-47 language tag with locale data, stored canonicalised. Built
 * with `refine` + `overwrite` rather than `transform` so `z.toJSONSchema`
 * (the public `/schema` endpoint) can still represent it. The description
 * flows into `/schema` and every MCP tool schema, so agents see the
 * examples where they read the contract.
 */
export const languageTag = z
  .string()
  .max(35)
  .refine(isSupportedLanguage, {
    message: 'Expected a BCP-47 language tag with locale data, e.g. "en", "ru", "pt-BR"',
    // Stop here on failure: `overwrite` below would otherwise still run
    // and throw RangeError on a malformed tag instead of reporting an issue.
    abort: true,
  })
  .overwrite(canonicalLanguage)

/**
 * Internal base schema shared across transports. Not re-exported from
 * src/schema/index.ts — consumers who need the shape use PostInputSchema.
 * Exists so REST's PostInputSchema and MCP's create_post tool schema
 * can share both the field shape and the slug/title refinement without
 * duplication.
 */
export const PostInputBaseSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Post title, 1–200 characters. The slug is derived from it when `slug` is omitted.'),
  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .describe(
      'URL slug, e.g. "hello-world": 2–100 lowercase letters, digits and hyphens, no hyphen at either end. The post lives at {blog_url}{slug}/. Omit to derive it from the title. Cannot be changed later; "lang" is reserved.',
    )
    .optional(),
  body: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Post content as markdown. Raw HTML is stripped. A YouTube URL alone on its own line becomes an embedded player.',
    ),
  excerpt: z
    .string()
    .max(300)
    .describe(
      'Summary shown under the title in the post list, up to 300 characters. Omit to derive it from the body.',
    )
    .optional(),
  tags: z
    .array(z.string())
    .describe('Tags shown on the post page, e.g. ["ai", "travel"]. Defaults to none.')
    .default([]),
  status: z
    .enum(['draft', 'published'])
    .describe(
      '"published" (default) puts the post live immediately; "draft" saves it without publishing.',
    )
    .default('published'),
  seoTitle: z
    .string()
    .max(200)
    .describe(
      'Title for search results and link previews, up to 200 characters. Defaults to `title`.',
    )
    .optional(),
  seoDescription: z
    .string()
    .max(300)
    .describe(
      'Description for search results and link previews, up to 300 characters. Defaults to the excerpt.',
    )
    .optional(),
  author: z
    .string()
    .max(100)
    .describe(
      "Author name, up to 100 characters. Used in the page's metadata, the feed and the markdown source.",
    )
    .optional(),
  coverImage: httpUrl
    .describe(
      'Cover image URL (http/https), shown above the post and used as its link-preview image. Use an uploaded image URL or any public image URL.',
    )
    .optional(),
  language: languageTag
    .describe(
      'Language of this post as a BCP-47 tag, e.g. "en", "ru", "pt-BR". Omit to inherit the blog\'s language.',
    )
    .optional(),
  // Input-only: resolved to a shared `translationGroup` id on write.
  translationOf: z
    .string()
    .min(1)
    .max(100)
    .describe(
      "Slug of an existing post in this blog that this post translates. The two become a translation group: one post per language, cross-linked with hreflang and a language switcher. Set `language` to the translation's language; it must differ from every other member's.",
    )
    .optional(),
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
