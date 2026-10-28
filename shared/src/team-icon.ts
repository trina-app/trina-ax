// The team's logo as the tab icon (Admin › Team settings; docs/DECISIONS.md "팀 로고"). Pure code shared by the server
// (validation, the public /team-icon route, the icon links in index.html), the web app (the links after sign-in, a
// check before uploading) and the web client's mock server.
//
// Only raster images whose header can be read here: PNG, JPEG and WebP. Never SVG: an SVG served from the team's own
// address can run scripts. The type the uploader names must match the file's first bytes, and the pixel size comes
// from the header (no image library: the file is served as uploaded and browsers scale it).

export const TEAM_ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type TeamIconType = (typeof TEAM_ICON_TYPES)[number]
export const TEAM_ICON_MAX_BYTES = 1024 * 1024
export const TEAM_ICON_MIN_PX = 32
export const TEAM_ICON_MAX_PX = 4096
/** what the hint recommends (the home-screen icon of iPhones is 180 × 180) */
export const TEAM_ICON_RECOMMENDED_PX = 180
/** the public route: the logo, or the default icon when none is set */
export const TEAM_ICON_PATH = '/team-icon'
/** the version is the start of the file's SHA-256 (hex) */
export const TEAM_ICON_VERSION_RE = /^[0-9a-f]{16}$/

/** A stored logo as the server (or the mock) serves it. */
export interface TeamIconFile { bytes: Uint8Array<ArrayBuffer>; type: TeamIconType; width: number; height: number; version: string }

export const isTeamIconType = (t: unknown): t is TeamIconType => typeof t === 'string' && (TEAM_ICON_TYPES as readonly string[]).includes(t)

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const ascii = (b: Uint8Array, i: number, s: string) => {
  if (i + s.length > b.length) return false
  for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false
  return true
}

function png(b: Uint8Array): { width: number; height: number } | null {
  // signature, then the IHDR chunk first: length 13, "IHDR", width, height (big-endian)
  if (b.length < 33 || !ascii(b, 0, '\x89PNG\r\n\x1a\n') || u32be(b, 8) !== 13 || !ascii(b, 12, 'IHDR')) return null
  return { width: u32be(b, 16), height: u32be(b, 20) }
}

// JPEG frame headers (SOF0–SOF15 except DHT C4, JPG C8, DAC CC) carry the size
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
function jpeg(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null
  let i = 2
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null
    while (b[i] === 0xff && i < b.length) i++ // fill bytes
    const m = b[i++]!
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue // markers without a length
    if (m === 0xd9 || m === 0xda) return null // end of image or start of scan before any frame header
    if (i + 2 > b.length) return null
    const len = u16be(b, i)
    if (len < 2) return null
    if (SOF.has(m)) {
      if (len < 7 || i + 7 > b.length) return null
      return { height: u16be(b, i + 3), width: u16be(b, i + 5) }
    }
    i += len
  }
  return null
}

function webp(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null
  if (ascii(b, 12, 'VP8X')) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  if (ascii(b, 12, 'VP8 ')) {
    // lossy: frame tag (3 bytes), start code 9d 01 2a, then 14-bit width and height
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { width: ((b[26]! | (b[27]! << 8)) & 0x3fff), height: ((b[28]! | (b[29]! << 8)) & 0x3fff) }
  }
  if (ascii(b, 12, 'VP8L')) {
    // lossless: signature 0x2f, then width-1 and height-1 in 14 bits each
    if (b[20] !== 0x2f) return null
    const x = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
    return { width: (x & 0x3fff) + 1, height: ((x >>> 14) & 0x3fff) + 1 }
  }
  return null
}

/** The type and pixel size of a PNG, JPEG or WebP from its first bytes; null for anything else (SVG, GIF, HTML…). */
export function imageInfo(b: Uint8Array): { type: TeamIconType; width: number; height: number } | null {
  const p = png(b)
  if (p) return { type: 'image/png', ...p }
  const j = jpeg(b)
  if (j) return { type: 'image/jpeg', ...j }
  const w = webp(b)
  if (w) return { type: 'image/webp', ...w }
  return null
}

/** Why a logo is refused (the server and the web put each into words). */
export type TeamIconProblem = 'type' | 'mismatch' | 'too_big' | 'too_small' | 'too_large'

/**
 * Check an upload: `declared` is the type the uploader names (the browser's file type). Refused: a type other than
 * PNG / JPEG / WebP (SVG included), first bytes that are not that type, more than 1 MiB, under 32 × 32 or over
 * 4096 × 4096 pixels (either side).
 */
export function checkTeamIcon(b: Uint8Array, declared: string): { ok: true; type: TeamIconType; width: number; height: number } | { ok: false; problem: TeamIconProblem } {
  const type = declared.split(';')[0]!.trim().toLowerCase()
  if (!isTeamIconType(type)) return { ok: false, problem: 'type' }
  if (b.byteLength > TEAM_ICON_MAX_BYTES) return { ok: false, problem: 'too_big' }
  const info = imageInfo(b)
  if (!info || info.type !== type) return { ok: false, problem: 'mismatch' }
  if (info.width < TEAM_ICON_MIN_PX || info.height < TEAM_ICON_MIN_PX) return { ok: false, problem: 'too_small' }
  if (info.width > TEAM_ICON_MAX_PX || info.height > TEAM_ICON_MAX_PX) return { ok: false, problem: 'too_large' }
  return { ok: true, ...info }
}

/** The address of the logo at a version (the long-cached form). */
export const teamIconUrl = (version: string) => `${TEAM_ICON_PATH}?v=${encodeURIComponent(version)}`

export interface IconLink { rel: 'icon' | 'apple-touch-icon'; href: string; type?: string; sizes?: string }

/**
 * The icon links of the app shell. Without a logo: the default mark (PNG sizes for browsers without SVG icons, the
 * SVG last for those that take it, the home-screen icon). With one: the logo for all of them (browsers scale it).
 * web/index.html carries the default block between ICON_LINKS_START and ICON_LINKS_END (a test keeps them equal);
 * the server swaps the block when a logo is set, the web app swaps the links after sign-in.
 */
export function iconLinks(version: string | null): IconLink[] {
  if (version) {
    const href = teamIconUrl(version)
    return [{ rel: 'icon', href }, { rel: 'apple-touch-icon', href }]
  }
  return [
    { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/icons/favicon-16.png' },
    { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/icons/favicon-32.png' },
    { rel: 'icon', type: 'image/png', sizes: '48x48', href: '/icons/favicon-48.png' },
    { rel: 'icon', type: 'image/svg+xml', sizes: 'any', href: '/favicon.svg' },
    { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
  ]
}

export const ICON_LINKS_START = '<!-- icons -->'
export const ICON_LINKS_END = '<!-- /icons -->'

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
/** The links as the HTML lines of web/index.html (4-space indent, one per line). */
export function iconLinksHtml(links: IconLink[], indent = '    '): string {
  return links
    .map((l) => `${indent}<link rel="${l.rel}"${l.type ? ` type="${attr(l.type)}"` : ''}${l.sizes ? ` sizes="${attr(l.sizes)}"` : ''} href="${attr(l.href)}" />`)
    .join('\n')
}

/** index.html with the block between the markers replaced by these links (unchanged when the markers are missing). */
export function withIconLinks(html: string, links: IconLink[]): string {
  const a = html.indexOf(ICON_LINKS_START)
  const z = html.indexOf(ICON_LINKS_END, a)
  if (a < 0 || z < 0) return html
  const indent = /([ \t]*)$/.exec(html.slice(0, a))?.[1] ?? '    '
  return `${html.slice(0, a)}${ICON_LINKS_START}\n${iconLinksHtml(links, indent)}\n${indent}${html.slice(z)}`
}

/** The PWA manifest with the logo as its only icon (an installed app shows it); `manifest` is the built one. */
export function manifestWithIcon(manifest: string, icon: Pick<TeamIconFile, 'type' | 'width' | 'height' | 'version'>): string {
  const m = JSON.parse(manifest) as Record<string, unknown>
  m.icons = [{ src: teamIconUrl(icon.version), sizes: `${icon.width}x${icon.height}`, type: icon.type, purpose: 'any' }]
  return JSON.stringify(m, null, 2)
}
