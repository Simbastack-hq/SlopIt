import type { Tokens } from 'marked'
import { SlopItError, type SlopItErrorCode } from '../errors.js'
import type { Post } from '../schema/index.js'
import { splitCode, walkBodyTokens } from './markdown.js'

// Live facts: the syntax contract (docs/specs/2026-10-21-live-facts.md §1–2,
// docs/solutions/live-facts.md). A post body names a blog fact inline as
// `{{fact:name}}`. One scanner (scanFacts) finds those tokens outside code,
// and everything else goes through it: validation, which posts use which
// facts, dry-run previews and substitution. No other code searches bodies
// for tokens, so they can never disagree about where a fact is.

/** A fact name: a lowercase letter, then up to 39 of a–z, 0–9 and `_`. */
export const FACT_NAME = /^[a-z][a-z0-9_]{0,39}$/

// Anything else (wrong case, spaces, one brace) is ordinary text, never an error.
const TOKEN = /\{\{fact:([a-z][a-z0-9_]{0,39})\}\}/g

export interface FactOccurrence {
  name: string
  /** Offsets of the whole token in the source. */
  start: number
  end: number
  /** 1-based source line, and the offset where that line starts. */
  line: number
  lineStart: number
}

/**
 * Every fact token in `md` outside code, in document order. "Code" is
 * splitCode's: fenced blocks and inline spans, the same split the HTML
 * stripping uses. Indented code blocks are not code here (the same
 * trade-off as stripDangerousBlocks): a token there is substituted, and
 * the value shows as code text, which is harmless because values are inert.
 */
export function scanFacts(md: string): FactOccurrence[] {
  const found: FactOccurrence[] = []
  const parts = splitCode(md)
  let offset = 0
  let line = 1
  let lineStart = 0
  let counted = 0 // newlines are counted up to this offset
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      for (const m of parts[i].matchAll(TOKEN)) {
        const start = offset + m.index
        for (; counted < start; counted++) {
          if (md.charCodeAt(counted) === 10) {
            line++
            lineStart = counted + 1
          }
        }
        found.push({ name: m[1], start, end: start + m[0].length, line, lineStart })
      }
    }
    offset += parts[i].length
  }
  return found
}

/** The distinct fact names a body uses, in order of first use. */
export function factNames(md: string): string[] {
  return [...new Set(scanFacts(md).map((o) => o.name))]
}

/**
 * What the author typed on the line before a token, when the token could
 * still start (or finish starting) a block: after indentation, blockquote
 * markers and list markers with their space, either nothing, digits (an
 * ordered-list number the value could complete), or a run of `#`, `-` or
 * `=` (a heading, rule or setext underline the value could extend).
 * Returns that remainder, or null when other text comes first, which
 * means the token sits mid-line and can't start a block. A linear walk,
 * not a regex: line prefixes can be long.
 */
function blockStartPrefix(md: string, from: number, to: number): string | null {
  const isDigit = (k: number) => k < to && md.charCodeAt(k) >= 48 && md.charCodeAt(k) <= 57
  const isSpace = (k: number) => k < to && (md[k] === ' ' || md[k] === '\t')
  let i = from
  while (i < to) {
    const c = md[i]
    if (c === ' ' || c === '\t' || c === '>') {
      i++
    } else if ((c === '-' || c === '*' || c === '+') && isSpace(i + 1)) {
      i += 2
    } else {
      let d = i
      while (isDigit(d) && d - i < 10) d++
      if (d === i || d - i > 9 || (md[d] !== '.' && md[d] !== ')') || !isSpace(d + 1)) break
      i = d + 2
    }
  }
  if (i === to) return ''
  const c = md[i]
  let k = i
  if (c === '#' || c === '-' || c === '=') while (k < to && md[k] === c) k++
  else while (isDigit(k)) k++
  return k === to ? md.slice(i, to) : null
}

/**
 * Backslash-escape the character that would make `text` block syntax at
 * the start of a block's content, given what the author typed just
 * before it (`prefix`, from blockStartPrefix): `#` (heading), `-` `+`
 * (list, rule, setext underline), `=` (setext underline), `>`
 * (blockquote), the `.`/`)` of an ordered-list number, or more of the
 * `#`/`-`/`=` run the author started. `*`, `_`, `~`, `` ` ``, `<`, `|`
 * and `[` can't occur in a value at all.
 */
function escapeBlockStart(prefix: string, text: string): string {
  if (/^[#=-]/.test(prefix)) return text.startsWith(prefix[0]) ? '\\' + text : text
  const list = /^\d+[.)]/.exec(prefix + text)
  if (list) {
    const at = list[0].length - 1 - prefix.length
    return text.slice(0, at) + '\\' + text.slice(at)
  }
  return prefix === '' && /^[#+\-=>]/.test(text) ? '\\' + text : text
}

/**
 * Replace `occurrences` (from scanFacts(md)) whose name has a value. A
 * token without one (an unknown fact in a draft) stays literal. Values
 * are inert inline (see checkFactValue), so the only thing they could
 * change is block structure at the start of a line; escapeBlockStart
 * covers that, looking at back-to-back tokens and the text the author
 * typed around them together.
 */
function substituteOccurrences(
  md: string,
  occurrences: readonly FactOccurrence[],
  values: ReadonlyMap<string, string>,
): string {
  let out = ''
  let pos = 0
  let i = 0
  let lastLine = -1
  while (i < occurrences.length) {
    // A run of tokens with nothing between them substitutes as one piece.
    let j = i
    while (j + 1 < occurrences.length && occurrences[j + 1].start === occurrences[j].end) j++
    const first = occurrences[i]
    const last = occurrences[j]
    let text = ''
    for (let k = i; k <= j; k++) {
      text += values.get(occurrences[k].name) ?? md.slice(occurrences[k].start, occurrences[k].end)
    }
    // The author's text after the run, up to the next token or the line
    // end: `{{fact:n}}. Item` with n = 5 must not become an ordered list.
    const limit = j + 1 < occurrences.length ? occurrences[j + 1].start : md.length
    let segmentEnd = last.end
    while (segmentEnd < limit && md.charCodeAt(segmentEnd) !== 10) segmentEnd++
    const piece = text + md.slice(last.end, segmentEnd)
    // Only a line's first run can start a block: a later one has an earlier
    // token in front of it. Checking once per line keeps this linear.
    const prefix =
      first.line === lastLine ? null : blockStartPrefix(md, first.lineStart, first.start)
    lastLine = first.line
    out += md.slice(pos, first.start) + (prefix === null ? piece : escapeBlockStart(prefix, piece))
    pos = segmentEnd
    i = j + 1
  }
  return out + md.slice(pos)
}

/** `md` with every known fact substituted, outside code. Unknown tokens stay literal. */
export function substituteFacts(md: string, values: ReadonlyMap<string, string>): string {
  return substituteOccurrences(md, scanFacts(md), values)
}

/**
 * Plain-text substitution for a stored auto-excerpt (no markdown escaping:
 * it is shown as text). The caller passes values only for names the body
 * itself uses, so a token-like string that came from inline code stays.
 */
function substitutePlain(text: string, values: ReadonlyMap<string, string>): string {
  return text.replace(TOKEN, (token, name: string) => values.get(name) ?? token)
}

export interface FactLine {
  line: number
  before: string
  after: string
}

/**
 * Whole source lines of `md` that use `name` (a paragraph line, a list
 * item, a table row), substituted with `before` and then `after` values.
 * Drives the dry-run preview, through the same scanner and substitution
 * as the page.
 */
export function factLines(
  md: string,
  name: string,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): FactLine[] {
  const byLine = new Map<number, FactOccurrence[]>()
  for (const o of scanFacts(md)) {
    const onLine = byLine.get(o.line)
    if (onLine === undefined) byLine.set(o.line, [o])
    else onLine.push(o)
  }
  const out: FactLine[] = []
  for (const [line, onLine] of byLine) {
    if (!onLine.some((o) => o.name === name)) continue
    const start = onLine[0].lineStart
    const nl = md.indexOf('\n', start)
    const text = md.slice(start, nl === -1 ? md.length : nl)
    const local = onLine.map((o) => ({
      ...o,
      start: o.start - start,
      end: o.end - start,
      lineStart: 0,
    }))
    out.push({
      line,
      before: substituteOccurrences(text, local, before),
      after: substituteOccurrences(text, local, after),
    })
  }
  return out
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

// Characters a value can't hold. With them gone a value is inert in every
// context a fact may sit in: no link or image (`[` `]`), HTML or autolink
// (`<` `>`), emphasis (`*` `_`), strikethrough or a `~~~` fence (`~`),
// code (`` ` ``), table cell break (`|`), escapes (`\`) or template braces
// (`{` `}`; the theme renderer would read `{{x}}` as a variable).
const FORBIDDEN = '[]<>*_~`|\\{}'

/** A valid value, trimmed, or FACT_VALUE_INVALID naming what is wrong. */
export function checkFactValue(raw: string): string {
  const value = raw.trim()
  if (value.length < 1 || value.length > 120) {
    throw new SlopItError(
      'FACT_VALUE_INVALID',
      'A fact value must be 1–120 characters after trimming',
      { length: value.length },
    )
  }
  if (/[\x00-\x1F\x7F-\x9F\u2028\u2029]/.test(value)) {
    throw new SlopItError(
      'FACT_VALUE_INVALID',
      'A fact value must be one line with no control characters',
      {},
    )
  }
  for (const ch of value) {
    if (FORBIDDEN.includes(ch)) {
      throw new SlopItError(
        'FACT_VALUE_INVALID',
        `A fact value can't contain "${ch}". None of [ ] < > * _ ~ \` | \\ { } are allowed: a value is plain text`,
        { character: ch },
      )
    }
  }
  return value
}

/**
 * Throws unless every fact token in a post write is somewhere facts may
 * go. `fields` are the write's other text fields (title, excerpt, tags…):
 * a token in any of them is FACT_NOT_ALLOWED_HERE. In the body, a token
 * in a heading is FACT_IN_HEADING (a heading's anchor and the contents
 * rail must not move when a value does) and one in a link or image
 * address, a reference definition or `<…>` is FACT_IN_URL. When the post
 * is or becomes published, every name must be one of `known`
 * (FACT_NOT_FOUND); a draft may name facts that don't exist yet.
 */
export function validatePostFacts(
  body: string,
  fields: Readonly<Record<string, string | readonly string[] | null | undefined>>,
  published: boolean,
  known: ReadonlySet<string>,
): void {
  for (const [field, raw] of Object.entries(fields)) {
    for (const text of typeof raw === 'string' ? [raw] : (raw ?? [])) {
      const m = /\{\{fact:([a-z][a-z0-9_]{0,39})\}\}/.exec(text)
      if (m) {
        throw new SlopItError(
          'FACT_NOT_ALLOWED_HERE',
          `{{fact:${m[1]}}} is in "${field}". Facts can only go in the post body; write the figure as plain text here`,
          { field, name: m[1] },
        )
      }
    }
  }

  const occurrences = scanFacts(body)
  if (occurrences.length === 0) return
  const bad = contextViolation(body, occurrences)
  if (bad !== null) {
    const { code, occurrence: o } = bad
    const where =
      code === 'FACT_IN_HEADING'
        ? "is in a heading. A heading's link anchor must not change when a value does: put the figure in the text below it"
        : 'is inside a link or image address, a reference definition or <…>. Facts can only go in text: put the figure in the link text or next to the link'
    throw new SlopItError(code, `{{fact:${o.name}}} on line ${o.line} ${where}`, {
      name: o.name,
      line: o.line,
    })
  }

  if (!published) return
  const unknown = [...new Set(occurrences.map((o) => o.name))].filter((n) => !known.has(n))
  if (unknown.length > 0) {
    throw new SlopItError(
      'FACT_NOT_FOUND',
      `This post uses facts that don't exist: ${unknown.join(', ')}. Create each with set_fact (PUT /blogs/:id/facts/:name) first, or save the post as a draft until they exist`,
      { names: unknown },
    )
  }
}

type ContextCode = Extract<SlopItErrorCode, 'FACT_IN_HEADING' | 'FACT_IN_URL'>

/**
 * The first token (document order) in a forbidden context, or null.
 * Contexts come from the page's own parser: each token is swapped for an
 * alphanumeric sentinel, the body is lexed, and a sentinel found in a
 * heading's text or a link, image or definition's address (or title)
 * marks its token. An alphanumeric sentinel behaves like any value would
 * inside a URL (`https://x.com/{{fact:a}}` is still an autolink). One
 * case the lexer can't show: `<{{fact:a}}>` lexes as an HTML tag with a
 * sentinel but as an autolink with `https:…` in it, so a token right
 * after `<`, or inside `<…>` with no spaces, is checked on the source.
 */
function contextViolation(
  md: string,
  occurrences: readonly FactOccurrence[],
): { code: ContextCode; occurrence: FactOccurrence } | null {
  const codes = new Map<number, ContextCode>()

  // `<…>` on the source, in two linear passes: the delimiter (whitespace,
  // `<` or `>`) nearest before each token and nearest after it. Tokens
  // hold none, so neighbouring tokens don't hide them.
  const delimiter = (k: number) => {
    const c = md[k]
    return c === '<' || c === '>'
      ? c
      : c === ' ' || c === '\t' || c === '\n' || c === '\r'
        ? ' '
        : ''
  }
  const opened: boolean[] = []
  let seen = ''
  for (let i = 0, p = 0; i < occurrences.length; i++) {
    for (; p < occurrences[i].start; p++) seen = delimiter(p) || seen
    opened.push(seen === '<')
  }
  seen = ''
  for (let i = occurrences.length - 1, p = md.length - 1; i >= 0; i--) {
    for (; p >= occurrences[i].end; p--) seen = delimiter(p) || seen
    const o = occurrences[i]
    const rightAfterOpen = md[o.start - 1] === '<' || md.slice(o.start - 2, o.start) === '</'
    if ((opened[i] && seen === '>') || rightAfterOpen) codes.set(i, 'FACT_IN_URL')
  }

  let nonce = 'zfactz'
  while (md.includes(nonce)) nonce += 'z'
  let sentinelized = ''
  let pos = 0
  occurrences.forEach((o, i) => {
    sentinelized += md.slice(pos, o.start) + `${nonce}${i}q`
    pos = o.end
  })
  sentinelized += md.slice(pos)
  const sentinel = new RegExp(`${nonce}(\\d+)q`, 'g')
  const mark = (text: string | null | undefined, code: ContextCode) => {
    for (const m of (text ?? '').matchAll(sentinel)) {
      const i = Number(m[1])
      if (!codes.has(i)) codes.set(i, code)
    }
  }
  walkBodyTokens(sentinelized, (token) => {
    if (token.type === 'heading') {
      mark((token as Tokens.Heading).text, 'FACT_IN_HEADING')
    } else if (token.type === 'link' || token.type === 'image' || token.type === 'def') {
      const t = token as Tokens.Link | Tokens.Image | Tokens.Def
      mark(t.href, 'FACT_IN_URL')
      mark(t.title, 'FACT_IN_URL')
    }
  })

  for (let i = 0; i < occurrences.length; i++) {
    const code = codes.get(i)
    if (code !== undefined) return { code, occurrence: occurrences[i] }
  }
  return null
}

// -----------------------------------------------------------------------------
// Materialising posts for rendering (spec §6)
// -----------------------------------------------------------------------------

/** What rendering needs of a fact. */
export interface FactRecord {
  value: string
  /** When the publisher says they last checked the value (ISO 8601). */
  confirmedAt: string
  /** When the value last changed (ISO 8601). */
  updatedAt: string
}

export interface MaterializedPost {
  /** The post as rendered: body (and auto-excerpt) substituted, `updatedAt` effective. */
  post: Post
  /** Present when the post shows at least one fact. */
  factsNote?: { oldestConfirmedAt: string }
}

// Timestamps come in two spellings: ISO 8601 from JS and SQLite's
// `datetime('now')` default ('YYYY-MM-DD HH:MM:SS', UTC). Compare instants.
function instant(ts: string): number {
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts,
  )
}

/**
 * A post as every rendered representation shows it (page, `.md` twin,
 * feeds, sitemap, llms.txt, home and "More from" lists): fact tokens in
 * the body replaced with the blog's current values, the stored
 * auto-excerpt likewise, and `updatedAt` moved to the newest value change
 * of a fact it uses when that is later (the effective modified time;
 * confirming a value without changing it never moves it). Tokens naming
 * no fact stay literal (draft previews). The stored post never changes.
 *
 * A post without tokens comes back as the same object, so its output is
 * byte-identical to rendering without live facts.
 */
export function materializePost(
  post: Post,
  facts: ReadonlyMap<string, FactRecord>,
): MaterializedPost {
  const occurrences = scanFacts(post.body)
  if (occurrences.length === 0) return { post }
  const used = new Map<string, FactRecord>()
  for (const { name } of occurrences) {
    const fact = facts.get(name)
    if (fact !== undefined) used.set(name, fact)
  }
  if (used.size === 0) return { post }

  const values = new Map([...used].map(([name, f]) => [name, f.value]))
  let updatedAt = post.updatedAt
  let oldestConfirmedAt: string | undefined
  for (const f of used.values()) {
    if (instant(f.updatedAt) > instant(updatedAt)) updatedAt = f.updatedAt
    if (oldestConfirmedAt === undefined || instant(f.confirmedAt) < instant(oldestConfirmedAt)) {
      oldestConfirmedAt = f.confirmedAt
    }
  }
  return {
    post: {
      ...post,
      body: substituteOccurrences(post.body, occurrences, values),
      excerpt: post.excerpt === undefined ? undefined : substitutePlain(post.excerpt, values),
      updatedAt,
    },
    factsNote: { oldestConfirmedAt: oldestConfirmedAt! },
  }
}
