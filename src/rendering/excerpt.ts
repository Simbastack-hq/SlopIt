/**
 * Build an auto-excerpt from markdown body: strip common syntax, collapse
 * whitespace, truncate to `max` (160) chars with a trailing ellipsis on
 * overflow.
 *
 * Not a real markdown parser — good enough for v1 for typical posts. Edge
 * cases (inline HTML, code fences with content) produce noisy excerpts,
 * which is acceptable; callers who care supply an explicit excerpt field.
 *
 * Lives here, not in posts.ts, because rendering also derives an excerpt
 * at render time for a post whose body uses live facts (rendering/facts.ts).
 *
 * @internal — exported for unit testing; not re-exported from src/index.ts.
 */
export function autoExcerpt(body: string, max = 160): string {
  const stripped = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*#+ /gm, '')
    .replace(/^[ \t]*> /gm, '')
    .replace(/^[ \t]*[-*+] /gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return clipExcerpt(stripped, max)
}

/** `text` cut to `max` chars with a trailing ellipsis, the way autoExcerpt cuts. */
export function clipExcerpt(text: string, max = 160): string {
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + '…'
}
