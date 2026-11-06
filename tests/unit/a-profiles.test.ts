// Profiles and the people directory (docs/DECISIONS.md "프로필과 사람 목록"): who can read the directory and what it
// shows, own title / status / photo, what a photo must be and that its metadata is cut out, and that nobody can change
// another person's profile.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AVATAR_MAX_BYTES } from '@mycel/shared'
import { prepareAvatar } from '../../server/src/auth/avatar'
import { AVATAR_TEXT } from '../../server/src/auth/profiles'
import { makeJpeg, makePng, makeWebp, SVG } from '../lib/images'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client
let mia: Client
let miaId: string
let ben: Client
let benId: string

beforeAll(async () => {
  h = await harness('profiles')
  owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'mia' })
  mia = a.client; miaId = a.id
  const b = await addMember(h, owner, { username: 'ben' })
  ben = b.client; benId = b.id
})
afterAll(() => h?.close())

function put(c: Client | null, bytes: Uint8Array<ArrayBuffer>, type: string) {
  const headers: Record<string, string> = { 'x-mycel-csrf': '1', 'content-type': 'application/octet-stream' }
  if (c?.cookie) headers.cookie = c.cookie
  return h.fetch(`/api/me/avatar?type=${encodeURIComponent(type)}`, { method: 'PUT', headers, body: bytes })
}
const get = (c: Client | null, p: string) => h.fetch(p, { headers: c?.cookie ? { cookie: c.cookie } : {} })
const people = async (c: Client) => (await c.call('GET', '/api/people')).people as { id: string; name: string; title?: string; status?: string; avatarVersion?: number }[]
const actions = async () => ((await owner.call('GET', '/api/admin/audit?source=admin&limit=200')).items as { action: string; actor: { id: string } | null; detail: Record<string, unknown> | null }[]).filter((e) => e.action.startsWith('profile.'))

// containers with metadata in them, to see that it is cut out
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const SECRET = 'GPS-LAT-37.5665'
function pngWithText(): Uint8Array<ArrayBuffer> {
  const png = makePng(64, 64)
  const text = new TextEncoder().encode(`tEXtComment\0${SECRET}`)
  const chunk = [...u32(text.length - 4), ...text, 0, 0, 0, 0] // the CRC is not read when cutting out
  return new Uint8Array([...png.slice(0, 33), ...chunk, ...png.slice(33)])
}
function webpWithExif(): Uint8Array<ArrayBuffer> {
  const le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
  const a = (s: string) => [...s].map((c) => c.charCodeAt(0))
  const exif = new TextEncoder().encode(SECRET + '!') // even length
  const vp8x = [...a('VP8X'), ...le(10), 0x08, 0, 0, 0, 63, 0, 0, 63, 0, 0]
  const body = [...a('WEBP'), ...vp8x, ...a('EXIF'), ...le(exif.length), ...exif, ...a('VP8 '), ...le(4), 1, 2, 3, 4]
  return new Uint8Array([...a('RIFF'), ...le(body.length), ...body])
}
const hasSecret = (b: Uint8Array) => Buffer.from(b).includes(SECRET)

describe('the people directory', () => {
  test('a member reads it; it holds no email, role or group, and nobody signed out reads it', async () => {
    const r = await people(mia)
    expect(r.map((p) => p.name).sort()).toEqual(['BEN', 'MIA', 'Olga Owner'])
    for (const p of r) expect(Object.keys(p).filter((k) => !['id', 'name', 'title', 'status', 'avatarVersion'].includes(k))).toEqual([])
    const text = JSON.stringify(await mia.call('GET', '/api/people'))
    expect(text).not.toContain('@')
    expect(text).not.toMatch(/"(email|role|groups?|username)"/)
    expect((await get(null, '/api/people')).status).toBe(401)
  })
  test('a deactivated person is left out and their photo is gone', async () => {
    expect((await put(ben, makePng(64, 64), 'image/png')).status).toBe(200)
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(benId)
    expect((await people(mia)).map((p) => p.id)).not.toContain(benId)
    expect((await get(mia, `/api/people/${benId}/avatar`)).status).toBe(404)
    h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = ?").run(benId)
    expect((await people(mia)).map((p) => p.id)).toContain(benId)
  })
})

describe('own profile', () => {
  test('title and status are saved, shown to others and in /api/me, and an empty value clears them', async () => {
    const r = await mia.call('PATCH', '/api/me/profile', { title: 'Designer', status: 'Out until Monday' })
    expect(r).toEqual({ id: miaId, name: 'MIA', title: 'Designer', status: 'Out until Monday' })
    expect((await people(ben)).find((p) => p.id === miaId)).toEqual({ id: miaId, name: 'MIA', title: 'Designer', status: 'Out until Monday' })
    expect((await mia.call('GET', '/api/me')).user).toMatchObject({ title: 'Designer', status: 'Out until Monday' })
    await mia.call('PATCH', '/api/me/profile', { status: '' })
    expect((await people(ben)).find((p) => p.id === miaId)).toEqual({ id: miaId, name: 'MIA', title: 'Designer' })
  })
  test('the own name can be changed (it is not admin-owned) and the change is audited', async () => {
    const r = await mia.call('PATCH', '/api/me/profile', { name: 'Mia Park' })
    expect(r.name).toBe('Mia Park')
    expect((await people(ben)).find((p) => p.id === miaId)?.name).toBe('Mia Park')
    const a = (await actions()).filter((e) => e.actor?.id === miaId)
    expect(a.map((e) => e.action)).toEqual(['profile.update', 'profile.update', 'profile.update'].slice(0, a.length))
    expect(a.length).toBeGreaterThanOrEqual(3)
    expect(a.some((e) => (e.detail as any)?.name?.to === 'Mia Park')).toBe(true)
  })
  test('too long, or a field that is not meant: refused', async () => {
    expect((await mia.try('PATCH', '/api/me/profile', { title: 'x'.repeat(61) })).status).toBe(400)
    expect((await mia.try('PATCH', '/api/me/profile', { status: 'x'.repeat(81) })).status).toBe(400)
    expect((await mia.try('PATCH', '/api/me/profile', { name: '   ' })).status).toBe(400)
    expect((await mia.try('PATCH', '/api/me/profile', { role: 'admin' })).status).toBe(400)
    expect((await mia.try('PATCH', '/api/me/profile', { id: benId, title: 'Mine now' })).status).toBe(400)
  })
  test('nobody changes another person\'s profile or photo: the person is the session\'s, never the request\'s', async () => {
    const before = (await people(owner)).find((p) => p.id === benId)
    expect((await mia.try('PATCH', `/api/me/profile?id=${benId}`, { title: 'Hacked' })).status).toBe(200) // changes mia's own
    expect((await people(owner)).find((p) => p.id === benId)).toEqual(before)
    expect((await mia.try('PUT', `/api/people/${benId}/avatar`)).status).toBe(404)
    expect((await mia.try('PATCH', `/api/people/${benId}`, { title: 'x' })).status).toBe(404)
    expect((await mia.try('DELETE', `/api/people/${benId}/avatar`)).status).toBe(404)
    expect((await mia.call('GET', '/api/me')).user.title).toBe('Hacked')
    await mia.call('PATCH', '/api/me/profile', { title: 'Designer' })
  })
  test('signed out: 401', async () => {
    expect((await h.fetch('/api/me/profile', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1' }, body: '{}' })).status).toBe(401)
    expect((await put(null, makePng(64, 64), 'image/png')).status).toBe(401)
  })
})

describe('the photo', () => {
  test('a member sets it; it is served to members only, cached for good at its version, and others see the version', async () => {
    const r = await put(mia, makePng(128, 128), 'image/png')
    expect(r.status).toBe(200)
    const { avatarVersion } = (await r.json()) as { avatarVersion: number }
    expect((await people(ben)).find((p) => p.id === miaId)?.avatarVersion).toBe(avatarVersion)
    expect((await mia.call('GET', '/api/me')).user.avatarVersion).toBe(avatarVersion)
    const img = await get(ben, `/api/people/${miaId}/avatar?v=${avatarVersion}`)
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(img.headers.get('cache-control')).toContain('max-age=31536000')
    expect(img.headers.get('x-content-type-options')).toBe('nosniff')
    expect(img.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(img.headers.get('set-cookie')).toBeNull()
    expect(new Uint8Array(await img.arrayBuffer()).byteLength).toBeGreaterThan(100)
    // without the current version the answer is not cached for long
    expect((await get(ben, `/api/people/${miaId}/avatar`)).headers.get('cache-control')).not.toContain('31536000')
    expect((await get(ben, `/api/people/${miaId}/avatar?v=1`)).headers.get('cache-control')).not.toContain('31536000')
    expect((await get(null, `/api/people/${miaId}/avatar?v=${avatarVersion}`)).status).toBe(401)
    const again = await get(ben, `/api/people/${miaId}/avatar`)
    const etag = again.headers.get('etag')!
    expect((await h.fetch(`/api/people/${miaId}/avatar`, { headers: { cookie: ben.cookie!, 'if-none-match': etag } })).status).toBe(304)
  })
  test('a new photo gets a new version; removing it brings the letter back and the address answers 404', async () => {
    const v1 = (await people(ben)).find((p) => p.id === miaId)!.avatarVersion!
    const v2 = ((await (await put(mia, makeJpeg(96, 96), 'image/jpeg')).json()) as { avatarVersion: number }).avatarVersion
    expect(v2).toBeGreaterThan(v1)
    expect((await get(ben, `/api/people/${miaId}/avatar?v=${v2}`)).headers.get('content-type')).toBe('image/jpeg')
    expect((await mia.try('DELETE', '/api/me/avatar')).status).toBe(204)
    expect((await people(ben)).find((p) => p.id === miaId)?.avatarVersion).toBeUndefined()
    expect((await get(ben, `/api/people/${miaId}/avatar?v=${v2}`)).status).toBe(404)
    expect((await mia.try('DELETE', '/api/me/avatar')).status).toBe(204)
    const v3 = ((await (await put(mia, makePng(64, 64), 'image/png')).json()) as { avatarVersion: number }).avatarVersion
    expect(v3).toBeGreaterThan(v2) // an address is never reused for another photo
    await mia.try('DELETE', '/api/me/avatar')
  })
  test('the avatar of an unknown or an invalid id is 404 or 400, never a file', async () => {
    expect((await get(mia, '/api/people/nobody/avatar')).status).toBe(404)
    expect((await get(mia, `/api/people/${(await people(mia)).find((p) => p.name === 'Olga Owner')!.id}/avatar`)).status).toBe(404) // no photo
    expect((await get(mia, '/api/people/..%2F..%2Fetc/avatar')).status).toBeGreaterThanOrEqual(400)
  })
  test('photo changes are audited with the person', async () => {
    const a = (await actions()).filter((e) => e.actor?.id === miaId).map((e) => e.action)
    expect(a).toContain('profile.avatar_set')
    expect(a).toContain('profile.avatar_remove')
  })
})

describe('what a photo must be', () => {
  const refused = async (bytes: Uint8Array<ArrayBuffer>, type: string, status: number, reason: string) => {
    const r = await put(mia, bytes, type)
    const body = (await r.json()) as { error: { message: string; params?: Record<string, unknown> } }
    expect({ type, status: r.status, reason: body.error.params?.reason }).toEqual({ type, status, reason })
    expect(body.error.message).toBe(AVATAR_TEXT[reason as keyof typeof AVATAR_TEXT].ko)
  }
  test('not an image: SVG, GIF, HTML, text, a type that lies', async () => {
    await refused(SVG, 'image/svg+xml', 400, 'type')
    await refused(SVG, 'image/png', 400, 'mismatch')
    await refused(new TextEncoder().encode('GIF89a' + 'x'.repeat(40)), 'image/gif', 400, 'type')
    await refused(new TextEncoder().encode('<html><script>alert(1)</script></html>'), 'image/jpeg', 400, 'mismatch')
    await refused(makeJpeg(64, 64), 'image/png', 400, 'mismatch')
    await refused(new TextEncoder().encode('just text'), 'text/plain', 400, 'type')
  })
  test('not a square, too small, too large, too heavy', async () => {
    await refused(makePng(128, 96), 'image/png', 400, 'not_square')
    await refused(makePng(63, 63), 'image/png', 400, 'too_small')
    await refused(makeWebp(600, 600), 'image/webp', 400, 'too_large')
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1)
    big.set(makePng(64, 64))
    await refused(big, 'image/png', 413, 'too_big')
  })
  test('nothing was stored by all that', async () => {
    expect((await people(ben)).find((p) => p.id === miaId)?.avatarVersion).toBeUndefined()
  })
  test('metadata is cut out: PNG text, JPEG EXIF, WebP EXIF', () => {
    const png = pngWithText()
    expect(hasSecret(png)).toBe(true)
    const p = prepareAvatar(png, 'image/png')
    expect(p.ok && hasSecret(p.bytes)).toBe(false)
    expect(p.ok && Buffer.from(p.bytes).includes('tEXt')).toBe(false)

    const jpeg = makeJpeg(64, 64) // carries an APP1 (EXIF) segment
    expect(Buffer.from(jpeg).includes(Buffer.from([0xff, 0xe1]))).toBe(true)
    const j = prepareAvatar(jpeg, 'image/jpeg')
    expect(j.ok).toBe(true)
    expect(j.ok && Buffer.from(j.bytes).includes(Buffer.from([0xff, 0xe1]))).toBe(false)
    expect(j.ok && Buffer.from(j.bytes).includes(Buffer.from([0xff, 0xe0]))).toBe(true) // the picture's own header stays

    const webp = webpWithExif()
    expect(hasSecret(webp)).toBe(true)
    const w = prepareAvatar(webp, 'image/webp')
    expect(w.ok && hasSecret(w.bytes)).toBe(false)
    expect(w.ok && Buffer.from(w.bytes).includes('EXIF')).toBe(false)
    if (w.ok) {
      expect(w.bytes[20]! & 0x08).toBe(0) // the EXIF flag is off
      expect(new DataView(w.bytes.buffer, w.bytes.byteOffset).getUint32(4, true) + 8).toBe(w.bytes.length) // the RIFF size is right
    }
  })
  test('an animated WebP and a cut-off PNG are refused', () => {
    const w = webpWithExif()
    w[20] = w[20]! | 0x02
    expect(prepareAvatar(w, 'image/webp')).toEqual({ ok: false, problem: 'animated' })
    expect(prepareAvatar(makePng(64, 64).slice(0, 60), 'image/png').ok).toBe(false)
  })
  test('a stored photo has no metadata when read back', async () => {
    const r = await put(mia, pngWithText(), 'image/png')
    expect(r.status).toBe(200)
    const { avatarVersion } = (await r.json()) as { avatarVersion: number }
    const img = new Uint8Array(await (await get(ben, `/api/people/${miaId}/avatar?v=${avatarVersion}`)).arrayBuffer())
    expect(hasSecret(img)).toBe(false)
    await mia.try('DELETE', '/api/me/avatar')
  })
})
