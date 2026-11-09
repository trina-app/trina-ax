// The team's logo (Admin › Team settings; docs/DECISIONS.md "Team logo as the tab icon", changed 2026-11-07): it shows
// only inside the page, in the computer's sidebar header. The tab icon, /favicon.ico, the home-screen icon and the
// installed app's manifest are always the product's. Pure code shared by the server (validation, the public
// /team-icon route), the web app (a check before uploading, the sidebar's address) and the web client's mock server.
//
// Only raster images whose header can be read here: PNG, JPEG and WebP. Never SVG: an SVG served from the team's own
// address can run scripts. The type the uploader names must match the file's first bytes, and the pixel size comes
// from the header (no image library: the file is served as uploaded and browsers scale it).

export const TEAM_ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type TeamIconType = (typeof TEAM_ICON_TYPES)[number]
export const TEAM_ICON_MAX_BYTES = 1024 * 1024
export const TEAM_ICON_MIN_PX = 32
export const TEAM_ICON_MAX_PX = 4096
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
