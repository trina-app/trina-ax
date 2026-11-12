// ⌘K search of the files sent in rooms, by name (rooms/search.ts searchRoomFiles; docs/DECISIONS.md "⌘K에서 대화방
// 메시지 찾기"): a hit is only a file of a message the person would see by opening its room now, by the rule message
// search uses (store.ts SEE_MEMBER_SQL, canSee, messagesOut): rooms they are in, a later member's view (group chats from
// their join, team rooms their whole history), never an old answer hidden from them nor anything in its thread, never
// someone else's private preview, nothing after leaving, nothing deleted, archived or not sent yet. Every word in the
// name, newest first, in pages. The fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner.
// File names and texts are made up; rows are written straight into the database where sending is not the point.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type RoomFile, type RoomFileSearchPage, type RoomMessage } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { roomFilesOf } from '../../server/src/rooms/files'
import { roomFilesSql, searchRoomFiles } from '../../server/src/rooms/search'
import type { ReadSource } from '../../server/src/chat/read-scope'

setDefaultTimeout(120_000)
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-rooms-file-search' })
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
  const g = await h.api('dana').call(API.createGroup, { body: { name: `files-${++groups}`, memberIds } })
  const r = (await h.api(memberIds[0]!).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)
  if (!r) throw new Error('no team room')
  return { roomId: r.id, groupId: g.id }
}
const setMembers = (groupId: string, memberIds: string[]) => h.api('dana').call(API.updateGroup, { params: { id: groupId }, body: { memberIds } })
const groupChat = async (by: string, others: string[]) => (await h.api(by).call(API.createRoom, { body: { kind: 'group', userIds: others } })).id
const dm = async (by: string, other: string) => (await h.api(by).call(API.createRoom, { body: { kind: 'dm', userId: other } })).id
/** a file uploaded to the room by `user`, not sent yet */
async function upload(user: string, roomId: string, name: string): Promise<RoomFile> {
  const bytes = new TextEncoder().encode(`fake file ${name}`)
  const src = path.join(h.dataDir, `upload-${uuidv7()}`)
  fs.writeFileSync(src, bytes)
  return roomFilesOf(h.ctx).create(user, roomId, name, src, createHash('sha256').update(bytes).digest('hex'))
}
const send = (user: string, roomId: string, body: string, extra: Record<string, unknown> = {}) =>
  h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: [], fileIds: [], ...extra } }) as Promise<RoomMessage>
/** files sent by `user` in one message (no text, as most file messages are) */
async function sendFiles(user: string, roomId: string, names: string[], extra: Record<string, unknown> = {}) {
  const files = []
  for (const n of names) files.push(await upload(user, roomId, n))
  const message = await send(user, roomId, '', { fileIds: files.map((f) => f.id), ...extra })
  return { message, files }
}
const search = (user: string, q: string, extra: { cursor?: string; limit?: number } = {}) => h.api(user).call(API.searchRoomFiles, { query: { q, ...extra } }) as Promise<RoomFileSearchPage>
const names = (p: RoomFileSearchPage) => p.items.map((i) => i.file.name)
/** the raw JSON a search answers (to look for names that must never be in it) */
const raw = async (user: string, q: string, cursor?: string) => (await h.req(user, `/api/room-files?q=${encodeURIComponent(q)}${cursor ? `&cursor=${cursor}` : ''}`)).text()
const EMPTY = { items: [], rooms: [], nextCursor: null }
const folder = (p: string): ReadSource => ({ type: 'folder', id: (h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string }).id })
const next = (roomId: string) => (h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
/** a message straight into the database: a person's (a shared answer when `answerAt` is set), or a private preview */
function put(roomId: string, author: string, body: string, o: { privateTo?: string; answerAt?: number } = {}): string {
  const id = uuidv7()
  h.ctx.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, visible_to, body, mentions, created_at, answer_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`)
    .run(id, roomId, next(roomId), o.privateTo ? 'ai' : 'user', o.privateTo ? null : author, o.privateTo ? 'private' : 'room', o.privateTo ?? null, body, new Date().toISOString(), o.answerAt ?? null)
  return id
}
/** an upload attached to a message written straight into the database */
async function attach(user: string, roomId: string, messageId: string, name: string) {
  const f = await upload(user, roomId, name)
  h.ctx.db.query('UPDATE room_files SET message_id = ? WHERE id = ?').run(messageId, f.id)
  return f
}
/** An AI answer to `asker`'s question with the question's scope, straight into the database (rooms/history.ts judges it
 * for later members). */
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

describe('who finds a file', () => {
  test('a non-member finds nothing, an owner and an admin included', async () => {
    const { roomId } = await teamRoom(['alice', 'erin'])
    const { message, files } = await sendFiles('alice', roomId, ['NONMEMBER-FILE 견적서.pdf'])
    for (const u of ['alice', 'erin']) {
      const page = await search(u, 'nonmember-file')
      expect(names(page)).toEqual(['NONMEMBER-FILE 견적서.pdf'])
      expect(page.items[0]).toMatchObject({ messageId: message.id, roomId, threadRootId: null, author: { id: 'alice', name: 'Alice Kim' }, file: { id: files[0]!.id, kind: 'pdf' } })
      expect(page.rooms).toEqual([expect.objectContaining({ id: roomId, kind: 'team', name: `files-${groups}` })])
    }
    for (const u of ['bob', 'carol', 'dana']) {
      expect(await search(u, 'NONMEMBER-FILE')).toEqual(EMPTY)
      expect(await raw(u, '견적서')).not.toContain('NONMEMBER')
    }
  })

  test('after leaving a group chat, or being taken out of a team room, nothing', async () => {
    const chat = await groupChat('alice', ['bob', 'erin'])
    await sendFiles('bob', chat, ['LEFT-FILE group.xlsx'])
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    await sendFiles('alice', roomId, ['LEFT-FILE team.xlsx'])
    expect(names(await search('erin', 'LEFT-FILE')).sort()).toEqual(['LEFT-FILE group.xlsx', 'LEFT-FILE team.xlsx'])
    await h.api('erin').call(API.leaveRoom, { params: { id: chat } })
    expect(names(await search('erin', 'LEFT-FILE'))).toEqual(['LEFT-FILE team.xlsx'])
    await setMembers(groupId, ['alice'])
    expect(await search('erin', 'LEFT-FILE')).toEqual(EMPTY)
    expect(await raw('erin', 'LEFT-FILE')).not.toContain('LEFT-FILE')
    // the others keep theirs
    expect(names(await search('alice', 'LEFT-FILE'))).toHaveLength(2)
  })

  test('a later member of a group chat finds no file from before they joined, nor one in a later reply of an older thread', async () => {
    const chat = await groupChat('alice', ['erin', 'carol'])
    const before = await sendFiles('alice', chat, ['JOIN-FILE before bob.pdf'])
    await h.api('alice').call(API.inviteRoomMembers, { params: { id: chat }, body: { userIds: ['bob'] } })
    await sendFiles('alice', chat, ['JOIN-FILE after bob.pdf'])
    await sendFiles('erin', chat, ['JOIN-FILE old thread.pdf'], { threadRootId: before.message.id })
    expect(names(await search('bob', 'JOIN-FILE'))).toEqual(['JOIN-FILE after bob.pdf'])
    expect(await raw('bob', 'JOIN-FILE')).not.toMatch(/before bob|old thread/)
    expect(names(await search('carol', 'JOIN-FILE'))).toHaveLength(3)
  })

  test('a later member of a team room finds the files sent before them, a thread reply with its thread', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const root = await sendFiles('alice', roomId, ['HISTORY-FILE root.docx'])
    const reply = await sendFiles('erin', roomId, ['HISTORY-FILE reply.docx'], { threadRootId: root.message.id })
    expect(await search('bob', 'HISTORY-FILE')).toEqual(EMPTY)
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    const page = await search('bob', 'HISTORY-FILE')
    expect(names(page)).toEqual(['HISTORY-FILE reply.docx', 'HISTORY-FILE root.docx'])
    expect(page.items[0]).toMatchObject({ messageId: reply.message.id, threadRootId: root.message.id, author: { id: 'erin' } })
  })

  test('a 1:1 chat\'s files are found by its two people only', async () => {
    const room = await dm('alice', 'bob')
    await sendFiles('alice', room, ['DM-FILE 계약서.pdf'])
    for (const u of ['alice', 'bob']) expect(names(await search(u, 'DM-FILE'))).toEqual(['DM-FILE 계약서.pdf'])
    for (const u of ['erin', 'carol', 'dana']) expect(await raw(u, 'DM-FILE')).not.toContain('계약서')
    expect((await search('bob', 'DM-FILE')).rooms).toEqual([{ id: room, kind: 'dm', name: null, peers: [{ id: 'alice', name: 'Alice Kim' }], memberCount: 2 }])
  })

  test('an answer hidden from a later member: neither the files in its thread nor a shared answer\'s files', async () => {
    const { roomId, groupId } = await teamRoom(['alice', 'erin'])
    const a = aiAnswer(roomId, 'alice', 'The brief says this', { sources: [folder('groups/marketing')] })
    await sendFiles('erin', roomId, ['HIDDEN-FILE in its thread.pdf'], { threadRootId: a.answerId })
    // an answer alice sent from her own AI chat with a file attached; its chat did not say what it used
    const shared = put(roomId, 'alice', 'From my chat: the plan', { answerAt: 0 })
    await attach('alice', roomId, shared, 'HIDDEN-FILE shared answer.pdf')
    await sendFiles('erin', roomId, ['HIDDEN-FILE plain.pdf'])
    await setMembers(groupId, ['alice', 'erin', 'bob'])
    expect(names(await search('alice', 'HIDDEN-FILE')).sort()).toEqual(['HIDDEN-FILE in its thread.pdf', 'HIDDEN-FILE plain.pdf', 'HIDDEN-FILE shared answer.pdf'])
    expect(names(await search('bob', 'HIDDEN-FILE'))).toEqual(['HIDDEN-FILE plain.pdf'])
    for (const q of ['HIDDEN-FILE', 'thread', 'shared']) expect(await raw('bob', q)).not.toMatch(/in its thread|shared answer/)
  })

  test('a private preview\'s file only for its person; archived rooms, deleted messages and unsent uploads for nobody', async () => {
    const chat = await groupChat('alice', ['bob', 'erin'])
    const preview = put(chat, 'alice', 'a preview', { privateTo: 'alice' })
    await attach('alice', chat, preview, 'PRIVATE-FILE preview.png')
    expect(names(await search('alice', 'PRIVATE-FILE'))).toEqual(['PRIVATE-FILE preview.png'])
    for (const u of ['bob', 'erin']) expect(await raw(u, 'PRIVATE-FILE')).not.toContain('preview.png')
    // an upload not sent yet, even its uploader's
    await upload('bob', chat, 'UNSENT-FILE draft.pdf')
    for (const u of ['alice', 'bob', 'erin']) expect(await search(u, 'UNSENT-FILE')).toEqual(EMPTY)
    // a deleted message: its files go with it
    const gone = await sendFiles('bob', chat, ['DELETED-FILE old.pdf'])
    expect(names(await search('erin', 'DELETED-FILE'))).toEqual(['DELETED-FILE old.pdf'])
    await h.api('bob').call(API.deleteRoomMessage, { params: { id: chat, messageId: gone.message.id } })
    for (const u of ['alice', 'bob', 'erin']) expect(await search(u, 'DELETED-FILE')).toEqual(EMPTY)
    // an archived room, as the rooms list does not show it
    await sendFiles('bob', chat, ['ARCHIVED-FILE plan.pdf'])
    expect(names(await search('erin', 'ARCHIVED-FILE'))).toHaveLength(1)
    h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), chat)
    for (const u of ['alice', 'bob', 'erin']) expect(await search(u, 'ARCHIVED-FILE')).toEqual(EMPTY)
  })
})

describe('how it matches', () => {
  test('every word, in any order and any case; % and _ as themselves; Korean by part of a word', async () => {
    const { roomId } = await teamRoom(['alice', 'erin'])
    await sendFiles('alice', roomId, ['WORDS-FILE Q4 Budget_final 100%.xlsx', 'WORDS-FILE Q4 Budgetxfinal.xlsx', 'WORDS-FILE 견적서_초안.hwp'])
    expect(names(await search('erin', 'budget q4 words-file')).sort()).toEqual(['WORDS-FILE Q4 Budget_final 100%.xlsx', 'WORDS-FILE Q4 Budgetxfinal.xlsx'])
    expect(names(await search('erin', 'WORDS-FILE budget_'))).toEqual(['WORDS-FILE Q4 Budget_final 100%.xlsx'])
    expect(names(await search('erin', 'WORDS-FILE 100%'))).toEqual(['WORDS-FILE Q4 Budget_final 100%.xlsx'])
    expect(names(await search('erin', '초안 견적'))).toEqual(['WORDS-FILE 견적서_초안.hwp'])
    expect(await search('erin', 'WORDS-FILE budget 견적')).toEqual(EMPTY)
    // a name typed decomposed (as some Macs send it) finds the stored name
    expect(names(await search('erin', 'WORDS-FILE 견적서'.normalize('NFD')))).toEqual(['WORDS-FILE 견적서_초안.hwp'])
  })

  test('pages: newest first, two files of one message apart, no repeats, a cursor only at a file they see', async () => {
    const chat = await groupChat('alice', ['erin', 'carol'])
    // a file bob sees, sent before all the others (his 1:1 with alice)
    await sendFiles('alice', await dm('alice', 'bob'), ['PAGE-FILE early.txt'])
    // before bob: never his, so never a cursor of his
    for (let i = 0; i < 3; i++) await sendFiles('alice', chat, [`PAGE-FILE unseen ${i}.txt`])
    await h.api('alice').call(API.inviteRoomMembers, { params: { id: chat }, body: { userIds: ['bob'] } })
    await sendFiles('alice', chat, ['PAGE-FILE 1.txt'])
    await sendFiles('erin', chat, ['PAGE-FILE 2a.txt', 'PAGE-FILE 2b.txt'])
    await sendFiles('alice', chat, ['PAGE-FILE 3.txt'])
    await sendFiles('carol', chat, ['PAGE-FILE 4.txt'])
    const seen: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 10; i++) {
      const page = await search('bob', 'PAGE-FILE', { limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...names(page))
      if (!page.nextCursor) break
      // the cursor names the page's last hit: a file bob sees
      const c = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')) as { f: string }
      const last = page.items.at(-1)!
      expect(Number(c.f)).toBe((h.ctx.db.query('SELECT rowid AS n FROM room_files WHERE id = ?').get(last.file.id) as { n: number }).n)
      cursor = page.nextCursor
    }
    expect(seen).toEqual(['PAGE-FILE 4.txt', 'PAGE-FILE 3.txt', 'PAGE-FILE 2b.txt', 'PAGE-FILE 2a.txt', 'PAGE-FILE 1.txt', 'PAGE-FILE early.txt'])
    // a cursor that is not one: refused
    expect((await h.req('bob', `/api/room-files?q=PAGE&cursor=${Buffer.from('{"f":"x"}').toString('base64url')}`)).status).toBe(400)
    // a hand-made cursor at, just above and just below a file he does not see: the files he sees below it, never that
    // one, and no cursor that names it (as message search, b-rooms-search.test.ts)
    const unseenRow = (h.ctx.db.query("SELECT rowid AS n FROM room_files WHERE name = 'PAGE-FILE unseen 1.txt'").get() as { n: number }).n
    const at = (n: number) => Buffer.from(JSON.stringify({ f: String(n) })).toString('base64url')
    for (const q of ['PAGE-FILE', 'unseen', 'PAGE-FILE unseen', '1.txt', '.txt'])
      for (const n of [unseenRow, unseenRow + 1, unseenRow - 1]) {
        const p = await search('bob', q, { cursor: at(n) })
        // what he sees below it comes back (the early file), never the unseen ones, and no further cursor
        expect(names(p), `${q} ${n}`).toEqual(q === 'PAGE-FILE' || q === '.txt' ? ['PAGE-FILE early.txt'] : [])
        expect(p.nextCursor).toBeNull()
        expect(await raw('bob', q, at(n))).not.toContain('unseen')
      }
  })

  test('20,000 files among 100,000 messages: newest first with no sort, a rare name read through once (timed; the plan)', async () => {
    // erin's room and one she is not in, five messages for every file, the files spread over both
    const { roomId } = await teamRoom(['alice', 'erin'])
    const other = (await teamRoom(['alice'])).roomId
    const db = h.ctx.db
    const now = new Date().toISOString()
    const t0 = performance.now()
    db.transaction(() => {
      const msg = db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'user', 'alice', 'room', ?, '[]', ?)`)
      const file = db.query(`INSERT INTO room_files (id, room_id, user_id, message_id, name, size, mime, kind, sha256, created_at) VALUES (?, ?, 'alice', ?, ?, 10, 'application/pdf', 'pdf', 'x', ?)`)
      for (let i = 0; i < 20_000; i++) {
        const room = i % 2 ? roomId : other
        for (let k = 0; k < 4; k++) msg.run(uuidv7(), room, next(room), `bulk text ${i} ${k}`, now)
        const id = uuidv7()
        msg.run(id, room, next(room), '', now)
        file.run(uuidv7(), room, id, i % 1000 === 7 || i % 1000 === 8 ? `BULK-RARE 특별견적 ${i}.pdf` : `bulk 견적서 ${i}.pdf`, now)
      }
    })()
    const insert = performance.now() - t0
    const median = (q: string, cursor?: string) => {
      const ms: number[] = []
      for (let i = 0; i < 5; i++) {
        const s = performance.now()
        searchRoomFiles(db, 'erin', { q, ...(cursor ? { cursor } : {}) })
        ms.push(performance.now() - s)
      }
      return Number(ms.sort((a, b) => a - b)[2]!.toFixed(2))
    }
    const page2 = searchRoomFiles(db, 'erin', { q: '견적' }).nextCursor!
    const times = { 견적: median('견적'), '견적 page 2': median('견적', page2), 'BULK-RARE': median('BULK-RARE'), '특별 견적': median('특별 견적'), none: median('없는파일이름') }
    console.log(`room file search on 20,000 files and 100,000 messages (insert ${Math.round(insert)} ms), median ms per query: ${JSON.stringify(times)}`)
    // the rare name: 40 in all, 20 of them in erin's room
    expect(searchRoomFiles(db, 'erin', { q: 'BULK-RARE', limit: 30 }).items).toHaveLength(20)
    expect(searchRoomFiles(db, 'bob', { q: 'BULK-RARE' }).items).toEqual([])
    // generous: a slow machine under load; the numbers above go in DECISIONS
    for (const ms of Object.values(times)) expect(ms).toBeLessThan(1000)
    // room_files first, newest first by rowid (from the cursor on a later page): no sort for the ORDER BY
    const plan = (after: boolean) => (db.query(`EXPLAIN QUERY PLAN ${roomFilesSql(2, after)}`).all('erin', JSON.stringify([roomId]), '%a%', '%b%', ...(after ? [Number.MAX_SAFE_INTEGER] : []), 21) as { detail: string }[]).map((r) => r.detail)
    expect(plan(false)[0]).toMatch(/^SCAN f\b/)
    expect(plan(true)[0]).toMatch(/^SEARCH f USING INTEGER PRIMARY KEY \(rowid<\?\)/)
    for (const p of [plan(false), plan(true)]) {
      expect(p.join('\n')).not.toMatch(/TEMP B-TREE/)
      expect(p.join('\n')).toMatch(/SEARCH m USING INDEX/)
    }
  })
})
