// Phone notifications follow the common messenger rule (docs/decisions/20261124-push-preview-slack-rule.md, owner
// 2026-11-24 "슬랙룰 따라가자"): who and where as the title and the message as the line, on by default; "Show message
// preview in notifications" off: who and where only, never the text. Rooms, chats shared with people, project chats and
// chat threads alike. Files say what was sent; text that may hold a secret, and every text while safe operations run,
// never goes. A chat message and a chat thread reply go to phones as room codes, so the phone apps out there ask for
// these words (server/src/notifications/push-native.ts nativeCode, push-service.ts label).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { PushService, pushOf } from '../../server/src/notifications/push-service'
import { TEXT } from '../../server/src/notifications/text'
import { savePreferences } from '../../server/src/notifications/preferences'
import { setUserLocale } from '../../server/src/auth/users'
import { nativeCode, type NativeSend } from '../../server/src/notifications/push-native'
import { noteSharedMessage } from '../../server/src/chat/message-notices'
import { newId } from '../../server/src/db'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(90_000)
const GATEWAY = 'https://push.example.test'
let h: Harness, p: PushService | undefined
afterEach(async () => { await p?.stop(); p = undefined; await h?.close(); delete process.env.MYCEL_SAFE_OPS_1A })

const cm = () => 'cm-' + crypto.randomUUID()
const newKey = () => crypto.randomBytes(32).toString('base64url')
const hashOf = (key: string) => crypto.createHash('sha256').update(key).digest('hex')
const sessionOf = (userId: string) => (h.ctx.db.query('SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(userId) as { id: string }).id
// a 1×1 PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))

/** mia, nora (an iPhone with a label key) and otto in a group room "design"; a DM mia → nora. */
async function world() {
  h = await harness('push-preview-slack-rule')
  await pushOf(h.ctx).stop()
  let now = Date.now()
  const sent: NativeSend[] = []
  p = new PushService(h.ctx, { config: () => null, native: () => ({ url: GATEWAY }), nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } }, phoneDecision: () => ({ kind: 'send' }), now: () => now })
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const key = newKey()
  const device = p.registerDevice(nora.id, sessionOf(nora.id), { consent: true, platform: 'ios', environment: 'production', token: crypto.randomBytes(32).toString('hex'), labelHash: hashOf(key) })
  now += 5
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  const upload = async (c: Client, roomId: string, name: string, bytes: Uint8Array) => {
    const form = new FormData()
    form.set('file', new File([bytes as BlobPart], name))
    const r = await h.fetch(`/api/rooms/${roomId}/files`, { method: 'POST', body: form, headers: { cookie: c.cookie!, 'x-mycel-csrf': '1' } })
    expect(r.status).toBe(201)
    return (await r.json()) as { id: string; kind: string }
  }
  /** a room message's notice for nora, pushed to her phone */
  const roomPushed = async (messageId: string) => {
    now = Math.max(now + 5, Date.now()); await p!.tick()
    const id = (h.ctx.db.query('SELECT id FROM room_notices WHERE source_id=? AND user_id=?').get(messageId, nora.id) as { id: string } | null)?.id
    expect(id).toBeTruthy(); return id!
  }
  const ask = (notificationId: string, k = key) => p!.label(device.id, { key: k, notificationId })
  return { owner, mia, nora, otto, key, device, sent, dm, send, upload, roomPushed, ask, tick: async () => { now = Math.max(now + 5, Date.now()); await p!.tick() } }
}

test('a room message: who and where, and the whole message as one line, cut at 200 characters; preview off: no text', async () => {
  const w = await world()
  const m = await w.send(w.mia.client, w.dm.id, '내일 회의 3시로 옮겨요\n\n장소는 2층 회의실이에요')
  const id = await w.roomPushed(m.id)
  // the default (preview on): every line, not just the first
  expect(w.ask(id)).toEqual({ title: 'MIA', body: '내일 회의 3시로 옮겨요 장소는 2층 회의실이에요', roomId: w.dm.id })
  const long = await w.send(w.mia.client, w.dm.id, '가나다라 '.repeat(40) + 'xyz '.repeat(40))
  const body = w.ask(await w.roomPushed(long.id)).body!
  expect([...body].length).toBe(200)
  expect(body.endsWith('…')).toBe(true)
  // a person with previews off gets who and where, never the text
  savePreferences(h.ctx.db, w.nora.id, { messagePreview: false })
  const off = w.ask(id)
  expect(off).toEqual({ title: 'MIA', body: TEXT['room.dm'].ko, roomId: w.dm.id })
  expect(JSON.stringify(off)).not.toContain('회의')
})

test('a message with only files says what was sent: a photo, a file by name, several files', async () => {
  const w = await world()
  setUserLocale(h.ctx.db, w.nora.id, 'en')
  const photo = await w.upload(w.mia.client, w.dm.id, 'cat.png', PNG)
  expect(photo.kind).toBe('image')
  const m1 = await w.send(w.mia.client, w.dm.id, '', { fileIds: [photo.id] })
  expect(w.ask(await w.roomPushed(m1.id)).body).toBe('Sent a photo')
  const doc = await w.upload(w.mia.client, w.dm.id, 'report.txt', new TextEncoder().encode('numbers'))
  const m2 = await w.send(w.mia.client, w.dm.id, '', { fileIds: [doc.id] })
  expect(w.ask(await w.roomPushed(m2.id)).body).toBe('Sent a file: report.txt')
  const a = await w.upload(w.mia.client, w.dm.id, 'a.txt', new TextEncoder().encode('a'))
  const b = await w.upload(w.mia.client, w.dm.id, 'b.png', PNG)
  const m3 = await w.send(w.mia.client, w.dm.id, '', { fileIds: [a.id, b.id] })
  expect(w.ask(await w.roomPushed(m3.id)).body).toBe('Sent 2 files')
  // with text, the text
  const c = await w.upload(w.mia.client, w.dm.id, 'c.png', PNG)
  const m4 = await w.send(w.mia.client, w.dm.id, 'look at this', { fileIds: [c.id] })
  expect(w.ask(await w.roomPushed(m4.id)).body).toBe('look at this')
  // preview off: not even what was sent
  savePreferences(h.ctx.db, w.nora.id, { messagePreview: false })
  expect(w.ask(await w.roomPushed(m2.id)).body).toBe(TEXT['room.dm'].en)
})

test('never a secret: a password, a key or a one-time code keeps the generic line; safe operations: no text at all', async () => {
  const w = await world()
  for (const text of ['wifi password: Tr1na-guest!77', 'here is the key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', '인증번호 482913 입니다', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    const m = await w.send(w.mia.client, w.dm.id, text)
    const a = w.ask(await w.roomPushed(m.id))
    expect(a).toEqual({ title: 'MIA', body: TEXT['room.dm'].ko, roomId: w.dm.id })
  }
  const plain = await w.send(w.mia.client, w.dm.id, '점심 뭐 먹을까요')
  const id = await w.roomPushed(plain.id)
  expect(w.ask(id).body).toBe('점심 뭐 먹을까요')
  process.env.MYCEL_SAFE_OPS_1A = '1'
  expect(w.ask(id)).toEqual({ title: 'MIA', body: TEXT['room.dm'].ko, roomId: w.dm.id })
})

/** A chat mia shares with nora by name, and a message of mia's in it (as the chat runtime notes it). */
async function sharedChat(w: Awaited<ReturnType<typeof world>>, title: string) {
  const chat = await w.mia.client.call('POST', '/api/chats', {})
  h.ctx.db.query('UPDATE chats SET title = ? WHERE id = ?').run(title, chat.id)
  const put = (confirmKey?: string) => w.mia.client.call('PUT', `/api/chats/${chat.id}/audience`, { subjects: [{ subjectType: 'user', subjectId: w.nora.id }], ...(confirmKey ? { confirmKey } : {}) })
  let r = await put()
  if (r.status === 'confirm') r = await put(r.confirmKey)
  expect(r.status).toBe('saved')
  const row = h.ctx.db.query('SELECT id, user_id, shared_at, project_id, people_shared_at, deleted_at, room_id FROM chats WHERE id = ?').get(chat.id) as Parameters<typeof noteSharedMessage>[1]
  const say = async (content: string, attachments: unknown[] = []) => {
    const id = newId()
    h.ctx.db.query("INSERT INTO messages (id, chat_id, role, author_id, content, attachments, status) VALUES (?, ?, 'user', ?, ?, ?, 'done')").run(id, chat.id, w.mia.id, content, JSON.stringify(attachments))
    noteSharedMessage(h.ctx, row, id, w.mia.id)
    await w.tick()
    const n = h.ctx.db.query('SELECT id FROM chat_message_notices WHERE source_id = ? AND user_id = ?').get(id, w.nora.id) as { id: string } | null
    expect(n).toBeTruthy()
    return n!.id
  }
  return { chat, say }
}

test('a message in a chat shared with people: sent as a room code; who, the chat and the message; preview off: no text', async () => {
  const w = await world()
  expect(nativeCode('chat.message')).toBe('room.chat_message')
  expect(nativeCode('chat.thread_reply')).toBe('room.chat_thread')
  expect(nativeCode('room.dm')).toBe('room.dm')
  const c = await sharedChat(w, 'Launch plan')
  const id = await c.say('카피 시안 두 개 올렸어요\n확인 부탁해요')
  const push = w.sent.find((s) => s.payload.notificationId === id)!
  // the phone gets ids and a room code only: its extension asks for the words
  expect(push.payload.code).toBe('room.chat_message')
  expect(JSON.stringify(push)).not.toContain('카피')
  expect(w.ask(id)).toEqual({ title: 'MIA · Launch plan', body: '카피 시안 두 개 올렸어요 확인 부탁해요', roomId: c.chat.id })
  // files only
  setUserLocale(h.ctx.db, w.nora.id, 'en')
  const pic = await c.say('', [{ id: newId(), name: 'shot.png', path: '', size: 1, mime: 'image/png', kind: 'image', source: 'chat' }])
  expect(w.ask(pic).body).toBe('Sent a photo')
  const ref = await c.say('', [{ id: newId(), name: 'Salaries 2026.xlsx', path: 'hr/Salaries 2026.xlsx', size: 1, mime: 'application/vnd.ms-excel', kind: 'spreadsheet', source: 'team' }])
  // a team-folder file is never named (each person sees those by their own access)
  expect(w.ask(ref).body).toBe('Sent a file')
  // a secret: the generic line
  const key = await c.say('token: xoxb-1234567890-abcdefghij')
  expect(w.ask(key).body).toBe(TEXT['chat.message'].en)
  // previews off: who and where, never the text
  savePreferences(h.ctx.db, w.nora.id, { messagePreview: false })
  const off = w.ask(id)
  expect(off).toEqual({ title: 'MIA · Launch plan', body: TEXT['chat.message'].en, roomId: c.chat.id })
  expect(JSON.stringify(off)).not.toContain('카피')
})

test('a chat message: the same {} for another key, another person\'s notice, a muted or read chat', async () => {
  const w = await world()
  const c = await sharedChat(w, 'Launch plan')
  const id = await c.say('hello there')
  expect(w.ask(id).title).toBe('MIA · Launch plan')
  expect(w.ask(id, newKey())).toEqual({})
  // otto is not in the chat; a notice id that is not nora's
  const ottoKey = newKey()
  const ottoDevice = p!.registerDevice(w.otto.id, sessionOf(w.otto.id), { consent: true, platform: 'ios', environment: 'production', token: crypto.randomBytes(32).toString('hex'), labelHash: hashOf(ottoKey) })
  expect(p!.label(ottoDevice.id, { key: ottoKey, notificationId: id })).toEqual({})
  // muted: nothing
  await w.nora.client.call('POST', `/api/chats/${c.chat.id}/mute`, {})
  expect(w.ask(id)).toEqual({})
})

test('a reply in a chat thread: sent as a room code; who, the chat › Thread and the reply; preview off: no text', async () => {
  const w = await world()
  const c = await sharedChat(w, 'Launch plan')
  // a finished answer of Trina's in the chat, and a thread under it that nora follows (she replied first)
  const answer = newId()
  h.ctx.db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'assistant', 'Draft A or B?', 'done')").run(answer, c.chat.id)
  const reply = (cl: Client, text: string) => cl.call('POST', `/api/chats/${c.chat.id}/messages/${answer}/thread`, { text, clientId: cm() })
  await reply(w.nora.client, 'B 같아요')
  await reply(w.mia.client, '좋아요, B로 갈게요\n오늘 안에 정리할게요')
  const n = h.ctx.db.query('SELECT id FROM chat_thread_notices WHERE source_id = ? AND user_id = ?').get(answer, w.nora.id) as { id: string } | null
  expect(n).toBeTruthy()
  // the reply waits a little before its push (someone with the thread open reads it first)
  h.ctx.db.query('UPDATE chat_thread_notices SET push_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), n!.id)
  await w.tick()
  const push = w.sent.find((s) => s.payload.notificationId === n!.id)
  expect(push?.payload.code).toBe('room.chat_thread')
  expect(w.ask(n!.id)).toEqual({ title: 'MIA · Launch plan › 스레드', body: '좋아요, B로 갈게요 오늘 안에 정리할게요', roomId: c.chat.id, threadId: answer })
  savePreferences(h.ctx.db, w.nora.id, { messagePreview: false })
  const off = w.ask(n!.id)
  expect(off).toEqual({ title: 'MIA · Launch plan › 스레드', body: TEXT['chat.thread_reply'].ko, roomId: c.chat.id, threadId: answer })
  expect(JSON.stringify(off)).not.toContain('정리')
})
