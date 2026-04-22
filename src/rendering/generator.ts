import type { Store } from '../db/store.js'

export interface RendererConfig {
  store: Store
  outputDir: string   // where static files are written, per-blog subdirs
  baseUrl: string     // e.g. "https://blog.example.com" — used for feeds + SEO
}

export interface Renderer {
  /** Re-render every page of a blog to disk. */
  renderBlog(blogId: string): Promise<void>
  /** Render a single post + its blog index + feeds. */
  renderPost(postId: string): Promise<void>
}

export function createRenderer(_config: RendererConfig): Renderer {
  return {
    renderBlog: async (_blogId: string) => {
      throw new Error('renderBlog: not implemented')
    },
    renderPost: async (_postId: string) => {
      throw new Error('renderPost: not implemented')
    },
  }
}
