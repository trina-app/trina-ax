// Room notices in the Inbox (docs/DECISIONS.md "알림함의 대화 알림"): mentions and replies in threads I follow are rows and
// count, a DM or "모든 메시지" message is not (it still makes its notice and push); a row is one place (a timeline, a
// thread) with who, where, why and the newest first line, counted from my place there; reading it reads the whole row;
// nothing of a message I can no longer read; the text never goes into the notice a push opens, which carries the
// title ("민준 · #마케팅 › 스레드") instead, names made one plain line.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { plainLabel } from '@mycel/shared/api'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { notificationsOf } from '../../server/src/notifications/service'
import { savePreferences } from '../../server/src/notifications/preferences'
import { roomsOf } from '../../server/src/rooms/service'
import { noticeWanted } from '../../server/src/rooms/alerts'
import { COUNT_MAX, plainMarkdown, previewLine } from '../../server/src/rooms/inbox'
import { zonedClock } from '../../shared/src/api/room-alerts'
import { addMember, harness, RecordingHub, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

const cm = () => 'cm-' + crypto.randomUUID()

async function setup() {
  h = await harness('b-rooms-inbox')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id, otto.id, pia.id] })
  // these tests send many messages: the sending budget's clock moves 2 s a send
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 2000)
  const n = notificationsOf(h.ctx)
  const rooms = async (c: Client) => (await c.call('GET', '/api/rooms')).items as any[]
  const team = (await rooms(mia.client)).find((r) => r.kind === 'team' && r.groupId === group.id)
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  const reply = (c: Client, roomId: string, rootId: string, body: string, extra: Record<string, unknown> = {}) => send(c, roomId, body, { threadRootId: rootId, ...extra })
  /** the Inbox's conversation rows, newest first, as the app gets them */
  const rows = (uid = nora.id) => n.list(uid, {}).items.filter((x) => x.code === 'room.dm' || x.code === 'room.mention')
  const notices = (uid = nora.id) => h.ctx.db.query('SELECT id, event_type, read_at FROM room_notices WHERE user_id = ? ORDER BY created_at, id').all(uid) as { id: string; event_type: string; read_at: string | null }[]
  return { owner, mia, nora, otto, pia, group, n, rooms, team, send, reply, rows, notices }
}

test('rows are mentions and replies in threads I follow; a DM or a "모든 메시지" message makes its notice and push but no row', async () => {
  const { mia, nora, otto, n, team, send, reply, rows, notices } = await setup()
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  await send(mia.client, dm.id, 'hello in the DM')
  await nora.client.call('PATCH', `/api/rooms/${team.id}`, { notifyLevel: 'all' })
  await send(mia.client, team.id, 'a plain message of an all-messages room')
  // both notices are there and would push; neither is a row, neither counts
  expect(notices().map((x) => x.event_type)).toEqual(['room.dm', 'room.dm'])
  for (const x of notices()) expect(noticeWanted(h.ctx.db, x.id)).toBe(true)
  expect(rows()).toEqual([])
  expect(n.list(nora.id, {}).unreadCount).toBe(0)
  // a mention, and a reply in a thread nora follows (she wrote the root): rows, counted
  // (nora's own message reads the room up to it: her thread's root first)
  const root = await send(nora.client, team.id, 'nora asks')
  const m = await send(mia.client, team.id, '\n  내일   회의 자료\n둘째 줄', { mentions: [nora.id] })
  const r = await reply(mia.client, team.id, root.id, 'mia answers')
  expect(rows().map((x) => [x.code, x.room?.reason, x.room?.message])).toEqual([['room.dm', 'reply', r.id], ['room.mention', 'mention', m.id]])
  expect(n.list(nora.id, {}).unreadCount).toBe(2)
  // a thread nora does not follow tells her nothing
  const other = await send(mia.client, team.id, 'mia asks')
  await reply(otto.client, team.id, other.id, 'otto answers')
  expect(rows()).toHaveLength(2)
  // a room she hides: its rows go and do not count (the notices stay; a mention brings the room back, and its rows)
  await nora.client.call('PUT', `/api/rooms/${team.id}/hidden`, { hidden: true })
  expect(rows()).toEqual([])
  expect(n.list(nora.id, {}).unreadCount).toBe(0)
})

test('a row says who, where and why with the first line; the notice a push opens has the line only while the person\'s message preview is on', async () => {
  const { mia, nora, otto, n, team, send, reply, rows } = await setup()
  const m = await send(mia.client, team.id, '\n  내일   회의 자료\n둘째 줄은 안 보여요', { mentions: [nora.id] })
  const [row] = rows()
  expect(row).toMatchObject({ code: 'room.mention', link: 'room', readAt: null, room: {
    id: team.id, from: 'MIA', fromId: mia.id, kind: 'team', name: 'design', reason: 'mention', message: m.id, preview: '내일 회의 자료', count: 1, people: 1, at: m.createdAt,
  } })
  expect(row!.room!.thread).toBeUndefined()
  expect(row!.room!.label).toBeUndefined()
  // the single notice (GET /api/notifications/:id, what a push opens): who and where as the title, and the first line
  // as the body while the message preview is on (the default)
  expect(n.get(nora.id, row!.id).room!.preview).toBe('내일 회의 자료')
  // and its place, for a notification's "Mark as read"
  expect(n.get(nora.id, row!.id).room!.seq).toBe(m.seq)
  // off: no text
  savePreferences(h.ctx.db, nora.id, { messagePreview: false })
  const one = n.get(nora.id, row!.id)
  expect(one.room).toMatchObject({ id: team.id, from: 'MIA', reason: 'mention', message: m.id })
  expect(one.room!.label).toMatch(/^MIA · #design$/)
  expect(one.room!.preview).toBeUndefined()
  expect(JSON.stringify(one)).not.toContain('회의')
  expect(JSON.stringify(n.read(nora.id, row!.id))).not.toContain('회의')
  // in a thread: "› 스레드" in the person's language; a DM: the person alone
  const root = await send(nora.client, team.id, 'root')
  await reply(otto.client, team.id, root.id, 'SECRET reply text')
  const thread = rows()[0]!
  expect(n.get(nora.id, thread.id).room!.label).toMatch(/^OTTO · #design › (스레드|Thread)$/)
  expect(JSON.stringify(n.get(nora.id, thread.id))).not.toContain('SECRET')
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  await send(mia.client, dm.id, '@NORA in a DM', { mentions: [nora.id] })
  const inDm = rows().find((x) => x.room?.id === dm.id)!
  expect(inDm.room).toMatchObject({ kind: 'dm', name: null, reason: 'mention' })
  expect(n.get(nora.id, inDm.id).room!.label).toBe('MIA')
  // "@전체": everyone for those not picked by name, a mention for the one picked as well
  const all = await send(mia.client, team.id, '@전체 @NORA 공지', { mentionsAll: true, mentions: [nora.id] })
  expect(rows(otto.id).find((x) => x.room?.message === all.id)?.room).toMatchObject({ reason: 'everyone', preview: '@전체 @NORA 공지' })
  expect(rows(nora.id).find((x) => x.room?.message === all.id)?.room).toMatchObject({ reason: 'mention' })
  expect(previewLine('   \n\t ')).toBe('')
  expect(previewLine('x'.repeat(500))).toHaveLength(200)
})

test('one row per place: a thread\'s mention and replies, a timeline\'s mentions; counted from my place; reading it reads them all', async () => {
  const { mia, nora, otto, pia, n, team, send, reply, rows, notices } = await setup()
  const root = await send(nora.client, team.id, '분기 계획')
  const r1 = await reply(mia.client, team.id, root.id, '첫 답글')
  await reply(otto.client, team.id, root.id, '@NORA 이거 봐 주세요', { mentions: [nora.id] })
  const r3 = await reply(pia.client, team.id, root.id, '세 번째 답글\n자세히')
  const t1 = await send(mia.client, team.id, '@NORA 하나', { mentions: [nora.id] })
  // the run of mentions in the timeline: the second is held back by the first (one notice), still counted
  const t2 = await send(otto.client, team.id, '@NORA 둘', { mentions: [nora.id] })
  expect(notices().map((x) => x.event_type).sort()).toEqual(['room.dm', 'room.mention', 'room.mention'])
  const list = rows()
  expect(list).toHaveLength(2)
  expect(list[0]!.room!.thread).toBeUndefined()
  expect(list[0]!.room).toMatchObject({ id: team.id, reason: 'mention', from: 'OTTO', message: t1.id, preview: '@NORA 둘', count: 2, people: 2, at: t2.createdAt })
  expect(list[1]!.room).toMatchObject({ thread: root.id, reason: 'mention', from: 'PIA', message: r1.id, preview: '세 번째 답글', count: 3, people: 3, at: r3.createdAt })
  expect(n.list(nora.id, {}).unreadCount).toBe(2)
  // pages follow the rows' order
  const first = n.list(nora.id, { limit: 1 })
  expect(first.items.map((x) => x.id)).toEqual([list[0]!.id])
  expect(n.list(nora.id, { limit: 1, cursor: first.nextCursor! }).items.map((x) => x.id)).toEqual([list[1]!.id])
  // reading the thread's row reads both its notices, at one time: one read row, as it was
  n.read(nora.id, list[1]!.id)
  expect(notices().filter((x) => !x.read_at).map((x) => x.event_type)).toEqual(['room.mention'])
  const read = rows().find((x) => x.room?.thread === root.id)!
  expect(read).toMatchObject({ readAt: expect.any(String), room: { count: 3, people: 3, message: r1.id } })
  expect(rows().filter((x) => x.room?.thread === root.id)).toHaveLength(1)
  expect(n.list(nora.id, {}).unreadCount).toBe(1)
  // the next reply is a new row, counted from her place in the thread
  await nora.client.call('POST', `/api/rooms/${team.id}/messages/${root.id}/thread/read`, { seq: 9999 })
  const again = await reply(mia.client, team.id, root.id, '다시 시작')
  expect(rows()[0]!.room).toMatchObject({ thread: root.id, reason: 'reply', count: 1, message: again.id, from: 'MIA' })
  // reading the room reads the timeline's row (as before), not the thread's
  await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 9999 })
  expect(rows().filter((x) => !x.readAt).map((x) => x.room?.thread)).toEqual([root.id])
})

test('a run split by quiet hours is one row; reading it reads both notices', async () => {
  const { mia, nora, n, team, send, reply, rows, notices } = await setup()
  const root = await send(nora.client, team.id, 'root')
  updateTeamSettings(h.ctx.db, { timeZone: 'Asia/Seoul' })
  const m = zonedClock(Date.now(), 'Asia/Seoul').minute
  const hhmm = (x: number) => { const v = ((x % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}` }
  await nora.client.call('PATCH', '/api/notification-preferences', { quietHours: { on: true, start: hhmm(m - 60), end: hhmm(m + 60), weekends: false } })
  const night = await reply(mia.client, team.id, root.id, '밤에')
  await nora.client.call('PATCH', '/api/notification-preferences', { quietHours: { on: false, start: '22:00', end: '08:00', weekends: false } })
  await reply(mia.client, team.id, root.id, '아침에')
  const latest = await reply(mia.client, team.id, root.id, '아침에 또')
  expect((h.ctx.db.query('SELECT quiet FROM room_notices WHERE user_id = ? AND read_at IS NULL ORDER BY created_at, id').all(nora.id) as { quiet: number }[]).map((r) => r.quiet)).toEqual([1, 0])
  const list = rows()
  expect(list).toHaveLength(1)
  expect(list[0]!.room).toMatchObject({ message: night.id, count: 3, preview: '아침에 또', at: latest.createdAt })
  expect(n.list(nora.id, {}).unreadCount).toBe(1)
  n.read(nora.id, list[0]!.id)
  expect(notices().filter((x) => !x.read_at)).toEqual([])
  expect(rows()).toHaveLength(1)
})

test('only what the person may read: nothing after leaving, for an archived room, a deleted message; a deleted first reply keeps the rest', async () => {
  const { owner, mia, nora, otto, pia, group, n, team, send, reply, rows } = await setup()
  // a group chat nora leaves: her notices of it go
  const g = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name: 'SECRET PLANS' })
  await send(mia.client, g.id, '@NORA SECRET LINE', { mentions: [nora.id] })
  expect(rows().some((x) => x.room?.id === g.id)).toBe(true)
  await nora.client.call('POST', `/api/rooms/${g.id}/leave`)
  expect(JSON.stringify(n.list(nora.id, {}))).not.toContain('SECRET')
  // a team room she is taken out of (out of the group): its notices go too
  await send(mia.client, team.id, '@NORA TEAM SECRET', { mentions: [nora.id] })
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, otto.id, pia.id] })
  roomsOf(h.ctx).sync()
  expect(JSON.stringify(n.list(nora.id, {}))).not.toContain('SECRET')
  // a room archived while its notice stays: no row, no count (a push that opens the notice gets no room)
  const kept = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name: 'ARCHIVED NAME' })
  await send(mia.client, kept.id, '@OTTO ARCHIVED LINE', { mentions: [otto.id] })
  const before = n.list(otto.id, {}).unreadCount
  const id = (h.ctx.db.query('SELECT id FROM room_notices WHERE user_id = ? AND room_id = ?').get(otto.id, kept.id) as { id: string }).id
  h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), kept.id)
  expect(JSON.stringify(n.list(otto.id, {}))).not.toContain('ARCHIVED')
  expect(n.list(otto.id, {}).unreadCount).toBe(before - 1)
  expect(n.get(otto.id, id)).toMatchObject({ link: null })
  expect(n.get(otto.id, id).room).toBeUndefined()
  // a deleted mention: its notice goes; a deleted first reply of a run: the rest of the run keeps the row
  const gone = await send(otto.client, team.id, '@MIA GONE', { mentions: [mia.id] })
  await otto.client.call('DELETE', `/api/rooms/${team.id}/messages/${gone.id}`)
  expect(JSON.stringify(n.list(mia.id, {}))).not.toContain('GONE')
  const root = await send(mia.client, team.id, 'root')
  const one = await reply(otto.client, team.id, root.id, 'GONE first')
  await reply(otto.client, team.id, root.id, 'second')
  const third = await reply(pia.client, team.id, root.id, 'third')
  await otto.client.call('DELETE', `/api/rooms/${team.id}/messages/${one.id}`)
  const rest = rows(mia.id).find((x) => x.room?.thread === root.id)!
  expect(rest.room).toMatchObject({ count: 2, people: 2, preview: 'third', at: third.createdAt })
  expect(JSON.stringify(rest)).not.toContain('GONE')
  const lone = await send(mia.client, team.id, 'lone root')
  const only = await reply(otto.client, team.id, lone.id, 'ONLY ONE')
  await otto.client.call('DELETE', `/api/rooms/${team.id}/messages/${only.id}`)
  expect(rows(mia.id).some((x) => x.room?.thread === lone.id)).toBe(false)
})

test('a member who joined a team room after a thread\'s root sees it, so a mention there is a row (docs/DECISIONS.md "지난 대화"); an AI answer in a row says it is the AI', async () => {
  const { owner, mia, nora, otto, pia, group, n, team, send, reply, rows } = await setup()
  const root = await send(mia.client, team.id, 'root before')
  await reply(nora.client, team.id, root.id, 'nora replies')
  const quin = await addMember(h, owner, { username: 'quin' })
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, nora.id, otto.id, pia.id, quin.id] })
  roomsOf(h.ctx).sync()
  await reply(otto.client, team.id, root.id, '@QUIN LATE REPLY', { mentions: [quin.id] })
  expect(JSON.stringify(n.list(quin.id, {}))).toContain('LATE')
  // an AI answer in the thread (written here as the AI would be): the row names the AI, no person
  const seq = (h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(team.id) as { last_seq: number }).last_seq
  const aiId = crypto.randomUUID()
  h.ctx.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, body, mentions, created_at, thread_root_id, thread_root_seq)
    VALUES (?, ?, ?, 'ai', NULL, ?, 'room', '**요약**: 세 가지', '[]', ?, ?, ?)`).run(aiId, team.id, seq, otto.id, new Date().toISOString(), root.id, root.seq)
  roomsOf(h.ctx).notify(h.ctx.db.query('SELECT * FROM room_messages WHERE id = ?').get(aiId) as any)
  const row = rows(mia.id).find((x) => x.room?.thread === root.id)!
  expect(row.room).toMatchObject({ ai: true, fromId: null, from: null, preview: '요약: 세 가지', people: 3, count: 3 })
  // the notice a push opened was the run's first reply's
  expect(n.get(mia.id, row.id).room!.label).toMatch(/^NORA · #design › (스레드|Thread)$/)
  // otto asked it: the answer is not news to him
  expect(rows(otto.id).some((x) => x.room?.thread === root.id && !x.readAt)).toBe(false)
})

test('names are one plain line: no control or bidirectional characters, no line breaks, capped', async () => {
  const { owner, nora, group, n, team, send, rows } = await setup()
  expect(plainLabel('A‮evil⁦x⁩​\nB\tC\u0007')).toBe('Aevilx B C')
  expect(plainLabel('👩‍💻 dev')).toBe('👩‍💻 dev')
  expect([...plainLabel('가'.repeat(120), 80)]).toHaveLength(80)
  const eve = await addMember(h, owner, { username: 'eve' })
  h.ctx.db.query('UPDATE users SET name = ? WHERE id = ?').run('Eve‮\nlive⁩', eve.id)
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [eve.id, nora.id] })
  roomsOf(h.ctx).sync()
  await send(eve.client, team.id, '@NORA hi‮ there', { mentions: [nora.id] })
  const row = rows().find((x) => x.room?.id === team.id)!
  expect(row.room).toMatchObject({ from: 'Eve live', preview: '@NORA hi there' })
  expect(n.get(nora.id, row.id).room!.label).toBe('Eve live · #design')
})

test('review fixes: a read that stops inside a run keeps it unread; the count is read again when rows go or come; the count is capped; an edited-away mention', async () => {
  const { mia, nora, otto, n, team, send, reply, rows } = await setup()
  const hub = new RecordingHub()
  h.ctx.services.realtime = hub
  const changed = (uid: string) => hub.events.filter((e) => e.target === uid && (e.data as any)?.data?.code === 'notifications.changed').length
  // a mention at 1, a plain message, a mention at 3 (held back by the first): a read up to the plain message keeps the
  // row unread and counts what is left
  const m1 = await send(mia.client, team.id, '@NORA one', { mentions: [nora.id] })
  const plain = await send(mia.client, team.id, 'plain')
  const m3 = await send(otto.client, team.id, '@NORA three', { mentions: [nora.id] })
  await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: plain.seq })
  expect(n.list(nora.id, {}).unreadCount).toBe(1)
  expect(rows()[0]).toMatchObject({ readAt: null, room: { count: 1, message: m3.id, preview: '@NORA three' } })
  await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: m3.seq })
  expect(n.list(nora.id, {}).unreadCount).toBe(0)
  expect(rows()[0]).toMatchObject({ readAt: expect.any(String), room: { count: 2, message: m1.id } })
  // hiding the room and showing it again: the Inbox's count is told to read again each time
  await send(mia.client, team.id, '@NORA again', { mentions: [nora.id] })
  const before = changed(nora.id)
  await nora.client.call('PUT', `/api/rooms/${team.id}/hidden`, { hidden: true })
  expect(changed(nora.id)).toBe(before + 1)
  expect(n.list(nora.id, {}).unreadCount).toBe(0)
  await nora.client.call('PUT', `/api/rooms/${team.id}/hidden`, { hidden: false })
  expect(changed(nora.id)).toBe(before + 2)
  expect(n.list(nora.id, {}).unreadCount).toBe(1)
  // the notice a push opens has no room while the room is hidden
  await nora.client.call('PUT', `/api/rooms/${team.id}/hidden`, { hidden: true })
  expect(n.get(nora.id, rows().length ? rows()[0]!.id : (h.ctx.db.query('SELECT id FROM room_notices WHERE user_id = ? AND read_at IS NULL').get(nora.id) as { id: string }).id).room).toBeUndefined()
  await nora.client.call('PUT', `/api/rooms/${team.id}/hidden`, { hidden: false })
  // leaving a group chat: told too
  const g = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  await send(mia.client, g.id, '@NORA in the group', { mentions: [nora.id] })
  const left = changed(nora.id)
  await nora.client.call('POST', `/api/rooms/${g.id}/leave`)
  expect(changed(nora.id)).toBeGreaterThan(left)
  // a long run of replies counts at most COUNT_MAX
  const root = await send(nora.client, team.id, 'a long thread')
  for (let i = 0; i < COUNT_MAX + 5; i++) await reply(i % 2 ? mia.client : otto.client, team.id, root.id, `reply ${i}`)
  const long = rows().find((x) => x.room?.thread === root.id)!
  expect(long.room).toMatchObject({ count: COUNT_MAX, people: 2, preview: `reply ${COUNT_MAX + 4}` })
  // a mention edited away: the row is no longer a mention
  await nora.client.call('POST', `/api/rooms/${team.id}/read`, { seq: 99999 })
  const e = await send(mia.client, team.id, '@NORA soon edited', { mentions: [nora.id] })
  expect(rows().find((x) => x.sourceId === e.id)?.room?.reason).toBe('mention')
  await mia.client.call('PATCH', `/api/rooms/${team.id}/messages/${e.id}`, { body: 'nothing for nora', mentions: [] })
  expect(rows().find((x) => x.sourceId === e.id)?.room).toMatchObject({ reason: 'message', preview: 'nothing for nora' })
  expect(n.get(nora.id, rows().find((x) => x.sourceId === e.id)!.id).room?.reason).toBe('message')
  // an answer's Markdown is one plain line
  expect(plainMarkdown('## 제목\n- **굵게** `code` [링크](https://example.test)')).toBe('제목\n굵게 code 링크')
})
