// shared_with_me (server/src/chat/shared-with-me-tool.ts; docs/decisions/20261116-ai-screen-and-shared-tools.md; QA
// "Manual AI tests" MAN-020): the files shared with the person, listed when the AI asks (no list in every turn), each row
// asked again with FileShares.open. And the gate that goes with reading one: a file read through a grant is other
// people's words (server/src/chat/grant-reads.ts), so the share and post tools keep their card after it and changes ask.
// The fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner (b-harness people), tess added.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared'
import { API, FILE_SHARE_EVERYONE, type Room } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { dropAlways, keepAlways } from '../../server/src/chat/always-allow'
import { othersSource, readByGrant, seenWhy, SHARED_FILE_SOURCE } from '../../server/src/chat/grant-reads'
import { DELETE_REFUSAL, deleteFilesRefusal } from '../../server/src/chat/delete-files'
import { skillFilesRefusal } from '../../server/src/chat/skill-files'
import { tr } from '../../server/src/chat/i18n'
import { GUEST_TURN_TOOLS } from '../../server/src/chat/guest-tools'
import { readRooms } from '../../server/src/chat/read-rooms'
import { addSources, sourceOf } from '../../server/src/chat/read-scope'
import { SHARED_WITH_ME_MAX, sharedWithMeOff } from '../../server/src/chat/shared-with-me-tool'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { RuleSet } from '../../server/src/policy/access'
import { teamTimeZone, updateTeamSettings } from '../../server/src/admin/settings'
import { zonedDay } from '../../server/src/system/time-zone'
import { OWN_WORDS_TOOLS, ROOMS_SEEN_READ_ONLY_TOOLS, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { roomsOf } from '../../server/src/rooms/service'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const LIST = (args: Record<string, unknown> = {}) => fake({ tool: 'shared_with_me', args, sayResult: true })

let h: Harness
const socks: Record<string, TestSocket> = {}
let finance = '', marketing = '', financeRoom = ''
let clock = Date.now()
const put = (rel: string, body: string) => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }
type Subject = { subjectType: 'user' | 'group'; subjectId: string }
const shareFile = (owner: string, p: string, add: Subject[], remove: Subject[] = []) => h.api(owner).call(API.putFileShares, { body: { path: p, add, remove } })
const user = (id: string): Subject => ({ subjectType: 'user', subjectId: id })
const group = (id: string): Subject => ({ subjectType: 'group', subjectId: id })
const linkOf = async (owner: string, p: string) => ((await h.api(owner).call(API.fileLink, { body: { path: p } })) as { id: string }).id

beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-with-me-tool', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    if (g === 'finance') finance = id; else marketing = id
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('tess', 'tess', 'Tess Yoon', 'member', 'active', NULL)").run()
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  financeRoom = ((await h.api('bob').call(API.listRooms)).items as Room[]).find((r) => r.kind === 'team' && r.name === 'Finance')!.id
  for (const u of ['alice', 'bob', 'erin']) { socks[u] = await h.ws(u, { windowId: `win-swm-${u}` }); await socks[u]!.next('hello') }
  // a shared file with the same name as a file in bob's own folders (MAN-020)
  put('users/alice/quote.md', 'ALICE-QUOTE: acme 1,200')
  put('groups/finance/quote.md', 'FINANCE-QUOTE: internal 900')
  put('users/alice/menu.md', 'menu')
  put('users/bob/payroll.md', 'bob payroll')
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

/** deleteFilesRefusal as a scheduled run with the person's own "Always allow" for deletes would ask it: since #1338 a chat
 * that read rooms or a shared file asks on the card, so only such a run, which shows no card, is refused for it */
function scheduledDelete(x: unknown, who: string, db: import('bun:sqlite').Database) {
  const e = x as { spec: Record<string, unknown> }
  db.query("INSERT INTO card_always_allow (user_id, kind, created_at) VALUES (?, 'delete_files', ?)").run(who, new Date().toISOString())
  try {
    const place = () => ({ db, userId: who, chatId: 'no-such-chat', turnId: 'scheduled-delete', locale: 'en' as const, clientKind: 'schedule' })
    return deleteFilesRefusal({ ...e, spec: { ...e.spec, clientKind: 'schedule' }, alwaysPlace: place } as never)
  } finally { db.query("DELETE FROM card_always_allow WHERE user_id = ? AND kind = 'delete_files'").run(who) }
}

type Card = { question: string; note?: string; origin?: string; options?: { label: string; value: string }[]; details?: { label: string; text: string }[] }
async function turn(who: string, content: string, o: { chat?: string; answer?: string | null } = {}) {
  const chatId = o.chat ?? (await h.api(who).call(API.createChat, { body: {} })).id
  const r = await h.api(who).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  let card = null as Card | null
  if (o.answer !== undefined) {
    const c = await socks[who]!.next('turn.request', (f) => f.data.turnId === r.turnId)
    card = c.data.request as unknown as Card
    if (o.answer !== null) await h.api(who).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: o.answer } })
  }
  const done = await socks[who]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  const cards = socks[who]!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === r.turnId).length
  return { chatId, turnId: r.turnId as string, content: done.data.message.content as string, card, cards }
}

describe('the list', () => {
  test('nothing shared: says so; then each file with its name, who shared it, how it reaches the person, the day and its link, by-name shares first', async () => {
    expect((await turn('bob', LIST())).content).toContain('No file is shared with the user one by one right now')
    await shareFile('alice', 'users/alice/quote.md', [user('bob')])
    // (a member shares with their own groups; carol, an admin, with any)
    await h.api('carol').call(API.saveContent, { body: { path: 'users/carol/notes-for-finance.md', content: 'notes', baseSha256: null } })
    await shareFile('carol', 'users/carol/notes-for-finance.md', [group(finance)])
    await shareFile('alice', 'users/alice/menu.md', [group(FILE_SHARE_EVERYONE)])
    const ids = { quote: await linkOf('alice', 'users/alice/quote.md'), notes: await linkOf('carol', 'users/carol/notes-for-finance.md'), menu: await linkOf('alice', 'users/alice/menu.md') }
    const r = await turn('bob', LIST())
    const lines = r.content.split('\n').filter((l) => l.startsWith('- '))
    const day = zonedDay(new Date(), teamTimeZone(h.ctx.db))
    // the list's own order (files/shares.ts sharedWithMe): shared with them by name first, then through a group or the
    // whole team, the newest first in each part
    expect(lines).toEqual([
      `- "quote.md" from "Alice Kim", shared with the user, ${day}: /f/${ids.quote}`,
      `- "menu.md" from "Alice Kim", shared with everyone on the team, ${day}: /f/${ids.menu}`,
      `- "notes-for-finance.md" from "Carol Park", shared with the group "Finance", ${day}: /f/${ids.notes}`,
    ])
    // never the path of a file the folder rules do not show them
    expect(r.content).not.toContain('users/alice')
    expect(r.content).not.toContain('users/carol')
    // someone it was not shared with gets only the whole team's
    const t = await turn('erin', LIST())
    expect(t.content.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(0, 11))).toEqual(['- "menu.md"'])
  })

  test('the day is the team\'s (QA TC-4373): shared at 19:00 UTC is the next day in Asia/Seoul, as Shared with me shows it', async () => {
    const id = await linkOf('alice', 'users/alice/quote.md')
    h.ctx.db.query("UPDATE file_share_grants SET granted_at = '2026-11-16T19:00:00.000Z' WHERE share_id = ? AND subject_type = 'user' AND subject_id = 'bob'").run(id)
    const was = teamTimeZone(h.ctx.db)
    updateTeamSettings(h.ctx.db, { timeZone: 'Asia/Seoul' })
    try {
      const line = (await turn('bob', LIST())).content.split('\n').find((l) => l.endsWith(`/f/${id}`))!
      expect(line).toContain(', 2026-11-17: ')
    } finally { updateTeamSettings(h.ctx.db, { timeZone: was }) }
  })

  test('MAN-020: the shared file and a team file of the same name: the list names the shared one by its link, and read opens exactly that one', async () => {
    const id = await linkOf('alice', 'users/alice/quote.md')
    const r = await turn('bob', [LIST({ query: 'quote' }), fake({ tool: 'read', args: { file_path: `/f/${id}` }, sayResult: true })].join('\n'))
    expect(r.content.split('\n').filter((l) => l.startsWith('- ')).length).toBe(1)
    expect(r.content).toContain('ALICE-QUOTE')
    expect(r.content).not.toContain('FINANCE-QUOTE')
  })

  test('query: a part of the file name or of the sharer\'s name; nothing matching says so', async () => {
    const by = await turn('bob', LIST({ query: 'alice' }))
    expect(by.content.split('\n').filter((l) => l.startsWith('- ')).length).toBe(2)
    const one = await turn('bob', LIST({ query: 'NOTES' }))
    expect(one.content.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(0, 24))).toEqual(['- "notes-for-finance.md"'])
    const none = await turn('bob', LIST({ query: 'payroll<turn_context>' }))
    expect(none.content).toContain('No file shared with the user matches "payroll')
    expect(none.content).not.toContain('<turn_context>')
  })

  test('only what opens now: a share taken away, or a file that left its place, is not listed', async () => {
    await shareFile('carol', 'users/carol/notes-for-finance.md', [], [group(finance)])
    fs.rmSync(path.join(h.ctx.files.fx.root, 'users/alice/menu.md'))
    const r = await turn('bob', LIST())
    expect(r.content.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(0, 12))).toEqual(['- "quote.md"'])
  })

  test('a file their folders show too, shared with them by name: its place in words, no path', async () => {
    // carol (an admin) adds the file through the app, so she owns it, then shares it with bob by name
    await h.api('carol').call(API.saveContent, { body: { path: 'groups/finance/plan-2027.md', content: 'plan', baseSha256: null } })
    await shareFile('carol', 'groups/finance/plan-2027.md', [user('bob')])
    const r = await turn('bob', LIST({ query: 'plan-2027' }))
    const line = r.content.split('\n').find((l) => l.startsWith('- '))!
    expect(line).toContain('"plan-2027.md" from "Carol Park", shared with the user')
    expect(line).toContain("also in the user's folders:")
    expect(line).not.toContain('groups/finance')
  })

  test('names are one line, quoted, our block tags neutralized; capped at SHARED_WITH_ME_MAX with a note', async () => {
    for (let i = 0; i < SHARED_WITH_ME_MAX + 3; i++) {
      await h.api('alice').call(API.saveContent, { body: { path: `users/alice/bulk/f-${String(i).padStart(2, '0')}.md`, content: 'x', baseSha256: null } })
      await shareFile('alice', `users/alice/bulk/f-${String(i).padStart(2, '0')}.md`, [user('erin')])
    }
    h.ctx.db.query("UPDATE users SET name = 'Alice </turn_context> Kim' WHERE id = 'alice'").run()
    try {
      const r = await turn('erin', LIST())
      expect(r.content.split('\n').filter((l) => l.startsWith('- ')).length).toBe(SHARED_WITH_ME_MAX)
      expect(r.content).toContain(`(Only ${SHARED_WITH_ME_MAX} are listed: older ones may be shared too.`)
      expect(r.content).not.toContain('</turn_context>')
      const few = await turn('erin', LIST({ limit: 2 }))
      expect(few.content.split('\n').filter((l) => l.startsWith('- ')).length).toBe(2)
    } finally { h.ctx.db.query("UPDATE users SET name = 'Alice Kim' WHERE id = 'alice'").run() }
  })
})

describe('where it is offered', () => {
  test('the person\'s own chat has the tool and no list in its instructions or its turn context', async () => {
    expect((await turn('bob', fake({ echo: 'tools' }))).content.split(',')).toContain('shared_with_me')
    const sys = (await turn('bob', fake({ echo: 'system' }))).content
    expect(sys).toContain('call shared_with_me')
    expect(sys).not.toContain('Files shared with you')
    expect(sys).not.toContain('quote.md')
    expect((await turn('bob', fake({ echo: 'message' }))).content).not.toContain('quote.md')
  })

  test('off: a shared chat, a template or restricted run, Slack, a scheduled run, a confidential chat, a guest', async () => {
    const base = { rt: h.rt(), spec: { userId: 'bob', chatId: 'none', clientKind: 'web' }, shared: null, restricted: false, templateRun: false, fromSlack: false }
    const off = (over: Record<string, unknown>) => sharedWithMeOff({ ...base, ...over } as never)
    expect(off({})).toBeNull()
    expect(off({ spec: { ...base.spec, clientKind: 'schedule' } })).toBe('a scheduled run')
    expect(off({ shared: { kind: 'project' } })).toBe('a shared chat')
    expect(off({ restricted: true })).toBe('a run limited to one task')
    expect(off({ templateRun: true })).toBe('a run limited to one task')
    expect(off({ fromSlack: true })).toBe('a question from Slack')
    const chat = (await h.api('bob').call(API.createChat, { body: {} })).id
    h.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(chat)
    expect(off({ spec: { ...base.spec, chatId: chat } })).toBe('a confidential chat')
    h.ctx.db.query("INSERT INTO users (id, username, name, role, status, guest) VALUES ('gus', 'gus', 'Gus Guest', 'member', 'active', 1)").run()
    expect(off({ spec: { ...base.spec, userId: 'gus' } })).toBe('a guest')
  })

  test('never a sub-agent\'s, a shared chat\'s or a guest\'s tool; after a room read it goes on without the room card', () => {
    expect(PARENT_ONLY_TOOLS.has('shared_with_me')).toBe(true)
    expect(SHARED_TOOLS.has('shared_with_me')).toBe(false)
    expect(GUEST_TURN_TOOLS.has('shared_with_me')).toBe(false)
    expect(ROOMS_SEEN_READ_ONLY_TOOLS.has('shared_with_me')).toBe(true)
  })
})

describe('a file read through a grant is other people\'s words', () => {
  const exec = (chatId: string, who = 'bob', readPaths: string[] = []) => ({ rt: h.rt(), spec: { userId: who, chatId, assistantId: '' }, roomsSeen: false, files: { readPaths: new Set(readPaths) } }) as never

  test('readByGrant and the card\'s words: a place the person\'s own folder rules do not open, in this turn\'s reads or in the chat\'s read scope', async () => {
    const chat = (await h.api('bob').call(API.createChat, { body: {} })).id
    expect(readByGrant(exec(chat))).toBe(false)
    // his own folders: not a grant read
    expect(readByGrant(exec(chat, 'bob', ['groups/finance/quote.md', 'users/bob/payroll.md', 'shared/glossary.md']))).toBe(false)
    // another person's folder, a group's he is not in: only a grant opens those
    expect(readByGrant(exec(chat, 'bob', ['users/alice/quote.md']))).toBe(true)
    expect(readByGrant(exec(chat, 'bob', ['groups/marketing/campaign-brief.md']))).toBe(true)
    // kept with the chat: the scope of an earlier turn
    const rules = RuleSet.load(h.ctx.db)
    addSources(h.ctx.db, chat, [sourceOf(h.ctx.db, rules, 'groups/finance/quote.md')])
    expect(readByGrant(exec(chat))).toBe(false)
    addSources(h.ctx.db, chat, [sourceOf(h.ctx.db, rules, 'users/alice/quote.md')])
    expect(readByGrant(exec(chat))).toBe(true)
    // only the card's words go by this (seenWhy): the gates ask the chat's marks (turn.ts noteOthersReads)
    expect(readRooms(exec(chat))).toBe(false)
    expect(seenWhy(exec(chat), 'roomsSeenWhy')).toBe('sharedFileSeenWhy')
    expect(seenWhy(exec(chat), 'roomsSeenConfirm')).toBe('sharedFileSeenConfirm')
    expect(seenWhy(exec(chat), 'roomsSeenConfirmRead')).toBe('sharedFileSeenConfirmRead')
    // a room's words came in too: the room sentence, as before
    addSources(h.ctx.db, chat, [{ type: 'room', id: financeRoom }])
    expect(seenWhy(exec(chat), 'roomsSeenWhy')).toBe('roomsSeenWhy')
    // the owner's own chat that read the same file: her own folder, no grant
    const hers = (await h.api('alice').call(API.createChat, { body: {} })).id
    addSources(h.ctx.db, hers, [sourceOf(h.ctx.db, rules, 'users/alice/quote.md')])
    expect(readByGrant(exec(hers, 'alice'))).toBe(false)
    expect(seenWhy(exec(hers, 'alice'), 'roomsSeenWhy')).toBe('roomsSeenWhy')
  })

  test('the marks: the list itself (names other people wrote) and a grant read mark the chat; the grant read also counts as a room read for good', async () => {
    expect(OWN_WORDS_TOOLS.has('shared_with_me')).toBe(false)
    const marks = (chat: string) => h.ctx.db.query('SELECT others_words o, rooms_seen r FROM chats WHERE id = ?').get(chat) as { o: number; r: number }
    const listed = await turn('bob', LIST())
    expect(marks(listed.chatId)).toEqual({ o: 1, r: 0 })
    const id = await linkOf('alice', 'users/alice/quote.md')
    const read = await turn('bob', fake({ tool: 'read', args: { file_path: `/f/${id}` } }))
    expect(marks(read.chatId)).toEqual({ o: 1, r: 1 })
  })

  test('the card after a grant read says a shared file was read, not "messages from your conversations", in all six languages', async () => {
    const id = await linkOf('alice', 'users/alice/quote.md')
    const read = fake({ tool: 'read', args: { file_path: `/f/${id}` } })
    const write = fake({ tool: 'write', args: { file_path: 'groups/finance/after-shared.md', content: 'x' }, sayResult: true })
    const r = await turn('bob', `${read}\n${write}`, { answer: null })
    // (bob's language in the fixture is Korean)
    // (the wider-audience card says why under its buttons, QA TC-4815)
    expect(r.card!.note).toContain(tr('sharedFileSeenWhy', 'ko').slice(0, 20))
    expect(r.card!.note).not.toContain(tr('roomsSeenWhy', 'ko').slice(0, 12))
    for (const l of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
      for (const k of ['sharedFileSeenWhy', 'sharedFileSeenConfirm', 'sharedFileSeenConfirmRead'] as const) {
        expect(tr(k, l).length).toBeGreaterThan(10)
        expect(tr(k, l)).not.toBe(tr(k.replace('sharedFile', 'rooms') as 'roomsSeenWhy', l))
      }
      expect(tr('sharedFileSeenConfirm', l, { ai: 'AI', what: 'W' })).toContain('W')
    }
    expect(tr('sharedFileSeenWhy', 'en')).toBe("A file someone shared with you (other people's words) was read here, so changes are asked first.")
  })

  test('refusals after a grant read name "a file someone shared" with the user, not their team chat rooms (delete, a change left unanswered); a room read keeps the room words', async () => {
    const rules = RuleSet.load(h.ctx.db)
    // the words picked from what the chat holds (the gate itself asks the marks: readRooms with rooms_seen)
    const chat = (await h.api('bob').call(API.createChat, { body: {} })).id
    addSources(h.ctx.db, chat, [sourceOf(h.ctx.db, rules, 'users/alice/quote.md')])
    const seen = { ...(exec(chat) as object), roomsSeen: true } as never
    expect(othersSource(seen, 'ROOM')).toBe(SHARED_FILE_SOURCE)
    expect(deleteFilesRefusal(seen)).toBeNull()
    expect(scheduledDelete(seen, 'bob', h.ctx.db)).toBeNull() // the person's Always holds after a room or shared-file read (Rule A, decision 20261123-ask-registry-findings)
    expect(DELETE_REFUSAL.sharedFile).toContain('a file someone shared with the user')
    expect(DELETE_REFUSAL.sharedFile).not.toContain('chat room')
    const intoSkills = { path: 'users/bob/payroll.md', to_folder: 'skills' }
    expect(skillFilesRefusal({ ...(seen as object), spec: { userId: 'bob', chatId: chat, assistantId: '', clientKind: 'web' } } as never, intoSkills)!.text).toContain(`read ${SHARED_FILE_SOURCE}`)
    addSources(h.ctx.db, chat, [{ type: 'room', id: financeRoom }])
    expect(othersSource(seen, 'ROOM')).toBe('ROOM')
    expect(deleteFilesRefusal(seen)).toBeNull()
    expect(scheduledDelete(seen, 'bob', h.ctx.db)).toBeNull() // the person's Always holds after a room or shared-file read (Rule A, decision 20261123-ask-registry-findings)
    expect(skillFilesRefusal({ ...(seen as object), spec: { userId: 'bob', chatId: chat, assistantId: '', clientKind: 'web' } } as never, intoSkills)!.text).toContain('read a team chat room')

    // end to end: bob's AI reads alice's shared file, then tries to delete one of his files; then a change whose card nobody answers
    const id = await linkOf('alice', 'users/alice/quote.md')
    const read = fake({ tool: 'read', args: { file_path: `/f/${id}` } })
    const del = fake({ tool: 'delete_files', args: { paths: ['users/bob/payroll.md'] }, sayResult: true })
    // (the chat is marked once the read is noted: the delete comes in the next message of the same chat)
    const first = await turn('bob', read)
    // (since #1338 the delete asks on its card, its question led by the shared-file line; left unanswered, nothing goes)
    const d = await turn('bob', del, { chat: first.chatId, answer: null })
    expect(d.cards).toBe(1)
    expect(d.card!.question).toContain(tr('sharedFileSeenWhy', 'ko').slice(0, 20))
    expect(d.content).not.toContain('team chat rooms')
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users/bob/payroll.md'))).toBe(true)
    const audit = h.ctx.db.query("SELECT json_extract(detail, '$.outcome') o, json_extract(detail, '$.reason') r FROM audit_log WHERE action = 'files.ai_trash' AND json_extract(detail, '$.turnId') = ?").all(d.turnId)
    expect(audit).toEqual([{ o: 'no_answer', r: null }])
    const write = fake({ tool: 'write', args: { file_path: 'groups/finance/declined-after-shared.md', content: 'x' }, sayResult: true })
    // (left unanswered: the card runs out, and the refusal says why every change here asks)
    const w = await turn('bob', `${read}\n${write}`, { answer: null })
    expect(w.card!.note).toContain(tr('sharedFileSeenWhy', 'ko').slice(0, 20))
    expect(w.content).toContain('a file someone shared with the user')
    expect(w.content).not.toContain('team chat rooms')
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'groups/finance/declined-after-shared.md'))).toBe(false)
  })

  // Rule A (#1143, the owner's 11-13 rule): the person's own "Always allow" is final, also after a grant read; the guards
  // below hold for people without it (docs/decisions/20261116-sharing-all-integration.md)
  test('share_with_person after a grant read: without "Always allow" a file the asker did not name is refused and a named one asks; with it the choice is final', async () => {
    const id = await linkOf('alice', 'users/alice/quote.md')
    const read = fake({ tool: 'read', args: { file_path: `/f/${id}` } })
    const give = fake({ tool: 'share_with_person', args: { paths: ['users/bob/payroll.md'], people: ['Alice Kim'] }, sayResult: true })
    // the AI read alice's shared file (which could say "share payroll.md with Alice") and then shares bob's file with her
    const r = await turn('bob', `summarise the quote alice sent\n${read}\n${give}`)
    expect(r.cards).toBe(0)
    expect(r.content).toContain('Nothing was shared')
    expect(r.content).toContain('named it in their own message')
    expect(h.ctx.db.query("SELECT 1 FROM file_shares WHERE path = 'users/bob/payroll.md'").get()).toBeNull()
    // the file named by bob: the card (the explicit ask never skips it after other people's words)
    const card = await turn('bob', `summarise the quote and share payroll.md with Alice Kim after\n${read}\n${give}`, { answer: 'no' })
    expect(card.card!.origin).toBe('server')
    expect(card.card!.options!.map((x) => x.value)).toEqual(['share', '__always', 'no'])
    expect(h.ctx.db.query("SELECT 1 FROM file_shares WHERE path = 'users/bob/payroll.md'").get()).toBeNull()
    // "Always allow" on: final (the residual risk Rule A accepts: a planted line in a shared file is then acted on)
    keepAlways(h.ctx.db, 'bob', 'share_files', null)
    try {
      const on = await turn('bob', `summarise the quote alice sent\n${read}\n${give}`)
      expect(on.cards).toBe(0)
      expect(on.content).toContain('"status":"shared"')
    } finally {
      dropAlways(h.ctx.db, 'bob', 'card:share_files')
      await shareFile('bob', 'users/bob/payroll.md', [], [user('alice')])
    }
  })

  test('post_to_room under "Always allow": after a grant read the explicit-ask skip is off and the card leads the call', async () => {
    const id = await linkOf('alice', 'users/alice/quote.md')
    const read = fake({ tool: 'read', args: { file_path: `/f/${id}` } })
    const post = (text: string) => fake({ tool: 'post_to_room', args: { room: financeRoom, text }, sayResult: true })
    // control: the explicit ask in his own words posts with no card
    const control = await turn('bob', `send the note to Finance\n${post('control')}`)
    expect(control.cards).toBe(0)
    const r = await turn('bob', `send the note to Finance\n${read}\n${post('after a grant read')}`, { answer: 'no' })
    expect(r.card!.origin).toBe('server')
    expect(r.card!.question).toContain('Finance')
  })

  test('the room-change gate: after a grant read a change to a team file waits for the person\'s yes', async () => {
    const id = await linkOf('alice', 'users/alice/quote.md')
    const read = fake({ tool: 'read', args: { file_path: `/f/${id}` } })
    const write = fake({ tool: 'write', args: { file_path: 'groups/finance/from-quote.md', content: 'copied' }, sayResult: true })
    const control = await turn('bob', write)
    expect(control.cards).toBe(0)
    fs.rmSync(path.join(h.ctx.files.fx.root, 'groups/finance/from-quote.md'), { force: true })
    const r = await turn('bob', `${read}\n${write}`, { answer: null })
    expect(r.card!.origin).toBe('server')
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'groups/finance/from-quote.md'))).toBe(false)
  })
})
