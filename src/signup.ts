import { z } from 'zod'
import { createApiKey, createBlog } from './blogs.js'
import { mapErrorToEnvelope } from './envelope.js'
import { SlopItError } from './errors.js'
import { generateOnboardingBlock } from './onboarding.js'
import { createPost } from './posts.js'
import type { PreviewUrlFor } from './preview.js'
import type { MutationRenderer } from './rendering/generator.js'
import type { Blog, Post } from './schema/index.js'
import { BlogNameSchema, CreateBlogInputSchema, PostInputSchema } from './schema/index.js'
import { nameCandidates, randomBlogName } from './blog-name.js'
import type { Store } from './db/store.js'

/**
 * What signup accepts: the blog fields plus three signup-only extras.
 * `post` publishes the blog's first post in the same call (one request
 * from a stranger to a live post). `invite` is a host-issued code the
 * host's InvitePolicy checks and redeems; core gives it no meaning.
 * `foundVia` is echoed back for the host to record; core doesn't store it.
 */
export const SignupInputSchema = CreateBlogInputSchema.extend({
  post: PostInputSchema.optional().describe(
    'The first post, published in the same call: the same fields as create_post (`title` and markdown `body` required). Saves a second call. If the blog is created but the post fails, the response still carries the key and blog, plus `post_error`.',
  ),
  invite: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe(
      'An invite code the human was given. Pass it exactly as written; a code the host does not recognise fails with INVITE_INVALID before anything is created.',
    )
    .optional(),
  foundVia: z
    .preprocess((val) => {
      if (typeof val !== 'string') return val
      // One line of plain text: control characters become spaces, and
      // runs of whitespace (\s covers U+2028/2029) collapse to one. Blank means omitted:
      // this field never blocks a signup.
      const cleaned = val
        .replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return cleaned === '' ? undefined : cleaned
    }, z.string().max(200).optional())
    .describe(
      'Optional: where you or your human heard about SlopIt (a site, a directory, a post, a person, a search). Plain text, one line, up to 200 characters.',
    )
    .optional(),
})
export type SignupInput = z.input<typeof SignupInputSchema>

/**
 * Host hook for invite codes. `check` runs before anything is created, so
 * a mistyped code fails cleanly; `redeem` runs once the blog exists and
 * returns a short note for the response (e.g. "Pro for 12 months"). A
 * redeem failure doesn't undo the signup; it's logged and reported as
 * `invite.applied: false`.
 */
export interface InvitePolicy {
  check(code: string): { ok: true } | { ok: false; reason: string }
  redeem(code: string, blog: Blog): { note: string }
}

/**
 * Hook fired after a blog + API key are created. Platform passes a
 * concrete sender (Resend, SES, SMTP, …); self-hosters can omit the hook
 * entirely. Awaited but its failure does NOT fail the signup — the user
 * still gets their blog + key in the response. `email_sent` reflects
 * whether the hook resolved without throwing.
 */
export type OnSignupHook = (params: { blog: Blog; apiKey: string; email: string }) => Promise<void>

/**
 * Structural subset of ApiRouterConfig / McpServerConfig that
 * `signupBlog` actually depends on. Lets REST and MCP share the same
 * orchestration without dragging in fields neither path uses (authMode,
 * etc). Both consumer configs satisfy this shape via TS structural
 * typing — no casts at the call sites.
 */
export interface SignupConfig {
  store: Store
  rendererFor: (blog: Blog) => MutationRenderer
  baseUrl: string
  mcpEndpoint?: string
  docsUrl?: string
  skillUrl?: string
  bugReportUrl?: string
  dashboardUrl?: string
  requireEmail?: boolean
  termsUrl?: string
  onSignup?: OnSignupHook
  /**
   * Optional policy hook for blog names. Runs AFTER core's structural
   * validation (length, regex) but BEFORE persistence. Core treats names
   * as opaque DNS-safe strings; the platform wires this to enforce
   * reserved-subdomain, length-floor, and profanity rules. A rejection of
   * a chosen `name` becomes a `BLOG_NAME_RESERVED` error with the
   * validator's `reason` as the message; a rejected auto-picked name is
   * skipped for the next candidate.
   */
  nameValidator?: (name: string) => { ok: true } | { ok: false; reason: string }
  /** Invite codes accepted at signup; without it any `invite` fails. */
  invites?: InvitePolicy
  /** Draft previews for a first post saved as a draft. */
  previewUrlFor?: PreviewUrlFor
}

export interface SignupResult {
  blog: Blog
  apiKey: string
  blogUrl: string
  onboardingText: string
  /** Whether the welcome email was sent successfully. False if no email
   * was provided OR the hook threw OR no hook was wired. */
  emailSent: boolean
  /** The first post, when `post` was given and it was created. */
  firstPost?: { post: Post; postUrl?: string; previewUrl?: string }
  /** Why the first post wasn't created; the blog and key still were. */
  postError?: { code: string; message: string; details: Record<string, unknown> }
  /** Present when an invite code was given. */
  invite?: { applied: boolean; note?: string }
  /** True when signup gave no `name` and core picked one. */
  nameAutoAssigned: boolean
  /** The caller's `foundVia`, cleaned, for the host to record. Not stored by core. */
  foundVia?: string
}

/**
 * Single source of truth for blog + API key signup. REST `/signup` and
 * MCP `signup` both call this so they cannot drift on validation,
 * persistence, hook semantics, or onboarding text. Returns the assembled
 * response plus `emailSent` — the transport layer adapts shape but
 * never re-implements the steps.
 */
export async function signupBlog(config: SignupConfig, rawInput: unknown): Promise<SignupResult> {
  // Single Zod parse at the boundary. createBlog re-parses defensively;
  // that's cheap and not worth carving out.
  const {
    post: firstPostInput,
    invite: inviteCode,
    foundVia,
    ...blogInput
  } = SignupInputSchema.parse(rawInput)
  const input = blogInput

  // Keep email optional in the shared schema: instance policy belongs
  // here so REST and MCP receive this structured, actionable error
  // instead of an SDK/Zod validation envelope.
  if (config.requireEmail === true && input.email === undefined) {
    throw new SlopItError(
      'EMAIL_REQUIRED',
      'This SlopIt instance requires an email at signup. Call signup again with an "email" field (the blog owner\'s email address) — it is the only recovery channel for the API key.',
    )
  }

  const email = input.email ?? null

  // Policy check (platform-supplied) on a name the caller chose. The hook
  // decides its own rules; core just translates a rejection into a
  // structured error so REST and MCP envelopes stay consistent. A picked
  // name goes through the same hook in createAutoNamedBlog.
  if (input.name !== undefined && config.nameValidator !== undefined) {
    const verdict = config.nameValidator(input.name)
    if (!verdict.ok) {
      throw new SlopItError('BLOG_NAME_RESERVED', verdict.reason, { name: input.name })
    }
  }

  // Invite codes are checked before anything is created, so a typo costs
  // nothing and the caller can retry with the right code.
  if (inviteCode !== undefined) {
    const verdict = config.invites?.check(inviteCode) ?? {
      ok: false as const,
      reason: 'This host does not use invite codes',
    }
    if (!verdict.ok) {
      throw new SlopItError('INVITE_INVALID', verdict.reason, { invite: inviteCode })
    }
  }

  const nameAutoAssigned = input.name === undefined
  const { blog } = nameAutoAssigned
    ? createAutoNamedBlog(config, input)
    : createBlog(config.store, input)
  const { apiKey } = createApiKey(config.store, blog.id)
  const renderer = config.rendererFor(blog)

  // Redeem the invite before the welcome email, so the email already sees
  // what the code unlocked (no upgrade pitch to someone just given Pro).
  let invite: SignupResult['invite']
  if (inviteCode !== undefined) {
    try {
      invite = { applied: true, note: config.invites!.redeem(inviteCode, blog).note }
    } catch (err) {
      console.error('[slopit] invite redeem failed; signup continues:', err)
      invite = { applied: false }
    }
  }

  let emailSent = false
  if (email !== null && config.onSignup !== undefined) {
    try {
      await config.onSignup({ blog, apiKey, email })
      emailSent = true
    } catch (err) {
      // Hook failures are best-effort; signup still succeeds. Surfaced
      // to the caller via emailSent: false so onboarding copy stays
      // honest ("save this key NOW") instead of falsely claiming a
      // copy was sent.
      const message = err instanceof Error ? err.message : String(err)
      console.error('[slopit] onSignup hook failed; signup continues without email:', message)
    }
  }

  // The first post. A failure here (a live-fact token the new blog can't
  // have, a bad translationOf) must not cost the caller the key they just
  // got, so it is reported next to the signup instead of thrown.
  let firstPost: SignupResult['firstPost']
  let postError: SignupResult['postError']
  if (firstPostInput !== undefined) {
    try {
      const { post, postUrl } = createPost(config.store, renderer, blog.id, firstPostInput)
      const previewUrl = post.status === 'draft' ? config.previewUrlFor?.(blog, post) : undefined
      firstPost = { post, postUrl, previewUrl }
    } catch (err) {
      const env = mapErrorToEnvelope(err)
      postError = { code: env.code, message: env.message, details: env.details }
    }
  }

  const onboardingText = generateOnboardingBlock({
    blog,
    apiKey,
    blogUrl: renderer.baseUrl,
    baseUrl: config.baseUrl,
    schemaUrl: `${config.baseUrl}/schema`,
    mcpEndpoint: config.mcpEndpoint,
    dashboardUrl: config.dashboardUrl,
    docsUrl: config.docsUrl,
    skillUrl: config.skillUrl,
    bugReportUrl: config.bugReportUrl,
    emailProvided: email !== null,
    emailSent,
    nameAutoAssigned,
    firstPostCreated: firstPost !== undefined,
    // Any invite that passed `check` reached `redeem`, which may have
    // consumed it even if it then threw.
    inviteUsed: inviteCode !== undefined,
  })

  return {
    blog,
    apiKey,
    blogUrl: renderer.baseUrl,
    onboardingText,
    emailSent,
    firstPost,
    postError,
    invite,
    nameAutoAssigned,
    foundVia,
  }
}

// Collision suffixes tried per picked name (`acme-2` … `acme-9`), then
// random names, before giving up loudly.
const MAX_SUFFIX = 9
const RANDOM_ATTEMPTS = 5

/**
 * Create a blog for a signup that gave no `name`, under the first picked
 * name that passes the same checks as a chosen one (schema, then the
 * host's nameValidator). A taken name gets `-2`, `-3` …; the UNIQUE
 * constraint decides, so two concurrent signups can't both get `acme`.
 * Past the suffix cap, or with no usable candidate, a random name.
 */
function createAutoNamedBlog(
  config: SignupConfig,
  input: z.infer<typeof CreateBlogInputSchema>,
): ReturnType<typeof createBlog> {
  const acceptable = (name: string) =>
    BlogNameSchema.safeParse(name).success && (config.nameValidator?.(name).ok ?? true)
  const tryCreate = (name: string) => {
    try {
      return createBlog(config.store, { ...input, name })
    } catch (err) {
      if (err instanceof SlopItError && err.code === 'BLOG_NAME_CONFLICT') return undefined
      throw err
    }
  }

  const base = nameCandidates({ parentSiteUrl: input.parentSiteUrl, title: input.title }).find(
    acceptable,
  )
  if (base !== undefined) {
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const name = n === 1 ? base : `${base}-${n}`
      if (!acceptable(name)) continue
      const created = tryCreate(name)
      if (created !== undefined) return created
    }
  }
  for (let i = 0; i < RANDOM_ATTEMPTS; i++) {
    const name = randomBlogName()
    if (!acceptable(name)) continue
    const created = tryCreate(name)
    if (created !== undefined) return created
  }
  throw new Error(`Could not pick a free blog name after ${RANDOM_ATTEMPTS} random attempts`)
}

/**
 * The signup extras as response fields, shared by REST and MCP:
 * `post` + `post_url` (or `preview_url` for a draft), `post_error`, `invite`,
 * `name_auto_assigned`, `found_via`.
 */
export function signupExtraFields(r: SignupResult): Record<string, unknown> {
  return {
    ...(r.firstPost !== undefined
      ? {
          post: r.firstPost.post,
          ...(r.firstPost.postUrl !== undefined ? { post_url: r.firstPost.postUrl } : {}),
          ...(r.firstPost.previewUrl !== undefined ? { preview_url: r.firstPost.previewUrl } : {}),
        }
      : {}),
    ...(r.postError !== undefined ? { post_error: r.postError } : {}),
    ...(r.invite !== undefined ? { invite: r.invite } : {}),
    ...(r.nameAutoAssigned ? { name_auto_assigned: true } : {}),
    ...(r.foundVia !== undefined ? { found_via: r.foundVia } : {}),
  }
}
