import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBlog, getBlogByName } from '../src/blogs.js'
import { createStore, type Store } from '../src/db/store.js'
import { createRenderer } from '../src/rendering/generator.js'
import { signupBlog, signupExtraFields, type SignupConfig } from '../src/signup.js'

describe('signupBlog auto-naming', () => {
  let dir: string
  let store: Store

  const config = (nameValidator?: SignupConfig['nameValidator']): SignupConfig => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://blog.example',
    })
    return { store, rendererFor: () => renderer, baseUrl: 'https://api.example', nameValidator }
  }

  // A platform-like validator: reserved subdomains and a profanity list.
  const policy: SignupConfig['nameValidator'] = (name) =>
    ['www', 'api', 'admin'].includes(name)
      ? { ok: false, reason: 'reserved' }
      : name.includes('crap')
        ? { ok: false, reason: 'profanity' }
        : { ok: true }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-auto-name-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('names an unnamed signup from the parent site and says so', async () => {
    const r = await signupBlog(config(), { parentSiteUrl: 'https://www.ailoot.ai/' })
    expect(r.blog.name).toBe('ailoot')
    expect(r.nameAutoAssigned).toBe(true)
    expect(getBlogByName(store, 'ailoot')?.id).toBe(r.blog.id)
    expect(signupExtraFields(r)).toMatchObject({ name_auto_assigned: true })
    expect(r.onboardingText).toContain('this blog is named "ailoot"')
    expect(r.onboardingText).toContain("can't be changed later")
  })

  it('falls back to a random name when nothing usable was given', async () => {
    const r = await signupBlog(config(), { email: 'someone@gmail.com', title: '日本語' })
    expect(r.blog.name).toMatch(/^blog-[a-z0-9]{5}$/)
    expect(r.nameAutoAssigned).toBe(true)
  })

  it('skips a candidate the host rejects (reserved) for the next one', async () => {
    const r = await signupBlog(config(policy), {
      parentSiteUrl: 'https://www.admin.io',
      title: 'Acme',
    })
    expect(r.blog.name).toBe('acme')
  })

  it('never names a blog from the email (private recovery channel)', async () => {
    const r = await signupBlog(config(), { email: 'alice@private-family.net' })
    expect(r.blog.name).toMatch(/^blog-[a-z0-9]{5}$/)
    expect(r.blog.name).not.toContain('private-family')
  })

  it('suggests a fresh signup only when nothing is attached yet', async () => {
    const bare = await signupBlog(config(), { title: 'Bare' })
    expect(bare.onboardingText).toContain('call signup again with `name`')

    const withPost = await signupBlog(config(), {
      title: 'With Post',
      post: { title: 'Hello', body: 'First.' },
    })
    expect(withPost.firstPost).toBeDefined()
    expect(withPost.onboardingText).toContain("can't be changed later")
    expect(withPost.onboardingText).not.toContain('call signup again')
    expect(withPost.onboardingText).toContain(
      "a separate blog that won't carry over the first post.",
    )
  })

  it('does not suggest a fresh signup once an invite was redeemed', async () => {
    const r = await signupBlog(
      {
        ...config(),
        invites: { check: () => ({ ok: true }), redeem: () => ({ note: 'Pro for 12 months' }) },
      },
      { title: 'Invited', invite: 'ONCE', post: { title: 'Hi', body: 'x' } },
    )
    expect(r.invite).toEqual({ applied: true, note: 'Pro for 12 months' })
    expect(r.onboardingText).not.toContain('call signup again')
    expect(r.onboardingText).toContain("won't carry over the first post or the invite.")
  })

  it('skips a candidate the host rejects (profanity) for the next one', async () => {
    const r = await signupBlog(config(policy), {
      parentSiteUrl: 'https://crapshoot.dev',
      title: 'Dice Talk',
    })
    expect(r.blog.name).toBe('dice-talk')
  })

  it('appends -2, -3 when the picked name is taken', async () => {
    createBlog(store, { name: 'acme' })
    const second = await signupBlog(config(), { title: 'Acme' })
    const third = await signupBlog(config(), { title: 'Acme' })
    expect(second.blog.name).toBe('acme-2')
    expect(third.blog.name).toBe('acme-3')
  })

  it('goes random once the suffixes run out', async () => {
    createBlog(store, { name: 'acme' })
    for (let n = 2; n <= 9; n++) createBlog(store, { name: `acme-${n}` })
    const r = await signupBlog(config(), { title: 'Acme' })
    expect(r.blog.name).toMatch(/^blog-[a-z0-9]{5}$/)
  })

  it('leaves a chosen name alone and still errors when it is taken', async () => {
    const chosen = await signupBlog(config(), { name: 'mine', title: 'Something Else' })
    expect(chosen.blog.name).toBe('mine')
    expect(chosen.nameAutoAssigned).toBe(false)
    expect(signupExtraFields(chosen)).not.toHaveProperty('name_auto_assigned')
    expect(chosen.onboardingText).not.toContain('No name was given')
    await expect(signupBlog(config(), { name: 'mine' })).rejects.toMatchObject({
      code: 'BLOG_NAME_CONFLICT',
    })
  })

  it('still rejects a chosen name the host refuses', async () => {
    await expect(signupBlog(config(policy), { name: 'admin' })).rejects.toMatchObject({
      code: 'BLOG_NAME_RESERVED',
    })
  })
})

describe('signupBlog foundVia', () => {
  let dir: string
  let store: Store
  const config = (): SignupConfig => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.ex' })
    return { store, rendererFor: () => renderer, baseUrl: 'https://api.example' }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-found-via-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('echoes a cleaned single line', async () => {
    const r = await signupBlog(config(), {
      name: 'fv',
      foundVia: '  Glama\n directory\u0007   listing ',
    })
    expect(r.foundVia).toBe('Glama directory listing')
    expect(signupExtraFields(r)).toMatchObject({ found_via: 'Glama directory listing' })
  })

  it('treats a blank value as omitted', async () => {
    const r = await signupBlog(config(), { name: 'fv', foundVia: ' \n\t ' })
    expect(r.foundVia).toBeUndefined()
    expect(signupExtraFields(r)).not.toHaveProperty('found_via')
  })

  it('rejects more than 200 characters before creating anything', async () => {
    await expect(signupBlog(config(), { name: 'fv', foundVia: 'x'.repeat(201) })).rejects.toThrow()
    expect(getBlogByName(store, 'fv')).toBeNull()
  })
})
