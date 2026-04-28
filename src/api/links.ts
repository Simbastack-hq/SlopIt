import type { Blog } from '../schema/index.js'
import type { Renderer } from '../rendering/generator.js'

/**
 * The subset of ApiRouterConfig that buildLinks depends on. Kept narrow
 * so the helper is easy to unit-test and to reuse at signup time (where
 * some config pieces aren't relevant).
 */
export interface LinkConfig {
  /**
   * Base URL of the API as the consumer reaches it — e.g.
   * `https://slopit.io/api` when the router is mounted under `/api`,
   * or `https://my-blog.example` when self-hosted at root. Used to emit
   * absolute URLs in `_links` so a caller can hit them without having
   * to know the mount path.
   */
  baseUrl: string
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
 * Every link is an **absolute URL** — relative paths break when the
 * consumer resolves them against the apex (which strips the API mount
 * path) instead of the API base. `view` is the public URL of the
 * rendered blog; `publish` / `list_posts` / `upload_media` /
 * `list_media` / `bridge` resolve against `config.baseUrl`;
 * `dashboard` / `docs` are absolute URLs from config.
 */
export function buildLinks(blog: Blog, config: LinkConfig): LinksBlock {
  const links: LinksBlock = {
    view: config.rendererFor(blog).baseUrl,
    publish: `${config.baseUrl}/blogs/${blog.id}/posts`,
    list_posts: `${config.baseUrl}/blogs/${blog.id}/posts`,
    upload_media: `${config.baseUrl}/blogs/${blog.id}/media`,
    list_media: `${config.baseUrl}/blogs/${blog.id}/media`,
    bridge: `${config.baseUrl}/bridge/report_bug`,
  }
  if (config.dashboardUrl !== undefined) links.dashboard = config.dashboardUrl
  if (config.docsUrl !== undefined) links.docs = config.docsUrl
  return links
}
