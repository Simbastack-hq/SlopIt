/**
 * Build a YAML frontmatter block (between `---` delimiters) for a
 * post's .md source file. Schema is fixed: title, slug, date, updated,
 * author, description, canonical, tags. Null/undefined/empty-array
 * values are omitted (not emitted as `key: null`).
 *
 * String values are emitted as YAML double-quoted scalars. YAML 1.2
 * §7.3.1 specifies that double-quoted scalars support JSON-compatible
 * escapes (`\n`, `\r`, `\t`, `\\`, `\"`, `\uXXXX`), so `JSON.stringify(s)`
 * produces a valid YAML double-quoted scalar for any input — including
 * titles, descriptions, or authors that contain newlines, tabs, CR, or
 * other control characters. Avoids the bug where a naive
 * backslash-and-quote-only escape produces frontmatter that doesn't
 * round-trip through any standard YAML parser when the value has
 * multi-line content.
 *
 * Tags emit as flow-style lists where each element is also a YAML
 * double-quoted scalar via the same JSON.stringify rule.
 */
export interface FrontmatterFields {
  title: string
  slug: string
  date?: string | null
  updated?: string | null
  author?: string | null
  description?: string | null
  canonical?: string | null
  tags?: readonly string[]
}

const KEYS = ['title', 'slug', 'date', 'updated', 'author', 'description', 'canonical'] as const

// YAML 1.2 double-quoted scalars are a superset of JSON string literals
// for the JSON-compatible escape set. JSON.stringify handles `"`, `\`,
// `\n`, `\r`, `\t`, `\b`, `\f`, and emits `\uXXXX` for other control
// characters — exactly what YAML accepts in double-quoted style.
function quote(s: string): string {
  return JSON.stringify(s)
}

export function buildFrontmatter(fields: FrontmatterFields): string {
  const lines: string[] = ['---']
  for (const key of KEYS) {
    const v = fields[key]
    if (v === undefined || v === null) continue
    lines.push(`${key}: ${quote(v)}`)
  }
  if (fields.tags && fields.tags.length > 0) {
    const items = fields.tags.map(quote).join(', ')
    lines.push(`tags: [${items}]`)
  }
  lines.push('---')
  return lines.join('\n')
}
