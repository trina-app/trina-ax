// Room pictures kept by the browser per sign-in (docs/DECISIONS.md "Room pictures are kept per sign-in";
// server/src/auth/media-key.ts): a room file's thumbnail says `private, immutable` only with the asking session's own
// media key in the address. Every request is still checked (members only, the message visible, the download-only
// list), another person's key or none is `private, no-cache`, an inline read or a download is never kept, a new sign-in
// has a new key, and signing out tells the browser to forget its cache. Never `public`.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { keptMediaCache, KEPT_MEDIA_MAX_AGE_S, mediaKeyOf } from '../../server/src/auth/media-key'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

// a real 1×1 PNG (the room keeps it as a picture; a small one is its own thumbnail)
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
const cm = () => 'cm-' + crypto.randomUUID()

async function setup() {
  h = await harness('b-room-media-cache')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const upload = async (name: string, bytes: Uint8Array) => {
    const form = new FormData()
    form.set('file', new File([bytes as BlobPart], name))
    const r = await h.fetch(`/api/rooms/${dm.id}/files`, { method: 'POST', body: form, headers: { cookie: mia.client.cookie!, 'x-mycel-csrf': '1' } })
    expect(r.status).toBe(201)
    return r.json()
  }
  const pic = await upload('photo.png', PNG)
  await mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: '', fileIds: [pic.id], clientMessageId: cm() })
  const key = async (c: Client) => (await c.call('GET', '/api/me')).session.mediaKey as string
  const get = (c: Client, id: string, q: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    h.fetch(`/api/rooms/${dm.id}/files/${id}?${new URLSearchParams(q)}`, { headers: { cookie: c.cookie!, ...headers } })
  return { owner, mia, nora, otto, dm, pic, upload, key, get }
}

const kept = (r: Response) => /^private, max-age=\d+, immutable$/.test(r.headers.get('cache-control') ?? '')

test('a room picture is kept by this browser only with the session\'s own key; anything else asks every time', async () => {
  const { mia, nora, otto, pic, key, get } = await setup()
  const nk = await key(nora.client)
  expect(nk).toMatch(/^[A-Za-z0-9_-]{22}$/)
  // each person, each sign-in, its own key
  expect(await key(mia.client)).not.toBe(nk)

  for (const q of [{ thumb: '1', k: nk }] as Record<string, string>[]) {
    const r = await get(nora.client, pic.id, q)
    expect(r.status).toBe(200)
    expect(kept(r)).toBe(true)
    const age = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control')!)![1])
    expect(age).toBeGreaterThan(60)
    expect(age).toBeLessThanOrEqual(KEPT_MEDIA_MAX_AGE_S)
    expect(r.headers.get('cache-control')).not.toContain('public')
    expect(r.headers.get('etag')).toBeTruthy()
    // the same picture again from a browser that has it: 304, still kept
    const again = await get(nora.client, pic.id, q, { 'if-none-match': r.headers.get('etag')! })
    expect(again.status).toBe(304)
    expect(kept(again)).toBe(true)
  }
  // no key, another person's key, a made-up one: private, no-cache (the browser asks the server each time)
  for (const k of [undefined, await key(mia.client), 'x'.repeat(22), nk.slice(0, 21)]) {
    const r = await get(nora.client, pic.id, { thumb: '1', ...(k === undefined ? {} : { k }) })
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('private, no-cache')
  }
  // the full picture (the viewer, "open original": an address a link opens) and a download are never kept, with the
  // key too
  for (const q of [{ k: nk }, { download: '1', k: nk }, { download: '1', thumb: '1', k: nk }]) {
    const r = await get(nora.client, pic.id, q)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('private, no-cache')
  }
  // someone outside the room with their own key: still 404, nothing to keep
  const out = await get(otto.client, pic.id, { thumb: '1', k: await key(otto.client) })
  expect(out.status).toBe(404)
  expect(kept(out)).toBe(false)
  // ... and with a member's key (an address seen on a shared computer): the same 404, the check runs first
  const borrowed = await get(otto.client, pic.id, { thumb: '1', k: nk })
  expect(borrowed.status).toBe(404)
  expect(kept(borrowed)).toBe(false)
})

test('a new sign-in has a new key; signing out clears the browser\'s cache; the ended session\'s key keeps nothing', async () => {
  const { nora, pic, key, get } = await setup()
  const before = await key(nora.client)
  const out = await nora.client.raw('POST', '/api/auth/logout')
  expect(out.status).toBe(204)
  expect(out.headers.get('clear-site-data')).toBe('"cache"')
  // signed out: the old address is refused like any request without a session
  expect((await get(nora.client, pic.id, { thumb: '1', k: before })).status).toBe(401)
  const again = h.client()
  await again.login('nora', nora.password)
  const after = await key(again)
  expect(after).not.toBe(before)
  // the last sign-in's address from this browser: answered, but not kept (no-cache: asked every time)
  const old = await get(again, pic.id, { thumb: '1', k: before })
  expect(old.status).toBe(200)
  expect(old.headers.get('cache-control')).toBe('private, no-cache')
  expect(kept(await get(again, pic.id, { thumb: '1', k: after }))).toBe(true)
})

test('every read is still checked: a member taken out, a deleted message, a file put on the download-only list', async () => {
  const { mia, nora, otto, dm, pic, upload, key, get } = await setup()
  const nk = await key(nora.client)
  // a group chat: otto saw its picture with his own key, then is taken out: the same address is 404 now
  const group = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  const form = new FormData()
  form.set('file', new File([PNG as BlobPart], 'group.png'))
  const gp = await (await h.fetch(`/api/rooms/${group.id}/files`, { method: 'POST', body: form, headers: { cookie: mia.client.cookie!, 'x-mycel-csrf': '1' } })).json()
  await mia.client.call('POST', `/api/rooms/${group.id}/messages`, { body: '', fileIds: [gp.id], clientMessageId: cm() })
  const ok = await key(otto.client)
  const groupGet = (c: Client) => h.fetch(`/api/rooms/${group.id}/files/${gp.id}?thumb=1&k=${ok}`, { headers: { cookie: c.cookie! } })
  const seen = await groupGet(otto.client)
  expect(seen.status).toBe(200)
  expect(kept(seen)).toBe(true)
  await mia.client.call('DELETE', `/api/rooms/${group.id}/members/${otto.id}`)
  const gone = await groupGet(otto.client)
  expect(gone.status).toBe(404)
  expect(kept(gone)).toBe(false)
  // a picture seen, then put on the download-only list: its thumbnail is refused from then on
  const later = await upload('later.png', Uint8Array.from([...PNG, 1]))
  await mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: '', fileIds: [later.id], clientMessageId: cm() })
  expect(kept(await get(nora.client, later.id, { thumb: '1', k: nk }))).toBe(true)
  // the bytes as the room keeps them (a photo's metadata is cut out on upload)
  const { sha256 } = h.ctx.db.query('SELECT sha256 FROM room_files WHERE id = ?').get(later.id) as { sha256: string }
  h.ctx.db.query("INSERT INTO safe_ops_artifacts(hash, size, kind) VALUES (?, 1, 'image')").run(sha256)
  expect((await get(nora.client, later.id, { thumb: '1', k: nk })).status).toBe(503)
  // the message deleted: 404 for the same address that was kept
  const msg = (await mia.client.call('GET', `/api/rooms/${dm.id}/messages`)).items.find((m: any) => m.files?.some((f: any) => f.id === pic.id))
  expect(msg).toBeTruthy()
  await mia.client.call('DELETE', `/api/rooms/${dm.id}/messages/${msg.id}`)
  expect((await get(nora.client, pic.id, { thumb: '1', k: nk })).status).toBe(404)
  // a picture on the download-only list: no thumbnail, no inline read; its download is not kept
  const bytes = Uint8Array.from([...PNG, 0])
  h.ctx.files.quarantine.add(bytes, 'image')
  const held = await upload('held.png', bytes)
  await mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: '', fileIds: [held.id], clientMessageId: cm() })
  expect((await get(nora.client, held.id, { thumb: '1', k: nk })).status).toBe(503)
  expect((await get(nora.client, held.id, { k: nk })).status).toBe(503)
  const down = await get(nora.client, held.id, { download: '1', k: nk })
  expect(down.status).toBe(200)
  expect(down.headers.get('cache-control')).toBe('private, no-cache')
})

test('keptMediaCache: only the session\'s own key, never past the session\'s end, at most a day', async () => {
  const { nora } = await setup()
  const s = (await nora.client.call('GET', '/api/me')).session as { id: string; expiresAt: string; mediaKey: string }
  const k = mediaKeyOf(h.ctx.db, s.id)!
  expect(k).toBe(s.mediaKey)
  const now = Date.parse(s.expiresAt)
  expect(keptMediaCache(h.ctx.db, s, k, now - 3 * 86_400_000)).toBe(`private, max-age=${KEPT_MEDIA_MAX_AGE_S}, immutable`)
  expect(keptMediaCache(h.ctx.db, s, k, now - 3_600_000)).toBe('private, max-age=3600, immutable')
  // the last minute of a session (or after it): nothing kept
  expect(keptMediaCache(h.ctx.db, s, k, now - 30_000)).toBeNull()
  expect(keptMediaCache(h.ctx.db, s, k, now + 1000)).toBeNull()
  expect(keptMediaCache(h.ctx.db, s, undefined)).toBeNull()
  expect(keptMediaCache(h.ctx.db, { ...s, id: crypto.randomUUID() }, k)).toBeNull()
})
