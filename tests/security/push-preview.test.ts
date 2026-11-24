// Security of a phone notification's words (docs/decisions/20261124-push-preview-slack-rule.md): the text of a message
// reaches only the phone of a person who still sees it, over the team's own label route (no session: the label key of
// that device), never the push gateway's request; a person with "Show message preview in notifications" off gets no
// text; someone taken out of a chat, a wrong key or another person's device gets the same {}.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { harness, withOwner, addMember, type Harness } from '../unit/a-lib'
import { PushService, pushOf } from '../../server/src/notifications/push-service'
import type { NativeSend } from '../../server/src/notifications/push-native'
import { savePreferences } from '../../server/src/notifications/preferences'
import { noteSharedMessage } from '../../server/src/chat/message-notices'
import { newId } from '../../server/src/db'

setDefaultTimeout(90_000)
let h: Harness | undefined, p: PushService | undefined
afterEach(async () => { await p?.stop(); p = undefined; await h?.close(); h = undefined })
const SECRET_TEXT = 'PLUM-7731 출시는 금요일'

test('the text goes to the person\'s own phone through the label route only; preview off, another device, a lost chat: no text', async () => {
  // the server's own push service (which answers the label route) knows the same gateway; it sends nothing here
  h = await harness('sec-push-preview', { push: { gatewayUrl: 'https://push.example.test' } } as never)
  await pushOf(h.ctx).stop()
  const sent: NativeSend[] = []
  p = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } }, phoneDecision: () => ({ kind: 'send' }) })
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const session = (u: string) => (h!.ctx.db.query('SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(u) as { id: string }).id
  const device = (u: string) => { const key = crypto.randomBytes(32).toString('base64url'); const d = p!.registerDevice(u, session(u), { consent: true, platform: 'android', environment: 'production', token: crypto.randomBytes(40).toString('base64url'), labelHash: crypto.createHash('sha256').update(key).digest('hex') }); return { id: d.id, key } }
  const noraPhone = device(nora.id), ottoPhone = device(otto.id)
  await new Promise((r) => setTimeout(r, 5))

  const chat = await mia.client.call('POST', '/api/chats', {})
  const share = async (ids: string[]) => {
    const put = (confirmKey?: string) => mia.client.call('PUT', `/api/chats/${chat.id}/audience`, { subjects: ids.map((subjectId) => ({ subjectType: 'user', subjectId })), ...(confirmKey ? { confirmKey } : {}) })
    let r = await put(); if (r.status === 'confirm') r = await put(r.confirmKey)
    expect(r.status).toBe('saved')
  }
  await share([nora.id, otto.id])
  const row = () => h!.ctx.db.query('SELECT id, user_id, shared_at, project_id, people_shared_at, deleted_at, room_id FROM chats WHERE id = ?').get(chat.id) as Parameters<typeof noteSharedMessage>[1]
  const msg = newId()
  h.ctx.db.query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', ?, ?, 'done')").run(msg, chat.id, mia.id, SECRET_TEXT)
  noteSharedMessage(h.ctx, row(), msg, mia.id)
  await p.tick()
  const noticeOf = (u: string) => (h!.ctx.db.query('SELECT id FROM chat_message_notices WHERE source_id = ? AND user_id = ?').get(msg, u) as { id: string }).id
  const noraNotice = noticeOf(nora.id)

  // what goes to the gateway: ids, a code, a locale; never the text, the chat's title or a name
  const pushes = sent.filter((s) => s.payload.notificationId === noraNotice || s.payload.notificationId === noticeOf(otto.id))
  expect(pushes).toHaveLength(2)
  for (const s of sent) expect(JSON.stringify(s)).not.toContain('PLUM')
  for (const s of pushes) {
    expect(s.payload.code).toBe('room.chat_message')
    expect(JSON.stringify(s.payload)).not.toContain('PLUM')
    expect(s.payload.label).toBe(true)
  }

  const label = async (deviceId: string, key: string, notificationId: string) => {
    const r = await h!.fetch(`/api/push/devices/${deviceId}/label`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1' }, body: JSON.stringify({ key, notificationId }) })
    expect(r.status).toBe(200)
    return r.json() as Promise<Record<string, string>>
  }
  // nora's own phone, her own notice: the words
  expect((await label(noraPhone.id, noraPhone.key, noraNotice)).body).toBe(SECRET_TEXT)
  // otto's phone asking for nora's notice, nora's device with otto's key, a made-up key: {}
  expect(await label(ottoPhone.id, ottoPhone.key, noraNotice)).toEqual({})
  expect(await label(noraPhone.id, ottoPhone.key, noraNotice)).toEqual({})
  expect(await label(noraPhone.id, crypto.randomBytes(32).toString('base64url'), noraNotice)).toEqual({})
  // nora turns previews off: who and where, never the text
  savePreferences(h.ctx.db, nora.id, { messagePreview: false })
  const off = await label(noraPhone.id, noraPhone.key, noraNotice)
  expect(off.title).toBeTruthy()
  expect(JSON.stringify(off)).not.toContain('PLUM')
  // otto is taken out of the chat: his notice's words are gone with it
  const ottoNotice = noticeOf(otto.id)
  expect((await label(ottoPhone.id, ottoPhone.key, ottoNotice)).body).toBe(SECRET_TEXT)
  await share([nora.id])
  expect(await label(ottoPhone.id, ottoPhone.key, ottoNotice)).toEqual({})
})
