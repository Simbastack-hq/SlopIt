import type { Blog } from '../schema/index.js'
import type { Renderer } from '../rendering/generator.js'

/**
 * The subset of ApiRouterConfig that buildLinks depends on. Kept narrow
 * so the helper is easy to unit-test and to reuse at signup time (where
 * some config pieces aren't relevant).
 */
export interface LinkConfig {
  rendererFor: (blog: Blog) => Renderer
  dashboardUrl?: string
  docsUrl?: string
}

export interface LinksBlock {
  view: string
  publish: string
  list_posts: string
  upload_media: string
  list_media: string
  dashboard?: string
  docs?: string
  bridge: string
}

/**
 * HATEOAS block emitted on every 2xx response except /health and /schema.
 * `view` is the public URL of the rendered blog (per-blog; derived from
 * rendererFor(blog).baseUrl). `publish` / `list_posts` / `bridge` are
 * relative paths — the consumer is expected to resolve against baseUrl
 * if needed. `dashboard` / `docs` are absolute URLs from config.
 */
export function buildLinks(blog: Blog, config: LinkConfig): LinksBlock {
  const links: LinksBlock = {
    view: config.rendererFor(blog).baseUrl,
    publish: `/blogs/${blog.id}/posts`,
    list_posts: `/blogs/${blog.id}/posts`,
    upload_media: `/blogs/${blog.id}/media`,
    list_media: `/blogs/${blog.id}/media`,
    bridge: '/bridge/report_bug',
  }
  if (config.dashboardUrl !== undefined) links.dashboard = config.dashboardUrl
  if (config.docsUrl !== undefined) links.docs = config.docsUrl
  return links
}
