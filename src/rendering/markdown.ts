import { marked } from 'marked'

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
// Note: marked.use() modifies the shared default marked instance. This is
// fine because src/rendering/markdown.ts is the only module in core that
// imports marked; no other code path depends on marked's default behavior.

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

marked.use({
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
})

// Markdown → HTML. Synchronous because blog posts are short and we render
// once at publish time; no reason to reach for async here.
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false })
}
