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
// (case-insensitive) — but only outside code fences and inline code. The
// split regex captures code segments at odd indices so we can skip them.
function stripDangerousBlocks(md: string): string {
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
  }
  return parts.join('')
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
  },
})

// Markdown → HTML. Synchronous because blog posts are short and we render
// once at publish time; no reason to reach for async here.
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string
}
