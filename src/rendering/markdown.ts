import { Marked, type MarkedExtension, type Tokens } from 'marked'

// v1 XSS defense: strip all raw HTML tokens (block and inline) via a
// renderer override PLUS a preprocess pass that removes the payload of
// <script>, <style>, and <iframe> blocks. Agents author content on their
// own blog; readers are untrusted recipients; until v2 adds proper
// DOM-level sanitization with an opt-in, the safe default is to drop raw
// HTML entirely.
//
// Legitimate markdown syntax (headings, emphasis, lists, links, code,
// blockquotes, images) is unaffected — marked's token model treats those
// as non-html tokens with their own renderers. Code fences and inline code
// are preserved verbatim by the preprocess pass (their HTML-like contents
// are later entity-escaped by marked's code renderer).
//
// The one exception is a YouTube player, and it never comes from author
// HTML: a paragraph holding nothing but a YouTube URL is rebuilt from the
// validated video id (see youtubeEmbedSrc). A raw <iframe> is still
// stripped like any other HTML.

// Strip <script>...</script>, <style>...</style>, <iframe>...</iframe>
// (case-insensitive) — but only outside code contexts. The split regex
// captures code segments at odd indices so we can skip them. We protect:
//   - triple-backtick fenced blocks (```…```)
//   - triple-tilde fenced blocks  (~~~…~~~)
//   - inline code spans           (`…`)
//
// Indented (4-space / tab) code blocks are NOT explicitly protected — if
// an author embeds dangerous HTML inside an indented code block, the
// payload gets stripped. The failure mode is visible text loss, not XSS
// (the marked `html` renderer override still drops the tags themselves).
// We accept this trade-off for v1; authors who want HTML examples should
// use fenced code blocks, which are the idiomatic form and preserved.
function stripDangerousBlocks(md: string): string {
  const parts = md.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
  }
  return parts.join('')
}

// Allowlist URL schemes for markdown links and images. Anything with an
// unlisted scheme (javascript:, data:, vbscript:, file:, etc.) is treated
// as unsafe and stripped. Relative URLs, fragment URLs, and
// protocol-relative URLs (`//example.com`) are treated as safe — they
// inherit the page's protocol, which is already HTTPS in practice.
//
// Without this check, a post body containing
// `[click me](javascript:alert(1))` renders as a live XSS link, because
// markdown `[text](url)` is a `link` token (not an `html` token) and
// bypasses the renderer.html override above. Marked v18 removed its own
// javascript: deny-list, so the allowlist lives here.
function isSafeHref(href: string | null | undefined): boolean {
  if (!href) return true // empty/missing href renders as no anchor; harmless
  const trimmed = href.trim()
  if (trimmed === '') return true
  // Fragment, absolute path, relative path, or protocol-relative — safe.
  if (/^(#|\/|\.)/.test(trimmed)) return true
  // Scheme present? Must be in the allowlist.
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto'
  }
  // No scheme match at all — treat as relative, safe.
  return true
}

function escapeHtmlLocal(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const safeHtml: MarkedExtension = {
  hooks: {
    preprocess(md: string): string {
      return stripDangerousBlocks(md)
    },
  },
  renderer: {
    html() {
      return ''
    },
    link(token: { href: string; title?: string | null; text: string }): string | false {
      if (!isSafeHref(token.href)) {
        // Unsafe scheme — drop the anchor, emit just the visible text.
        // token.text is marked's pre-extracted visible label; escape it
        // defensively in case it contains HTML-looking characters.
        return escapeHtmlLocal(token.text)
      }
      return false // fall through to default <a> rendering
    },
    image(token: { href: string; title?: string | null; text: string }): string | false {
      if (!isSafeHref(token.href)) {
        // Unsafe image src — strip entirely. Dropping alt text too keeps
        // output predictable; if the author wanted alt text for accessibility
        // with an unsafe image, they shouldn't have used an unsafe image.
        return ''
      }
      return false // fall through to default <img> rendering
    },
  },
}

const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com'])

// YouTube's `t=` start time: `90`, `90s`, `1m30s`, `1h2m3s`. Anything else
// (or zero) plays from the start — a bad timestamp shouldn't cost the player.
function startSeconds(t: string | null): number {
  const m = t?.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/)
  if (!m) return 0
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

// The video in a bare YouTube link (youtu.be/ID, youtube.com/watch?v=ID,
// youtube.com/shorts/ID), or null when `text` is anything else. Only the
// validated 11-char id and a number come out, so nothing the author typed
// reaches an attribute unvalidated. Other query params (si=, list=, …) are
// dropped.
function youtubeVideo(text: string): { id: string; start: number } | null {
  if (/\s/.test(text) || !URL.canParse(text)) return null
  const url = new URL(text)
  if (url.protocol !== 'https:') return null
  let id: string | null = null
  if (url.hostname === 'youtu.be') {
    id = url.pathname.slice(1)
  } else if (YOUTUBE_HOSTS.has(url.hostname)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v')
    else if (url.pathname.startsWith('/shorts/')) id = url.pathname.slice('/shorts/'.length)
  }
  if (id === null || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null
  return { id, start: startSeconds(url.searchParams.get('t')) }
}

// youtube-nocookie skips YouTube's tracking cookies until the reader hits
// play. The player refuses to load without a Referer (YouTube error 153),
// hence the explicit referrerpolicy. `allow` grants only what playback uses:
// no sensors, clipboard or web-share.
const youtubeEmbeds: MarkedExtension = {
  renderer: {
    paragraph(token: Tokens.Paragraph): string | false {
      const video = youtubeVideo(token.text.trim())
      if (video === null) return false // a normal paragraph
      const src = `https://www.youtube-nocookie.com/embed/${video.id}${video.start > 0 ? `?start=${video.start}` : ''}`
      return `<iframe src="${src}" title="YouTube video" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>\n`
    },
  },
}

const pageMarked = new Marked(safeHtml, youtubeEmbeds)
const feedMarked = new Marked(safeHtml)

// Markdown → HTML. Synchronous because blog posts are short and we render
// once at publish time; no reason to reach for async here. `embeds: false`
// is for RSS: feed readers strip iframes, so a bare YouTube URL stays the
// plain link it was written as.
export function renderMarkdown(md: string, { embeds = true }: { embeds?: boolean } = {}): string {
  return (embeds ? pageMarked : feedMarked).parse(md, { async: false })
}

// The YouTube videos (ids) and image srcs (as written: maybe relative, maybe
// an unsafe scheme) a body shows on its page, in document order. Same tokens
// the page renders from: a video is only a bare-URL paragraph, and nothing
// inside code or raw HTML counts.
export function bodyMedia(md: string): { videos: string[]; images: string[] } {
  const videos: string[] = []
  const images: string[] = []
  // `void`: the callback is sync, so walkTokens' promise array is empty.
  void pageMarked.walkTokens(pageMarked.lexer(stripDangerousBlocks(md)), (token) => {
    // Casts: `Token` includes marked's catch-all Generic, so `type` alone doesn't narrow.
    if (token.type === 'paragraph') {
      const video = youtubeVideo((token as Tokens.Paragraph).text.trim())
      if (video !== null) videos.push(video.id)
    } else if (token.type === 'image') {
      images.push((token as Tokens.Image).href)
    }
  })
  return { videos, images }
}
