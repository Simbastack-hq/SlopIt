import { randomBytes } from 'node:crypto'
import type { Token, Tokens } from 'marked'
import { SlopItError, type SlopItErrorCode } from '../errors.js'
import type { Post } from '../schema/index.js'
import { autoExcerpt, clipExcerpt } from './excerpt.js'
import { renderMarkdown, walkBodyTokens } from './markdown.js'
import { clipDescription, extractDescription } from './seo.js'
import { escapeHtml } from './templates.js'

// Live facts: the syntax contract (docs/specs/2026-10-21-live-facts.md,
// docs/solutions/live-facts.md). A post body names a blog fact inline as
// `{{fact:name}}`. One scanner (analyze → scanFacts) decides which tokens
// are live, using the page's own markdown lexer; validation, which posts
// use which facts, dry-run previews and every rendered output go through
// it, so they can never disagree about where a fact is.
//
// Values never go back through markdown parsing on the way to HTML or
// text: live tokens become inert placeholders, the markdown is processed,
// and the placeholders are filled with the value, escaped for the output.
// Only the `.md` twin carries values in markdown, serialised so they read
// as literal text.

/** A fact name: a lowercase letter, then up to 39 of a–z, 0–9 and `_`. */
export const FACT_NAME = /^[a-z][a-z0-9_]{0,39}$/

// Anything else (wrong case, spaces, one brace) is ordinary text, never an
// error; so is a token escaped as `\{{fact:name}}`.
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

type ContextCode = Extract<SlopItErrorCode, 'FACT_IN_HEADING' | 'FACT_IN_URL'>

interface Analysis {
  occurrence: FactOccurrence
  /** Inside code (fenced, indented or inline): literal text, not a fact. */
  inCode: boolean
  /** A context facts may not sit in, when it is one. */
  context: ContextCode | null
}

/** Every token match not escaped with a backslash, with its line. */
function matchTokens(md: string): FactOccurrence[] {
  const found: FactOccurrence[] = []
  let line = 1
  let lineStart = 0
  let counted = 0 // newlines are counted up to this offset
  for (const m of md.matchAll(TOKEN)) {
    const start = m.index
    let slashes = 0
    for (let k = start - 1; k >= 0 && md.charCodeAt(k) === 92; k--) slashes++
    if (slashes % 2 === 1) continue
    for (; counted < start; counted++) {
      if (md.charCodeAt(counted) === 10) {
        line++
        lineStart = counted + 1
      }
    }
    found.push({ name: m[1], start, end: start + m[0].length, line, lineStart })
  }
  return found
}

/**
 * Where each token match sits, decided by the page's own lexer: every
 * match is swapped for an alphanumeric sentinel, the body is lexed (as a
 * render would lex it), and the token holding each sentinel says where it
 * is. A sentinel in a code block or code span is code, whatever the
 * delimiters (multi-backtick spans, unclosed fences, indented code). One
 * in a heading, or in a link, image or reference definition's address,
 * title or label, is a forbidden context. An alphanumeric sentinel sits in
 * a URL the way any value would (`https://x.com/{{fact:a}}` is still an
 * autolink). `<…>` is checked on the source: the lexer reads
 * `<sentinel>` as a tag, but `<https:…>` would be an autolink.
 */
function analyze(md: string): Analysis[] {
  const occurrences = matchTokens(md)
  if (occurrences.length === 0) return []
  const inCode = new Set<number>()
  const context = new Map<number, ContextCode>()

  // `<…>`, in two linear passes: the delimiter (whitespace, `<` or `>`)
  // nearest before each token and nearest after it. Tokens hold none.
  const delimiter = (k: number) => {
    const c = md[k]
    if (c === '<' || c === '>') return c
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' ? ' ' : ''
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
    if ((opened[i] && seen === '>') || rightAfterOpen) context.set(i, 'FACT_IN_URL')
  }

  // Lowercase letters and digits only, and absent from the source in any
  // case: marked lowercases reference labels, so `[ZFACTZ0Q]: /x` must not
  // read as a sentinel.
  const folded = md.toLowerCase()
  let nonce = 'zfactz'
  while (folded.includes(nonce)) nonce += 'z'
  let sentinelized = ''
  let pos = 0
  occurrences.forEach((o, i) => {
    sentinelized += md.slice(pos, o.start) + `${nonce}${i}q`
    pos = o.end
  })
  sentinelized += md.slice(pos)
  const sentinel = new RegExp(`${nonce}(\\d+)q`, 'g')
  const found = (text: string | null | undefined) =>
    [...(text ?? '').matchAll(sentinel)].map((m) => Number(m[1]))
  const mark = (text: string | null | undefined, code: ContextCode) => {
    for (const i of found(text)) if (!context.has(i)) context.set(i, code)
  }
  walkBodyTokens(sentinelized, (token: Token) => {
    if (token.type === 'code' || token.type === 'codespan') {
      for (const i of found(token.raw)) inCode.add(i)
    } else if (token.type === 'heading') {
      mark(token.raw, 'FACT_IN_HEADING')
    } else if (token.type === 'link' || token.type === 'image') {
      const t = token as Tokens.Link | Tokens.Image
      mark(t.href, 'FACT_IN_URL')
      mark(t.title, 'FACT_IN_URL')
    } else if (token.type === 'def') {
      const t = token as Tokens.Def
      mark(t.tag, 'FACT_IN_URL')
      mark(t.href, 'FACT_IN_URL')
      mark(t.title, 'FACT_IN_URL')
    }
  })

  return occurrences.map((occurrence, i) => ({
    occurrence,
    inCode: inCode.has(i),
    context: inCode.has(i) ? null : (context.get(i) ?? null),
  }))
}

/** Every live fact token in `md` (outside code, not escaped), in document order. */
export function scanFacts(md: string): FactOccurrence[] {
  return analyze(md)
    .filter((a) => !a.inCode)
    .map((a) => a.occurrence)
}

/** The distinct fact names a body uses, in order of first use. */
export function factNames(md: string): string[] {
  return [...new Set(scanFacts(md).map((o) => o.name))]
}

// -----------------------------------------------------------------------------
// Placeholders: values never re-enter markdown on the way to HTML or text
// -----------------------------------------------------------------------------

interface Placeheld {
  /** The markdown with each valued occurrence replaced by a placeholder. */
  text: string
  /** Replace the placeholders in an output of `text` with `encode(value)`. */
  fill: (s: string, encode: (v: string) => string) => string
}

/**
 * Swap every occurrence `valueOf` gives a value for an inert placeholder:
 * private-use characters around a per-render random nonce and an index,
 * so author text can't spell one. Markdown sees an ordinary word.
 */
function withPlaceholders(
  md: string,
  occurrences: readonly FactOccurrence[],
  valueOf: (o: FactOccurrence) => string | undefined,
): Placeheld {
  let nonce = randomBytes(6).toString('hex')
  while (md.includes(nonce)) nonce = randomBytes(6).toString('hex')
  const pieces: string[] = []
  let text = ''
  let pos = 0
  for (const o of occurrences) {
    const v = valueOf(o)
    if (v === undefined) continue
    text += md.slice(pos, o.start) + `\uE000${nonce}${pieces.length}\uE001`
    pieces.push(v)
    pos = o.end
  }
  text += md.slice(pos)
  const re = new RegExp(`\uE000${nonce}(\\d+)\uE001`, 'g')
  return {
    text,
    fill: (s, encode) =>
      s.replace(re, (m, i: string) => {
        const v = pieces[Number(i)]
        return v === undefined ? m : encode(v)
      }),
  }
}

// -----------------------------------------------------------------------------
// The `.md` twin: values as literal-equivalent markdown
// -----------------------------------------------------------------------------

/**
 * What the author typed on the line before a token, when the token could
 * still start (or finish starting) a block: after indentation, blockquote
 * markers and list markers with their space, either nothing, digits (an
 * ordered-list number the value could complete), or a run of `#`, `-` or
 * `=` (a heading, rule or setext underline the value could extend).
 * Returns that remainder, or null when other text comes first. A linear
 * walk, not a regex: line prefixes can be long.
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
 * the start of a block's content, given what the author typed just before
 * it (`prefix`, from blockStartPrefix): `#` (heading), `-` `+` (list,
 * rule, setext underline), `=` (setext underline), `>` (blockquote), the
 * `.`/`)` of an ordered-list number, or more of the author's `#`/`-`/`=`.
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

// Minimal escaping keeps "$12/mo" and "v2.4.1" readable: only what would
// become an entity, an email or URL autolink, a tag or a cell break.
function escapeMinimal(value: string): string {
  return value
    .replace(/[&@<>|]/g, '\\$&')
    .replace(/:\/\//g, '\\://')
    .replace(/(^|[^A-Za-z0-9])(www)\./gi, '$1$2\\.')
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g

/**
 * `md` with each occurrence that has a value replaced by it, as markdown
 * that reads as the literal value. Only the values are escaped: author
 * text stays as written, apart from the backslash the line-start rules
 * may put before it. A run of tokens without values (an unknown fact in
 * a draft) is left exactly as written. `strict` escapes every ASCII
 * punctuation character of each value: the fallback for when minimal
 * escaping lets a value join the author's text into syntax (see
 * serializeTwin).
 */
function toMarkdown(
  md: string,
  occurrences: readonly FactOccurrence[],
  valueOf: (o: FactOccurrence) => string | undefined,
  strict: boolean,
): string {
  const escapeValue = strict ? (v: string) => v.replace(ASCII_PUNCTUATION, '\\$&') : escapeMinimal
  let out = ''
  let pos = 0
  let i = 0
  let lastLine = -1
  while (i < occurrences.length) {
    // A run of tokens with nothing between them serialises as one piece.
    let j = i
    while (j + 1 < occurrences.length && occurrences[j + 1].start === occurrences[j].end) j++
    const first = occurrences[i]
    const last = occurrences[j]
    const values = occurrences.slice(i, j + 1).map(valueOf)
    if (values.every((v) => v === undefined)) {
      i = j + 1
      continue
    }
    const before = md.slice(pos, first.start)
    // An entity the author started (`&`, `&#`, `&am`) must not be finished
    // by a value: every entity ends in `;`, so the run's `;` are escaped.
    const entity = /&#?[A-Za-z0-9]{0,31}$/.exec(before)
    const inEntity = entity !== null && before[entity.index - 1] !== '\\'
    let text = ''
    values.forEach((v, k) => {
      const o = occurrences[i + k]
      text += v === undefined ? md.slice(o.start, o.end) : escapeValue(v)
    })
    if (inEntity) text = text.replace(/(?<!\\);/g, '\\;')

    // The author's text after the run, up to the next token or the line
    // end: `{{fact:n}}. Item` with n = 5 must not become an ordered list.
    const limit = j + 1 < occurrences.length ? occurrences[j + 1].start : md.length
    let segmentEnd = last.end
    while (segmentEnd < limit && md.charCodeAt(segmentEnd) !== 10) segmentEnd++
    const tail = md.slice(last.end, segmentEnd)
    const piece = text + tail

    // Only a line's first run can start a block: a later one has an
    // earlier token in front of it. Checking once per line keeps this linear.
    const prefix =
      first.line === lastLine ? null : blockStartPrefix(md, first.lineStart, first.start)
    lastLine = first.line
    out += before + (prefix === null ? piece : escapeBlockStart(prefix, piece))
    pos = segmentEnd
    i = j + 1
  }
  return out + md.slice(pos)
}

// The parts of a document's structure a value could change: blocks,
// links, images, raw HTML, code, breaks. Emphasis is left out: a value's
// first character can flip emphasis flanking, which changes no meaning.
const IGNORED_IN_STRUCTURE = new Set(['text', 'escape', 'em', 'strong', 'del', 'space'])
function structure(md: string): string {
  const types: string[] = []
  walkBodyTokens(md, (t) => {
    if (!IGNORED_IN_STRUCTURE.has(t.type)) types.push(t.type)
  })
  return types.join(' ')
}

/**
 * The twin's body: values serialised with minimal escaping, checked
 * against the structure of the same body with inert placeholders
 * (`placeheld`). If a value joined the author's text into syntax (an
 * autolink, a table…), every value is escaped strictly instead. That is
 * kept even when the structure still differs: some joins live wholly in
 * the author's text around an alphanumeric value (`[{{fact:a}}]` matching
 * a reference definition, `www{{fact:a}}` with `a` = "www"… `.x.com`),
 * and author text is never rewritten. The page is unaffected either way.
 */
function serializeTwin(
  md: string,
  occurrences: readonly FactOccurrence[],
  valueOf: (o: FactOccurrence) => string | undefined,
  placeheld: string,
): string {
  const minimal = toMarkdown(md, occurrences, valueOf, false)
  return structure(minimal) === structure(placeheld)
    ? minimal
    : toMarkdown(md, occurrences, valueOf, true)
}

/**
 * `md` with known facts serialised as literal-equivalent markdown, as in
 * the `.md` twin. Unknown tokens stay literal.
 */
export function factsToMarkdown(md: string, values: ReadonlyMap<string, string>): string {
  const live = scanFacts(md)
  const valueOf = (o: FactOccurrence) => values.get(o.name)
  return serializeTwin(md, live, valueOf, withPlaceholders(md, live, valueOf).text)
}

// -----------------------------------------------------------------------------
// Dry-run preview
// -----------------------------------------------------------------------------

export interface FactLine {
  line: number
  before: string
  after: string
}

/**
 * Whole source lines of `md` that use `name` (a paragraph line, a list
 * item, a table row), with the live tokens on each replaced by `before`
 * and then `after` values, as plain text. Drives the dry-run preview,
 * through the same scanner as the page.
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
    const end = nl === -1 ? md.length : nl
    const fill = (values: ReadonlyMap<string, string>) => {
      let s = ''
      let pos = start
      for (const o of onLine) {
        s += md.slice(pos, o.start) + (values.get(o.name) ?? md.slice(o.start, o.end))
        pos = o.end
      }
      return s + md.slice(pos, end)
    }
    out.push({ line, before: fill(before), after: fill(after) })
  }
  return out
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

// Characters a value can't hold, so it stays plain text in every context
// a fact may sit in, the `.md` twin included: no link or image (`[` `]`),
// HTML or autolink (`<` `>`), emphasis (`*` `_`), strikethrough or a `~~~`
// fence (`~`), code (`` ` ``), table cell break (`|`), escapes (`\`) or
// template braces (`{` `}`).
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
  if (/^[-:= ]+$/.test(value)) {
    throw new SlopItError(
      'FACT_VALUE_INVALID',
      "A fact value can't be made only of -, : and = (it would read as a table rule or a heading underline)",
      {},
    )
  }
  return value
}

/**
 * Throws unless every fact token in a post write is somewhere facts may
 * go. `fields` are the write's other text fields (title, excerpt, tags…):
 * a token in any of them is FACT_NOT_ALLOWED_HERE. In the body, a live
 * token in a heading is FACT_IN_HEADING (a heading's anchor and the
 * contents rail must not move when a value does) and one in a link or
 * image address or title, a reference definition or `<…>` is FACT_IN_URL.
 * When the post is or becomes published, every live name must be one of
 * `known` (FACT_NOT_FOUND); a draft may name facts that don't exist yet.
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

  const live = analyze(body).filter((a) => !a.inCode)
  if (live.length === 0) return
  const bad = live.find((a) => a.context !== null)
  if (bad !== undefined) {
    const o = bad.occurrence
    const code = bad.context!
    const where =
      code === 'FACT_IN_HEADING'
        ? "is in a heading. A heading's link anchor must not change when a value does: put the figure in the text below it"
        : 'is inside a link or image address or title, a reference definition or <…>. Facts can only go in text: put the figure in the link text or next to the link'
    throw new SlopItError(code, `{{fact:${o.name}}} on line ${o.line} ${where}`, {
      name: o.name,
      line: o.line,
    })
  }

  if (!published) return
  const unknown = [...new Set(live.map((a) => a.occurrence.name))].filter((n) => !known.has(n))
  if (unknown.length > 0) {
    throw new SlopItError(
      'FACT_NOT_FOUND',
      `This post uses facts that don't exist: ${unknown.join(', ')}. Create each with set_fact (PUT /blogs/:id/facts/:name) first, or save the post as a draft until they exist`,
      { names: unknown },
    )
  }
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
  /**
   * The post as its text outputs show it: `body` is the `.md` twin's body
   * (values as literal markdown), `excerpt` and the description fallback
   * carry plain values, `updatedAt` is the effective modified time.
   */
  post: Post
  /** The body as HTML, values as escaped text. Same options as renderMarkdown. */
  bodyHtml: (opts?: { embeds?: boolean }) => string
  /** Present when the post shows at least one fact. */
  factsNote?: { oldestConfirmedAt: string }
}

/**
 * Milliseconds since the epoch for a stored timestamp. They come in two
 * spellings: ISO 8601 from JS and SQLite's `datetime('now')` default
 * ('YYYY-MM-DD HH:MM:SS', UTC). Compare instants, never strings.
 */
export function instant(ts: string): number {
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts,
  )
}

const isBlank = (s: string | undefined) => s === undefined || s.trim() === ''

/**
 * A post as every rendered representation shows it, with the blog's
 * current fact values:
 *
 * - HTML (page, feed): live tokens become placeholders, the markdown is
 *   rendered, and the placeholders are filled with the escaped value, so
 *   a value never becomes a link, an embed, an entity or block syntax.
 * - `.md` twin: `post.body` holds the values as literal-equivalent markdown.
 * - Excerpt: a fact-using post with no excerpt of its own stores none; it
 *   is derived here from the body, live tokens only, values as text. The
 *   description fallback (for a blank excerpt) is derived the same way and
 *   carried in `seoDescription`, the first link of resolveDescription's
 *   chain and read nowhere else.
 * - `updatedAt` moves to the newest value change of a fact it uses, when
 *   that is later (confirming a value never moves it).
 *
 * Tokens naming no fact stay literal (draft previews). The stored post
 * never changes. A post without live tokens comes back as the same
 * object, so its output is byte-identical to rendering without facts.
 */
export function materializePost(
  post: Post,
  facts: ReadonlyMap<string, FactRecord>,
): MaterializedPost {
  const live = scanFacts(post.body)
  if (live.length === 0) {
    return { post, bodyHtml: (opts) => renderMarkdown(post.body, opts) }
  }

  const used = new Map<string, FactRecord>()
  for (const { name } of live) {
    const fact = facts.get(name)
    if (fact !== undefined) used.set(name, fact)
  }
  const valueOf = (o: FactOccurrence) => used.get(o.name)?.value
  // Plain-text outputs hold every live token as a placeholder (so the
  // stripping can't touch it); an unknown one is filled back as written.
  const textOf = (o: FactOccurrence) => valueOf(o) ?? post.body.slice(o.start, o.end)
  const html = withPlaceholders(post.body, live, valueOf)
  const text = withPlaceholders(post.body, live, textOf)
  const plain = (s: string) => text.fill(s, (v) => v)

  const excerpt =
    post.excerpt !== undefined ? post.excerpt : clipExcerpt(plain(autoExcerpt(text.text, Infinity)))
  const seoDescription =
    isBlank(post.seoDescription) && isBlank(excerpt)
      ? clipDescription(plain(extractDescription(text.text, Infinity)))
      : post.seoDescription

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
      body: serializeTwin(post.body, live, valueOf, html.text),
      excerpt,
      seoDescription,
      updatedAt,
    },
    bodyHtml: (opts) => html.fill(renderMarkdown(html.text, opts), escapeHtml),
    ...(oldestConfirmedAt !== undefined ? { factsNote: { oldestConfirmedAt } } : {}),
  }
}
