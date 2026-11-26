// file_upload's files on this computer (docs/decisions/20261126-browser-file-upload.md). The page gets a file the way a
// person's pick gives it: a path on disk (DOM.setFileInputFiles / a drop), which the browser reads when the page
// uploads it, also after the AI's call (a web mail uploads on Send). So each file is written to
// <app data folder>/<product>-up/<callId>/<i>/<clean name> (folders 0700, files 0600; not the shared /tmp of Linux) and kept while the page may still read it:
// it goes when its tab closes or moves to another site, the person signed in changes, the app quits or starts again,
// and the oldest calls go when they hold more than KEEP_BYTES together.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** temp files of all calls together at most (the oldest calls go first; the running call stays) */
export const KEEP_BYTES = 500 * 1024 * 1024
/** the longest file name kept (characters), its extension included */
export const NAME_MAX = 120

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/**
 * A file name that is safe on every computer and still reads as the original: NFC, no path parts or characters
 * Windows refuses (\ / : * ? " < > | and control characters), no reserved device name (CON, NUL, COM1 ...), no trailing
 * dots or spaces, at most NAME_MAX characters with the extension kept. Never empty ("file").
 */
export function cleanUploadName(raw: string): string {
  let n = String(raw ?? '').normalize('NFC')
  n = n.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').replace(/[​-‏‪-‮⁦-⁩]/g, '')
  n = n.trim().replace(/[. ]+$/, '')
  n = n.replace(/^\.+/, (d) => '_'.repeat(d.length))
  if (!n) n = 'file'
  if (WINDOWS_RESERVED.test(n)) n = `_${n}`
  const chars = Array.from(n)
  if (chars.length > NAME_MAX) {
    const dot = n.lastIndexOf('.')
    const ext = dot > 0 ? Array.from(n.slice(dot)) : []
    const keepExt = ext.length > 0 && ext.length <= 16 ? ext : []
    n = chars.slice(0, NAME_MAX - keepExt.length).join('').replace(/[. ]+$/, '') + keepExt.join('')
  }
  return n || 'file'
}

/** The folder all calls' files go in. */
export const uploadRoot = (tempDir: string, product: string) => path.join(tempDir, `${product.replace(/[^A-Za-z0-9_-]/g, '') || 'app'}-up`)

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100) || 'call'

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

interface CallFiles { dir: string; tabId: string; bytes: number; at: number }

/** The temp files of every file_upload call, by the tab they went to. */
export class UploadTemp {
  private calls = new Map<string, CallFiles>()

  constructor(readonly root: string, private keepBytes = KEEP_BYTES) {}

  /** Bytes kept now (tests). */
  get bytes(): number { let n = 0; for (const c of this.calls.values()) n += c.bytes; return n }
  /** Call folders kept now (tests). */
  get dirs(): string[] { return [...this.calls.values()].map((c) => c.dir) }

  /** At start: whatever an earlier run left (it crashed, or quit before its cleanup). */
  sweep(): void {
    this.calls.clear()
    try { fs.rmSync(this.root, { recursive: true, force: true }) } catch { /* in use or gone: the next start tries again */ }
  }

  /** Write one call's files; returns their paths in order. A failure removes what this call wrote. */
  write(callId: string, tabId: string, files: readonly { name: string; bytes: Uint8Array }[]): string[] {
    const dir = path.join(this.root, safeId(callId))
    this.dropDir(dir)
    const out: string[] = []
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
      ownRoot(this.root)
      fs.mkdirSync(dir, { mode: 0o700 })
      files.forEach((f, i) => {
        const sub = path.join(dir, String(i))
        fs.mkdirSync(sub, { mode: 0o700 })
        const p = path.join(sub, cleanUploadName(f.name))
        fs.writeFileSync(p, f.bytes, { mode: 0o600, flag: 'wx' })
        out.push(p)
      })
    } catch (e) {
      this.dropDir(dir)
      throw e
    }
    this.calls.set(dir, { dir, tabId, bytes: files.reduce((n, f) => n + f.bytes.length, 0), at: Date.now() })
    this.trim(dir)
    return out
  }

  /** The tab closed or moved to another site: the page cannot read its files any more. */
  dropTab(tabId: string): void {
    for (const c of [...this.calls.values()]) if (c.tabId === tabId) this.dropDir(c.dir)
  }

  /** A call that attached nothing (the field refused, the page moved): its files go at once. */
  dropCall(callId: string): void {
    this.dropDir(path.join(this.root, safeId(callId)))
  }

  /** The person changed, the app quits: every file goes. */
  dropAll(): void {
    for (const c of [...this.calls.values()]) this.dropDir(c.dir)
  }

  /** Over keepBytes: the oldest calls go (never `keep`, the call just written). */
  private trim(keep: string) {
    const old = [...this.calls.values()].filter((c) => c.dir !== keep).sort((a, b) => a.at - b.at)
    while (this.bytes > this.keepBytes && old.length) this.dropDir(old.shift()!.dir)
  }

  private dropDir(dir: string) {
    this.calls.delete(dir)
    // only a folder of our own root (never anything a bad id could point at)
    if (path.dirname(dir) !== this.root) return
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* swept at the next start */ }
  }
}

/**
 * The root is a real folder of this user's, 0700 (it lives in the app's data folder; checked anyway: a folder someone
 * else made, or a link, would let another account read or swap the files). Throws otherwise.
 */
export function ownRoot(root: string): void {
  const st = fs.lstatSync(root)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('the upload folder is not a folder')
  if (process.platform === 'win32') return
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('the upload folder belongs to another account')
  if ((st.mode & 0o077) !== 0) fs.chmodSync(root, 0o700)
}

export type UploadHow = 'input' | 'chooser' | 'drop'

/**
 * The order file_upload tries (auto: the file field behind the ref, else the picker its click opens, else a drop on
 * it), or the one way asked for.
 */
export function uploadOrder(how: 'auto' | UploadHow | undefined): UploadHow[] {
  return how && how !== 'auto' ? [how] : ['input', 'chooser', 'drop']
}
