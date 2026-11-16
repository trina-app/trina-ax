// Apps posting in rooms: an Other app's own icon (docs/decisions/20261116-other-app-icon.md, QA TC-3544 / TC-3545). Who
// may change it (the settings' rule exactly), what an image must be (the profile photo's rules), who may see it, that a
// webhook payload can never set an icon or a name, and that it goes with the app.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { AVATAR_MAX_BYTES } from '@mycel/shared'
import { appText } from '../../server/src/rooms/apps/text'
import { makeJpeg, makePng, makeWebp, SVG } from '../lib/images'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })
const settle = () => new Promise((r) => setTimeout(r, 5))

async function setup() {
  h = await harness('b-room-apps-icon', { publicOrigins: ['https://team.acme-corp.com'] })
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [ada.id, mia.id, nora.id] })
  const team = ((await mia.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'team' && r.groupId === group.id).id as string
  const gc = (await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })).id as string
  const post = (address: string, body: unknown) => h.fetch(`/in/${address.split('/in/')[1]}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { owner, ada, mia, nora, otto, team, gc, post }
}

function put(c: Client | null, p: string, bytes: Uint8Array<ArrayBuffer>, type: string) {
  const headers: Record<string, string> = { 'x-mycel-csrf': '1', 'content-type': 'application/octet-stream' }
  if (c?.cookie) headers.cookie = c.cookie
  return h.fetch(`${p}?type=${encodeURIComponent(type)}`, { method: 'PUT', headers, body: bytes })
}
const get = (c: Client | null, p: string, more: Record<string, string> = {}) => h.fetch(p, { headers: { ...(c?.cookie ? { cookie: c.cookie } : {}), ...more } })
const iconRows = () => (h.ctx.db.query('SELECT COUNT(*) n FROM room_app_icons').get() as { n: number }).n

test('team room: its owners and admins set the icon; a member 403, anyone not in the room 404; everyone in the room sees it on the messages', async () => {
  const { owner, ada, mia, otto, team, post } = await setup()
  const made = await ada.client.call('POST', `/api/rooms/${team}/apps`, { kind: 'other', name: 'Dr Alaseo Alert' })
  const one = `/api/rooms/${team}/apps/${made.app.id}`
  // no icon yet: the app and its messages carry none (the web app draws the name's first letter)
  expect(made.app.icon).toBeUndefined()
  expect((await post(made.address, { text: 'Server down' })).status).toBe(200)
  await settle()
  let [m] = (await mia.client.call('GET', `/api/rooms/${team}/messages`)).items.filter((x: any) => x.app)
  expect(m.app.icon).toBeUndefined()

  // the settings' rule exactly: a member in the room 403, the owner and an outsider (not in the room) 404
  for (const [c, want] of [[mia.client, 403], [owner, 404], [otto.client, 404]] as const) {
    expect((await put(c, `${one}/icon`, makePng(96, 96), 'image/png')).status).toBe(want)
    expect((await c.try('PUT', `${one}/icon/emoji`, { emoji: '🚨' })).status).toBe(want)
    expect((await c.try('DELETE', `${one}/icon`)).status).toBe(want)
  }
  expect(iconRows()).toBe(0)

  const r = await put(ada.client, `${one}/icon`, makePng(96, 96), 'image/png')
  expect(r.status).toBe(200)
  const app = await r.json() as { icon?: { image: string } }
  expect(app.icon?.image).toMatch(new RegExp(`^/api/rooms/${team}/apps/${made.app.id}/icon\\?v=\\d+$`))
  // the list says it too, and every message of the app shows the icon now (past ones too)
  expect((await ada.client.call('GET', `/api/rooms/${team}/apps`)).items[0].icon).toEqual(app.icon)
  ;[m] = (await mia.client.call('GET', `/api/rooms/${team}/messages`)).items.filter((x: any) => x.app)
  expect(m.app.icon).toEqual(app.icon)

  // a member of the room may see the image, as an image only, cached for good at its version
  const img = await get(mia.client, app.icon!.image)
  expect(img.status).toBe(200)
  expect(img.headers.get('content-type')).toBe('image/png')
  expect(img.headers.get('x-content-type-options')).toBe('nosniff')
  expect(img.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
  expect(img.headers.get('cache-control')).toContain('immutable')
  expect((await get(mia.client, `${one}/icon`)).headers.get('cache-control')).not.toContain('31536000')
  expect((await get(mia.client, app.icon!.image, { 'if-none-match': img.headers.get('etag')! })).status).toBe(304)
  // not for anyone outside the room, nor signed out
  expect((await get(otto.client, app.icon!.image)).status).toBe(404)
  expect((await get(owner, app.icon!.image)).status).toBe(404)
  expect((await get(null, app.icon!.image)).status).toBe(401)
  // the app's id under another room is not there
  const gc2 = (await ada.client.call('POST', '/api/rooms', { kind: 'group', userIds: [mia.id, otto.id] })).id
  expect((await get(ada.client, `/api/rooms/${gc2}/apps/${made.app.id}/icon`)).status).toBe(404)
  expect((await put(ada.client, `/api/rooms/${gc2}/apps/${made.app.id}/icon`, makePng(96, 96), 'image/png')).status).toBe(404)

  // a new icon is a new address; an emoji replaces the image (whose address is gone)
  const v2 = (await (await put(ada.client, `${one}/icon`, makeJpeg(128, 128), 'image/jpeg')).json() as { icon: { image: string } }).icon.image
  expect(v2).not.toBe(app.icon!.image)
  const e = await ada.client.call('PUT', `${one}/icon/emoji`, { emoji: '🚨' })
  expect(e.icon).toEqual({ emoji: '🚨' })
  expect((await get(mia.client, v2)).status).toBe(404)
  ;[m] = (await mia.client.call('GET', `/api/rooms/${team}/messages`)).items.filter((x: any) => x.app)
  expect(m.app.icon).toEqual({ emoji: '🚨' })

  // Remove icon: the letter again; a second remove changes nothing
  expect((await ada.client.call('DELETE', `${one}/icon`)).icon).toBeUndefined()
  expect((await ada.client.call('DELETE', `${one}/icon`)).icon).toBeUndefined()
  expect(iconRows()).toBe(0)

  // audited: who, the room, what was set; never the bytes
  const rows = h.ctx.db.query("SELECT actor_id actor, target, detail FROM audit_log WHERE action = 'room_app.icon' ORDER BY id").all() as { actor: string; target: string; detail: string }[]
  expect(rows.map((x) => JSON.parse(x.detail).set)).toEqual(['image', 'image', 'emoji', null])
  expect(rows.every((x) => x.actor === ada.id && x.target === made.app.id)).toBe(true)
  expect(JSON.parse(rows[0]!.detail)).toMatchObject({ roomId: team, size: expect.any(Number), before: null })

  // the admin made a member: 403 now, as for every setting
  await owner.call('PATCH', `/api/admin/users/${ada.id}`, { role: 'member' })
  expect((await ada.client.try('PUT', `${one}/icon/emoji`, { emoji: '🔥' })).status).toBe(403)
})

test('group chat: any member sets it (the settings\' rule), a guest in it does not but sees it', async () => {
  const { mia, nora, otto, gc } = await setup()
  const a = await nora.client.call('POST', `/api/rooms/${gc}/apps`, { kind: 'other', name: 'Deploys' })
  const one = `/api/rooms/${gc}/apps/${a.app.id}`
  // not only who added it: any member of the chat, as for the name and the switches
  const r = await put(otto.client, `${one}/icon`, makeWebp(64, 64), 'image/webp')
  expect(r.status).toBe(200)
  const icon = (await r.json() as { icon: { image: string } }).icon
  const gus = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: gc } })
  expect((await put(gus.client, `${one}/icon`, makePng(96, 96), 'image/png')).status).toBe(403)
  expect((await gus.client.try('PUT', `${one}/icon/emoji`, { emoji: '🔥' })).status).toBe(403)
  expect((await gus.client.try('DELETE', `${one}/icon`)).status).toBe(403)
  expect((await get(gus.client, icon.image)).status).toBe(200)
})

test('an image follows the profile photo\'s rules; an emoji is exactly one; only a plain Other app has one', async () => {
  const { ada, team } = await setup()
  const made = await ada.client.call('POST', `/api/rooms/${team}/apps`, { kind: 'other', name: 'Alerts' })
  const one = `/api/rooms/${team}/apps/${made.app.id}/icon`
  const refused = async (bytes: Uint8Array<ArrayBuffer>, type: string) => {
    const r = await put(ada.client, one, bytes, type)
    return [r.status, ((await r.json()) as { error?: { params?: { reason?: string } } }).error?.params?.reason]
  }
  expect(await refused(SVG, 'image/svg+xml')).toEqual([400, 'type'])
  expect(await refused(SVG, 'image/png')).toEqual([400, 'mismatch'])
  expect(await refused(makePng(96, 64), 'image/png')).toEqual([400, 'not_square'])
  expect(await refused(makePng(32, 32), 'image/png')).toEqual([400, 'too_small'])
  expect(await refused(makePng(600, 600), 'image/png')).toEqual([400, 'too_large'])
  expect(await refused(makePng(96, 96), 'image/jpeg')).toEqual([400, 'mismatch'])
  const big = new Uint8Array(AVATAR_MAX_BYTES + 10)
  big.set(makePng(96, 96))
  expect((await put(ada.client, one, big, 'image/png')).status).toBe(413)
  // the refusal is in plain words, in the uploader's language
  const r = await put(ada.client, one, makePng(96, 64), 'image/png')
  expect(((await r.json()) as { error: { message: string } }).error.message).toBe(appText('iconShape', 'ko', { min: 64, max: 512 }))
  // a camera's EXIF block is cut out before the icon is stored
  const ok = await put(ada.client, one, makeJpeg(96, 96), 'image/jpeg')
  expect(ok.status).toBe(200)
  const stored = h.ctx.db.query('SELECT image FROM room_app_icons WHERE app_id = ?').get(made.app.id) as { image: Uint8Array }
  expect(Buffer.from(stored.image).includes(Buffer.from('Exif'))).toBe(false)

  for (const emoji of ['', 'ab', '🚨🔥', '🚨 ', 'x🚨', '\u{E0041}']) expect([emoji, (await ada.client.try('PUT', `${one}/emoji`, { emoji })).status]).toEqual([emoji, 400])
  // one form of an emoji, whether typed with its selector or not
  expect((await ada.client.call('PUT', `${one}/emoji`, { emoji: '❤' })).icon).toEqual({ emoji: '❤️' })
  expect((await ada.client.try('PUT', `${one}/emoji`, { emoji: '🚨', image: 'https://evil.example/x.png' })).status).toBe(400)

  // a named service, Sentry, GitHub, Google Forms keep their marks
  for (const body of [{ kind: 'sentry' }, { kind: 'github' }, { kind: 'google_forms' }, { kind: 'other', preset: 'notion' }]) {
    const x = await ada.client.call('POST', `/api/rooms/${team}/apps`, body)
    const p = `/api/rooms/${team}/apps/${x.app.id}/icon`
    const a = await put(ada.client, p, makePng(96, 96), 'image/png')
    expect([body, a.status, ((await a.json()) as any).error?.params?.reason]).toEqual([body, 400, 'not_other'])
    expect((await ada.client.try('PUT', `${p}/emoji`, { emoji: '🚨' })).status).toBe(400)
    expect((await ada.client.try('DELETE', p)).status).toBe(400)
  }
})

test('a webhook payload never sets an icon or a name (Slack username / icon_url / icon_emoji, Discord avatar_url)', async () => {
  const { ada, mia, team, post } = await setup()
  const made = await ada.client.call('POST', `/api/rooms/${team}/apps`, { kind: 'other', name: 'Alerts' })
  const icon = (await ada.client.call('PUT', `/api/rooms/${team}/apps/${made.app.id}/icon/emoji`, { emoji: '🚨' })).icon
  expect((await post(made.address, { text: 'Slack shaped', username: 'Mia', icon_url: 'https://evil.example/mia.png', icon_emoji: ':ghost:' })).status).toBe(200)
  expect((await post(made.address, { content: 'Discord shaped', username: 'Ada', avatar_url: 'https://evil.example/ada.png' })).status).toBe(200)
  await settle()
  const ms = (await mia.client.call('GET', `/api/rooms/${team}/messages`)).items.filter((x: any) => x.app)
  expect(ms).toHaveLength(2)
  for (const m of ms) {
    expect(m.app).toMatchObject({ name: 'Alerts', icon })
    expect(JSON.stringify(m)).not.toContain('evil.example')
    expect(JSON.stringify(m)).not.toContain(':ghost:')
  }
  // the app's own icon did not change either
  expect((await ada.client.call('GET', `/api/rooms/${team}/apps`)).items[0].icon).toEqual(icon)
})

test('the icon goes with the app (and with its room); the app\'s old messages keep only its name', async () => {
  const { ada, mia, team, gc, nora, post } = await setup()
  const made = await ada.client.call('POST', `/api/rooms/${team}/apps`, { kind: 'other', name: 'Alerts' })
  const r = await put(ada.client, `/api/rooms/${team}/apps/${made.app.id}/icon`, makePng(96, 96), 'image/png')
  const image = ((await r.json()) as { icon: { image: string } }).icon.image
  expect((await post(made.address, { text: 'Server down' })).status).toBe(200)
  await settle()
  expect(iconRows()).toBe(1)
  await ada.client.call('DELETE', `/api/rooms/${team}/apps/${made.app.id}`)
  expect(iconRows()).toBe(0)
  expect((await get(mia.client, image)).status).toBe(404)
  const [m] = (await mia.client.call('GET', `/api/rooms/${team}/messages`)).items.filter((x: any) => x.app)
  expect(m.app).toMatchObject({ id: null, name: 'Alerts' })
  expect(m.app.icon).toBeUndefined()
  // a group chat's app: its icon goes when the chat's last member leaves and the chat is removed with its apps
  const g = await nora.client.call('POST', `/api/rooms/${gc}/apps`, { kind: 'other', name: 'Deploys' })
  await nora.client.call('PUT', `/api/rooms/${gc}/apps/${g.app.id}/icon/emoji`, { emoji: '🚀' })
  expect(iconRows()).toBe(1)
  h.ctx.db.query('DELETE FROM rooms WHERE id = ?').run(gc)
  expect(iconRows()).toBe(0)
})
