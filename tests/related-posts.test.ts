import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog, updateBlog } from '../src/blogs.js'
import {
  createPost,
  deletePost,
  getPost,
  listPublishedPostsForBlog,
  updatePost,
} from '../src/posts.js'
import { createRenderer, renderMoreFrom } from '../src/rendering/generator.js'
import type { Post } from '../src/schema/index.js'

// "More from this blog" — the three newest published posts, excluding
// the one being read, at the end of every post page. Spec:
// docs/superpowers/specs/2026-09-02-related-posts-design.md

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    blogId: 'b1',
    slug: 'hello',
    title: 'Hello',
    body: 'body',
    excerpt: undefined,
    tags: [],
    status: 'published',
    seoTitle: undefined,
    seoDescription: undefined,
    author: undefined,
    coverImage: undefined,
    publishedAt: '2025-01-15T12:00:00Z',
    createdAt: '2025-01-15T12:00:00Z',
    updatedAt: '2025-01-15T12:00:00Z',
    ...overrides,
  }
}

describe('renderMoreFrom', () => {
  const self = makePost({ id: 'self', slug: 'self', title: 'Self' })
  const others = ['a', 'b', 'c', 'd'].map((k) =>
    makePost({ id: k, slug: `post-${k}`, title: `Post ${k.toUpperCase()}`, excerpt: `About ${k}` }),
  )

  it('returns empty string when the post is the only published post', () => {
    expect(renderMoreFrom(self, [self])).toBe('')
    expect(renderMoreFrom(self, [])).toBe('')
  })

  it('excludes the post itself and keeps the caller order (newest first)', () => {
    const html = renderMoreFrom(self, [others[0], self, others[1]])
    expect(html).not.toContain('post-self')
    expect(html.indexOf('post-a')).toBeLessThan(html.indexOf('post-b'))
  })

  it('caps at three items', () => {
    const html = renderMoreFrom(self, [self, ...others])
    expect(html).toContain('post-a')
    expect(html).toContain('post-b')
    expect(html).toContain('post-c')
    expect(html).not.toContain('post-d')
  })

  it('links relatively (../<slug>/), matching blogHomeHref: ".."', () => {
    const html = renderMoreFrom(self, [self, others[0]])
    expect(html).toContain('<a href="../post-a/">Post A</a>')
  })

  it('shows the resolved description and omits the <p> when there is none', () => {
    const withDesc = renderMoreFrom(self, [self, others[0]])
    expect(withDesc).toContain('<p>About a</p>')
    const noDesc = renderMoreFrom(self, [
      self,
      makePost({ id: 'x', slug: 'x', title: 'X', body: '', excerpt: '' }),
    ])
    expect(noDesc).toContain('<a href="../x/">X</a></li>')
    expect(noDesc).not.toContain('<p>')
  })

  it('uses the fixed heading and labels the nav by it', () => {
    const html = renderMoreFrom(self, [self, others[0]])
    expect(html).toContain('<nav class="more-from" aria-labelledby="more-from-heading">')
    expect(html).toContain('<h2 id="more-from-heading">More from this blog</h2>')
  })

  it('escapes title, description, and slug', () => {
    const html = renderMoreFrom(self, [
      self,
      makePost({
        id: 'evil',
        slug: 'a"b',
        title: '<script>x</script>',
        excerpt: 'Tom & "Jerry"',
      }),
    ])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html).toContain('Tom &amp; &quot;Jerry&quot;')
    expect(html).toContain('href="../a&quot;b/"')
  })
})

describe('More from this blog — lifecycle', () => {
  let dir: string
  let store: Store
  let outputDir: string
  let renderer: ReturnType<typeof createRenderer>
  let blogId: string

  const pageOf = (slug: string) => readFileSync(join(outputDir, blogId, slug, 'index.html'), 'utf8')
  const linksIn = (html: string): string[] =>
    [...html.matchAll(/<nav class="more-from"[\s\S]*?<\/nav>/g)]
      .flatMap((m) => [...m[0].matchAll(/href="\.\.\/([^/"]+)\/"/g)])
      .map((m) => m[1])

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-more-from-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
    renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example' })
    blogId = createBlog(store, { name: 'siblings' }).blog.id
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // Publish with distinct timestamps so "newest first" is unambiguous.
  function publish(slug: string, extra: Partial<Parameters<typeof createPost>[3]> = {}) {
    const { post } = createPost(store, renderer, blogId, {
      title: `Title ${slug}`,
      slug,
      body: `Body of ${slug}`,
      ...extra,
    })
    return post
  }
  function setPublishedAt(slug: string, iso: string) {
    store.db
      .prepare('UPDATE posts SET published_at = ? WHERE blog_id = ? AND slug = ?')
      .run(iso, blogId, slug)
  }

  it('a lone post renders no block at all', () => {
    publish('only')
    expect(pageOf('only')).not.toContain('more-from')
  })

  it('two posts link to each other, one item each', () => {
    publish('one')
    publish('two')
    expect(linksIn(pageOf('one'))).toEqual(['two'])
    expect(linksIn(pageOf('two'))).toEqual(['one'])
  })

  it('every page lists the three newest OTHER posts, newest first', () => {
    for (let i = 1; i <= 5; i++) {
      publish(`p${i}`)
      setPublishedAt(`p${i}`, `2025-01-0${i}T00:00:00Z`)
    }
    renderer.renderBlogPosts(blogId)

    // Newest page (p5) lists the next three down.
    expect(linksIn(pageOf('p5'))).toEqual(['p4', 'p3', 'p2'])
    // Oldest page (p1) lists the three newest.
    expect(linksIn(pageOf('p1'))).toEqual(['p5', 'p4', 'p3'])
    // A middle page skips itself.
    expect(linksIn(pageOf('p4'))).toEqual(['p5', 'p3', 'p2'])
  })

  it('a new publish shows up on every existing page (no stale lists)', () => {
    publish('old')
    expect(pageOf('old')).not.toContain('more-from')
    publish('fresh')
    expect(linksIn(pageOf('old'))).toEqual(['fresh'])
  })

  it('drafts are never candidates', () => {
    publish('live')
    publish('hidden', { status: 'draft' })
    publish('other')
    expect(linksIn(pageOf('live'))).toEqual(['other'])
    expect(pageOf('live')).not.toContain('hidden')
  })

  it('deleting a post removes it from every sibling page', () => {
    publish('keep')
    publish('gone')
    expect(linksIn(pageOf('keep'))).toEqual(['gone'])
    deletePost(store, renderer, blogId, 'gone')
    expect(pageOf('keep')).not.toContain('more-from')
  })

  it('unpublishing a post removes it from every sibling page', () => {
    publish('keep')
    publish('paused')
    updatePost(store, renderer, blogId, 'paused', { status: 'draft' })
    expect(pageOf('keep')).not.toContain('more-from')
  })

  it('title and description edits propagate to sibling pages', () => {
    publish('aa')
    publish('bb', { excerpt: 'first blurb' })
    expect(pageOf('aa')).toContain('Title bb')
    expect(pageOf('aa')).toContain('first blurb')

    updatePost(store, renderer, blogId, 'bb', { title: 'Renamed bb', excerpt: 'second blurb' })
    const a = pageOf('aa')
    expect(a).toContain('Renamed bb')
    expect(a).toContain('second blurb')
    expect(a).not.toContain('first blurb')
  })

  it('updateBlog refreshes post pages via renderBlogPosts alone (no renderPost loop)', () => {
    publish('aa')
    publish('bb')
    const posts = vi.spyOn(renderer, 'renderBlogPosts')
    const post = vi.spyOn(renderer, 'renderPost')
    const index = vi.spyOn(renderer, 'renderBlog')

    updateBlog(store, renderer, blogId, { parentSiteUrl: 'https://parent.example' })

    expect(posts).toHaveBeenCalledTimes(1)
    expect(index).toHaveBeenCalledTimes(1)
    expect(post).not.toHaveBeenCalled()
    expect(pageOf('aa')).toContain('https://parent.example')
    expect(pageOf('bb')).toContain('https://parent.example')
  })

  it('same-millisecond publishes order by insertion (later first)', () => {
    publish('first')
    publish('second')
    setPublishedAt('first', '2025-06-01T00:00:00.000Z')
    setPublishedAt('second', '2025-06-01T00:00:00.000Z')
    expect(listPublishedPostsForBlog(store, blogId).map((p) => p.slug)).toEqual(['second', 'first'])
  })

  describe('platform CTA-injector invariants (slopit-platform cta-injection.ts)', () => {
    // The injector treats a page as a post page iff it has exactly one
    // `</article>` and does not match the index marker below. The block
    // must sit inside the article so the CTA lands after it.
    const INDEX_MARKER = /<article\b[^>]*\bclass="[^"]*\bpost-item\b/

    it('a post page with the block still has exactly one </article> and no index marker', () => {
      publish('aa')
      publish('bb')
      const html = pageOf('aa')
      expect(html).toContain('class="more-from"')
      expect(html.split('</article>').length - 1).toBe(1)
      expect(INDEX_MARKER.test(html)).toBe(false)
    })

    it('the block precedes the closing </article>', () => {
      publish('aa')
      publish('bb')
      const html = pageOf('aa')
      expect(html.indexOf('class="more-from"')).toBeLessThan(html.indexOf('</article>'))
    })
  })

  describe('render failure keeps the DB compensated (weakened invariant)', () => {
    it('createPost: a throwing renderBlogPosts leaves no row behind', () => {
      publish('aa')
      const spy = vi.spyOn(renderer, 'renderBlogPosts').mockImplementation(() => {
        throw new Error('synthetic renderBlogPosts failure')
      })
      expect(() => publish('bb')).toThrow('synthetic renderBlogPosts failure')
      spy.mockRestore()
      expect(() => getPost(store, blogId, 'bb')).toThrow(
        expect.objectContaining({ code: 'POST_NOT_FOUND' }),
      )
    })

    it('updatePost: a throwing renderBlogPosts reverts the row', () => {
      publish('aa')
      const spy = vi.spyOn(renderer, 'renderBlogPosts').mockImplementation(() => {
        throw new Error('synthetic renderBlogPosts failure')
      })
      expect(() => updatePost(store, renderer, blogId, 'aa', { title: 'New' })).toThrow(
        'synthetic renderBlogPosts failure',
      )
      spy.mockRestore()
      expect(getPost(store, blogId, 'aa').title).toBe('Title aa')
    })
  })
})
