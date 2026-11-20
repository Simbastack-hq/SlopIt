import { generateShortId, generateSlug } from './ids.js'

// Auto-naming for a signup that gave no `name`. Unnamed blogs live at an
// id path nobody links to, and agents rarely think to pass a name, so
// signup picks one. Pure: signupBlog validates each candidate and
// handles collisions.

// Two-label public suffixes, so `shop.example.co.uk` names `example`, not
// `co`. Short on purpose: an unlisted one only costs a worse name, which
// then fails validation or reads oddly, never a wrong blog.
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.za', 'co.jp',
  'co.in', 'co.kr', 'co.ke', 'or.ke', 'co.il', 'co.id', 'com.br',
  'com.mx', 'com.ar', 'com.cn', 'com.hk', 'com.sg', 'com.tr', 'com.tw',
  'com.my', 'com.ph', 'com.pk', 'com.ng',
]) // prettier-ignore

// Hosts where the subdomain names the owner: `acme.github.io` → `acme`.
const SUBDOMAIN_HOSTS = [
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev',
  'web.app', 'firebaseapp.com', 'herokuapp.com', 'onrender.com',
  'fly.dev', 'surge.sh', 'glitch.me', 'replit.app', 'wordpress.com',
  'blogspot.com', 'substack.com', 'medium.com', 'notion.site',
  'webflow.io', 'framer.website', 'wixsite.com', 'carrd.co',
] // prettier-ignore

// Hosts where the path names the project: `github.com/owner/repo` → `repo`.
// GitLab nests groups (`gitlab.com/acme/platform/news-site`), so there the
// project is the last segment before GitLab's `/-/` subpage marker.
const REPO_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'])

// Hosts whose name says nothing about the owner. Skipped outright.
const SKIP_HOSTS = new Set([
  'x.com', 'twitter.com', 'linkedin.com', 'youtube.com', 'facebook.com',
  'instagram.com', 'tiktok.com', 'linktr.ee', 'google.com', 'notion.so',
]) // prettier-ignore

// Below this a derived name is noise (and likely reserved anyway).
const MIN_CANDIDATE = 3
// Leaves room for a `-N` collision suffix under the 63-char name cap.
const MAX_BASE = 60

/** The label a domain is registered under: `www.ailoot.ai` → `ailoot`. */
function registrableLabel(host: string): string | undefined {
  const labels = host.split('.').filter((l) => l !== '')
  if (labels.length < 2) return undefined
  const lastTwo = labels.slice(-2).join('.')
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) return labels.length >= 3 ? labels.at(-3) : undefined
  return labels.at(-2)
}

function siteLabel(parentSiteUrl: string): string | undefined {
  const url = new URL(parentSiteUrl)
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  // IPv4/IPv6 literals name a machine, not an owner.
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return undefined
  const bare = host.replace(/^www\./, '')
  if (SKIP_HOSTS.has(bare)) return undefined
  if (REPO_HOSTS.has(bare)) {
    const segments = url.pathname.split('/').filter((s) => s !== '')
    let project: string | undefined = segments[1] ?? segments[0]
    if (bare === 'gitlab.com') {
      const marker = segments.indexOf('-')
      project = (marker === -1 ? segments : segments.slice(0, marker)).at(-1)
    }
    return project?.replace(/\.git$/, '')
  }
  const shared = SUBDOMAIN_HOSTS.find((s) => bare === s || bare.endsWith(`.${s}`))
  if (shared !== undefined) {
    if (bare === shared) return undefined
    const label = bare
      .slice(0, -shared.length - 1)
      .split('.')
      .at(-1)!
    // Netlify/Vercel previews and branch deploys: `deploy-preview-12--acme`.
    return label.split('--').at(-1)
  }
  return registrableLabel(bare)
}

function toCandidate(raw: string | undefined): string | undefined {
  // Punycode labels (`xn--…`) slugify to gibberish.
  if (raw === undefined || raw.startsWith('xn--')) return undefined
  const slug = generateSlug(raw).slice(0, MAX_BASE).replace(/-+$/, '')
  return slug.length >= MIN_CANDIDATE ? slug : undefined
}

/**
 * Names to try, best first: the parent site's label, then the slugified
 * title. Deduplicated; may be empty. Callers still validate each one and
 * fall back to `randomBlogName()`. Never the email: it is the private
 * recovery channel, and a name is public and permanent.
 */
export function nameCandidates(input: { parentSiteUrl?: string; title?: string }): string[] {
  const raw = [
    input.parentSiteUrl === undefined ? undefined : siteLabel(input.parentSiteUrl),
    input.title,
  ]
  const out: string[] = []
  for (const r of raw) {
    const c = toCandidate(r)
    if (c !== undefined && !out.includes(c)) out.push(c)
  }
  return out
}

/** `blog-` + 5 chars from the id alphabet (no 0/o/1/l). */
export function randomBlogName(): string {
  return `blog-${generateShortId().slice(0, 5)}`
}
