// Thumbnails of pictures with transparency (docs/DECISIONS.md "Transparent pictures keep their transparency in
// thumbnails"): a PNG, WebP or GIF with see-through pixels gets a PNG thumbnail (a JPEG one painted them black: a red
// seal stamp on a black square), every other picture keeps its JPEG one. JPEG thumbnails made before are still served,
// and those of transparent pictures are made again once, in rooms and in chat attachments. The ffmpeg parts are skipped
// where there is no ffmpeg.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { which } from '../../server/src/config'
import { imageSize, makeThumbnail, mayHaveAlpha } from '../../server/src/uploads/image'
import { componentC } from '../../server/src/team-files/component'
import { roomFilesOf, THUMBS_REFRESHED_SETTING as ROOMS_DONE } from '../../server/src/rooms/files'
import { THUMBS_REFRESHED_SETTING as ATTACHMENTS_DONE } from '../../server/src/uploads/attachments'
import { makeCApp, type CApp } from '../lib/c-app'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)
const ffmpeg = which('ffmpeg')
const PHOTO = fs.readFileSync(path.join(import.meta.dir, '../fixtures/exif/portrait-o6.jpg'))
/** bytes that pass for a JPEG thumbnail (only its first bytes are looked at when served) */
const OLD_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])

// ---- PNGs made by hand: 8-bit rows, no filter
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(name: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(name, 'latin1'), data])
  const out = Buffer.alloc(4 + body.length + 4)
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** colour type 6 (RGBA) or 2 (RGB, the first 3 values of each pixel); `extra`: chunks before the picture */
function png(w: number, h: number, px: (x: number, y: number) => number[], o: { rgb?: boolean; extra?: Buffer[] } = {}): Buffer {
  const ch = o.rgb ? 3 : 4
  const raw = Buffer.alloc((w * ch + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y).slice(0, ch), y * (w * ch + 1) + 1 + x * ch)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = o.rgb ? 2 : 6
  return Buffer.concat([SIG, chunk('IHDR', ihdr), ...(o.extra ?? []), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const RED = [210, 30, 30, 255]
/** a red seal stamp on a see-through square: a ring and a block, the corners and the space between see-through */
const seal = (w = 800, h = 600) => png(w, h, (x, y) => {
  const d = Math.hypot(x - w / 2, y - h / 2)
  return (d < h * 0.45 && d > h * 0.35) || (Math.abs(x - w / 2) < 60 && Math.abs(y - h / 2) < 40) ? RED : [0, 0, 0, 0]
})
const opaque = (w = 400, h = 300) => png(w, h, () => [40, 90, 200, 255])
/** A PNG's top-left pixel (8-bit RGBA): the first pixel of the first row is stored as it is under every row filter. */
function corner(b: Uint8Array): number[] {
  const v = Buffer.from(b)
  expect([...v.subarray(0, 8)]).toEqual([...SIG])
  const idat: Buffer[] = []
  let type = -1
  for (let i = 8; i + 12 <= v.length;) {
    const len = v.readUInt32BE(i), name = v.toString('latin1', i + 4, i + 8)
    if (name === 'IHDR') type = v[i + 8 + 9]!
    if (name === 'IDAT') idat.push(v.subarray(i + 8, i + 8 + len))
    i += 12 + len
  }
  expect(type).toBe(6)
  return [...zlib.inflateSync(Buffer.concat(idat)).subarray(1, 5)]
}
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

describe('which pictures can be see-through, by their first bytes', () => {
  const webp = (fourcc: string, at: number, bit: number) => {
    const b = new Uint8Array(30)
    b.set(Buffer.from('RIFF'), 0); b.set(Buffer.from('WEBP'), 8); b.set(Buffer.from(fourcc), 12)
    b[at] = bit
    return b
  }
  test('PNG with an alpha channel or tRNS, WebP with alpha, GIF: yes; anything else: no', () => {
    expect(mayHaveAlpha(seal(8, 6))).toBe(true)
    expect(mayHaveAlpha(opaque(8, 6))).toBe(true) // an alpha channel: the pixels decide (makeThumbnail)
    expect(mayHaveAlpha(png(8, 6, () => RED, { rgb: true }))).toBe(false)
    expect(mayHaveAlpha(png(8, 6, () => RED, { rgb: true, extra: [chunk('tRNS', Buffer.from([0, 0, 0, 255, 0, 0]))] }))).toBe(true)
    const grey = png(8, 6, () => RED, { rgb: true }); grey[25] = 4
    expect(mayHaveAlpha(grey)).toBe(true)
    expect(mayHaveAlpha(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0]))).toBe(true)
    expect(mayHaveAlpha(webp('VP8X', 20, 0x10))).toBe(true)
    expect(mayHaveAlpha(webp('VP8X', 20, 0x20))).toBe(false)
    expect(mayHaveAlpha(webp('VP8L', 24, 0x10))).toBe(true)
    expect(mayHaveAlpha(webp('VP8L', 24, 0x0f))).toBe(false)
    expect(mayHaveAlpha(webp('VP8 ', 20, 0xff))).toBe(false)
    expect(mayHaveAlpha(PHOTO)).toBe(false)
    expect(mayHaveAlpha(new Uint8Array(0))).toBe(false)
    // a PNG whose chunks before the picture run past the bytes read: ffmpeg's look decides
    expect(mayHaveAlpha(png(8, 6, () => RED, { rgb: true }).subarray(0, 36))).toBe(true)
  })
})

describe('makeThumbnail', () => {
  let dir: string
  beforeAll(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'thumbs-')) })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
  /** an input, in a folder of its own (a thumbnail's name never meets it) */
  const file = (name: string, b: Uint8Array) => { fs.mkdirSync(path.join(dir, 'in'), { recursive: true }); const p = path.join(dir, 'in', name); fs.writeFileSync(p, b); return p }

  test.skipIf(!ffmpeg)('a PNG with see-through pixels gets a PNG thumbnail that keeps them', async () => {
    const base = path.join(dir, 'out', 'seal')
    expect(await makeThumbnail(file('seal.png', seal()), base, 640, path.join(dir, 'work'))).toBe('png')
    expect(fs.existsSync(`${base}.jpg`)).toBe(false)
    const b = fs.readFileSync(`${base}.png`)
    expect(imageSize(b)).toEqual({ width: 640, height: 480 })
    expect(corner(b)[3]).toBe(0)
    expect(fs.statSync(`${base}.png`).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.join(dir, 'out'))).toEqual(['seal.png']) // no temporary file left
  })
  test.skipIf(!ffmpeg)('a JPEG, and a PNG whose alpha channel has nothing see-through, keep JPEG thumbnails', async () => {
    const photo = path.join(dir, 'photo')
    expect(await makeThumbnail(file('photo.jpg', PHOTO), photo, 320, path.join(dir, 'work'))).toBe('jpg')
    expect(isJpeg(fs.readFileSync(`${photo}.jpg`))).toBe(true)
    const shot = path.join(dir, 'shot')
    expect(await makeThumbnail(file('shot.png', opaque()), shot, 320, path.join(dir, 'work'))).toBe('jpg')
    expect(fs.existsSync(`${shot}.png`)).toBe(false)
    // transparentOnly (the refresh of old ones): nothing for either
    for (const [name, b] of [['photo2.jpg', PHOTO], ['shot2.png', opaque()]] as const) {
      const base = path.join(dir, 'only-' + name)
      expect(await makeThumbnail(file(name, b), base, 320, path.join(dir, 'work'), undefined, { transparentOnly: true })).toBeNull()
      expect(fs.existsSync(`${base}.jpg`) || fs.existsSync(`${base}.png`)).toBe(false)
    }
  })
})

describe('rooms', () => {
  let h: Harness
  afterAll(async () => { await h?.close() })

  test('a transparent picture\'s thumbnail is a PNG; old JPEG ones are served, and transparent ones made again once', async () => {
    h = await harness('transparent-thumbs-rooms')
    const owner = await withOwner(h)
    const mia = await addMember(h, owner, { username: 'mia' })
    const nora = await addMember(h, owner, { username: 'nora' })
    const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
    const upload = async (name: string, b: Uint8Array) => {
      const form = new FormData()
      form.set('file', new File([b as BlobPart], name))
      const r = await h.fetch(`/api/rooms/${dm.id}/files`, { method: 'POST', body: form, headers: { cookie: mia.client.cookie!, 'x-mycel-csrf': '1' } })
      expect(r.status).toBe(201)
      return r.json() as Promise<{ id: string; thumb: boolean }>
    }
    const stamp = await upload('stamp.png', seal())
    const photo = await upload('photo.jpg', PHOTO)
    const older = await upload('older.png', seal(400, 300))
    await mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: '', fileIds: [stamp.id, photo.id, older.id], clientMessageId: 'cm-' + crypto.randomUUID() })
    const thumb = (id: string) => h.fetch(`/api/rooms/${dm.id}/files/${id}?thumb=1`, { headers: { cookie: nora.client.cookie! } })
    const dir = path.join(h.ctx.config.teamRoot, '.system', 'rooms', dm.id)
    if (ffmpeg) {
      expect([stamp.thumb, photo.thumb]).toEqual([true, true])
      const t = await thumb(stamp.id)
      expect(t.headers.get('content-type')).toBe('image/png')
      expect(t.headers.get('content-disposition')).toContain('stamp.png.png')
      expect(corner(new Uint8Array(await t.arrayBuffer()))[3]).toBe(0)
      expect((await thumb(photo.id)).headers.get('content-type')).toBe('image/jpeg')
      expect(fs.existsSync(path.join(dir, `${stamp.id}.thumb.jpg`))).toBe(false)
    }
    // `older` as it was before this change: a JPEG thumbnail, black where the stamp is see-through. Still served
    for (const e of ['png', 'jpg']) fs.rmSync(path.join(dir, `${older.id}.thumb.${e}`), { force: true })
    fs.writeFileSync(path.join(dir, `${older.id}.thumb.jpg`), OLD_JPEG)
    h.ctx.db.query('UPDATE room_files SET thumb = 1 WHERE id = ?').run(older.id)
    const old = await thumb(older.id)
    expect(old.status).toBe(200)
    expect(old.headers.get('content-type')).toBe('image/jpeg')
    expect(old.headers.get('content-disposition')).toContain('older.png.jpg')
    expect(Buffer.from(await old.arrayBuffer())).toEqual(OLD_JPEG)
    // a start's check of rows and files takes either kind of thumbnail for its file's (none is set aside)
    expect(roomFilesOf(h.ctx).reconcile().orphansMoved).toBe(0)
    expect(fs.existsSync(path.join(dir, `${older.id}.thumb.jpg`))).toBe(true)
    if (ffmpeg) expect(fs.existsSync(path.join(dir, `${stamp.id}.thumb.png`))).toBe(true)
    // once: the old JPEG one of a transparent picture becomes a PNG one; the photo's stays
    const files = roomFilesOf(h.ctx)
    if (ffmpeg) {
      // stopped (the server closing) before it is done: nothing changes and it is not marked done
      const stop = new AbortController()
      stop.abort()
      expect(await files.refreshThumbs(stop.signal)).toEqual({ refreshed: 0 })
      expect(h.ctx.db.query('SELECT 1 FROM settings WHERE key = ?').get(ROOMS_DONE)).toBeNull()
      expect(fs.existsSync(path.join(dir, `${older.id}.thumb.jpg`))).toBe(true)
      expect(await files.refreshThumbs()).toEqual({ refreshed: 1 })
      const now = await thumb(older.id)
      expect(now.headers.get('content-type')).toBe('image/png')
      expect(corner(new Uint8Array(await now.arrayBuffer()))[3]).toBe(0)
      expect(fs.existsSync(path.join(dir, `${older.id}.thumb.jpg`))).toBe(false)
      expect(fs.existsSync(path.join(dir, `${photo.id}.thumb.jpg`))).toBe(true)
      expect(h.ctx.db.query('SELECT 1 FROM settings WHERE key = ?').get(ROOMS_DONE)).toBeTruthy()
      expect(await files.refreshThumbs()).toBeNull()
    }
    // deleting the message removes every thumbnail with its file
    const msg = (await mia.client.call('GET', `/api/rooms/${dm.id}/messages`)).items.find((m: { files: { id: string }[] }) => m.files.some((f) => f.id === stamp.id))
    await mia.client.call('DELETE', `/api/rooms/${dm.id}/messages/${msg.id}`)
    expect(fs.readdirSync(dir).filter((n) => n.includes('.thumb.'))).toEqual([])
  })
})

describe('chat attachments', () => {
  let A: CApp
  beforeAll(async () => { A = await makeCApp('transparent-thumbs-attachments') })
  afterAll(async () => { await A.close() })

  test('a transparent picture\'s thumbnail is a PNG; old JPEG ones are served, and transparent ones made again once', async () => {
    const chat = A.chat('alice')
    const upload = async (name: string, b: Uint8Array) => {
      const fd = new FormData(); fd.set('chatId', chat); fd.set('file', new File([b as BlobPart], name))
      const r = await A.json('/api/uploads', { method: 'POST', body: fd, as: 'alice' })
      expect(r.status).toBe(201)
      return r.body as { id: string; path: string }
    }
    const row = (id: string) => A.ctx.db.query('SELECT thumb_path FROM attachments WHERE id = ?').get(id) as { thumb_path: string | null }
    const thumb = (id: string) => A.req(`/api/uploads/${id}/thumbnail`, { as: 'alice' })
    const thumbs = path.join(A.data, 'thumbs')
    const stamp = await upload('stamp.png', seal())
    const photo = await upload('photo.jpg', PHOTO)
    const older = await upload('older.png', seal(400, 300))
    const changed = await upload('changed.png', seal(400, 300))
    if (ffmpeg) {
      expect(row(stamp.id).thumb_path).toBe(`thumbs/${stamp.id}.png`)
      expect(row(photo.id).thumb_path).toBe(`thumbs/${photo.id}.jpg`)
      const t = await thumb(stamp.id)
      expect(t.headers.get('content-type')).toBe('image/png')
      expect(t.headers.get('content-disposition')).toContain('stamp.png.png')
      expect(corner(new Uint8Array(await t.arrayBuffer()))[3]).toBe(0)
      expect((await thumb(photo.id)).headers.get('content-type')).toBe('image/jpeg')
    }
    // `older` and `changed` as before this change: a JPEG thumbnail. Still served, as a JPEG
    for (const a of [older, changed]) {
      for (const e of ['png', 'jpg']) fs.rmSync(path.join(thumbs, `${a.id}.${e}`), { force: true })
      fs.mkdirSync(thumbs, { recursive: true })
      fs.writeFileSync(path.join(thumbs, `${a.id}.jpg`), OLD_JPEG)
      A.ctx.db.query('UPDATE attachments SET thumb_path = ? WHERE id = ?').run(`thumbs/${a.id}.jpg`, a.id)
    }
    const old = await thumb(older.id)
    expect(old.status).toBe(200)
    expect(old.headers.get('content-type')).toBe('image/jpeg')
    expect(old.headers.get('content-disposition')).toContain('older.png.jpg')
    expect(Buffer.from(await old.arrayBuffer())).toEqual(OLD_JPEG)
    // the hourly sweep keeps the thumbnails of attachments that are there, of either kind, and drops the others
    fs.writeFileSync(path.join(thumbs, `${crypto.randomUUID()}.png`), 'gone')
    expect(componentC(A.ctx).attachments.sweep()).toBe(1)
    expect(fs.existsSync(path.join(thumbs, `${older.id}.jpg`))).toBe(true)
    if (ffmpeg) expect(fs.existsSync(path.join(thumbs, `${stamp.id}.png`))).toBe(true)
    // once: a transparent one still the file attached gets its PNG thumbnail; one changed since keeps its old one
    fs.writeFileSync(path.join(A.team, ...changed.path.split('/')), seal(200, 100))
    if (ffmpeg) {
      expect(await componentC(A.ctx).attachments.refreshThumbs()).toEqual({ refreshed: 1 })
      expect(row(older.id).thumb_path).toBe(`thumbs/${older.id}.png`)
      expect(fs.existsSync(path.join(thumbs, `${older.id}.jpg`))).toBe(false)
      const now = await thumb(older.id)
      expect(now.headers.get('content-type')).toBe('image/png')
      expect(corner(new Uint8Array(await now.arrayBuffer()))[3]).toBe(0)
      expect(row(changed.id).thumb_path).toBe(`thumbs/${changed.id}.jpg`)
      expect(row(photo.id).thumb_path).toBe(`thumbs/${photo.id}.jpg`)
      expect(A.ctx.db.query('SELECT 1 FROM settings WHERE key = ?').get(ATTACHMENTS_DONE)).toBeTruthy()
      expect(await componentC(A.ctx).attachments.refreshThumbs()).toBeNull()
    }
  })
})
