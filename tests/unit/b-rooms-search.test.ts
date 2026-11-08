// ⌘K search of room messages (docs/DECISIONS.md "⌘K에서 대화방 메시지 찾기"): a hit is only a message the person would
// see by opening its room now (rooms/store.ts canSee): rooms they are in, a later member's view (group chats and 1:1s
// from their join, team rooms their whole history), never an old answer hidden from them nor its thread, nothing after
// leaving, nothing deleted or edited away. Korean by part of a word, newest first, in pages. And the timeline's page
// around a message (ListRoomMessagesQuery.around), which a hit opens. The fixture team: alice and erin in marketing, bob
// in finance, carol admin, dana owner. Rows are written straight into the database where the sending budget or the AI
// engine is not the point.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { API, uuidv7, type RoomMessage, type RoomSearchPage } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { searchRoomMessages, snippetOf } from '../../server/src/rooms/search'
import { canSee, memberRow, MSG_COLS, SEE_MEMBER_SQL, type MessageRow } from '../../server/src/rooms/store'
import { vacuumInto } from '../../server/src/system/backup'
import { migrate, openDb, readMigrations } from '../../server/src/db'
import type { ReadSource } from '../../server/src/chat/read-scope'

setDefaultTimeout(120_000)
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-rooms-search' })
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  // ten seconds a call: the sending budget never runs out here
  roomsOf(h.ctx).clock = () => (clock += 10_000)
})
afterAll(async () => { await h.close() })

let groups = 0
/** a team room of its own: a new group with these people */
async function teamRoom(memberIds: string[]): Promise<{ roomId: string; groupId: string }> {
  const g = await h.api('dana').call(API.createGroup, { body: { name: `search-${++groups}`, memberIds } })
  const r = (await h.api(memberIds[0]!).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)
  if (!r) throw new Error('no team room')
  return { roomId: r.id, groupId: g.id }
}
const setMembers = (groupId: string, memberIds: string[]) => h.api('dana').call(API.updateGroup, { params: { id: groupId }, body: { memberIds } })
const groupChat = async (by: string, others: string[]) => (await h.api(by).call(API.createRoom, { body: { kind: 'group', userIds: others } })).id
const dm = async (by: string, other: string) => (await h.api(by).call(API.createRoom, { body: { kind: 'dm', userId: other } })).id
const send = (user: string, roomId: string, body: string, extra: Record<string, unknown> = {}) =>
  h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: [], fileIds: [], ...extra } }) as Promise<RoomMessage>
const search = (user: string, q: string, extra: { cursor?: string; limit?: number } = {}) => h.api(user).call(API.searchRoomMessages, { query: { q, ...extra } }) as Promise<RoomSearchPage>
const bodies = (p: RoomSearchPage) => p.items.map((i) => i.snippet)
/** the raw JSON a search answers (to look for text that must never be in it) */
const rawSearch = async (user: string, q: string) => (await h.req(user, `/api/room-messages?q=${encodeURIComponent(q)}`)).text()
const folder = (p: string): ReadSource => ({ type: 'folder', id: (h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string }).id })
const next = (roomId: string) => (h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
/** a message straight into the database (no sending budget): a person's, or a private preview for `privateTo` */
function put(roomId: string, author: string, body: string, o: { privateTo?: string; at?: string } = {}): string {
  const id = uuidv7()
  h.ctx.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, visible_to, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`)
    .run(id, roomId, next(roomId), o.privateTo ? 'ai' : 'user', o.privateTo ? null : author, o.privateTo ? 'private' : 'room', o.privateTo ?? null, body, o.at ?? new Date().toISOString())
  return id
}
/** An AI answer to `asker`'s question with the question's scope, straight into the database (rooms/history.ts judges it
 * for later members): the question, the answer for the whole room, and the turn row. */
function aiAnswer(roomId: string, asker: string, body: string, scope: { sources: ReadSource[] }) {
  const db = h.ctx.db, now = new Date().toISOString()
  const qid = uuidv7(), aid = uuidv7()
  db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'user', ?, 'room', ?, '[]', ?)`)
    .run(qid, roomId, next(roomId), asker, '@트리나 what does it say?', now)
  db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, body, reply_to_id, mentions, created_at) VALUES (?, ?, ?, 'ai', NULL, ?, 'room', ?, ?, '[]', ?)`)
    .run(aid, roomId, next(roomId), asker, body, qid, now)
  db.query(`INSERT INTO room_ai_turns (turn_id, room_id, user_id, chat_id, question_id, status, answer_id, scope, created_at, ended_at) VALUES (?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?)`)
    .run(uuidv7(), roomId, asker, uuidv7(), qid, aid, JSON.stringify({ outside: false, ...scope }), now, now)
  return { questionId: qid, answerId: aid }
}

describe('who sees a hit', () => {
  test('a non-member gets nothing, an owner and an admin included', async () => {
    const { roomId } = await teamRoom(['alice', 'erin'])
    await send('alice', roomId, 'NONMEMBER-CANARY 견적서')
    expect(bodies(await search('alice', 'NONMEMBER-CANARY'))).toEqual(['NONMEMBER-CANARY 견적서'])
    expect(bodies(await search('erin', 'nonmember-canary'))).toEqual(['NONMEMBER-CANARY 견적서'])
    for (const u of ['bob', 'carol', 'dana']) {
      expect(await search(u, 'NONMEMBER-CANARY')).toEqual({ items: [], rooms: [], nextCursor: null })
      expect(await rawSearch(u, 'CANARY')).not.toContain('NONMEMBER')
    }
  })

  test('after leaving a group chat, or being taken out of a team room, nothing', async () => {
    const chat = await groupChat('alice', ['bob', 'erin'])
    await send('bob', chat, 'LEFT-CANARY in the group chat')
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    await send('alice', roomId, 'LEFT-CANARY in the team room')
    expect(bodies(await search('erin', 'LEFT-CANARY')).sort()).toEqual(['LEFT-CANARY in the group chat', 'LEFT-CANARY in the team room'])
    await h.api('erin').call(API.leaveRoom, { params: { id: chat } })
    expect(bodies(await search('erin', 'LEFT-CANARY'))).toEqual(['LEFT-CANARY in the team room'])
    await setMembers(groupId, ['alice'])
    expect((await search('erin', 'LEFT-CANARY')).items).toEqual([])
    expect(await rawSearch('erin', 'CANARY')).not.toContain('LEFT-CANARY')
    // the others keep theirs
    expect((await search('alice', 'LEFT-CANARY')).items).toHaveLength(2)
  })

  test('a later member of a group chat finds nothing from before they joined, nor a later reply in an older thread', async () => {
    const chat = await groupChat('alice', ['erin', 'carol'])
    const before = await send('alice', chat, 'JOIN-GROUP-CANARY before bob')
    await h.api('alice').call(API.inviteRoomMembers, { params: { id: chat }, body: { userIds: ['bob'] } })
    await send('alice', chat, 'JOIN-GROUP-CANARY after bob')
    await send('erin', chat, 'JOIN-GROUP-CANARY reply in the old thread', { threadRootId: before.id })
    expect(bodies(await search('bob', 'JOIN-GROUP-CANARY'))).toEqual(['JOIN-GROUP-CANARY after bob'])
    expect(await rawSearch('bob', 'JOIN-GROUP')).not.toMatch(/before bob|old thread/)
    expect((await search('carol', 'JOIN-GROUP-CANARY')).items).toHaveLength(3)
  })

  test('a later member of a team room finds what was said before them', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const root = await send('alice', roomId, 'TEAM-HISTORY-CANARY before bob')
    await send('erin', roomId, 'TEAM-HISTORY-CANARY in its thread', { threadRootId: root.id })
    expect((await search('bob', 'TEAM-HISTORY-CANARY')).items).toEqual([])
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const page = await search('bob', 'TEAM-HISTORY-CANARY')
    expect(bodies(page)).toEqual(['TEAM-HISTORY-CANARY in its thread', 'TEAM-HISTORY-CANARY before bob'])
    expect(page.rooms).toEqual([expect.objectContaining({ id: roomId, kind: 'team', name: `search-${groups}`, memberCount: 3 })])
  })

  test('an old answer hidden from a later member never matches, nor its thread, and its text is in no response', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const a = aiAnswer(roomId, 'alice', 'The brief says HIDDEN-ANSWER-CANARY 견적 비밀', { sources: [folder('groups/marketing')] })
    await send('erin', roomId, 'THREAD-OF-HIDDEN-CANARY 견적', { threadRootId: a.answerId })
    const quoting = await send('erin', roomId, 'QUOTE-CANARY 견적 about the answer', { replyToId: a.answerId })
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    // alice, who could open the brief, finds all of it
    expect((await search('alice', 'CANARY')).items.filter((i) => i.roomId === roomId).map((i) => i.snippet).sort()).toEqual(['QUOTE-CANARY 견적 about the answer', 'THREAD-OF-HIDDEN-CANARY 견적', 'The brief says HIDDEN-ANSWER-CANARY 견적 비밀'])
    // bob: not by its words, not its thread; a message quoting it is his to find, with its own words only
    expect((await search('bob', 'HIDDEN-ANSWER-CANARY')).items).toEqual([])
    expect((await search('bob', '비밀')).items).toEqual([])
    expect((await search('bob', 'THREAD-OF-HIDDEN')).items).toEqual([])
    const found = await search('bob', '견적')
    expect(found.items.filter((i) => i.roomId === roomId).map((i) => i.id)).toEqual([quoting.id])
    for (const q of ['견적', 'CANARY', 'HIDDEN', '비밀', 'brief', 'QUOTE']) {
      const raw = await rawSearch('bob', q)
      expect(raw).not.toContain('HIDDEN-ANSWER-CANARY')
      expect(raw).not.toContain('THREAD-OF-HIDDEN')
      expect(raw).not.toContain('비밀')
    }
    // the page around the quoting message (what the hit opens) has the answer as its one line only
    const around = await h.req('bob', `/api/rooms/${roomId}/messages?around=${quoting.id}`)
    const text = await around.text()
    expect(text).not.toContain('HIDDEN-ANSWER-CANARY')
    expect((JSON.parse(text) as { items: RoomMessage[] }).items.find((m) => m.id === a.answerId)).toMatchObject({ withheld: true, body: '' })
  })

  test('a 1:1 chat is found only by its two people; a private preview only by its person', async () => {
    const room = await dm('alice', 'bob')
    await send('alice', room, 'DM-CANARY 견적 just for you')
    for (const u of ['alice', 'bob']) expect(bodies(await search(u, 'DM-CANARY'))).toEqual(['DM-CANARY 견적 just for you'])
    for (const u of ['erin', 'carol', 'dana']) expect(await rawSearch(u, 'DM-CANARY')).not.toContain('just for you')
    const page = await search('bob', 'DM-CANARY')
    expect(page.items[0]).toMatchObject({ roomId: room, authorKind: 'user', author: { id: 'alice', name: 'Alice Kim' }, threadRootId: null, markdown: false })
    expect(page.rooms).toEqual([{ id: room, kind: 'dm', name: null, peers: [{ id: 'alice', name: 'Alice Kim' }], memberCount: 2 }])
    // the AI's private preview for alice in the room
    put(room, 'alice', 'PREVIEW-CANARY only alice sees this', { privateTo: 'alice' })
    expect(bodies(await search('alice', 'PREVIEW-CANARY'))).toEqual(['PREVIEW-CANARY only alice sees this'])
    expect(await rawSearch('bob', 'PREVIEW-CANARY')).not.toContain('only alice')
  })

  test('an archived room is not searched, as the rooms list does not show it', async () => {
    const chat = await groupChat('alice', ['bob', 'erin'])
    await send('alice', chat, 'ARCHIVED-CANARY')
    expect((await search('bob', 'ARCHIVED-CANARY')).items).toHaveLength(1)
    h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), chat)
    expect((await search('bob', 'ARCHIVED-CANARY')).items).toEqual([])
  })
})

describe('what a hit is', () => {
  test('a thread reply names its thread (it opens there); its first message does not', async () => {
    const { roomId } = await teamRoom(['alice', 'erin'])
    const root = await send('alice', roomId, 'THREADHIT-CANARY root')
    const reply = await send('erin', roomId, 'THREADHIT-CANARY reply', { threadRootId: root.id })
    const also = await send('erin', roomId, 'THREADHIT-CANARY also in the room', { threadRootId: root.id, alsoInRoom: true })
    const page = await search('alice', 'THREADHIT-CANARY')
    expect(page.items.map((i) => [i.id, i.threadRootId])).toEqual([[also.id, root.id], [reply.id, root.id], [root.id, null]])
    expect(page.items[0]).toMatchObject({ author: { id: 'erin', name: 'Erin Yoo' }, askedBy: null })
  })

  test('deleted and edited text is gone, from the index too', async () => {
    const { roomId } = await teamRoom(['alice', 'erin'])
    const edited = await send('alice', roomId, 'EDIT-OLD-CANARY 견적 초안')
    await h.api('alice').call(API.editRoomMessage, { params: { id: roomId, messageId: edited.id }, body: { body: 'EDIT-NEW-CANARY 견적 최종' } })
    const gone = await send('alice', roomId, 'DELETE-CANARY 견적 지울 것')
    await h.api('alice').call(API.deleteRoomMessage, { params: { id: roomId, messageId: gone.id } })
    for (const q of ['EDIT-OLD-CANARY', '초안', 'DELETE-CANARY', '지울']) expect((await search('erin', q)).items).toEqual([])
    expect(bodies(await search('erin', 'EDIT-NEW-CANARY'))).toEqual(['EDIT-NEW-CANARY 견적 최종'])
    const inIndex = (w: string) => (h.ctx.db.query('SELECT COUNT(*) n FROM room_messages_fts WHERE room_messages_fts MATCH ?').get(`"${w}"`) as { n: number }).n
    expect([inIndex('EDIT-OLD-CANARY'), inIndex('DELETE-CANARY'), inIndex('EDIT-NEW-CANARY')]).toEqual([0, 0, 1])
    // a row removed from the table (a room deleted with its messages) leaves the index too
    const id = put(roomId, 'alice', 'ROWGONE-CANARY')
    expect(inIndex('ROWGONE-CANARY')).toBe(1)
    h.ctx.db.query('DELETE FROM room_messages WHERE id = ?').run(id)
    expect(inIndex('ROWGONE-CANARY')).toBe(0)
  })

  test('Korean by part of a word, the text as one part, A–Z in any case, % and _ as themselves', async () => {
    const { roomId } = await teamRoom(['alice', 'erin'])
    await send('alice', roomId, 'KO-CANARY 견적서를 내일까지 보내드릴게요')
    await send('alice', roomId, 'KO-CANARY Quarterly Budget 할인 50% 적용')
    await send('alice', roomId, 'KO-CANARY 할인 500 적용, file_name.xlsx')
    const one = async (q: string) => bodies(await search('erin', q)).filter((b) => b.includes('KO-CANARY'))
    expect(await one('견적')).toEqual(['KO-CANARY 견적서를 내일까지 보내드릴게요'])
    expect(await one('견적서')).toEqual(['KO-CANARY 견적서를 내일까지 보내드릴게요'])
    expect(await one('서를 내일')).toEqual(['KO-CANARY 견적서를 내일까지 보내드릴게요'])
    expect(await one('견적서가')).toEqual([])
    expect(await one('quarterly budget')).toEqual(['KO-CANARY Quarterly Budget 할인 50% 적용'])
    expect(await one('50%')).toEqual(['KO-CANARY Quarterly Budget 할인 50% 적용'])
    expect(await one('_')).toEqual(['KO-CANARY 할인 500 적용, file_name.xlsx'])
    expect(await one('"')).toEqual([])
    // the same through the function, with a decomposed query (macOS file names)
    expect(searchRoomMessages(h.ctx.db, 'erin', { q: '견적'.normalize('NFD') }).items.map((i) => i.snippet)).toContain('KO-CANARY 견적서를 내일까지 보내드릴게요')
  })

  test('the snippet: around the first match, room links as #name, one line, cut with …', () => {
    const long = `${'가'.repeat(300)} 견적서 ${'나'.repeat(300)}`
    const s = snippetOf(long, '견적서')
    expect(s.length).toBeLessThanOrEqual(200)
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true)
    expect(s.indexOf('견적서')).toBeGreaterThan(50)
    expect(s.indexOf('견적서')).toBeLessThan(70)
    expect(snippetOf('see #[디자인 리뷰](room:019a5f00-0000-7000-8000-00000000a001)\n\nand  the 견적', '견적')).toBe('see #디자인 리뷰 and the 견적')
    expect(snippetOf('short one', 'zzz')).toBe('short one')
  })
})

describe('how much', () => {
  test('pages of at most 30, newest first, a cursor to the end; a bad cursor or limit is refused', async () => {
    const { roomId } = await teamRoom(['alice', 'erin'])
    const ids: string[] = []
    h.ctx.db.transaction(() => { for (let i = 0; i < 70; i++) ids.push(put(roomId, 'alice', `PAGE-CANARY ${i}`, { at: new Date(Date.UTC(2026, 10, 1, 9, i)).toISOString() })) })()
    const first = await search('erin', 'PAGE-CANARY')
    expect(first.items).toHaveLength(20)
    expect(first.items[0]!.snippet).toBe('PAGE-CANARY 69')
    const seen = [...first.items.map((i) => i.id)]
    let cursor = first.nextCursor
    while (cursor) {
      const p = await search('erin', 'PAGE-CANARY', { cursor, limit: 30 })
      expect(p.items.length).toBeLessThanOrEqual(30)
      seen.push(...p.items.map((i) => i.id))
      cursor = p.nextCursor
    }
    expect(seen).toEqual([...ids].reverse())
    expect((await h.req('erin', '/api/room-messages?q=PAGE&limit=31')).status).toBe(400)
    expect((await h.req('erin', '/api/room-messages?q=PAGE&cursor=nope')).status).toBe(400)
    expect((await h.req('erin', '/api/room-messages?q=')).status).toBe(400)
    expect((await h.req('erin', `/api/room-messages?q=${'a'.repeat(201)}`)).status).toBe(400)
    // NUL would end the index's query: refused, and the function drops it on its own
    expect((await h.req('erin', '/api/room-messages?q=a%00b')).status).toBe(400)
    expect(searchRoomMessages(h.ctx.db, 'erin', { q: 'PAGE\u0000-CANARY 1' }).items.length).toBeGreaterThan(0)
  })

  test('a cursor only ever names a message they see: messages they do not see change no page, no cursor (independent review)', async () => {
    // bob joins a group chat after 2,100 messages with the word, one of them a secret; erin's room has alice's previews
    const chat = await groupChat('alice', ['erin', 'carol'])
    const ids: string[] = []
    h.ctx.db.transaction(() => { for (let i = 0; i < 2_100; i++) ids.push(put(chat, 'alice', i === 1_000 ? '공통어 SECRET-CONTRACT 3억' : `공통어 pad ${i}`)) })()
    await h.api('alice').call(API.inviteRoomMembers, { params: { id: chat }, body: { userIds: ['bob'] } })
    const after = put(chat, 'alice', '공통어 after bob')
    h.ctx.db.transaction(() => { for (let i = 0; i < 2_100; i++) put(chat, 'alice', `공통어 preview ${i}`, { privateTo: 'alice' }) })()
    const page = await search('bob', '공통어')
    expect(page.items.map((i) => i.id)).toEqual([after])
    expect(page.nextCursor).toBeNull()
    expect(await search('bob', '없는공통어')).toEqual({ items: [], rooms: [], nextCursor: null })
    // a hand-made cursor at, just above and below a message he does not see: the same answer, no cursor to compare
    const rowid = (id: string) => (h.ctx.db.query('SELECT rowid r FROM room_messages WHERE id = ?').get(id) as { r: number }).r
    const at = (r: number) => Buffer.from(JSON.stringify({ r: String(r) })).toString('base64url')
    const secret = rowid(ids[1_000]!)
    for (const q of ['공통어', 'SECRET', '3억', 'pad'])
      for (const r of [secret, secret + 1, secret - 1]) expect(await search('bob', q, { cursor: at(r) })).toEqual({ items: [], rooms: [], nextCursor: null })
    // erin, in the same room from the start: alice's previews are not hers, the room's messages are, in pages
    const erin = await search('erin', '공통어', { limit: 30 })
    expect(erin.items[0]!.id).toBe(after)
    expect(erin.items.slice(1).map((i) => i.snippet)).toEqual(Array.from({ length: 29 }, (_, i) => `공통어 pad ${2_099 - i}`))
    expect(erin.nextCursor).not.toBeNull()
  })

  test('SEE_MEMBER_SQL is canSee: every member against every message of the rooms here', () => {
    const db = h.ctx.db
    const members = db.query('SELECT room_id, user_id FROM room_members').all() as { room_id: string; user_id: string }[]
    let checked = 0
    for (const { room_id, user_id } of members) {
      const me = memberRow(db, room_id, user_id)!
      const rows = db.query(`SELECT ${MSG_COLS} FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT 400`).all(room_id) as MessageRow[]
      const sql = new Set((db.query(`SELECT m.id FROM room_messages m JOIN room_members mm ON mm.room_id = m.room_id AND mm.user_id = ? WHERE m.room_id = ? AND ${SEE_MEMBER_SQL}`).all(user_id, room_id) as { id: string }[]).map((r) => r.id))
      for (const r of rows) {
        expect(`${user_id} ${r.id} ${sql.has(r.id)}`).toBe(`${user_id} ${r.id} ${canSee(db, r, me)}`)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(1_000)
  })

  test('on a 50,000-message room: fast, from the index first, newest first', async () => {
    const { roomId } = await teamRoom(['alice', 'erin', 'bob'])
    const words = ['안녕하세요', '오늘 회의는', '견적서를 보내드릴게요', '내일까지', '디자인 시안', '확인 부탁드립니다', 'the quarterly budget', '감사합니다', '고객사 미팅', '자료 공유', '네 알겠습니다', '배포 일정']
    const db = h.ctx.db
    const ins = db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'user', 'alice', 'room', ?, '[]', ?)`)
    const start = (db.query('SELECT last_seq FROM rooms WHERE id = ?').get(roomId) as { last_seq: number }).last_seq
    const t0 = performance.now()
    db.transaction(() => {
      for (let i = 0; i < 50_000; i++) {
        let b = ''
        for (let k = 0; k < 3 + (i * 7) % 10; k++) b += words[(i * 31 + k * 17) % words.length] + ' '
        if (i % 997 === 0) b += ' 특별견적 요청'
        ins.run(uuidv7(), roomId, start + i + 1, b.trim(), new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString())
      }
      db.query('UPDATE rooms SET last_seq = ? WHERE id = ?').run(start + 50_000, roomId)
    })()
    const inserted = performance.now() - t0
    const times: Record<string, number> = {}
    for (const q of ['견적', '네', '견적서', 'budget', '특별견적', '없는말입니다', '없음']) {
      searchRoomMessages(db, 'bob', { q })
      const runs: number[] = []
      for (let i = 0; i < 5; i++) { const t = performance.now(); searchRoomMessages(db, 'bob', { q }); runs.push(performance.now() - t) }
      times[q] = runs.sort((a, b) => a - b)[2]!
    }
    console.log(`room search on 50,000 messages (insert with the index: ${inserted.toFixed(0)} ms), median ms per query:`, JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Number(v.toFixed(2))]))))
    // a loose bound (a busy machine runs these far slower); the plan below is what keeps it off a walk of the room
    for (const v of Object.values(times)) expect(v).toBeLessThan(500)
    const page = searchRoomMessages(db, 'bob', { q: '특별견적' })
    expect(page.items).toHaveLength(20)
    expect(page.items.map((i) => i.createdAt)).toEqual([...page.items.map((i) => i.createdAt)].sort().reverse())
    // the index drives: SQLite never walks the room's messages
    const plan = (db.query(`EXPLAIN QUERY PLAN SELECT f.rowid FROM room_messages_fts f CROSS JOIN room_messages m ON m.rowid = f.rowid WHERE room_messages_fts MATCH '"특별견적"' AND m.room_id IN (SELECT value FROM json_each('[]')) ORDER BY f.rowid DESC LIMIT 5`).all() as { detail: string }[]).map((r) => r.detail)
    expect(plan[0]).toMatch(/VIRTUAL TABLE/)
    expect(plan.join(' | ')).not.toMatch(/SCAN m\b|TEMP B-TREE/)
  })

  test('the index keeps its rows on a backup copy (VACUUM INTO) and after VACUUM', async () => {
    const copy = path.join(h.dataDir, `vacuum-${uuidv7()}.db`)
    await vacuumInto(path.join(h.dataDir, 'app.db'), copy)
    const c = new Database(copy)
    try {
      const off = (d: Database) => (d.query('SELECT COUNT(*) n FROM room_messages_fts f JOIN room_messages m ON m.rowid = f.rowid WHERE f.body <> m.body').get() as { n: number }).n
      const missing = (d: Database) => (d.query("SELECT COUNT(*) n FROM room_messages m WHERE m.body <> '' AND NOT EXISTS (SELECT 1 FROM room_messages_fts f WHERE f.rowid = m.rowid)").get() as { n: number }).n
      expect([off(c), missing(c)]).toEqual([0, 0])
      c.exec('VACUUM')
      expect([off(c), missing(c)]).toEqual([0, 0])
    } finally { c.close(); fs.rmSync(copy, { force: true }) }
  })
})

describe('migration 267', () => {
  test('additive (reader level stays); fills the index from the messages already there', () => {
    const m = readMigrations().find((x) => x.name === '267_b_room_message_search.sql')!
    expect(m.minCompatibleReader).toBe(1)
    expect(readMigrations().filter((x) => x.version === 267)).toHaveLength(1)
    const dir = fs.mkdtempSync(path.join(h.dataDir, 'mig-'))
    const before = path.join(dir, 'before')
    fs.mkdirSync(before)
    for (const f of readMigrations()) if (f.version !== 267) fs.writeFileSync(path.join(before, f.name), f.sql)
    const db = openDb(path.join(dir, 'app.db'), { migrationsDir: before })
    try {
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'room_messages_fts'").get()).toBeNull()
      // a database already at the numbers after it (266 room grants, 272 onboarding files): 267 still applies
      const applied = () => (db.query('SELECT version FROM schema_migrations WHERE version IN (266, 267, 272) ORDER BY version').all() as { version: number }[]).map((r) => r.version)
      expect(applied()).toEqual([266, 272])
      db.exec("INSERT INTO users (id, username, name, role, password_hash) VALUES ('u1', 'u1', 'U1', 'member', 'x')")
      db.exec("INSERT INTO rooms (id, kind, created_at, activity_at, last_seq) VALUES ('019a5f00-0000-7000-8000-0000000000a1', 'group', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 3)")
      db.exec("INSERT INTO room_members (room_id, user_id, joined_at, visible_from_seq) VALUES ('019a5f00-0000-7000-8000-0000000000a1', 'u1', '2026-11-01T00:00:00Z', 0)")
      const ins = db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, deleted_at, event) VALUES (?, '019a5f00-0000-7000-8000-0000000000a1', ?, 'user', 'u1', 'room', ?, '[]', '2026-11-01T00:00:00Z', ?, ?)`)
      ins.run(uuidv7(), 1, '', null, '{"type":"created","userIds":["u1"]}')
      ins.run(uuidv7(), 2, '지난주 견적서를 보냈어요', null, null)
      ins.run(uuidv7(), 3, '', '2026-11-01T00:01:00Z', null)
      // (as at a start after the update: the copy before migrating a database with data, then 267)
      migrate(db, { backupDir: path.join(dir, 'backups') })
      expect(applied()).toEqual([266, 267, 272])
      expect(db.query('SELECT body FROM room_messages_fts').all()).toEqual([{ body: '지난주 견적서를 보냈어요' }])
      expect(searchRoomMessages(db, 'u1', { q: '견적' }).items.map((i) => i.snippet)).toEqual(['지난주 견적서를 보냈어요'])
      // no secure-delete: SQLite before 3.42 (macOS 13's) refuses it and cannot read an index that used it
      expect(db.query("SELECT v FROM room_messages_fts_config WHERE k = 'secure-delete'").get()).toBeNull()
    } finally { db.close() }
  })
})

describe('the page around a message (a hit opens the room there)', () => {
  test('around a message: older and newer pages from it; one not mine to see gives the newest page', async () => {
    const chat = await groupChat('alice', ['erin', 'carol'])
    const ids: string[] = []
    h.ctx.db.transaction(() => { for (let i = 0; i < 120; i++) ids.push(put(chat, 'alice', `AROUND ${i}`)) })()
    const page = await h.api('erin').call(API.listRoomMessages, { params: { id: chat }, query: { around: ids[10], limit: 20 } })
    const body = page.items.map((m) => m.body)
    expect(body).toContain('AROUND 10')
    expect(body[0]).toBe('AROUND 1')
    expect(page.nextCursor).not.toBeNull()
    expect(page.newerCursor).not.toBeNull()
    // newer pages until the newest
    let newer = page.newerCursor
    const after: string[] = []
    while (newer) {
      const p = await h.api('erin').call(API.listRoomMessages, { params: { id: chat }, query: { cursor: newer, limit: 50 } })
      expect(p.nextCursor).toBeNull()
      after.push(...p.items.map((m) => m.body))
      newer = p.newerCursor ?? null
    }
    expect(after.at(-1)).toBe('AROUND 119')
    expect(after[0]).toBe(`AROUND ${Number(body.at(-1)!.split(' ')[1]) + 1}`)
    // an older page from there
    const older = await h.api('erin').call(API.listRoomMessages, { params: { id: chat }, query: { cursor: page.nextCursor!, limit: 50 } })
    expect(older.items.filter((m) => !m.event).map((m) => m.body)).toEqual(['AROUND 0'])
    // a later member: a message from before they joined is not looked for (the newest page, as for no such message)
    await h.api('alice').call(API.inviteRoomMembers, { params: { id: chat }, body: { userIds: ['bob'] } })
    const bob = await h.api('bob').call(API.listRoomMessages, { params: { id: chat }, query: { around: ids[10] } })
    expect(bob.items.map((m) => m.body).join()).not.toContain('AROUND')
    expect(bob.newerCursor).toBeUndefined()
    // the newest page as before: no newerCursor
    expect((await h.api('erin').call(API.listRoomMessages, { params: { id: chat }, query: {} })).newerCursor).toBeUndefined()
  })

  test('around with a page of one: the message, and newer ones after it', async () => {
    const chat = await groupChat('alice', ['erin', 'carol'])
    const ids: string[] = []
    h.ctx.db.transaction(() => { for (let i = 0; i < 5; i++) ids.push(put(chat, 'alice', `ONE ${i}`)) })()
    const page = await h.api('erin').call(API.listRoomMessages, { params: { id: chat }, query: { around: ids[2], limit: 1 } })
    expect(page.items.map((m) => m.body)).toEqual(['ONE 2'])
    const next = await h.api('erin').call(API.listRoomMessages, { params: { id: chat }, query: { cursor: page.newerCursor!, limit: 50 } })
    expect(next.items.map((m) => m.body)).toEqual(['ONE 3', 'ONE 4'])
  })

  test('around a thread reply: the page around its thread\'s first message', async () => {
    const { roomId } = await teamRoom(['alice', 'erin'])
    const root = await send('alice', roomId, 'AROUND-ROOT')
    h.ctx.db.transaction(() => { for (let i = 0; i < 80; i++) put(roomId, 'alice', `AFTER ROOT ${i}`) })()
    const reply = await send('erin', roomId, 'AROUND-REPLY', { threadRootId: root.id })
    const page = await h.api('alice').call(API.listRoomMessages, { params: { id: roomId }, query: { around: reply.id, limit: 20 } })
    expect(page.items.map((m) => m.id)).toContain(root.id)
    expect(page.items.map((m) => m.id)).not.toContain(reply.id)
    expect(page.newerCursor).not.toBeNull()
  })
})
