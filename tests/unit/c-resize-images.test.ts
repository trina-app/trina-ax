// resize_images through the tool path (the MCP handler, as an engine calls it), QA TC-4539: the longest side, a width, a
// target file size and the presets; several photos in one call; copies next to the originals ("<name>-<word>.jpg"),
// never over them unless replace: true after a read; the EXIF orientation applied; the photo details (time taken,
// camera, location) kept by default and removed only on request (the owner, 2026-11-17); iPhone HEIC photos made into
// JPEG copies, read by the AI as images, and a plain sentence where the server has no HEIC decoder; other formats
// refused in plain words; the folder rules (read-only, someone else's file, skills).
// The pixels are handled by `mycel-safeops resize` (native/internal/safeops/resize.go, its own Go tests); the tests
// that convert skip without the built helper (bun run build:native).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ResizeImagesInput } from '@mycel/shared'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { pngOf, pngRgbaOf } from '../lib/images'
import { ROOM_FILE_TOOLS, SHARED_TOOLS, WRITE_TARGET_ARGS, namedPaths } from '../../server/src/rooms/ai-tools'
import { GUEST_TURN_TOOLS } from '../../server/src/chat/guest-tools'
import { RESIZE_WORD, RESIZE_PRESETS } from '../../server/src/tools/resize-images'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { displaySize } from '../../server/src/uploads/image'

setDefaultTimeout(60_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-resize-images') })
afterAll(async () => { await A.close() })

const ROOT = path.join(import.meta.dir, '..', '..')
const PHOTO = fs.readFileSync(path.join(ROOT, 'tests/ai-scenarios/fixture/files/groups/마케팅/사진/IMG_2041.jpg')) // 1200x800
const WEBP = fs.readFileSync(path.join(ROOT, 'docs/site/images/admin/home.webp'))
const helper = fs.existsSync(path.join(ROOT, 'native/bin', `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`, 'mycel-safeops'))
const conv = test.skipIf(!helper)

const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array | string) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
const size = (rel: string) => displaySize(fs.readFileSync(file(rel)))
let rpcId = 0
function turn(user: Person) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, A.turn(user, A.chat(user))))
  return async (name: string, args: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    return { text: r.result.content[0].text as string, isError: !!r.result.isError }
  }
}
const word = () => RESIZE_WORD[teamDefaultLocale(A.ctx.db)]
const D = 'groups/marketing/photos'

/** the JPEG with an APP1 Exif segment after SOI: Orientation and a GPS IFD whose area information holds a recognisable
 * string */
function withExif(jpg: Uint8Array, orient: number): Buffer {
  const t = Buffer.alloc(8 + 30 + 30 + 16)
  t.write('II', 0, 'latin1'); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4)
  t.writeUInt16LE(2, 8)
  t.writeUInt16LE(0x0112, 10); t.writeUInt16LE(3, 12); t.writeUInt32LE(1, 14); t.writeUInt16LE(orient, 18)
  t.writeUInt16LE(0x8825, 22); t.writeUInt16LE(4, 24); t.writeUInt32LE(1, 26); t.writeUInt32LE(38, 30)
  t.writeUInt16LE(2, 38)
  t.writeUInt16LE(1, 40); t.writeUInt16LE(2, 42); t.writeUInt32LE(2, 44); t.write('N\0', 48, 'latin1')
  t.writeUInt16LE(0x1c, 52); t.writeUInt16LE(7, 54); t.writeUInt32LE(16, 56); t.writeUInt32LE(68, 60)
  t.write('GPS-SECRET-PLACE', 68, 'latin1')
  const seg = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t])
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe1, (seg.length + 2) >> 8, (seg.length + 2) & 0xff])
  return Buffer.concat([head, seg, Buffer.from(jpg).subarray(2)])
}

/** the tags of IFD0 of a JPEG's EXIF (empty without one), with SHORT values */
function ifd0(jpg: Buffer): Map<number, number> {
  const out = new Map<number, number>()
  const at = jpg.indexOf('Exif\0\0', 0, 'latin1')
  if (at < 0) return out
  const t = jpg.subarray(at + 6)
  const le = t.toString('latin1', 0, 2) === 'II'
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o))
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o))
  const off = u32(4)
  for (let i = 0; i < u16(off); i++) out.set(u16(off + 2 + 12 * i), u16(off + 2 + 12 * i + 8))
  return out
}

describe('the input: one control or a preset, in plain numbers', () => {
  test('at least one control; a preset alone; output only for one photo; replace not with output', () => {
    const ok = (v: unknown) => ResizeImagesInput.safeParse(v).success
    expect(ok({ paths: ['a.jpg'], longest_side: 1200 })).toBe(true)
    expect(ok({ paths: ['a.jpg'], width: 600, max_mb: 2 })).toBe(true)
    expect(ok({ paths: ['a.jpg', 'b.png'], preset: 'web' })).toBe(true)
    expect(ok({ paths: ['a.jpg'] })).toBe(false)
    expect(ok({ paths: ['a.jpg'], preset: 'web', longest_side: 800 })).toBe(false)
    expect(ok({ paths: ['a.jpg', 'b.jpg'], longest_side: 800, output: 'x.jpg' })).toBe(false)
    expect(ok({ paths: ['a.jpg'], longest_side: 800, replace: true, output: 'x.jpg' })).toBe(false)
    expect(ok({ paths: [], longest_side: 800 })).toBe(false)
    expect(ok({ paths: Array.from({ length: 21 }, (_, i) => `${i}.jpg`), longest_side: 800 })).toBe(false)
    expect(ok({ paths: ['a.jpg'], longest_side: 3 })).toBe(false)
    expect(ok({ paths: ['a.jpg'], max_mb: 0.001 })).toBe(false)
  })
  test('the presets are plain sizes', () => {
    expect(RESIZE_PRESETS.smaller).toEqual({ permille: 500 })
    expect(RESIZE_PRESETS.email.side).toBe(1600)
    expect(RESIZE_PRESETS.web.side).toBe(1920)
  })
})

describe('copies next to the originals', () => {
  conv('longest side and width: a new file "<name>-<word>.jpg", the original untouched; the answer has sizes and a link', async () => {
    put(`${D}/shop.jpg`, PHOTO)
    const before = fs.readFileSync(file(`${D}/shop.jpg`))
    const call = turn('alice')
    const r = await call('resize_images', { paths: [`${D}/shop.jpg`], longest_side: 600 })
    expect(r.isError, r.text).toBe(false)
    const out = `${D}/shop-${word()}.jpg`
    expect(size(out)).toEqual({ width: 600, height: 400 })
    expect(r.text).toContain(`Saved ${out} (600×400,`)
    expect(r.text).toContain('was 1200×800')
    expect(r.text).toMatch(/\[shop-[^\]]+\.jpg\]\(/)
    expect(r.text).toContain('unchanged')
    // the details stay: the AI does not say anything was removed
    expect(r.text).toContain('keep the photo details')
    expect(r.text).not.toMatch(/location was removed|were removed/i)
    expect(fs.readFileSync(file(`${D}/shop.jpg`)).equals(before)).toBe(true)
    // a width; a second copy gets a free name
    const w = await call('resize_images', { paths: [`${D}/shop.jpg`], width: 300 })
    expect(w.isError, w.text).toBe(false)
    expect(size(`${D}/shop-${word()} (2).jpg`)).toEqual({ width: 300, height: 200 })
  })

  conv('a target file size: the copy is at most that size; a size it already meets makes no copy', async () => {
    put(`${D}/big.png`, pngOf(900, 700, (x, y) => [(x * 7 + y * 3) % 256, (x * y) % 256, (x ^ y) % 256]))
    const call = turn('alice')
    const r = await call('resize_images', { paths: [`${D}/big.png`], max_mb: 0.1 })
    expect(r.isError, r.text).toBe(false)
    const out = `${D}/big-${word()}.png`
    expect(fs.statSync(file(out)).size).toBeLessThanOrEqual(100_000)
    put(`${D}/small.jpg`, PHOTO)
    const none = await call('resize_images', { paths: [`${D}/small.jpg`], max_mb: 5 })
    expect(none.isError).toBe(true)
    expect(none.text).toContain('already')
    expect(fs.existsSync(file(`${D}/small-${word()}.jpg`))).toBe(false)
    // never larger: a bigger longest side than the photo has
    const up = await call('resize_images', { paths: [`${D}/small.jpg`], longest_side: 4000 })
    expect(up.isError).toBe(true)
    expect(up.text).toContain('1200×800')
  })

  conv('several photos in one call, a preset; a WebP becomes a JPEG and the answer says so; into a folder', async () => {
    put(`${D}/a.jpg`, PHOTO)
    put(`${D}/b.webp`, WEBP)
    put(`${D}/c.png`, pngRgbaOf(400, 200, (x) => [200, 30, 30, x < 200 ? 0 : 255]))
    const call = turn('alice')
    const r = await call('resize_images', { paths: [`${D}/a.jpg`, `${D}/b.webp`, `${D}/c.png`], preset: 'smaller', output_folder: `${D}/small` })
    expect(r.isError, r.text).toBe(false)
    expect(fs.readdirSync(file(`${D}/small`)).sort()).toEqual([`a-${word()}.jpg`, `b-${word()}.jpg`, `c-${word()}.png`].sort())
    expect(size(`${D}/small/a-${word()}.jpg`)).toEqual({ width: 600, height: 400 })
    expect(size(`${D}/small/c-${word()}.png`)).toEqual({ width: 200, height: 100 })
    expect(r.text).toMatch(/WebP.*JPEG/)
    expect(r.text.match(/^Saved /gm)?.length).toBe(3)
  })

  conv('the EXIF orientation is applied; the photo details (GPS included) stay by default, orientation reset', async () => {
    put(`${D}/phone.jpg`, withExif(PHOTO, 6)) // stored 1200x800, shown 800x1200
    const call = turn('alice')
    const r = await call('resize_images', { paths: [`${D}/phone.jpg`], longest_side: 300 })
    expect(r.isError, r.text).toBe(false)
    const out = fs.readFileSync(file(`${D}/phone-${word()}.jpg`))
    expect(displaySize(out)).toEqual({ width: 200, height: 300 })
    expect(out.includes('GPS-SECRET-PLACE')).toBe(true)
    expect(ifd0(out).get(0x0112)).toBe(1)
    expect(ifd0(out).has(0x8825)).toBe(true)
  })

  conv('the location is removed only on request ("without the location"); all details on request', async () => {
    put(`${D}/trip.jpg`, withExif(PHOTO, 1))
    const call = turn('alice')
    const r = await call('resize_images', { paths: [`${D}/trip.jpg`], longest_side: 300, remove_details: 'location' })
    expect(r.isError, r.text).toBe(false)
    const out = fs.readFileSync(file(`${D}/trip-${word()}.jpg`))
    expect(out.includes('GPS-SECRET-PLACE')).toBe(false)
    expect(ifd0(out).has(0x8825)).toBe(false)
    expect(ifd0(out).get(0x0112)).toBe(1)
    expect(r.text).toMatch(/location was removed/)
    const all = await call('resize_images', { paths: [`${D}/trip.jpg`], longest_side: 300, remove_details: 'all', output: `${D}/trip-bare.jpg` })
    expect(all.isError, all.text).toBe(false)
    const bare = fs.readFileSync(file(`${D}/trip-bare.jpg`))
    expect(bare.includes('Exif')).toBe(false)
    expect(all.text).toMatch(/details .* were removed/)
    // a photo without a location: the AI says there was none to remove, not that it removed one
    put(`${D}/plain.jpg`, PHOTO)
    const plain = await call('resize_images', { paths: [`${D}/plain.jpg`], longest_side: 300, remove_details: 'location' })
    expect(plain.text).toMatch(/had no location/)
    expect(plain.text).not.toMatch(/location was removed/)
  })

  conv('replace only with replace: true after a read: a new version, the old one in its history', async () => {
    put(`${D}/replace-me.jpg`, PHOTO)
    const call = turn('alice')
    const no = await call('resize_images', { paths: [`${D}/replace-me.jpg`], longest_side: 400, replace: true })
    expect(no.isError).toBe(true)
    expect(no.text).toContain('read it in this chat first')
    const over = await call('resize_images', { paths: [`${D}/replace-me.jpg`], longest_side: 400, output: `${D}/replace-me.jpg` })
    expect(over.isError).toBe(true)
    expect(over.text).toContain('replace: true')
    await call('read', { file_path: `${D}/replace-me.jpg` })
    const yes = await call('resize_images', { paths: [`${D}/replace-me.jpg`], longest_side: 400, replace: true })
    expect(yes.isError, yes.text).toBe(false)
    expect(yes.text).toContain('file history')
    expect(size(`${D}/replace-me.jpg`)).toEqual({ width: 400, height: 267 })
    expect((A.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(`${D}/replace-me.jpg`) as { n: number }).n).toBe(1)
  })
})

describe('what it cannot read, and the folder rules', () => {
  test('GIF and a damaged HEIC: a plain reason naming the file; nothing saved', async () => {
    put(`${D}/iphone.heic`, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1')]))
    put(`${D}/anim.gif`, Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'))
    const call = turn('alice')
    const before = fs.readdirSync(file(D)).length
    const heic = await call('resize_images', { paths: [`${D}/iphone.heic`], longest_side: 800 })
    expect(heic.isError).toBe(true)
    expect(heic.text).toContain('iphone.heic')
    expect(heic.text).toMatch(/damaged/)
    const gif = await call('resize_images', { paths: [`${D}/anim.gif`], longest_side: 800 })
    expect(gif.isError).toBe(true)
    expect(gif.text).toContain('anim.gif')
    expect(fs.readdirSync(file(D)).length).toBe(before)
  })

  conv('a damaged photo among good ones: the good ones are saved, the damaged one is named', async () => {
    put(`${D}/broken.jpg`, Buffer.from(PHOTO).subarray(0, 600))
    put(`${D}/good.jpg`, PHOTO)
    const r = await turn('alice')('resize_images', { paths: [`${D}/good.jpg`, `${D}/broken.jpg`], longest_side: 500 })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(`Saved ${D}/good-${word()}.jpg`)
    expect(r.text).toMatch(/broken\.jpg.*(damaged|could not be read)/)
    expect(fs.existsSync(file(`${D}/broken-${word()}.jpg`))).toBe(false)
    expect(r.text).not.toMatch(/resize: |mycel|at .*\.ts/)
  })

  test('a read-only folder is refused; someone else\'s file is not found; never into a skill folder', async () => {
    put('projects/falcon/team.jpg', PHOTO)
    const bob = turn('bob')
    const ro = await bob('resize_images', { paths: ['projects/falcon/team.jpg'], longest_side: 300 })
    expect(ro.isError).toBe(true)
    expect(ro.text).toContain('read-only')
    put('users/bob/private.jpg', PHOTO)
    const r = await turn('alice')('resize_images', { paths: ['users/bob/private.jpg'], longest_side: 300 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('not found or no access')
    expect(fs.readdirSync(file('users/bob')).filter((n) => n.startsWith('private'))).toEqual(['private.jpg'])
    const skill = await turn('carol')('resize_images', { paths: [`${D}/shop.jpg`], longest_side: 300, output: 'skills/x/out.jpg' })
    expect(skill.isError).toBe(true)
    expect(skill.text).toContain('skill folder')
  })

  test('caps: more than 20 photos is refused by the input', async () => {
    const r = await turn('alice')('resize_images', { paths: Array.from({ length: 21 }, (_, i) => `${D}/${i}.jpg`), longest_side: 300 })
    expect(r.isError).toBe(true)
  })

  test('the lists: shared chats, rooms and guests may use it; where it writes; the photos it names', () => {
    expect(SHARED_TOOLS.has('resize_images')).toBe(true)
    expect(ROOM_FILE_TOOLS.has('resize_images')).toBe(true)
    expect(GUEST_TURN_TOOLS.has('resize_images')).toBe(true)
    expect(WRITE_TARGET_ARGS.resize_images).toEqual(['output', 'output_folder'])
    expect(namedPaths('resize_images', { paths: ['a.jpg', 'b.png'], output_folder: 'x' }).map((x) => x.value)).toEqual(['a.jpg', 'b.png', 'x'])
  })
})
