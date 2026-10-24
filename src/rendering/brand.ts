import { escapeHtml } from './templates.js'

// A blog's brand: an accent color, a masthead logo and a favicon. The
// theme stays the theme; these only swap its accent and its marks so a
// blog on blog.acme.com looks like Acme's and not like SlopIt's.

// The `minimal` theme's page background and accent, as in its style.css
// and favicon.svg (tests/blog-brand.test.ts pins both). Readability is
// measured against the background; the favicon is recolored by
// replacing the accent.
const PAGE_BACKGROUND = '#fafaf9'
const THEME_ACCENT = '#ff4f00'

// Links, the parent-site pill and the contents marker are drawn in the
// accent on the page background. 3:1 is WCAG's floor for large text and
// UI components, and what the default coral itself reaches (3.2:1).
const MIN_ACCENT_CONTRAST = 3

// `--accent-dark` (hover/active) is the accent at 83% brightness, the
// ratio between the theme's own two coral shades.
const DARK_FACTOR = 0.83

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

function toHex(rgb: readonly number[]): string {
  return '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio between two `#rrggbb` colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function scale(hex: string, factor: number): string {
  return toHex(channels(hex).map((c) => c * factor))
}

export type AccentVerdict =
  | { ok: true }
  | { ok: false; ratio: number; suggestion: string; message: string }

/**
 * Whether `accent` (`#rrggbb`, lowercase) can be read on the page. A
 * refusal carries the lightest darker shade of the same color that
 * passes, so the caller can retry with something close to the brand.
 */
export function accentReadability(accent: string): AccentVerdict {
  const ratio = contrastRatio(accent, PAGE_BACKGROUND)
  if (ratio >= MIN_ACCENT_CONTRAST) return { ok: true }
  let suggestion = accent
  for (let f = 0.98; contrastRatio(suggestion, PAGE_BACKGROUND) < MIN_ACCENT_CONTRAST; f -= 0.02) {
    suggestion = scale(accent, f)
  }
  return {
    ok: false,
    ratio,
    suggestion,
    message: `accentColor ${accent} is too light to read on the blog's ${PAGE_BACKGROUND} background (${ratio.toFixed(1)}:1; links need at least ${MIN_ACCENT_CONTRAST}:1). Try ${suggestion}, the same color darkened just enough, or another darker shade of the brand.`,
  }
}

/** The blog's style.css: the theme's, plus the accent override when set. */
export function brandCss(themeCss: string, accent: string | null): string {
  if (accent === null) return themeCss
  return `${themeCss}
/* Blog brand (accentColor) */
:root {
  --accent: ${accent};
  --accent-dark: ${scale(accent, DARK_FACTOR)};
}
`
}

/** The blog's favicon.svg: the theme's, in the accent when one is set. */
export function brandFavicon(themeSvg: string, accent: string | null): string {
  if (accent === null) return themeSvg
  const marker = `fill="${THEME_ACCENT}"`
  if (!themeSvg.includes(marker)) {
    throw new Error(`theme favicon has no ${marker} to recolor; update THEME_ACCENT in brand.ts`)
  }
  return themeSvg.replaceAll(marker, `fill="${accent}"`)
}

/**
 * `<link rel="icon">`: the blog's own favicon when set (any image type,
 * so no `type`), else the theme's SVG at `localHref`.
 */
export function renderFaviconLink(faviconUrl: string | null, localHref: string): string {
  if (faviconUrl !== null) return `<link rel="icon" href="${escapeHtml(faviconUrl)}" />`
  return `<link rel="icon" type="image/svg+xml" href="${escapeHtml(localHref)}" />`
}

/**
 * What the masthead shows: the logo, named by the blog's display name
 * for screen readers and search, else the name as text.
 */
export function renderMastheadName(blogName: string, logoUrl: string | null): string {
  if (logoUrl === null) return escapeHtml(blogName)
  return `<img class="masthead-logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(blogName)}">`
}
