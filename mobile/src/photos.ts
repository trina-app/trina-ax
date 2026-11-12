// photo-pick-v1: the phone's own photo picker for the page's 사진 보관함 (src/protocol.ts PHOTO_PICK_CAPABILITY). Pure:
// no native imports here (the picker and the file reads are src/photo-io.ts), so the tests run it without Expo.
import { base64Size, MAX_FILE_BYTES, MAX_PICK_BYTES, MAX_PICK_FILES, pickChunkLength, pickedMime, safeFileName, TRANSFER_IDLE_MS, type PickedFile } from './protocol'
import { SheetGate } from './sheet'

/** What the system picker gave: the app's own copy (the uri never leaves the app), the name and type the picker says,
 * and the copy's size on disk. */
export interface PickedAsset { uri: string; name?: string | null; mime?: string | null; size: number }
export interface PickIO {
  /** Opens the system photo picker for at most `limit` pictures and videos; [] when the person cancelled. */
  launch(limit: number): Promise<PickedAsset[]>
  /** `length` bytes at `offset` of the app's copy, as base64. */
  read(uri: string, offset: number, length: number): Promise<string>
  /** Deletes the app's copy. */
  remove(uri: string): Promise<void>
}
/** The only photo failure the page learns by name: the phone refused access (Android's older picker may ask). */
export class PhotoRefused extends Error { constructor(readonly code: 'photo_denied') { super(code) } }
export interface Picks { files: PickedFile[]; tooBig: string[] }

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', '3gp': 'video/3gpp', webm: 'video/webm',
}
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/x-m4v': 'm4v',
  'video/quicktime': 'mov', 'video/3gpp': '3gp', 'video/webm': 'webm',
}
const extensionOf = (s: string) => /\.([A-Za-z0-9]{1,5})$/.exec(s)?.[1]?.toLowerCase()

/** A picked file's type: what the picker says when that is a picture or video type (Android: the original's, whose bytes
 * the app copied), else from the copy's or the name's extension (iOS names the copy by what it holds), else none. */
export function pickedType(a: Pick<PickedAsset, 'uri' | 'name' | 'mime'>): string | null {
  const said = a.mime?.toLowerCase()
  if (said && pickedMime(said)) return said
  const ext = extensionOf(a.uri.split(/[?#]/)[0] ?? '') ?? (a.name ? extensionOf(a.name) : undefined)
  return ext ? TYPES[ext] ?? null : null
}

/** A safe name (what safeFileName keeps as it is, so the page's check passes) whose extension fits the type: a name
 * without one, or with another (a HEIC photo iOS turned into a JPEG), gets the type's; a type this list does not know
 * (a DNG) keeps the name's own. A long name is shortened before its extension, never failed. No name: photo-1.jpg,
 * video-2.mov. */
export function pickedName(name: string | null | undefined, mime: string, index: number): string {
  const fallback = `${mime.startsWith('video/') ? 'video' : 'photo'}-${index + 1}`
  const given = (name ?? '').normalize('NFC').trim()
  const ext = extensionOf(given), want = EXTENSIONS[mime]
  const keep = ext && (!want || TYPES[ext] === mime) ? ext : want
  const tail = keep ? `.${keep}` : ''
  const stem = (ext ? given.slice(0, -(ext.length + 1)) : given)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '')
    .slice(0, 120 - tail.length)
    // no half of a character where it was cut, and no dot or space before the extension
    .replace(/[\uD800-\uDBFF]$/, '').replace(/[. ]+$/, '')
  const out = `${stem || fallback}${tail}`
  return safeFileName(out) === out ? out : `${fallback}${tail}`
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Base64 without a global btoa (React Native's engine may lack one), in blocks of 12 KiB so padding is only at the end. */
export function base64Bytes(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let start = 0; start < bytes.length; start += 0x3000) {
    const end = Math.min(start + 0x3000, bytes.length)
    let s = ''
    for (let i = start; i < end; i += 3) {
      const two = i + 1 < end, three = i + 2 < end
      const n = (bytes[i]! << 16) | ((two ? bytes[i + 1]! : 0) << 8) | (three ? bytes[i + 2]! : 0)
      s += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + (two ? ALPHABET[(n >> 6) & 63]! : '=') + (three ? ALPHABET[n & 63]! : '=')
    }
    parts.push(s)
  }
  return parts.join('')
}

interface Active {
  id: string; generation: number; nonce: string; files: (PickedFile & { uri: string })[]
  /** the next chunk the page may ask for: its number over the whole pick, its file and its byte offset */
  seq: number; index: number; offset: number
  reading: boolean; cancelled: boolean; timer: ReturnType<typeof setTimeout> | null
}
type Owner = { id: string; generation: number; nonce: string }

/** One pick at a time, bound to the document that asked (envelope id, nonce, generation). The picker opens through the
 * app's sheet gate (src/sheet.ts): not while another sheet is up, nor within 1.5 s after one closed, so a page cannot
 * reopen it without a tap. A fence (navigation, session reset, team change: `clear`) drops the pick and deletes the
 * app's copies, also when the picker answers after it. Chunks go in order, one at a time, each exactly as long as the
 * file says; anything else ends the pick. 60 seconds without a chunk ends it too. */
export class PhotoPicks {
  private active: Active | null = null
  private opening = false
  private used = new Set<string>()
  constructor(private io: PickIO, private timeout = TRANSFER_IDLE_MS, private gate = new SheetGate()) {}
  private touch(p: Active) {
    if (p.timer) clearTimeout(p.timer)
    p.timer = setTimeout(() => { void this.cancel(p) }, this.timeout)
  }
  private async drop(uris: string[]) { for (const uri of uris) await this.io.remove(uri).catch(() => {}) }
  private async cancel(p: Active) {
    p.cancelled = true
    if (p.timer) clearTimeout(p.timer)
    p.timer = null
    if (this.active === p) this.active = null
    const uris = p.files.map(f => f.uri); p.files = []
    await this.drop(uris)
  }
  private mine(m: Owner): Active {
    const p = this.active
    if (!p || p.id !== m.id || p.generation !== m.generation || p.nonce !== m.nonce) throw new Error('photo_missing')
    return p
  }
  async pick(m: Owner & { limit: number }): Promise<Picks> {
    if (this.opening || this.active || !this.gate.ready || this.used.has(m.id) || this.used.size >= 200) throw new Error('photo_busy')
    const limit = Math.min(Math.max(1, Math.floor(m.limit)), MAX_PICK_FILES)
    this.used.add(m.id)
    const p: Active = { id: m.id, generation: m.generation, nonce: m.nonce, files: [], seq: 0, index: 0, offset: 0, reading: false, cancelled: false, timer: null }
    this.active = p; this.opening = true
    let assets: PickedAsset[]
    try { assets = await this.gate.run(() => this.io.launch(limit)) } catch (error) {
      if (this.active === p) this.active = null
      throw error
    } finally { this.opening = false }
    // fenced while the picker was up: its copies go, and the answer is no one's
    if (p.cancelled || this.active !== p) { await this.drop(assets.map(a => a.uri)); throw new Error('photo_cancelled') }
    const files: Active['files'] = [], tooBig: string[] = [], dropped: string[] = []
    let total = 0
    for (const [i, a] of assets.entries()) {
      const mime = pickedType(a)
      if (!mime || files.length >= limit || !Number.isSafeInteger(a.size) || a.size < 1) { dropped.push(a.uri); continue }
      const name = pickedName(a.name, mime, i)
      if (a.size > MAX_FILE_BYTES || total + a.size > MAX_PICK_BYTES) {
        if (tooBig.length < MAX_PICK_FILES) tooBig.push(name)
        dropped.push(a.uri); continue
      }
      total += a.size; files.push({ name, mime, size: a.size, uri: a.uri })
    }
    await this.drop(dropped)
    if (p.cancelled || this.active !== p) { await this.drop(files.map(f => f.uri)); throw new Error('photo_cancelled') }
    p.files = files
    if (!files.length) this.active = null
    else this.touch(p)
    return { files: files.map(({ name, mime, size }) => ({ name, mime, size })), tooBig }
  }
  /** The next chunk, base64: exactly `pickChunkLength(size, offset)` bytes of file `index`. */
  async chunk(m: Owner & { seq: number; index: number; offset: number }): Promise<string> {
    const p = this.mine(m)
    const file = p.files[p.index]
    if (p.reading || !file || m.seq !== p.seq || m.index !== p.index || m.offset !== p.offset) { await this.cancel(p); throw new Error('photo_sequence') }
    const length = pickChunkLength(file.size, p.offset)
    p.reading = true; this.touch(p)
    try {
      const b64 = await this.io.read(file.uri, p.offset, length)
      if (p.cancelled || this.active !== p) throw new Error('photo_cancelled')
      // the copy changed under the app: no short or long chunk reaches the page
      if (base64Size(b64) !== length) throw new Error('photo_size')
      p.seq++; p.offset += length
      if (p.offset >= file.size) { p.index++; p.offset = 0 }
      return b64
    } catch (error) {
      await this.cancel(p)
      throw error
    } finally { p.reading = false }
  }
  /** The page has the bytes, or gave up: the app's copies go. */
  async done(m: Owner): Promise<void> { await this.cancel(this.mine(m)) }
  /** A fence: the pick goes, and the ids this document used are forgotten with it. */
  async clear(): Promise<void> {
    const p = this.active
    if (p) await this.cancel(p)
    this.used.clear()
  }
  /** The picker is on screen, or a pick waits for its chunks. */
  get busy(): boolean { return this.opening || !!this.active }
}
