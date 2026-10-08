import { escapeHtml } from './templates.js'

// The contents rail: a long post's sections, listed in the margin beside
// the post on screens wide enough to have one (style.css hides it below
// that). Spec: docs/superpowers/specs/2026-10-08-contents-rail-design.md
//
// A short post keeps a bare page: the rail only appears with at least
// MIN_SECTIONS h2s and MIN_WORDS words, the point where a reader starts
// losing their place.
const MIN_SECTIONS = 3
const MIN_WORDS = 1000

// The rail's one piece of behaviour: mark the section being read (the
// last h2 above the top third of the window, or the last one once the
// page is scrolled to the end) with aria-current, and hand its position
// to the CSS marker that glides along the rail. The list is plain links
// without it. A module script runs after the page is parsed, so the
// headings below it exist.
const SCRIPT = `<script type="module">
const nav = document.querySelector('.toc')
const list = nav.querySelector('ol')
const links = [...list.querySelectorAll('a')]
const heads = links.map((a) => document.getElementById(a.getAttribute('href').slice(1)))
let current = null
let queued = false
function update() {
  queued = false
  if (nav.offsetParent === null) return
  let i = -1
  heads.forEach((h, k) => {
    if (h.getBoundingClientRect().top <= innerHeight / 3) i = k
  })
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) i = links.length - 1
  const link = links[i] ?? null
  if (link !== current) {
    current?.removeAttribute('aria-current')
    link?.setAttribute('aria-current', 'location')
    current = link
  }
  if (link) {
    list.style.setProperty('--toc-y', link.offsetTop + 'px')
    list.style.setProperty('--toc-h', link.offsetHeight + 'px')
  }
}
addEventListener('scroll', () => {
  if (!queued) requestAnimationFrame(update)
  queued = true
}, { passive: true })
addEventListener('resize', update)
update()
</script>`

/**
 * Words in a rendered body, counted the way the page's language splits
 * them (ICU word segmentation), so a Japanese or Chinese post, written
 * without spaces, is measured as fairly as an English one.
 *
 * @internal
 */
export function countWords(html: string, lang: string): number {
  const text = html.replace(/<[^>]*>/g, ' ')
  let n = 0
  for (const s of new Intl.Segmenter(lang, { granularity: 'word' }).segment(text)) {
    if (s.isWordLike) n++
  }
  return n
}

/**
 * The contents rail for a rendered post body: one link per h2 (ids come
 * from renderMarkdown), plus the script that tracks the section being
 * read. '' when the post is too short to need one. `label` names the nav
 * for screen readers; nothing on the page shows it.
 *
 * The link text is the heading's inner HTML with the tags dropped. It is
 * still entity-escaped from marked, so it goes into the page as is.
 *
 * @internal
 */
export function renderToc(bodyHtml: string, lang: string, label: string): string {
  const sections = [...bodyHtml.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)].map(
    ([, id, inner]) => ({ id, text: inner.replace(/<[^>]*>/g, '').trim() }),
  )
  if (sections.length < MIN_SECTIONS || countWords(bodyHtml, lang) < MIN_WORDS) return ''
  const items = sections.map((s) => `<li><a href="#${s.id}">${s.text}</a></li>`).join('')
  return `<nav class="toc" aria-label="${escapeHtml(label)}"><ol>${items}</ol></nav>${SCRIPT}`
}
