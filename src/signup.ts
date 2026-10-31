import { z } from 'zod'
import { createApiKey, createBlog } from './blogs.js'
import { mapErrorToEnvelope } from './envelope.js'
import { SlopItError } from './errors.js'
import { generateOnboardingBlock } from './onboarding.js'
import { createPost } from './posts.js'
import type { PreviewUrlFor } from './preview.js'
import type { MutationRenderer } from './rendering/generator.js'
import type { Blog, Post } from './schema/index.js'
import { CreateBlogInputSchema, PostInputSchema } from './schema/index.js'
import type { Store } from './db/store.js'

/**
 * What signup accepts: the blog fields plus two signup-only extras. `post`
 * publishes the blog's first post in the same call (one request from a
 * stranger to a live post). `invite` is a host-issued code the host's
 * InvitePolicy checks and redeems; core gives it no meaning.
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
   * reserved-subdomain, length-floor, and profanity rules. Skipped when
   * `name` is not provided. A rejection becomes a `BLOG_NAME_RESERVED`
   * error with the validator's `reason` as the message.
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

  // Policy check (platform-supplied). Runs only when a name was actually
  // requested — unnamed blogs have nothing to validate. The hook decides
  // its own rules; core just translates a rejection into a structured
  // error so REST and MCP envelopes stay consistent.
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

  const { blog } = createBlog(config.store, input)
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
  }
}

/**
 * The signup extras as response fields, shared by REST and MCP:
 * `post` + `post_url` (or `preview_url` for a draft), `post_error`, `invite`.
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
  }
}
