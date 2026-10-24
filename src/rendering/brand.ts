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

// `--accent-dark` (hover/active) is the accent this much darker in
// OKLab lightness: the gap between the theme's own two coral shades.
const DARK_STEP = 0.08

type Rgb = [number, number, number]

function linear(hex: string): Rgb {
  return [1, 3, 5].map((i) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as Rgb
}

function toHex(lin: Rgb): string {
  return (
    '#' +
    lin
      .map((x) => {
        const c = Math.min(1, Math.max(0, x))
        const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
        return Math.round(s * 255)
          .toString(16)
          .padStart(2, '0')
      })
      .join('')
  )
}

function luminance(hex: string): number {
  const [r, g, b] = linear(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// OKLab (Björn Ottosson's matrices): lowering L keeps the hue and the
// colorfulness, where scaling RGB toward black turns a brand color muddy.
function toOklab(hex: string): Rgb {
  const [r, g, b] = linear(hex)
  const [l, m, s] = [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map(Math.cbrt)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function fromOklab([L, a, b]: Rgb): string {
  const [l, m, s] = [
    L + 0.3963377774 * a + 0.2158037573 * b,
    L - 0.1055613458 * a - 0.0638541728 * b,
    L - 0.0894841775 * a - 1.291485548 * b,
  ].map((x) => x ** 3)
  return toHex([
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ])
}

function darken(hex: string, step: number): string {
  const [L, a, b] = toOklab(hex)
  return fromOklab([Math.max(0, L - step), a, b])
}

/** WCAG 2 contrast ratio between two `#rrggbb` colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
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
  for (let step = 0.005; contrastRatio(suggestion, PAGE_BACKGROUND) < MIN_ACCENT_CONTRAST; ) {
    suggestion = darken(accent, step)
    step += 0.005
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
  --accent-dark: ${darken(accent, DARK_STEP)};
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
