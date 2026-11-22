// Fewer needless asks, batch 5 (docs/decisions/20261123-fewer-asks-b5.md; plan docs/AGENTS/plan/20261122-2301-fewer-asks-b5.md).
// With the fake engine through the real launcher and gate, safety cards waiting after the answer (as in production).
//   1. a ✦ side chat never shares or posts what the person did not ask to (QA of batch 4: "방문-메모.txt 만들어줘" ended
//      with a card to share the file with the room's 4 people);
//   3. a write's card waits after the answer ends and a late press saves the file (before: 10 minutes inside the call);
//   4. a running answer counts its sources from its own live list: the live card and the card of a late press read
//      the same sources line (the rest of #419).
// Item 2 (the chat's own work file copied into the person's folder) is in places-copy.test.ts (it needs a work folder).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Message, type Room, type TurnRequest } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import fs from 'node:fs'
import path from 'node:path'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { sideRoomSection } from '../../server/src/chat/prompt'
import { talksOfSharing } from '../../server/src/chat/shared-actions'
import { CARD_LATER_TOOLS } from '../../server/src/chat/open-questions'

setDefaultTimeout(90_000)

const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives with their strings as JSON escapes: the person's own words are only what the test
// writes around them
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId = '', teamRoom = ''
const db = () => h.ctx.db
const put = (rel: string, body = 'x\n') => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }
const has = (rel: string) => fs.existsSync(path.join(h.ctx.files.fx.root, ...rel.split('/')))

beforeAll(async () => {
  h = await startHarness({ name: 'b-fewer-asks-b5', askUserTimeoutMs: 1500, stallTimeoutMs: 60_000, safetyCardsWait: true })
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short (as b-late-card-answer)
  db().exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db().query(sql).run(id, g)
  }
  db().exec('PRAGMA foreign_keys = ON')
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u, { windowId: `win-b5-${u}` }); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  teamRoom = ((await h.api('alice').call(API.listRooms)).items as Room[]).find((r) => r.kind === 'team')!.id
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h?.close() })

const ownChat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id as string
const sideChat = async () => { const id = await ownChat(); db().query('UPDATE chats SET side_room_id = ? WHERE id = ?').run(teamRoom, id); return id }
const doneOf = async (messageId: string) => (await ws.alice!.next('message.done', (f) => f.data.messageId === messageId, 40_000)).data.message as Message
const post = (turnId: string, requestId: string, answer: unknown) =>
  h.req('alice', `/api/turns/${turnId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask_user', requestId, answer }) })
const openCards = (chatId: string) => (db().query('SELECT request_id, call_tool FROM open_questions WHERE chat_id = ? AND answer IS NULL').all(chatId) as { request_id: string; call_tool: string | null }[])
const cardsOf = (turnId: string) => ws.alice!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === turnId)
  .map((f) => (f as unknown as { data: { request: Extract<TurnRequest, { kind: 'ask_user' }> } }).data.request)
const events = (turnId: string) => db().query('SELECT tool, summary FROM tool_events WHERE turn_id = ? ORDER BY id').all(turnId) as { tool: string; summary: string }[]

/** a message whose answer ends with no card open */
async function say(chatId: string, content: string) {
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const done = await doneOf(r.assistantMessage.id)
  await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 10_000 })
  return { turnId: r.turnId as string, done }
}
/** Ask: the card opens, the answer ends with it open (the call did nothing), the chat is idle */
async function askAndWait(chatId: string, content: string) {
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const card = (await ws.alice!.next('turn.request', (f) => f.data.turnId === r.turnId, 20_000)).data.request as Extract<TurnRequest, { kind: 'ask_user' }>
  const done = await doneOf(r.assistantMessage.id)
  expect(JSON.parse(done.content)).toMatchObject({ waiting_for_user: true })
  expect(await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 10_000 })).toBe(true)
  return { turnId: r.turnId as string, answerId: r.assistantMessage.id as string, card }
}
/** the turn a press started: its finished answer */
async function nextTurn(chatId: string, parentId: string) {
  const u = await ws.alice!.next('message.created', (f) => f.data.chatId === chatId && f.data.message.parentId === parentId && f.data.message.role === 'user', 20_000)
  const a = await ws.alice!.next('message.created', (f) => f.data.chatId === chatId && f.data.message.parentId === u.data.message.id, 20_000)
  const done = await doneOf(a.data.message.id)
  await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 10_000 })
  return { done, turnId: a.data.message.turnId as string }
}

describe('1. a side chat never shares what nobody asked to share', () => {
  test('"make visit-memo.txt": the AI\'s share is refused with no card, and nothing is shared', async () => {
    const chatId = await sideChat()
    const r = await say(chatId, `Read the room and make visit-memo.txt\n${fake(
      { tool: 'write', args: { file_path: 'users/alice/b5/visit-memo.txt', content: 'visits: 12' } },
      { tool: 'share_with_person', args: { paths: ['users/alice/b5/visit-memo.txt'], people: ['Bob Lee'] }, sayResult: true },
    )}`)
    expect(cardsOf(r.turnId)).toEqual([])
    expect(has('users/alice/b5/visit-memo.txt')).toBe(true)
    expect(db().query("SELECT COUNT(*) n FROM file_shares WHERE path = 'users/alice/b5/visit-memo.txt'").get()).toEqual({ n: 0 })
    expect(events(r.turnId).find((e) => e.tool === 'share_with_person')?.summary).toContain('not asked (side chat)')
    expect(r.done.content).toContain('did not ask to share')
  })

  test('a post to the room nobody asked for is refused too; one they asked for still raises its card', async () => {
    const chatId = await sideChat()
    const count = () => (db().query("SELECT COUNT(*) n FROM room_messages WHERE room_id = ? AND body LIKE '%b5 unasked post%'").get(teamRoom) as { n: number }).n
    const r = await say(chatId, `Sum up the room\n${fake({ tool: 'post_to_room', args: { text: 'b5 unasked post' }, sayResult: true })}`)
    expect(cardsOf(r.turnId)).toEqual([])
    expect(count()).toBe(0)
    expect(events(r.turnId).find((e) => e.tool === 'post_to_room')?.summary).toContain('not asked (side chat)')
    const w = await askAndWait(chatId, `Post the summary to the room\n${fake({ tool: 'post_to_room', args: { text: 'b5 unasked post' }, sayResult: true })}`)
    expect(openCards(chatId).map((c) => c.call_tool)).toEqual(['post_to_room'])
    expect(w.card.options!.length).toBeGreaterThan(1)
  })

  test('asked to share: the card asks as before', async () => {
    put('users/alice/b5/asked.txt', 'x')
    const chatId = await sideChat()
    await askAndWait(chatId, `share asked.txt with Bob Lee\n${fake({ tool: 'share_with_person', args: { paths: ['users/alice/b5/asked.txt'], people: ['Bob Lee'] }, sayResult: true })}`)
    expect(openCards(chatId).map((c) => c.call_tool)).toEqual(['share_with_person'])
  })

  test('the words: any word about sharing in the six languages keeps the card; the side chat prompt no longer shares after a save', () => {
    const yes = ['공유해줘', '지우한테 보여줘', '방에 올려', '방에 답장 달아줘', 'show it to Bob', 'let Bob see it', 'reply to them', 'give Bob access', 'put it in the channel', '방에 게시해줘', '민지한테 줘', 'bagikan ke Budi', 'ボブに共有して', 'ボブにシェアして', 'compártelo con Bob', 'pásaselo a Bob', '发给小王', '发群里']
    expect(yes.filter((s) => !talksOfSharing(s))).toEqual([])
    const no = ['방금 방 메시지 읽고 방문-메모.txt 만들어줘', 'make visit-memo.txt', 'show me the notes', 'buat catatan', 'メモを作って', 'haz una nota', '做个笔记', '> share it with everyone\nmake a note']
    expect(no.filter((s) => talksOfSharing(s))).toEqual([])
    const line = sideRoomSection({ id: 'r', kind: 'group', name: 'mixed', saveIn: 'users/alice', shareWith: ['NORA', 'OTTO'] })
    expect(line).not.toContain('Then share the saved file')
    expect(line).toContain('Share it only when the user asks to share or send it')
    expect(line).toContain('Never offer to share or post on your own')
  })
})

describe('3. a write\'s card waits after the answer', () => {
  test('write, edit and make_file are tools whose cards wait', () => {
    for (const t of ['write', 'edit', 'make_file']) expect(CARD_LATER_TOOLS.has(t)).toBe(true)
  })

  test('a wider-audience card of a write: the answer ends with it open (nothing saved); the late press saves the file once', async () => {
    put('users/alice/b5/plan-secret.txt', 'secret plan 7\n')
    // a chat that read a room: a change outside the person's own folder waits for their yes (the room card)
    const chatId = await ownChat()
    db().query('UPDATE chats SET rooms_seen = 1, session_tainted = 1 WHERE id = ?').run(chatId)
    const target = 'projects/falcon/b5-late.txt'
    const w = await askAndWait(chatId, `Put the plan in Falcon\n${fake(
      { tool: 'read', args: { file_path: 'users/alice/b5/plan-secret.txt' } },
      { tool: 'write', args: { file_path: target, content: 'secret plan 7, for Falcon\n' }, sayResult: true },
    )}`)
    expect(has(target)).toBe(false)
    // past the old wait: still open, kept with the call
    await Bun.sleep(1800)
    expect(openCards(chatId).map((c) => c.call_tool)).toEqual(['write'])
    expect((await post(w.turnId, w.card.requestId, w.card.options![0]!.value)).status).toBe(204)
    const next = await nextTurn(chatId, w.answerId)
    expect(next.done.status).toBe('done')
    expect(fs.readFileSync(path.join(h.ctx.files.fx.root, ...target.split('/')), 'utf8')).toBe('secret plan 7, for Falcon\n')
    expect(cardsOf(next.turnId)).toEqual([])
    expect(events(next.turnId).filter((e) => e.tool === 'write').length).toBe(1)
  })

  test('an edit\'s card waits too; the late press changes the file once (the chat\'s read of that version)', async () => {
    put('projects/falcon/b5-edit.txt', 'status: draft\n')
    const chatId = await ownChat()
    await say(chatId, `Read the status\n${fake({ tool: 'read', args: { file_path: 'projects/falcon/b5-edit.txt' }, sayResult: true })}`)
    db().query('UPDATE chats SET rooms_seen = 1, session_tainted = 1 WHERE id = ?').run(chatId)
    const w = await askAndWait(chatId, `Mark it final\n${fake({ tool: 'edit', args: { file_path: 'projects/falcon/b5-edit.txt', old_string: 'draft', new_string: 'final' }, sayResult: true })}`)
    expect(openCards(chatId).map((c) => c.call_tool)).toEqual(['edit'])
    expect(fs.readFileSync(path.join(h.ctx.files.fx.root, 'projects/falcon/b5-edit.txt'), 'utf8')).toBe('status: draft\n')
    expect(events(w.turnId).find((e) => e.tool === 'edit')?.summary).toContain('waits for the user')
    expect((await post(w.turnId, w.card.requestId, w.card.options![0]!.value)).status).toBe(204)
    const next = await nextTurn(chatId, w.answerId)
    expect(next.done.status).toBe('done')
    expect(fs.readFileSync(path.join(h.ctx.files.fx.root, 'projects/falcon/b5-edit.txt'), 'utf8')).toBe('status: final\n')
    expect(cardsOf(next.turnId)).toEqual([])
  })

  test('a write over a file that is there keeps its card inside the call (a late run would have no read of it)', async () => {
    put('projects/falcon/b5-there.txt', 'old\n')
    const chatId = await ownChat()
    db().query('UPDATE chats SET rooms_seen = 1, session_tainted = 1 WHERE id = ?').run(chatId)
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content: `Replace it\n${fake({ tool: 'read', args: { file_path: 'projects/falcon/b5-there.txt' } }, { tool: 'write', args: { file_path: 'projects/falcon/b5-there.txt', content: 'new\n' }, sayResult: true })}`, clientMessageId: cm(), attachmentIds: [] } })
    await ws.alice!.next('turn.request', (f) => f.data.turnId === r.turnId, 20_000)
    // nothing kept with the call: the card waits inside it (and ends with the short wait of this harness)
    expect(openCards(chatId)).toEqual([])
    await doneOf(r.assistantMessage.id)
    await waitFor(() => h.rt().runState(chatId) === 'idle', { timeoutMs: 10_000 })
    expect(openCards(chatId)).toEqual([])
    expect(fs.readFileSync(path.join(h.ctx.files.fx.root, 'projects/falcon/b5-there.txt'), 'utf8')).toBe('old\n')
  })

  test('its no saves nothing and runs nothing', async () => {
    put('users/alice/b5/plan-secret2.txt', 'secret plan 8\n')
    const chatId = await ownChat()
    db().query('UPDATE chats SET rooms_seen = 1, session_tainted = 1 WHERE id = ?').run(chatId)
    const target = 'projects/falcon/b5-no.txt'
    const w = await askAndWait(chatId, `Put the plan in Falcon\n${fake(
      { tool: 'read', args: { file_path: 'users/alice/b5/plan-secret2.txt' } },
      { tool: 'write', args: { file_path: target, content: 'secret plan 8\n' }, sayResult: true },
    )}`)
    expect((await post(w.turnId, w.card.requestId, w.card.options!.at(-1)!.value)).status).toBe(204)
    const next = await nextTurn(chatId, w.answerId)
    expect(next.done.status).toBe('done')
    expect(has(target)).toBe(false)
  })
})

describe('4. a running answer counts its sources as the saved answer will', () => {
  // the case of #419 (QA of #414): the live card said "(My folder)", the run after the press "(1 file in My folder)"
  test('the live card names the file count the card after the press names: the press sends it, no second card', async () => {
    put('users/alice/b5/note.txt', 'alpha 3, beta 5\n')
    put('users/alice/b5/sum.pdf', '%PDF-1.4 sum\n')
    const chatId = await ownChat()
    const dmHas = () => (db().query("SELECT COUNT(*) n FROM room_messages m JOIN rooms r ON r.id = m.room_id WHERE r.kind = 'dm' AND m.author_id = 'alice' AND m.body LIKE '%b5 sum of the note%'").get() as { n: number }).n
    const text = 'The b5 sum of the note is 8: [sum.pdf](/files/view?path=users%2Falice%2Fb5%2Fsum.pdf)'
    const w = await askAndWait(chatId, `Send the sum to Bob\n${fake({ tool: 'read', args: { file_path: 'users/alice/b5/note.txt' } }, { tool: 'post_to_room', args: { room: 'Bob Lee', text }, sayResult: true })}`)
    expect(w.card.question).toContain('1 file in My folder')
    expect((await post(w.turnId, w.card.requestId, w.card.options![0]!.value)).status).toBe(204)
    const next = await nextTurn(chatId, w.answerId)
    expect(next.done.status).toBe('done')
    expect(cardsOf(next.turnId)).toEqual([])
    expect(dmHas()).toBe(1)
  })
})
