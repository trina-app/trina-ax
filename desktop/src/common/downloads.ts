// Where a download of the team page goes in the desktop app: straight into the computer's Downloads folder, with no
// save window (main/app-window.ts, docs/decisions/20261117-desktop-direct-downloads.md). The file's name comes from the
// team server or the page (a header, an <a download>): it is not trusted. Pure: unit-tested in
// tests/unit/e-desktop-downloads.test.ts.
import * as nodePath from 'node:path'

/** Only the path functions used here, so a test can pick Windows' or the Mac's rules on any computer. */
export type PathRules = Pick<typeof nodePath, 'join' | 'resolve' | 'dirname' | 'basename'>

/** The name when nothing usable is left of the one given. */
export const DOWNLOAD_FALLBACK_NAME = 'download'
/** A name's longest length in UTF-8 bytes: file systems stop at 255, and " (99)" still has to fit. */
export const DOWNLOAD_NAME_MAX_BYTES = 200
/** "name (1).ext" … "name (999).ext", then a name with the time in it. */
const MAX_NUMBERED = 999

/** Names Windows keeps for devices, with or without an extension ("CON", "nul.txt", "COM1.pdf"). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

/** The extension as people read it: the last dot and what follows, when short and not the whole name. */
function splitExt(name: string): [stem: string, ext: string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || name.length - dot > 16) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

/** Cut to at most `max` UTF-8 bytes without splitting a character. */
function cutBytes(s: string, max: number): string {
  let out = ''
  let used = 0
  for (const ch of s) {
    const b = bytes(ch)
    if (used + b > max) break
    out += ch
    used += b
  }
  return out
}

/**
 * A file name that is safe in one folder on a Mac and on Windows: the last part only (no folders, either slash), no
 * control characters, none of the characters Windows refuses, no leading dots or spaces (no "..", no hidden file), no
 * trailing dots or spaces, no device name, and not too long (the extension is kept). Never empty.
 */
export function safeDownloadName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw.normalize('NFC') : ''
  // the last part: a name may carry a path with either slash ("..\\..\\x", "/etc/passwd", "C:\\x")
  name = name.split(/[\\/]/).pop() ?? ''
  name = name
    // control characters, and the marks that turn text around (a name that reads "…fdp.exe" as "…exe.pdf")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (WINDOWS_DEVICE.test(name)) name = `_${name}`
  if (bytes(name) > DOWNLOAD_NAME_MAX_BYTES) {
    const [stem, ext] = splitExt(name)
    name = cutBytes(stem, DOWNLOAD_NAME_MAX_BYTES - bytes(ext)).replace(/[.\s]+$/, '') + ext
  }
  return name || DOWNLOAD_FALLBACK_NAME
}

/**
 * The path a download is saved at: `dir` + the cleaned name, or "name (1).ext", "name (2).ext" … when `taken` says a
 * path is in use (a file there, or another download on its way to it). A file that is there is never replaced. The
 * result is always directly inside `dir`: null when it would not be (it cannot happen with a cleaned name; the caller
 * then keeps the save window).
 */
export function pickDownloadPath(dir: string, raw: unknown, taken: (path: string) => boolean, o: { path?: PathRules; now?: () => number } = {}): string | null {
  const p = o.path ?? nodePath
  const root = p.resolve(dir)
  const inside = (file: string) => {
    const full = p.resolve(root, file)
    return p.dirname(full) === root && p.basename(full) === file ? full : null
  }
  const name = safeDownloadName(raw)
  const [stem, ext] = splitExt(name)
  for (let n = 0; n <= MAX_NUMBERED; n++) {
    const full = inside(n === 0 ? name : `${stem} (${n})${ext}`)
    if (!full) return null
    if (!taken(full)) return full
  }
  const full = inside(`${stem} (${(o.now ?? Date.now)()})${ext}`)
  return full && !taken(full) ? full : null
}

/** How a download ended, for the page's notice: 'cancelled' says nothing. */
export function downloadOutcome(state: string): 'saved' | 'failed' | null {
  return state === 'completed' ? 'saved' : state === 'cancelled' ? null : 'failed'
}
