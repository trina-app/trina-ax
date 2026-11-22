// QA S-120 (docs/decisions/20261122-room-link-ask-and-team-file-names.md): a linked team file in a room post.
// The poster's card: a file the asker's own AI made in a group folder in an earlier answer is theirs to share (the card
// names who cannot open it and Send lets them view it); a teammate's file in a team folder the asker reads stays a
// link, and the card now NAMES the room members who cannot open it (the folder's rule); a teammate's personal file
// reached only through a share keeps the count. The viewer's side: GET/POST /api/rooms/:id/messages/:messageId/file-access
// (rooms/file-ask.ts) answers ask / asked / open / no, and the ask is an ordinary file access request.
// The fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner (b-harness people).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type Room, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { fileSharesOf } from '../../server/src/files/shares'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const post = (args: Record<string, unknown>) => fake({ tool: 'post_to_room', args, sayResult: true })

let h: Harness
const socks: Record<string, TestSocket> = {}
let rooms: { all: string; marketing: string }
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-room-link-ask', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  const alice = (await h.api('alice').call(API.listRooms)).items as Room[]
  rooms = { all: alice.find((r) => r.kind === 'all')!.id, marketing: alice.find((r) => r.kind === 'team' && r.name === 'Marketing')!.id }
  socks.alice = await h.ws('alice', { windowId: 'win-rla-alice' })
  await socks.alice.next('hello')
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

type Card = { question: string; options?: { label: string; value: string }[] }
async function turn(user: string, content: string, o: { chat?: string; answer?: string } = {}) {
  const chatId = o.chat ?? (await h.api(user).call(API.createChat, { body: {} })).id
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  let card = null as Card | null
  if (o.answer !== undefined) {
    const c = await socks[user]!.next('turn.request', (f) => f.data.turnId === r.turnId)
    card = c.data.request as unknown as Card
    await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: o.answer } })
  }
  const done = await socks[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  return { chatId, content: done.data.message.content as string, card }
}
const put = (rel: string, body: string) => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }
const wroteIt = (user: string, rel: string) => h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action) VALUES (NULL, ?, ?, 'create')").run(user, rel)
const link = (rel: string) => `[${rel.slice(rel.lastIndexOf('/') + 1)}](/files/view?path=${encodeURIComponent(rel)})`
const lastIn = async (roomId: string) => ((await h.api('alice').call(API.listRoomMessages, { params: { id: roomId }, query: {} })).items as RoomMessage[]).at(-1)!

describe('the poster\'s card', () => {
  test('root cause: a file my AI made in a group folder in an earlier answer is mine to share; the card names who cannot open it', async () => {
    const rel = 'groups/marketing/q3-summary-120.md'
    const made = await turn('alice', fake({ tool: 'write', args: { file_path: rel, content: '# Q3 summary\n' }, sayResult: true }))
    // the AI's write records alice as the file's maker (files/shares.ts creatorOf): she owns it and may share it
    expect(fileSharesOf(h.ctx).view('alice', rel, 'en')).toMatchObject({ canShare: true, mine: true })
    const r = await turn('alice', post({ room: rooms.all, text: `Q3: ${link(rel)}` }), { chat: made.chatId, answer: 'no' })
    expect(r.card!.question).toContain("Bob Lee can't open the file yet; sending shares it with them.")
  })

  test('a teammate\'s file in a team folder I read: still a link, but the card names the room members who cannot open it', async () => {
    const rel = 'groups/marketing/erins-plan-120.md'
    put(rel, '# Erin\'s plan'); wroteIt('erin', rel)
    const r = await turn('alice', [fake({ tool: 'read', args: { file_path: rel } }), post({ room: rooms.all, text: `Plan: ${link(rel)}` })].join('\n'), { answer: 'send' })
    expect(r.card!.options!.map((x) => x.value).filter((v) => v !== '__always')).toEqual(['send', 'no'])
    expect(r.card!.question).toContain("Bob Lee can't open the linked file.")
    expect((await lastIn(rooms.all)).files).toEqual([])
    // Ask <owner> follows the post, and the AI is told the people there can ask from the link themselves
    const out = JSON.parse(r.content)
    expect(out.cannot_open).toContain('Ask Erin Yoo')
    expect(out.cannot_open).toContain('Ask to view')
  })

  test('in Korean the AI is told the room link\'s button by its Korean label ("보기 요청"), never "Ask to view"', async () => {
    const rel = 'groups/marketing/erins-plan-ko-120.md'
    put(rel, '# 계획'); wroteIt('erin', rel)
    const was = (h.ctx.db.query('SELECT locale FROM users WHERE id = ?').get('alice') as { locale: string | null }).locale
    h.ctx.db.query("UPDATE users SET locale = 'ko' WHERE id = 'alice'").run()
    try {
      const r = await turn('alice', [fake({ tool: 'read', args: { file_path: rel } }), post({ room: rooms.all, text: `계획: ${link(rel)}` })].join('\n'), { answer: 'send' })
      const out = JSON.parse(r.content)
      expect(out.cannot_open).toContain('"보기 요청"')
      expect(out.cannot_open).not.toContain('Ask to view')
    } finally { h.ctx.db.query('UPDATE users SET locale = ? WHERE id = ?').run(was, 'alice') }
  })

  test('a teammate\'s personal file I have only through a share: a count, nobody named', async () => {
    const rel = 'users/erin/notes-120.md'
    put(rel, '# Erin notes'); wroteIt('erin', rel)
    fileSharesOf(h.ctx).change('erin', rel, [{ subjectType: 'user', subjectId: 'alice' }], [], 'en')
    const id = fileSharesOf(h.ctx).liveRow(rel)!.id
    const r = await turn('alice', [fake({ tool: 'read', args: { file_path: rel } }), post({ room: rooms.all, text: `Notes: /f/${id}` })].join('\n'), { answer: 'no' })
    expect(r.card!.question).toContain("3 people there can't open notes-120.md")
    expect(r.card!.question).not.toContain('Bob')
    expect(r.card!.question).not.toContain('Carol')
  })

  test('a file in a group folder I am not in, shared with me one by one: a count, nobody named', async () => {
    const rel = 'groups/finance/bobs-forecast-120.md'
    put(rel, '# Forecast'); wroteIt('bob', rel)
    fileSharesOf(h.ctx).change('bob', rel, [{ subjectType: 'user', subjectId: 'alice' }], [], 'en')
    const r = await turn('alice', [fake({ tool: 'read', args: { file_path: rel } }), post({ room: rooms.all, text: `Forecast: ${link(rel)}` })].join('\n'), { answer: 'no' })
    expect(r.card!.question).toContain("4 people can't open 1 linked file.")
    expect(r.card!.question).not.toContain('Erin')
    expect(r.card!.question).not.toContain('Carol')
  })
})

describe('the viewer\'s ask (rooms/file-ask.ts)', () => {
  const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as { status?: number; code?: string } } throw new Error('expected an error') }
  const send = async (user: string, roomId: string, body: string) => (await h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: [], fileIds: [] } })) as RoomMessage
  const view = (user: string, roomId: string, messageId: string, p: string) => h.api(user).call(API.roomFileAccess, { params: { id: roomId, messageId }, query: { path: p } })
  const ask = (user: string, roomId: string, messageId: string, p: string) => h.api(user).call(API.requestRoomFile, { params: { id: roomId, messageId }, body: { path: p } })

  test('ask, asked, and the owner\'s Share lets them open it; the generic answerer for a file the poster does not own', async () => {
    const rel = 'groups/marketing/erin-deck-120.md'
    put(rel, '# Deck'); wroteIt('erin', rel)
    const m = await send('alice', rooms.all, `Deck: ${link(rel)}`)
    // bob (finance) cannot read marketing: he may ask; erin answers, who is not the poster, so nobody is named
    expect(await view('bob', rooms.all, m.id, rel)).toEqual({ status: 'ask', by: null })
    const sent = await ask('bob', rooms.all, m.id, rel)
    expect(sent.status).toBe('sent')
    expect(await view('bob', rooms.all, m.id, rel)).toMatchObject({ status: 'asked', by: null })
    expect((await ask('bob', rooms.all, m.id, rel)).status).toBe('already')
    // an ordinary file request, audited, with the owner's Activity row
    const q = h.ctx.db.query("SELECT r.id FROM file_access_requests r JOIN file_shares s ON s.id = r.share_id WHERE s.path = ? AND r.requester_id = 'bob' AND r.state = 'pending'").get(rel) as { id: string }
    expect(q).toBeTruthy()
    expect(h.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'file.access_request' AND actor_id = 'bob'").get()).toBeTruthy()
    expect(h.ctx.db.query("SELECT 1 FROM file_share_notices WHERE user_id = 'erin' AND event_type = 'file.access_requested'").get()).toBeTruthy()
    // erin shares it: bob opens it by its link now
    expect(fileSharesOf(h.ctx).answer('erin', q.id, 'approve', 'en')).toEqual({ state: 'approved' })
    const open = await view('bob', rooms.all, m.id, rel)
    expect(open.status).toBe('open')
    expect(open.status === 'open' && open.link).toBe(fileSharesOf(h.ctx).liveRow(rel)!.id)
  })

  test('the poster\'s own file: the answerer is named (the viewer sees the poster anyway); someone who reads it gets open', async () => {
    const rel = 'groups/marketing/alice-sheet-120.md'
    put(rel, '# Sheet'); wroteIt('alice', rel)
    const m = await send('alice', rooms.all, `Sheet: ${link(rel)}`)
    expect(await view('bob', rooms.all, m.id, rel)).toEqual({ status: 'ask', by: 'Alice Kim' })
    expect(await view('erin', rooms.all, m.id, rel)).toEqual({ status: 'open' })
  })

  test('a GET never makes the link row; the POST does', async () => {
    const rel = 'groups/marketing/no-row-yet-120.md'
    put(rel, '# No row'); wroteIt('erin', rel)
    const m = await send('alice', rooms.all, `New: ${link(rel)}`)
    expect(await view('bob', rooms.all, m.id, rel)).toEqual({ status: 'ask', by: null })
    expect(fileSharesOf(h.ctx).liveRow(rel)).toBeNull()
    expect((await ask('bob', rooms.all, m.id, rel)).status).toBe('sent')
    expect(fileSharesOf(h.ctx).liveRow(rel)).toBeTruthy()
  })

  test('a poster who cannot read the linked file: no, also when the file already has a link row (no probing)', async () => {
    const rel = 'groups/finance/bob-ledger-120.md'
    put(rel, '# Ledger'); wroteIt('bob', rel)
    // the file has a live link row (bob made its link)
    fileSharesOf(h.ctx).linkFor('bob', rel)
    expect(fileSharesOf(h.ctx).liveRow(rel)).toBeTruthy()
    // alice (marketing) cannot read finance, yet posts a link to it; erin (marketing) must learn nothing from it
    const m = await send('alice', rooms.all, `Ledger: ${link(rel)}`)
    expect(await view('erin', rooms.all, m.id, rel)).toEqual({ status: 'no' })
    expect((await errOf(ask('erin', rooms.all, m.id, rel))).status).toBe(404)
    expect(h.ctx.db.query("SELECT 1 FROM file_access_requests r JOIN file_shares s ON s.id = r.share_id WHERE s.path = ? AND r.requester_id = 'erin'").get(rel)).toBeNull()
    // the same path with no row at all: the same answer
    const rel2 = 'groups/finance/bob-ledger2-120.md'
    put(rel2, '# Ledger 2'); wroteIt('bob', rel2)
    const m2 = await send('alice', rooms.all, `Ledger: ${link(rel2)}`)
    expect(await view('erin', rooms.all, m2.id, rel2)).toEqual({ status: 'no' })
    expect((await errOf(ask('erin', rooms.all, m2.id, rel2))).status).toBe(404)
  })

  test('no: a path not linked in that message, a message I cannot see, a deleted message, a guest; a room I am not in: its 404', async () => {
    const rel = 'groups/marketing/hidden-120.md', other = 'groups/marketing/other-120.md'
    put(rel, '# Hidden'); put(other, '# Other'); wroteIt('erin', rel); wroteIt('erin', other)
    const m = await send('alice', rooms.all, `Look: ${link(rel)}`)
    // a path the message does not link (even one that exists), and one that does not exist at all: the same answer
    expect(await view('bob', rooms.all, m.id, other)).toEqual({ status: 'no' })
    expect(await view('bob', rooms.all, m.id, 'groups/marketing/nothing-here.md')).toEqual({ status: 'no' })
    expect(await view('bob', rooms.all, m.id, 'groups/finance/budget.md')).toEqual({ status: 'no' })
    expect((await errOf(ask('bob', rooms.all, m.id, other))).status).toBe(404)
    // a message of a room bob is not in (the Marketing room)
    const inMkt = await send('alice', rooms.marketing, `Look: ${link(rel)}`)
    expect((await errOf(view('bob', rooms.marketing, inMkt.id, rel))).status).toBe(404)
    expect((await errOf(ask('bob', rooms.marketing, inMkt.id, rel))).status).toBe(404)
    // a message id from another room under this room
    expect(await view('bob', rooms.all, inMkt.id, rel)).toEqual({ status: 'no' })
    // a message from before bob could see the room's history (seesFrom): set his view to start after it
    const before = await send('alice', rooms.all, `Earlier: ${link(rel)}`)
    const seq = (h.ctx.db.query('SELECT seq FROM room_messages WHERE id = ?').get(before.id) as { seq: number }).seq
    const was = h.ctx.db.query('SELECT visible_from_seq, history_from_seq FROM room_members WHERE room_id = ? AND user_id = ?').get(rooms.all, 'bob') as { visible_from_seq: number; history_from_seq: number | null }
    h.ctx.db.query('UPDATE room_members SET visible_from_seq = ?, history_from_seq = ? WHERE room_id = ? AND user_id = ?').run(seq, seq, rooms.all, 'bob')
    try { expect(await view('bob', rooms.all, before.id, rel)).toEqual({ status: 'no' }) } finally {
      h.ctx.db.query('UPDATE room_members SET visible_from_seq = ?, history_from_seq = ? WHERE room_id = ? AND user_id = ?').run(was.visible_from_seq, was.history_from_seq, rooms.all, 'bob')
    }
    expect((await view('bob', rooms.all, before.id, rel)).status).toBe('ask')
    // deleted
    const gone = await send('alice', rooms.all, `Gone: ${link(rel)}`)
    await h.api('alice').call(API.deleteRoomMessage, { params: { id: rooms.all, messageId: gone.id } })
    expect(await view('bob', rooms.all, gone.id, rel)).toEqual({ status: 'no' })
    // a guest never asks
    h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run('bob')
    try {
      const r = await view('bob', rooms.all, m.id, rel).catch((e) => e as { status?: number })
      expect('status' in r && (r.status === 'no' || r.status === 403 || r.status === 404)).toBe(true)
    } finally { h.ctx.db.query('UPDATE users SET guest = 0 WHERE id = ?').run('bob') }
    expect((await view('bob', rooms.all, m.id, rel)).status).toBe('ask')
  })
})
