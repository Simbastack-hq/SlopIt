import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createApiRouter } from '../src/api/index.js'
import { createRenderer, type MutationRenderer } from '../src/rendering/generator.js'
import { createApiKey, createBlog } from '../src/blogs.js'
import { createPost, getPost, updatePost, MAX_SCHEDULE_DAYS } from '../src/posts.js'
import { publishDuePosts } from '../src/schedule.js'
import { SlopItError } from '../src/errors.js'

const thrown = (fn: () => unknown): SlopItError => {
  try {
    fn()
  } catch (e) {
    if (e instanceof SlopItError) return e
    throw e
  }
  throw new Error('expected a SlopItError')
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
const DAY = 86_400_000

describe('scheduled publishing', () => {
  let dir: string
  let out: string
  let store: Store
  let renderer: MutationRenderer
  let blogId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-schedule-'))
    out = join(dir, 'out')
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderer = createRenderer({ store, outputDir: out, baseUrl: 'https://b.example/' })
    blogId = createBlog(store, { name: 'sched' }).blog.id
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const page = (slug: string) => join(out, blogId, slug, 'index.html')

  describe('createPost', () => {
    it('saves a draft that carries publishAt, normalised to UTC, and renders nothing', () => {
      const at = new Date(Date.now() + 2 * 3_600_000)
      const local = at.toISOString().replace('Z', '+00:00')
      const { post, postUrl } = createPost(store, renderer, blogId, {
        title: 'Later',
        body: 'bb',
        slug: 'later',
        publishAt: local,
      })
      expect(post.status).toBe('draft')
      expect(post.publishAt).toBe(at.toISOString())
      expect(post.publishedAt).toBeNull()
      expect(postUrl).toBeUndefined()
      expect(existsSync(page('later'))).toBe(false)
    })

    it('schedules even when status says "published" (its default)', () => {
      const { post } = createPost(store, renderer, blogId, {
        title: 'Later',
        body: 'bb',
        status: 'published',
        publishAt: inHours(1),
      })
      expect(post.status).toBe('draft')
      expect(post.publishAt).toBeDefined()
    })

    it('refuses a time in the past or more than 90 days ahead', () => {
      const past = thrown(() =>
        createPost(store, renderer, blogId, { title: 'xx', body: 'bb', publishAt: inHours(-1) }),
      )
      expect(past.code).toBe('PUBLISH_AT_INVALID')
      const far = new Date(Date.now() + (MAX_SCHEDULE_DAYS + 1) * DAY).toISOString()
      const tooFar = thrown(() =>
        createPost(store, renderer, blogId, { title: 'xx', body: 'bb', publishAt: far }),
      )
      expect(tooFar.code).toBe('PUBLISH_AT_INVALID')
      expect(tooFar.details).toMatchObject({ maxDays: MAX_SCHEDULE_DAYS })
    })

    it('rejects a time without a timezone at the schema', () => {
      expect(() =>
        createPost(store, renderer, blogId, {
          title: 'xx',
          body: 'bb',
          publishAt: '2030-01-01T09:00:00',
        }),
      ).toThrow()
    })

    it('needs the live facts it uses to exist, since it will publish unattended', () => {
      const err = thrown(() =>
        createPost(store, renderer, blogId, {
          title: 'xx',
          body: 'Price: {{fact:price}}',
          publishAt: inHours(1),
        }),
      )
      expect(err.code).toBe('FACT_NOT_FOUND')
    })
  })

  describe('updatePost', () => {
    const scheduled = (slug = 'pp') =>
      createPost(store, renderer, blogId, { title: 'P', body: 'bb', slug, publishAt: inHours(1) })
        .post

    it('reschedules and cancels a draft', () => {
      scheduled()
      const later = inHours(5)
      expect(updatePost(store, renderer, blogId, 'pp', { publishAt: later }).post.publishAt).toBe(
        later,
      )
      const cancelled = updatePost(store, renderer, blogId, 'pp', { publishAt: null }).post
      expect(cancelled.publishAt).toBeUndefined()
      expect(cancelled.status).toBe('draft')
    })

    it('keeps the schedule across other edits, and publishing by hand clears it', () => {
      scheduled()
      expect(
        updatePost(store, renderer, blogId, 'pp', { title: 'P2' }).post.publishAt,
      ).toBeDefined()
      const live = updatePost(store, renderer, blogId, 'pp', { status: 'published' }).post
      expect(live.status).toBe('published')
      expect(live.publishAt).toBeUndefined()
      expect(existsSync(page('pp'))).toBe(true)
    })

    it('schedules an existing draft', () => {
      createPost(store, renderer, blogId, { title: 'D', body: 'bb', slug: 'dd', status: 'draft' })
      expect(
        updatePost(store, renderer, blogId, 'dd', { publishAt: inHours(2) }).post.publishAt,
      ).toBeDefined()
    })

    it('refuses to schedule a live post unless the same call unpublishes it', () => {
      createPost(store, renderer, blogId, { title: 'L', body: 'bb', slug: 'll' })
      const err = thrown(() => updatePost(store, renderer, blogId, 'll', { publishAt: inHours(2) }))
      expect(err.code).toBe('PUBLISH_AT_INVALID')
      expect(getPost(store, blogId, 'll').status).toBe('published')

      const back = updatePost(store, renderer, blogId, 'll', {
        status: 'draft',
        publishAt: inHours(2),
      }).post
      expect(back.status).toBe('draft')
      expect(back.publishAt).toBeDefined()
      expect(existsSync(page('ll'))).toBe(false)
    })

    it('refuses status "published" together with publishAt', () => {
      scheduled()
      const err = thrown(() =>
        updatePost(store, renderer, blogId, 'pp', { status: 'published', publishAt: inHours(3) }),
      )
      expect(err.code).toBe('PUBLISH_AT_INVALID')
    })
  })

  describe('publishDuePosts', () => {
    it('publishes only what is due, oldest first, and clears the schedule', () => {
      createPost(store, renderer, blogId, {
        title: 'A',
        body: 'bb',
        slug: 'aa',
        publishAt: inHours(2),
      })
      createPost(store, renderer, blogId, {
        title: 'B',
        body: 'bb',
        slug: 'bb',
        publishAt: inHours(1),
      })
      createPost(store, renderer, blogId, {
        title: 'C',
        body: 'bb',
        slug: 'cc',
        publishAt: inHours(9),
      })

      expect(publishDuePosts(store, () => renderer).published).toEqual([])

      const now = new Date(Date.now() + 3 * 3_600_000)
      const res = publishDuePosts(store, () => renderer, { now })
      expect(res.published.map((p) => p.slug)).toEqual(['bb', 'aa'])
      expect(res.failed).toEqual([])
      for (const slug of ['aa', 'bb']) {
        const p = getPost(store, blogId, slug)
        expect(p.status).toBe('published')
        expect(p.publishAt).toBeUndefined()
        expect(p.publishedAt).not.toBeNull()
        expect(existsSync(page(slug))).toBe(true)
      }
      expect(getPost(store, blogId, 'cc').status).toBe('draft')
      expect(existsSync(join(out, blogId, 'index.html'))).toBe(true)

      // Nothing left due: a second tick is a no-op.
      expect(publishDuePosts(store, () => renderer, { now }).published).toEqual([])
    })

    it('leaves a post that fails to publish as an unscheduled draft and keeps going', () => {
      createPost(store, renderer, blogId, {
        title: 'X',
        body: 'bb',
        slug: 'xx',
        publishAt: inHours(1),
      })
      createPost(store, renderer, blogId, {
        title: 'Y',
        body: 'bb',
        slug: 'yy',
        publishAt: inHours(1),
      })
      const broken: MutationRenderer = {
        ...renderer,
        baseUrl: renderer.baseUrl,
        renderPost: (id, post) => {
          if (post.slug === 'xx') throw new Error('disk full')
          renderer.renderPost(id, post)
        },
      }
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const res = publishDuePosts(store, () => broken, {
        now: new Date(Date.now() + 2 * 3_600_000),
      })
      err.mockRestore()

      expect(res.failed).toEqual([
        { blogId, slug: 'xx', error: expect.stringContaining('disk full') },
      ])
      expect(res.published.map((p) => p.slug)).toEqual(['yy'])
      const x = getPost(store, blogId, 'xx')
      expect(x.status).toBe('draft')
      expect(x.publishAt).toBeUndefined()
    })
  })

  describe('REST', () => {
    it('accepts publishAt in JSON and as a text/markdown query parameter', async () => {
      const apiKey = createApiKey(store, blogId).apiKey
      const app = createApiRouter({
        store,
        rendererFor: () => renderer,
        baseUrl: 'https://api.example',
      })
      const at = inHours(4)

      const json = await app.request(`/blogs/${blogId}/posts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'J', body: 'bb', slug: 'jj', publishAt: at }),
      })
      expect(json.status).toBe(200)
      const jBody = (await json.json()) as { post: { status: string; publishAt?: string } }
      expect(jBody.post).toMatchObject({ status: 'draft', publishAt: at })

      const md = await app.request(
        `/blogs/${blogId}/posts?title=M&slug=mm&publishAt=${encodeURIComponent(at)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'text/markdown' },
          body: '# hi',
        },
      )
      expect(md.status).toBe(200)
      expect(getPost(store, blogId, 'mm').publishAt).toBe(at)

      const bad = await app.request(`/blogs/${blogId}/posts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Z', body: 'bb', publishAt: inHours(-2) }),
      })
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
        'PUBLISH_AT_INVALID',
      )
    })
  })
})
