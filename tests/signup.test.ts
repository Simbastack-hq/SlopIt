import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createRenderer } from '../src/rendering/generator.js'
import { signupBlog, type OnSignupHook, type SignupConfig } from '../src/signup.js'

describe('signupBlog orchestration', () => {
  let dir: string
  let store: Store

  const makeConfig = (
    overrides: {
      onSignup?: OnSignupHook
      nameValidator?: SignupConfig['nameValidator']
    } = {},
  ) => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://blog.example',
    })
    return {
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      ...overrides,
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-signup-orch-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns blog + apiKey + onboardingText with emailSent: false when no email is provided', async () => {
    const onSignup = vi.fn<OnSignupHook>(async () => {})
    const result = await signupBlog(makeConfig({ onSignup }), { name: 'noemail' })

    expect(result.blog.id).toMatch(/^[a-z0-9]+$/)
    expect(result.blog.name).toBe('noemail')
    expect(result.apiKey).toMatch(/^sk_slop_/)
    expect(result.blogUrl).toBe('https://blog.example/')
    expect(result.emailSent).toBe(false)
    expect(onSignup).not.toHaveBeenCalled()
  })

  it('fires onSignup with normalized email and reports emailSent: true on hook success', async () => {
    const onSignup = vi.fn<OnSignupHook>(async () => {})
    const result = await signupBlog(makeConfig({ onSignup }), {
      name: 'withemail',
      email: '  Foo@Example.COM  ',
    })

    expect(result.emailSent).toBe(true)
    expect(onSignup).toHaveBeenCalledTimes(1)
    const call = onSignup.mock.calls[0][0]
    expect(call.blog.id).toBe(result.blog.id)
    expect(call.apiKey).toBe(result.apiKey)
    expect(call.email).toBe('foo@example.com')
  })

  it('reports emailSent: false and still succeeds when the hook throws', async () => {
    const onSignup = vi.fn<OnSignupHook>(async () => {
      throw new Error('resend down')
    })
    // Suppress the expected error log so the test output stays clean
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await signupBlog(makeConfig({ onSignup }), {
      name: 'hookfails',
      email: 'a@b.com',
    })

    expect(result.emailSent).toBe(false)
    expect(result.apiKey).toMatch(/^sk_slop_/)
    expect(onSignup).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('does not call onSignup when the hook is omitted (self-host case)', async () => {
    // No onSignup provided. Email accepted and persisted, but no send.
    const result = await signupBlog(makeConfig(), {
      name: 'noh',
      email: 'a@b.com',
    })
    expect(result.emailSent).toBe(false)
  })

  it('onboarding text reflects send outcome — success message', async () => {
    const result = await signupBlog(makeConfig({ onSignup: async () => {} }), {
      name: 'okay',
      email: 'a@b.com',
    })
    expect(result.onboardingText).toContain('We sent a copy of this key to your email')
    expect(result.onboardingText).not.toContain('Email send FAILED')
  })

  it('onboarding text reflects send outcome — failure message', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await signupBlog(
      makeConfig({
        onSignup: async () => {
          throw new Error('boom')
        },
      }),
      { name: 'fail', email: 'a@b.com' },
    )
    expect(result.onboardingText).toContain('Email send FAILED')
    expect(result.onboardingText).not.toContain('We sent a copy')
    errSpy.mockRestore()
  })

  it('onboarding text omits the recovery line entirely when no email was provided', async () => {
    const result = await signupBlog(makeConfig(), { name: 'plain' })
    expect(result.onboardingText).not.toContain('We sent a copy')
    expect(result.onboardingText).not.toContain('Email send FAILED')
  })

  describe('nameValidator hook', () => {
    it('throws BLOG_NAME_RESERVED when the validator rejects the name', async () => {
      const config = makeConfig({
        nameValidator: (name) =>
          name === 'admin' ? { ok: false, reason: "'admin' is reserved." } : { ok: true },
      })
      await expect(signupBlog(config, { name: 'admin' })).rejects.toMatchObject({
        code: 'BLOG_NAME_RESERVED',
        message: "'admin' is reserved.",
        details: { name: 'admin' },
      })
    })

    it('skips the validator entirely when name is omitted', async () => {
      const validator = vi.fn(() => ({ ok: true as const }))
      const result = await signupBlog(makeConfig({ nameValidator: validator }), {})
      expect(validator).not.toHaveBeenCalled()
      expect(result.blog.name).toBeNull()
    })

    it('proceeds when validator returns ok', async () => {
      const validator = vi.fn(() => ({ ok: true as const }))
      const result = await signupBlog(makeConfig({ nameValidator: validator }), {
        name: 'happy-blog',
      })
      expect(validator).toHaveBeenCalledWith('happy-blog')
      expect(result.blog.name).toBe('happy-blog')
    })

    it('proceeds when no validator is wired (self-host backward compat)', async () => {
      const result = await signupBlog(makeConfig(), { name: 'no-validator' })
      expect(result.blog.name).toBe('no-validator')
    })
  })
})
