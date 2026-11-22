// Thumbnails of room pictures kept in the team folder (rooms/file-refs.ts: a computer upload in a project's room or a
// department's group channel, a team file picked in a project room, a conversation's file moved when it became a
// project). Such a file has no thumbnail of its own (its bytes are the team file's now and may change), so the room's
// `?thumb=1` (rooms/files.ts openThumb) asks here, always after the read checks ran for the viewer:
//   - a thumbnail made like a room photo's (uploads/image.ts makeThumbnail, 640 px: a GIF's first frame, a picture with
//     see-through pixels as PNG, a HEIC through the HEIC converter when this server has one), from a copy read through
//     one descriptor bound to the inode the check saw (no swap between the check and the read), kept in
//     <data dir>/room-team-thumbs/<room file id>/<dev>-<ino>-<size>-<mtime>.<jpg|png> (0700 / 0600) and made again when
//     the file changes (another key; the older one goes);
//   - when none could be made: the picture itself only when it is a small web image (≤ 2 MB PNG, JPEG, GIF, WebP), as
//     before; never a large original.
// The cache holds bytes of a team file, outside the team folder: it is read only through openThumb after the checks,
// and goes with its room file row (rooms/files.ts afterDelete).
import fs from 'node:fs'
import path from 'node:path'
import { SMALL_UPLOAD_MAX } from '@mycel/shared/api'
import { nativeBinDir, which } from '../config'
import { ext } from '../files/extract'
import { heicTools } from '../files/heic-preview'
import { openChecked } from '../team-files/place'
import { makeWorkDir } from '../tools/isolate'
import { makeThumbnail, type ThumbExt } from '../uploads/image'
import { CONVERT_RSS_MIB } from '../files/vision'

export const TEAM_THUMBS_DIR = 'room-team-thumbs'
/** a web image this small may be shown as it is when no thumbnail could be made (the chats' team file references' rule) */
export const SMALL_ORIGINAL_MAX = 2 * 1024 * 1024
/** the largest team file a thumbnail is made of (a room photo's limit) */
export const TEAM_THUMB_INPUT_MAX = SMALL_UPLOAD_MAX
/** the thumbnail's longest side, as a room photo's */
const THUMB_PX = 640
/** thumbnails made at once (each an isolated converter) */
const MAKING_MAX = 2

const WEB = /^(png|jpe?g|gif|webp)$/
const FFMPEG_READS = /^(png|jpe?g|gif|webp|bmp)$/
const HEIC = /^(heic|heif)$/
const ID = /^[0-9a-f-]{36}$/i

/** A small web image that may be its own thumbnail. */
export const smallWebImage = (name: string, size: number): boolean => WEB.test(ext(name)) && size <= SMALL_ORIGINAL_MAX

let tools: { at: number; ffmpeg: boolean; heic: boolean } | null = null
/** what this server can convert now (looked up at most once a minute: a list shows many files) */
function convert(): { ffmpeg: boolean; heic: boolean } {
  if (!tools || Date.now() - tools.at > 60_000) {
    const h = heicTools()
    tools = { at: Date.now(), ffmpeg: !!which('ffmpeg'), heic: !!(h.heifDec || h.imageIo) && fs.existsSync(path.join(nativeBinDir(), 'mycel-safeops')) }
  }
  return tools
}
/** for tests: forget what was looked up */
export function resetConvertTools(t?: { ffmpeg: boolean; heic: boolean }) { tools = t ? { at: Date.now() + 3600_000, ...t } : null }

/** Can a picture of this name and size have a preview here (RoomFile.thumb)? A web image or BMP when ffmpeg is here
 * (a small web image also without it), a HEIC when the HEIC converter is; SVG, TIFF and anything else: no (rooms make
 * no thumbnail of them either). */
export function teamThumbPossible(name: string, size: number): boolean {
  if (size > TEAM_THUMB_INPUT_MAX) return false
  const e = ext(name)
  if (smallWebImage(name, size)) return true
  if (FFMPEG_READS.test(e)) return convert().ffmpeg
  if (HEIC.test(e)) return convert().heic
  return false
}

/** The file as it is now, for the cache's name: another write, a replacement or a move to another disk is another key.
 * The change time is in it too: a write that puts the modification time back (touch -r, a sync tool) still moves it. */
export const thumbKey = (st: Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>): string => `${st.dev}-${st.ino}-${st.size}-${Math.trunc(st.mtimeMs)}-${Math.trunc(st.ctimeMs)}`
/** requests that may wait for a converter; more get no thumbnail now (the picture asks again on its next show) */
export const WAITING_MAX = 20
/** the converter's memory cap for one thumbnail (the image converters' own, files/vision.ts) */
const THUMB_RSS_MIB = CONVERT_RSS_MIB

export class TeamThumbs {
  private making = new Map<string, Promise<{ abs: string; ext: ThumbExt } | null>>()
  private running = 0
  private waiting: (() => void)[] = []
  constructor(private dataDir: string, private log?: { debug: (msg: string, o?: Record<string, unknown>) => void }) {}

  root() { return path.join(this.dataDir, TEAM_THUMBS_DIR) }
  private dir(fileId: string) {
    if (!ID.test(fileId)) throw new Error('not a room file id')
    return path.join(this.root(), fileId)
  }

  /** No thumbnail could be made of this version of the file (`<key>.none`): not tried again until the file changes. */
  failed(fileId: string, key: string): boolean {
    try { return fs.lstatSync(path.join(this.dir(fileId), `${key}.none`)).isFile() } catch { return false }
  }

  /** the thumbnail kept for this version of the file, or null */
  cached(fileId: string, key: string): { abs: string; ext: ThumbExt } | null {
    for (const e of ['png', 'jpg'] as const) {
      const abs = path.join(this.dir(fileId), `${key}.${e}`)
      try { const st = fs.lstatSync(abs); if (st.isFile() && st.nlink === 1) return { abs, ext: e } } catch { /* the next */ }
    }
    return null
  }

  /** A thumbnail of the team file at `abs`, which the caller's check saw as `seen` (and the viewer may read now). Read
   * through one descriptor that must be that very file (openChecked: no link, the same inode); null when it is not, is
   * too large, or no thumbnail could be made. */
  async make(fileId: string, abs: string, seen: fs.Stats): Promise<{ abs: string; ext: ThumbExt } | null> {
    const key = thumbKey(seen)
    const have = this.cached(fileId, key)
    if (have) return have
    if (this.failed(fileId, key)) return null
    const k = `${fileId}/${key}`
    const going = this.making.get(k)
    if (going) return going
    // too many waiting already: none now (not remembered as failed)
    if (this.running >= MAKING_MAX && this.waiting.length >= WAITING_MAX) return null
    const p = (async () => {
      await this.slot()
      try { return await this.build(fileId, key, abs, seen) } finally { this.release(); this.making.delete(k) }
    })()
    this.making.set(k, p)
    return p
  }

  private async build(fileId: string, key: string, abs: string, seen: fs.Stats): Promise<{ abs: string; ext: ThumbExt } | null> {
    if (seen.size > TEAM_THUMB_INPUT_MAX) return null
    const workBase = path.join(this.dataDir, 'work')
    const work = makeWorkDir(workBase)
    try {
      // the bytes of the very file the check saw, copied through its descriptor
      let opened: { fd: number; st: fs.Stats }
      try { opened = openChecked(abs, seen) } catch { return null }
      const input = path.join(work, `in.${ext(abs).replace(/[^a-z0-9]/g, '') || 'img'}`)
      try {
        const st = opened.st
        if (st.ino !== seen.ino || st.dev !== seen.dev || st.size !== seen.size || st.size > TEAM_THUMB_INPUT_MAX) return null
        const out = fs.openSync(input, 'wx', 0o600)
        try {
          const buf = Buffer.alloc(1024 * 1024)
          let pos = 0
          while (pos < st.size) {
            const n = fs.readSync(opened.fd, buf, 0, Math.min(buf.length, st.size - pos), pos)
            if (!n) break
            fs.writeSync(out, buf, 0, n)
            pos += n
          }
        } finally { fs.closeSync(out) }
      } finally { fs.closeSync(opened.fd) }
      const dir = this.dir(fileId)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      let made: ThumbExt | null = null
      try { made = await makeThumbnail(input, path.join(dir, key), THUMB_PX, workBase, undefined, { maxRssMiB: THUMB_RSS_MIB }) } catch (e) { this.log?.debug('team picture thumbnail failed', { err: e }) }
      // none could be made of this version: remembered, so the next show does not run the converter again
      if (!made) fs.writeFileSync(path.join(dir, `${key}.none`), '', { mode: 0o600 })
      // what was kept for older versions of the file goes
      for (const n of fs.readdirSync(dir)) if (!n.startsWith(`${key}.`)) fs.rmSync(path.join(dir, n), { force: true })
      return made ? { abs: path.join(dir, `${key}.${made}`), ext: made } : null
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }

  /** the room file row went: its thumbnails go */
  remove(fileId: string) { try { fs.rmSync(this.dir(fileId), { recursive: true, force: true }) } catch { /* not an id: nothing kept */ } }

  /** At start: the folders of room files that have no row any more (a delete that stopped half way, a restored
   * database) go. `live`: does this room file id still have a row kept in the team folder. */
  prune(live: (fileId: string) => boolean): number {
    let n = 0
    let names: string[]
    try { names = fs.readdirSync(this.root()) } catch { return 0 }
    for (const id of names) {
      if (ID.test(id) && live(id)) continue
      try { fs.rmSync(path.join(this.root(), id), { recursive: true, force: true }); n++ } catch { /* the next start */ }
    }
    return n
  }

  private slot(): Promise<void> {
    if (this.running < MAKING_MAX) { this.running++; return Promise.resolve() }
    return new Promise((r) => this.waiting.push(() => { this.running++; r() }))
  }
  private release() { this.running--; this.waiting.shift()?.() }
}
