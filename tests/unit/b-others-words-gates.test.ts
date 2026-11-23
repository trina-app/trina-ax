// The share and room-post gates count file content written by others (docs/decisions/20261116-always-allow-more-cards.md
// "Content written by others", 20261116-shared-files-for-the-ai.md, 20261116-no-card-after-explicit-ask.md): once a
// person's own chat has read something another person wrote (a teammate's team file, a file shared with them, a page,
// a connected service), the explicit-ask skip (our own text match) no longer applies there. Their own "Always allow" is
// final (owner 2026-11-13, docs/decisions/20261116-always-allow-final-rule-a.md): with it on, shares and room posts go
// without the card in their own chat whatever it read; the guards apply only where they have not chosen it.
// The fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner (b-harness people), tess added.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared'
import { API, type Room } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { dropAlways, keepAlways } from '../../server/src/chat/always-allow'
import { fileSharesOf } from '../../server/src/files/shares'
import { fromAsker, madeInTurn, namedInFull, namesGroup, namesRecipient, othersWordsIn, soleNames } from '../../server/src/chat/shared-actions'
import { shareWithPersonTool } from '../../server/src/chat/share-with-person'
import { OWN_CHAT_TEAM_TOOLS, OWN_WORDS_TOOLS } from '../../server/src/rooms/ai-tools'
import { roomsOf } from '../../server/src/rooms/service'
import { turnPerson } from '../../server/src/chat/tools'
import type { TurnExec } from '../../server/src/chat/turn'

setDefaultTimeout(90_000)
const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives sit in the person's message: their strings spelled as JSON escapes, so the person's own
// words are only what the test writes around them
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const share = (args: Record<string, unknown>) => fake({ tool: 'share_with_person', args, sayResult: true })
const post = (args: Record<string, unknown>) => fake({ tool: 'post_to_room', args, sayResult: true })
const read = (file_path: string) => fake({ tool: 'read', args: { file_path } })

let h: Harness
const socks: Record<string, TestSocket> = {}
let clock = Date.now()
let everyone = ''
const put = (rel: string, body: string, by?: string) => {
  const abs = path.join(h.ctx.files.fx.root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  if (by) h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action) VALUES (NULL, ?, ?, 'create')").run(by, rel)
}
beforeAll(async () => {
  // a short card wait: a turn whose card nobody answers ends by itself (the tests count the cards)
  h = await startHarness({ name: 'b-others-words-gates', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  h.ctx.db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('tess', 'tess', 'Tess Yoon', 'member', 'active', NULL)").run()
  for (const u of ['alice', 'bob']) {
    socks[u] = await h.ws(u, { windowId: `win-owg-${u}` })
    await socks[u]!.next('hello')
  }
  everyone = ((await h.api('bob').call(API.listRooms)).items as Room[]).find((r) => r.kind === 'all')!.id
  // a teammate's file in a folder bob reads, one of bob's own, and one alice keeps in her own folder
  put('shared/alice-notes.md', 'notes by alice', 'alice')
  put('users/bob/own-notes.md', 'notes by bob', 'bob')
  put('users/alice/for-bob.md', 'a file alice shares with bob', 'alice')
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) put(`users/bob/ledger-${n}.txt`, `ledger ${n}`, 'bob')
  keepAlways(h.ctx.db, 'bob', 'share_files', null)
  keepAlways(h.ctx.db, 'bob', 'post_to_room', null)
})
afterAll(async () => {
  for (const k of ['share_files', 'post_to_room']) dropAlways(h.ctx.db, 'bob', `card:${k}`)
  for (const s of Object.values(socks)) s.close()
  await h?.close()
})

/** One turn of `user`; a card it raises is left unanswered (it ends by itself). The cards raised and the AI's words. */
async function turn(user: string, content: string, chat?: string) {
  const chatId = chat ?? (await h.api(user).call(API.createChat, { body: {} })).id
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const done = await socks[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 40_000)
  const cards = socks[user]!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === r.turnId)
    .map((f) => (f as unknown as { data: { request: { options?: { value: string }[] } } }).data.request)
  return { chatId, turnId: r.turnId as string, messageId: r.userMessage!.id as string, content: done.data.message.content as string, cards }
}
const sharedRow = (p: string) => h.ctx.db.query('SELECT 1 FROM file_shares WHERE path = ?').get(p)
// (the file's and the person's names as JSON escapes: bob's own words name neither)
const unnamed = (n: number) => share({ paths: [`users/bob/ledger-${n}.txt`], people: ['Tess Yoon'] })

describe('share_with_person with "Always allow" on, in my own chat', () => {
  test('a clean chat, my message asks and names the person: no card (the owner\'s rule), whatever the file', async () => {
    const r = await turn('bob', `send it to tess\n${unnamed(1)}`)
    expect(r.cards).toHaveLength(0)
    expect(JSON.parse(r.content).status).toBe('shared')
  })

  test('after reading my own file: still no card', async () => {
    const r = await turn('bob', `send it to tess\n${read('users/bob/own-notes.md')}\n${unnamed(2)}`)
    expect(r.cards).toHaveLength(0)
    expect(JSON.parse(r.content).status).toBe('shared')
  })

  test('after reading a teammate\'s team file, in the same answer: my Always allow is final, no card', async () => {
    const r = await turn('bob', `send it to tess\n${read('shared/alice-notes.md')}\n${unnamed(3)}`)
    expect(r.cards).toHaveLength(0)
    expect(JSON.parse(r.content).status).toBe('shared')
  })

  test('...and in a later answer of the same chat, also when my message names nobody', async () => {
    const first = await turn('bob', `read it\n${read('shared/alice-notes.md')}`)
    const r = await turn('bob', `go on\n${unnamed(4)}`, first.chatId)
    expect(r.cards).toHaveLength(0)
    expect(sharedRow('users/bob/ledger-4.txt')).not.toBeNull()
  })

  test('after reading a file shared with me (a share grant): my Always allow still holds', async () => {
    fileSharesOf(h.ctx).change('alice', 'users/alice/for-bob.md', [{ subjectType: 'user', subjectId: 'bob' }], [], 'en')
    const r = await turn('bob', `go on\n${fake({ tool: 'read', args: { file_path: 'users/alice/for-bob.md' }, sayResult: true })}\n${unnamed(5)}`)
    // (the grant read worked: the file's text came back)
    expect(r.content).toContain('a file alice shares with bob')
    expect(r.cards).toHaveLength(0)
    expect(sharedRow('users/bob/ledger-5.txt')).not.toBeNull()
  })

  test('without Always allow, after such a read: the explicit ask of my own named file to a named person goes (do then undo)', async () => {
    dropAlways(h.ctx.db, 'bob', 'card:share_files')
    try {
      const first = await turn('bob', `read it\n${read('shared/alice-notes.md')}`)
      // since docs/decisions/20261123-do-then-undo.md content others wrote no longer stops the explicit ask: the file and
      // the person are in my own words, the file is mine, and the share card offers Undo
      const explicit = await turn('bob', `share ledger-6.txt with tess\n${unnamed(6)}`, first.chatId)
      expect(explicit.cards).toHaveLength(0)
      expect(sharedRow('users/bob/ledger-6.txt')).not.toBeNull()
      // a send word is no ask to share a file (SHARE_ASK): the card
      const named = await turn('bob', `send ledger-7.txt to tess\n${unnamed(7)}`, first.chatId)
      expect(named.cards).toHaveLength(1)
      expect(sharedRow('users/bob/ledger-7.txt')).toBeNull()
      // a chat that read rooms (a share grant read counts as one): a file my own message did not bring is refused
      const grant = await turn('bob', `go on\n${fake({ tool: 'read', args: { file_path: 'users/alice/for-bob.md' }, sayResult: true })}\n${unnamed(8)}`)
      expect(grant.content).toContain('a file is shared only when the user named it in their own message')
      expect(grant.cards).toHaveLength(0)
      expect(sharedRow('users/bob/ledger-8.txt')).toBeNull()
    } finally { keepAlways(h.ctx.db, 'bob', 'share_files', null) }
  })
})

describe('post_to_room with "Always allow" on, in my own chat', () => {
  // (the room's id as JSON escapes; bob's words name no place)
  const toEveryone = (text: string) => post({ room: everyone, text })
  test('a clean chat, my message asks and names the place: no card', async () => {
    const r = await turn('bob', `send this to tess\n${post({ room: 'Tess Yoon', text: 'hello one' })}`)
    expect(r.cards).toHaveLength(0)
    expect(JSON.parse(r.content).status).toBe('sent')
  })

  test('after reading a teammate\'s team file: my Always allow is final, also for a place my message did not name', async () => {
    const r = await turn('bob', `go on\n${read('shared/alice-notes.md')}\n${toEveryone('hello two')}`)
    expect(r.cards).toHaveLength(0)
    expect(JSON.parse(r.content).status).toBe('sent')
  })

  test('without Always allow: after reading a file the recipient can see too, the explicit ask goes (do then undo)', async () => {
    dropAlways(h.ctx.db, 'bob', 'card:post_to_room')
    try {
      // (docs/decisions/20261123-do-then-undo.md: the floor is content the recipient could not see, and tess sees shared/)
      const r = await turn('bob', `send this one to tess\n${read('shared/alice-notes.md')}\n${post({ room: 'Tess Yoon', text: 'hello three' })}`)
      expect(r.cards).toHaveLength(0)
      expect(r.content).toContain('"status":"sent"')
    } finally { keepAlways(h.ctx.db, 'bob', 'post_to_room', null) }
  })
})

describe('what counts as content written by others', () => {
  const marked = (chatId: string) => !!(h.ctx.db.query('SELECT others_words AS o FROM chats WHERE id = ?').get(chatId) as { o: number }).o

  test('the tools that bring nothing in are listed; the web, rooms, Drive, Slack and anything new are not (fails closed)', () => {
    for (const t of ['read', 'grep', 'glob', 'list', 'write', 'edit', 'make_file', 'ask_user', 'set_title', 'share_with_person', 'post_to_room', 'agent']) expect(OWN_WORDS_TOOLS.has(t)).toBe(true)
    for (const t of ['find_skills', 'WebSearch', 'web_search', 'web_fetch', 'save_url', 'rooms', 'room_read', 'room_file', 'chat_file', 'save_room_file', 'drive_read', 'drive_search', 'slack_read_channel', 'box_shell', 'call_tool', 'api_request', 'read_page', 'a_tool_added_later']) expect(OWN_WORDS_TOOLS.has(t)).toBe(false)
    // a room read keeps a chat to the team's own words for the room card, but its messages are other people's words here
    expect(OWN_CHAT_TEAM_TOOLS.has('room_read')).toBe(true)
  })

  test('my own files do not mark the chat; a teammate\'s file, a file with no history in a team folder, and one a teammate changed do', async () => {
    const own = await turn('bob', `read it\n${read('users/bob/own-notes.md')}`)
    expect(marked(own.chatId)).toBe(false)
    // a team file I made myself, read again: still mine
    put('shared/bob-plan.md', 'plan by bob', 'bob')
    const mine = await turn('bob', `read it\n${read('shared/bob-plan.md')}`)
    expect(marked(mine.chatId)).toBe(false)
    // listing a team folder shows names only: not marked
    const listed = await turn('bob', `look\n${fake({ tool: 'list', args: { path: 'shared' } })}`)
    expect(marked(listed.chatId)).toBe(false)
    // ...then a teammate changes it
    h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action) VALUES (NULL, 'alice', 'shared/bob-plan.md', 'update')").run()
    const changed = await turn('bob', `read it\n${read('shared/bob-plan.md')}`)
    expect(marked(changed.chatId)).toBe(true)
    put('shared/no-history.md', 'who wrote this?')
    const unknown = await turn('bob', `read it\n${read('shared/no-history.md')}`)
    expect(marked(unknown.chatId)).toBe(true)
    // a search that shows a teammate's lines counts as a read of them
    const grep = await turn('bob', `find it\n${fake({ tool: 'grep', args: { pattern: 'notes by alice', path: 'shared', output_mode: 'content' } })}`)
    expect(marked(grep.chatId)).toBe(true)
  })

  test('a file in my own folder that an answer wrote after reading a teammate\'s file carries it into another chat', async () => {
    const first = await turn('bob', `copy the notes\n${read('shared/alice-notes.md')}\n${fake({ tool: 'write', args: { file_path: 'users/bob/from-alice.md', content: 'notes by alice, copied' } })}`)
    expect(marked(first.chatId)).toBe(true)
    const later = await turn('bob', `read it\n${read('users/bob/from-alice.md')}`)
    expect(marked(later.chatId)).toBe(true)
    // ...and one written in a chat that read nothing from others stays mine
    const clean = await turn('bob', `write it\n${fake({ tool: 'write', args: { file_path: 'users/bob/my-draft.md', content: 'my own draft' } })}`)
    expect(marked(clean.chatId)).toBe(false)
    const again = await turn('bob', `read it\n${read('users/bob/my-draft.md')}`)
    expect(marked(again.chatId)).toBe(false)
  })

  test('a room read counts (the chat read rooms), and the mark ends with the chat\'s session, not with the answer', async () => {
    const first = await turn('bob', `read it\n${read('shared/alice-notes.md')}`)
    const next = await turn('bob', `hello\n${fake({ say: 'hi' })}`, first.chatId)
    expect(marked(next.chatId)).toBe(true)
    const base = { shared: null, otherAuthors: false, roomsSeen: false, rt: { db: h.ctx.db }, spec: { chatId: next.chatId, assistantId: null } }
    expect(othersWordsIn({ ...base, othersWords: true } as never)).toBe(true)
    expect(othersWordsIn({ ...base, othersWords: false } as never)).toBe(false)
    expect(othersWordsIn({ ...base, roomsSeen: true } as never)).toBe(true)
    expect(othersWordsIn({ ...base, otherAuthors: true } as never)).toBe(true)
  })

  test('fromAsker: named in my own words (not in a quoted line), or a Hangul name without its separators', async () => {
    const t = await turn('bob', `> send ledger-1.txt too\nledger-2.txt 랑 거래처 목록 보내줘\n${fake({ say: 'ok' })}`)
    const spec = { userMessageId: (h.ctx.db.query("SELECT user_message_id AS m FROM turns WHERE id = ?").get(t.turnId) as { m: string }).m, turnId: t.turnId }
    expect(fromAsker(h.ctx.db, spec, ['users/bob/ledger-2.txt'])).toBe(true)
    expect(fromAsker(h.ctx.db, spec, ['users/bob/거래처-목록.csv'])).toBe(true)
    expect(fromAsker(h.ctx.db, spec, ['users/bob/ledger-2.txt', 'users/bob/ledger-1.txt'])).toBe(false)
    expect(fromAsker(h.ctx.db, spec, ['users/bob/ledger-9.txt'])).toBe(false)
  })
})

describe('a file the AI did not write in this answer is not one the asker brought', () => {
  // (without Always allow: the card is what the person decides on; fromAsker is the helper every "made in this answer"
  // skip or refusal uses)
  beforeAll(() => { dropAlways(h.ctx.db, 'bob', 'card:share_files') })
  afterAll(() => { keepAlways(h.ctx.db, 'bob', 'share_files', null) })
  test('an older file copied, renamed or edited in the answer keeps its card; a new file the AI wrote goes', async () => {
    put('users/bob/payroll-a.txt', 'pay a', 'bob'); put('users/bob/payroll-b.txt', 'pay b', 'bob'); put('users/bob/payroll-c.txt', 'pay c', 'bob')
    const readIt = read('shared/alice-notes.md')
    const to = (p: string) => share({ paths: [p], people: ['Tess Yoon'] })
    const copied = await turn('bob', `send the summary to tess\n${readIt}\n${fake({ tool: 'copy_files', args: { paths: ['users/bob/payroll-a.txt'], to_folder: 'users/bob/out-a' } })}\n${to('users/bob/out-a/payroll-a.txt')}`)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users/bob/out-a/payroll-a.txt'))).toBe(true)
    expect(sharedRow('users/bob/out-a/payroll-a.txt')).toBeNull()
    expect(copied.content).not.toContain('"status":"shared"')
    const renamed = await turn('bob', `send the summary to tess\n${readIt}\n${fake({ tool: 'rename_file', args: { path: 'users/bob/payroll-b.txt', new_name: 'summary-b.txt' } })}\n${to('users/bob/summary-b.txt')}`)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users/bob/summary-b.txt'))).toBe(true)
    expect(sharedRow('users/bob/summary-b.txt')).toBeNull()
    expect(renamed.content).not.toContain('"status":"shared"')
    const edited = await turn('bob', `send the summary to tess\n${readIt}\n${read('users/bob/payroll-c.txt')}\n${fake({ tool: 'edit', args: { file_path: 'users/bob/payroll-c.txt', old_string: 'pay c', new_string: 'pay c.' } })}\n${to('users/bob/payroll-c.txt')}`)
    expect(sharedRow('users/bob/payroll-c.txt')).toBeNull()
    expect(edited.content).not.toContain('"status":"shared"')
    // a new file the AI wrote in this answer: one the asker brought (fromAsker), though the card shows in this chat
    const made = await turn('bob', `send the summary to tess\n${readIt}\n${fake({ tool: 'write', args: { file_path: 'users/bob/new-summary.md', content: 'summary' } })}\n${to('users/bob/new-summary.md')}`)
    expect(fromAsker(h.ctx.db, { userMessageId: made.messageId, turnId: made.turnId }, ['users/bob/new-summary.md'])).toBe(true)
    expect(fromAsker(h.ctx.db, { userMessageId: copied.messageId, turnId: copied.turnId }, ['users/bob/out-a/payroll-a.txt'])).toBe(false)
    expect(fromAsker(h.ctx.db, { userMessageId: renamed.messageId, turnId: renamed.turnId }, ['users/bob/summary-b.txt'])).toBe(false)
    expect(fromAsker(h.ctx.db, { userMessageId: edited.messageId, turnId: edited.turnId }, ['users/bob/payroll-c.txt'])).toBe(false)
    for (const t of [copied, renamed, edited, made]) expect(t.cards).toHaveLength(1)
  })
})

describe('a scheduled run (nobody answers a card)', () => {
  // the run's person chose "Always allow" for shares: the tool is offered there (share-with-person.ts shareWithPersonOff)
  async function run(task: string, othersWords: boolean, n: number) {
    const t = await turn('bob', `${task}\n${fake({ say: 'ok' })}`)
    const userMessageId = (h.ctx.db.query('SELECT user_message_id AS m FROM turns WHERE id = ?').get(t.turnId) as { m: string }).m
    const files = {}
    const exec = {
      rt: h.rt(), files, shared: null, restricted: false, templateRun: false, roomsSeen: false, otherAuthors: false, othersWords,
      spec: { clientKind: 'schedule', userId: 'bob', chatId: t.chatId, locale: 'en', assistantId: null, userMessageId, turnId: t.turnId },
      livePrincipal: () => h.ctx.files.principal('bob'), patchToolStep: () => {}, runningStepId: () => null,
      // (TurnExec.waitForPerson in a scheduled run: no answer, at once)
      waitForPerson: async () => null,
      alwaysPlace: () => ({ db: h.ctx.db, userId: 'bob', chatId: t.chatId, turnId: t.turnId, locale: 'en', clientKind: 'schedule' }),
    }
    const r = await shareWithPersonTool(exec as never).call({ paths: [`users/bob/ledger-${n}.txt`], people: ['Tess Yoon'] }, files as never)
    return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
  }

  test('the person\'s Always allow covers their scheduled runs (owner 2026-11-14), also after content by others; without it nothing is shared', async () => {
    h.ctx.db.query("DELETE FROM file_shares WHERE path LIKE 'users/bob/ledger-%'").run()
    expect(JSON.parse(await run('send the weekly file to tess', false, 9)).status).toBe('shared')
    expect(JSON.parse(await run('weekly task', false, 1)).status).toBe('shared')
    h.ctx.db.query("DELETE FROM file_shares WHERE path LIKE 'users/bob/ledger-%'").run()
    // the run read a teammate's file: the person's choice is final there too
    expect(JSON.parse(await run('send the weekly file to tess', true, 1)).status).toBe('shared')
    h.ctx.db.query("DELETE FROM file_shares WHERE path LIKE 'users/bob/ledger-%'").run()
    // without Always allow: not offered in a scheduled run at all
    dropAlways(h.ctx.db, 'bob', 'card:share_files')
    try {
      expect(await run('send ledger-9.txt to tess every week', false, 9)).toContain('Nothing was shared: a scheduled run has nobody to answer the card')
      expect(await run('send ledger-9.txt to tess every week', true, 9)).toContain('Nothing was shared: a scheduled run has nobody to answer the card')
      expect(sharedRow('users/bob/ledger-9.txt')).toBeNull()
    } finally { keepAlways(h.ctx.db, 'bob', 'share_files', null) }
  })
})

describe('a chat other members wrote in that is no longer shared', () => {
  test('Always allow needs no own ask there; a file the asker did not bring goes too (docs/decisions/20261122-always-allow-holds-everywhere.md B4)', async () => {
    const t = await turn('bob', `ledger-3.txt please\n${fake({ say: 'ok' })}`)
    const userMessageId = (h.ctx.db.query('SELECT user_message_id AS m FROM turns WHERE id = ?').get(t.turnId) as { m: string }).m
    const files = {}
    let cards = 0
    const exec = {
      rt: h.rt(), files, shared: null, restricted: false, templateRun: false, roomsSeen: false, otherAuthors: true, othersWords: true,
      spec: { clientKind: 'web', userId: 'bob', chatId: t.chatId, locale: 'en', assistantId: null, userMessageId, turnId: t.turnId },
      livePrincipal: () => h.ctx.files.principal('bob'), patchToolStep: () => {}, noteReads: () => {}, runningStepId: () => null,
      waitForPerson: async () => { cards++; return null },
      alwaysPlace: () => ({ db: h.ctx.db, userId: 'bob', chatId: t.chatId, turnId: t.turnId, locale: 'en', clientKind: 'web' }),
    }
    h.ctx.db.query("DELETE FROM file_shares WHERE path LIKE 'users/bob/ledger-%'").run()
    const call = async (n: number) => (await shareWithPersonTool(exec as never).call({ paths: [`users/bob/ledger-${n}.txt`], people: ['Tess Yoon'] }, files as never)).content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    // named file, nobody named and no ask word: no card under Always allow
    expect(JSON.parse(await call(3)).status).toBe('shared')
    expect(cards).toBe(0)
    // a file bob did not bring: under his Always allow it goes too (Rule A); without it, refused
    expect(JSON.parse(await call(4)).status).toBe('shared')
    expect(cards).toBe(0)
    dropAlways(h.ctx.db, 'bob', 'card:share_files')
    try {
      expect(await call(5)).toContain('a file is shared only when the user named it in their own message')
    } finally { keepAlways(h.ctx.db, 'bob', 'share_files', null) }
  })
})

describe('a file read through a share grant', () => {
  const chatRow = (chatId: string) => h.ctx.db.query('SELECT rooms_seen AS r, others_words AS o FROM chats WHERE id = ?').get(chatId) as { r: number; o: number }
  const grantRead = fake({ tool: 'read', args: { file_path: 'users/alice/for-bob.md' }, sayResult: true })

  test('the mark lasts for the chat and every gate of a room read applies: a later change waits for its card', async () => {
    fileSharesOf(h.ctx).change('alice', 'users/alice/for-bob.md', [{ subjectType: 'user', subjectId: 'bob' }], [], 'en')
    const first = await turn('bob', `read it\n${grantRead}`)
    expect(first.content).toContain('a file alice shares with bob')
    expect(chatRow(first.chatId)).toEqual({ r: 1, o: 1 })
    // a later answer of the same chat: a new team file waits for the person's yes, as after a room read
    const later = await turn('bob', `go on\n${fake({ tool: 'write', args: { file_path: 'shared/after-grant-read.md', content: 'x' } })}`, first.chatId)
    expect(later.cards).toHaveLength(1)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'shared', 'after-grant-read.md'))).toBe(false)
    // a chat that read no shared file is as before: no card
    const clean = await turn('bob', `go on\n${fake({ tool: 'write', args: { file_path: 'shared/no-grant-read.md', content: 'x' } })}`)
    expect(clean.cards).toHaveLength(0)
  })

  test('a scheduled run does not read through a grant', async () => {
    const chat = (await h.api('bob').call(API.createChat, { body: {} })).id
    const row = h.rt().store.chatRow(chat)!
    const started = h.rt().createTurn({ chat: row, userId: 'bob', locale: 'en', windowId: null, clientKind: 'schedule', engine: row.engine as 'claude-code', model: null,
      user: { parentId: row.active_leaf_id, content: `weekly task\n${grantRead}`, attachments: [], clientMessageId: cm() } })
    const done = await socks.bob!.next('message.done', (f) => f.data.message.turnId === started.turnId, 30_000)
    expect(done.data.message.content).not.toContain('a file alice shares with bob')
    expect(chatRow(chat).r).toBe(0)
  })
})

describe('second review: what "made in this answer" means, and a chat that read nothing', () => {
  test('madeInTurn: only a new file the AI wrote itself (write, or make_file from its own text); never one a tool built from another file, a page or a room', () => {
    const db = h.ctx.db
    const ev = (turn: string, p: string, detail: unknown, action = 'create') => db.query('INSERT INTO file_events (turn_id, user_id, path, action, detail) VALUES (?, ?, ?, ?, ?)').run(turn, 'bob', p, action, detail === null ? null : JSON.stringify(detail))
    const cases: [string, unknown, boolean][] = [
      ['w.md', { tool: 'write' }, true],
      ['m.docx', { tool: 'make_file', own: true }, true],
      ['m-old.docx', { tool: 'make_file' }, false],
      ['m-safe.pptx', { tool: 'make_file', safeOpsJob: 'j', quarantined: true }, false],
      ['from-source.pdf', { tool: 'make_file', from: 'users/bob/payroll.xlsx', pages: 2 }, false],
      ['printed.pdf', { tool: 'make_file', from: 'a.md', pages: 1, files: ['b.png'] }, false],
      ['stamped.pdf', { tool: 'stamp_pdf' }, false],
      ['edited.pdf', { tool: 'edit_pdf' }, false],
      ['split.pdf', { tool: 'split_pdf' }, false],
      ['merged.pdf', { tool: 'merge_pdfs' }, false],
      ['out.hwpx', { tool: 'edit_hwp' }, false],
      ['commented.docx', { tool: 'comment_docx' }, false],
      ['page.html', { tool: 'save_url', url: 'https://example.com/', type: 'text/html' }, false],
      ['room.pdf', { tool: 'save_room_file', type: 'application/pdf' }, false],
      ['video.mp4', { tool: 'generate_video' }, false],
      ['copied.txt', { tool: 'copy_files', sourcePaths: ['users/bob/x.txt'] }, false],
      ['moved.txt', { tool: 'move_files', movedFrom: 'users/bob/x.txt' }, false],
      ['no-detail.txt', null, false],
    ]
    for (const [name, detail, made] of cases) {
      const rel = `users/bob/made/${name}`
      ev('turn-made-1', rel, detail)
      expect([name, madeInTurn(db, 'turn-made-1', rel)]).toEqual([name, made])
      // not this turn's
      expect(madeInTurn(db, 'turn-made-other', rel)).toBe(false)
    }
    // a file that was there before the turn and is written again: not new
    ev('turn-made-0', 'users/bob/made/old.md', { tool: 'write' })
    ev('turn-made-1', 'users/bob/made/old.md', { tool: 'write' }, 'update')
    expect(madeInTurn(db, 'turn-made-1', 'users/bob/made/old.md')).toBe(false)
    // written new in this turn, then changed by something else: not what the AI wrote
    const later: [string, string, unknown, string][] = [
      ['stamped-over.pdf', 'turn-made-1', { tool: 'stamp_pdf' }, 'update'],
      ['built-over.xlsx', 'turn-made-1', { tool: 'make_file', from: 'users/bob/payroll.xlsx' }, 'update'],
      ['copied-over.txt', 'turn-made-1', { tool: 'copy_files', sourcePaths: ['users/bob/x.txt'] }, 'create'],
      ['person-over.txt', 'turn-made-9', { tool: 'file-screen' }, 'update'],
    ]
    for (const [name, t, detail, action] of later) {
      const rel = `users/bob/made/${name}`
      ev('turn-made-1', rel, { tool: 'write' })
      ev(t, rel, detail, action)
      expect([name, madeInTurn(db, 'turn-made-1', rel)]).toEqual([name, false])
    }
    // ...its own edit afterwards keeps it
    ev('turn-made-1', 'users/bob/made/edited-own.md', { tool: 'write' })
    ev('turn-made-1', 'users/bob/made/edited-own.md', { tool: 'edit' }, 'update')
    expect(madeInTurn(db, 'turn-made-1', 'users/bob/made/edited-own.md')).toBe(true)
    // deleted earlier, then written new in this turn: new
    ev('turn-made-0', 'users/bob/made/again.md', { tool: 'write' })
    ev('turn-made-0', 'users/bob/made/again.md', null, 'delete')
    ev('turn-made-1', 'users/bob/made/again.md', { tool: 'write' })
    expect(madeInTurn(db, 'turn-made-1', 'users/bob/made/again.md')).toBe(true)
    // a folder above it renamed or made since (a rename logs events at the folder's path only): not what the AI wrote
    ev('turn-made-1', 'users/bob/made/dir/f.xlsx', { tool: 'make_file', own: true })
    expect(madeInTurn(db, 'turn-made-1', 'users/bob/made/dir/f.xlsx')).toBe(true)
    ev('turn-made-1', 'users/bob/made/dir', { tool: 'rename_file' }, 'delete')
    ev('turn-made-1', 'users/bob/made/dir', { tool: 'rename_file', movedFrom: 'users/bob/made/stage' })
    expect(madeInTurn(db, 'turn-made-1', 'users/bob/made/dir/f.xlsx')).toBe(false)
    db.query("DELETE FROM file_events WHERE turn_id IN ('turn-made-0', 'turn-made-1', 'turn-made-9')").run()
  })

  test('the real tools: a file make_file built from another file, or wrote over its own new file from one, is not made in this answer', async () => {
    // (without Always allow: the card is the person's decision; fromAsker is what a "made in this answer" skip uses)
    dropAlways(h.ctx.db, 'bob', 'card:share_files')
    try {
    put('users/bob/payroll-z.csv', 'name,pay\nbob,1\n', 'bob')
    const readIt = read('shared/alice-notes.md')
    const to = (p: string) => share({ paths: [p], people: ['Tess Yoon'] })
    const built = await turn('bob', `send the summary to tess\n${readIt}\n${fake({ tool: 'make_file', args: { source: 'users/bob/payroll-z.csv', format: 'xlsx', output: 'users/bob/out-z.xlsx' } })}\n${to('users/bob/out-z.xlsx')}`)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users/bob/out-z.xlsx'))).toBe(true)
    expect(built.content).not.toContain('"status":"shared"')
    expect(sharedRow('users/bob/out-z.xlsx')).toBeNull()
    // its own new file first, then the same output built from the other file
    const over = await turn('bob', `send the summary to tess\n${readIt}\n${fake({ tool: 'make_file', args: { content: 'a,b\n1,2\n', format: 'xlsx', output: 'users/bob/out-y.xlsx' } })}\n${fake({ tool: 'make_file', args: { source: 'users/bob/payroll-z.csv', format: 'xlsx', output: 'users/bob/out-y.xlsx' } })}\n${to('users/bob/out-y.xlsx')}`)
    expect(over.content).not.toContain('"status":"shared"')
    expect(sharedRow('users/bob/out-y.xlsx')).toBeNull()
    // its own text alone: made in this answer
    const own = await turn('bob', `send the summary to tess\n${readIt}\n${fake({ tool: 'make_file', args: { content: 'a,b\n1,2\n', format: 'xlsx', output: 'users/bob/out-x.xlsx' } })}\n${to('users/bob/out-x.xlsx')}`)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users/bob/out-x.xlsx'))).toBe(true)
    // (one the asker brought, fromAsker; the card shows anyway in a chat with other people's words)
    expect(fromAsker(h.ctx.db, { userMessageId: own.messageId, turnId: own.turnId }, ['users/bob/out-x.xlsx'])).toBe(true)
    expect(fromAsker(h.ctx.db, { userMessageId: built.messageId, turnId: built.turnId }, ['users/bob/out-z.xlsx'])).toBe(false)
    expect(own.cards).toHaveLength(1)
    } finally { keepAlways(h.ctx.db, 'bob', 'share_files', null) }
  })

  test('my own chat: "Always allow" is final, whatever my message names (owner 2026-11-13)', async () => {
    // (a file nobody has yet: "already open" is said before any card, AI sharing integration)
    h.ctx.db.query("DELETE FROM file_shares WHERE path = 'users/bob/ledger-1.txt'").run()
    const none = await turn('bob', `go on\n${unnamed(1)}`)
    expect(none.cards).toHaveLength(0)
    expect(JSON.parse(none.content).status).toBe('shared')
    const about = await turn('bob', `what did tess say?\n${unnamed(2)}`)
    expect(about.cards).toHaveLength(0)
    const post1 = await turn('bob', `go on\n${post({ room: everyone, text: 'hello four' })}`)
    expect(post1.cards).toHaveLength(0)
    expect(JSON.parse(post1.content).status).toBe('sent')
  })

  test('a team file attached to a send: in a chat that read nothing, a file built from another file keeps the card; one I named or the AI wrote itself does not', async () => {
    put('users/bob/payroll-w.csv', 'name,pay\nbob,1\n', 'bob')
    const built = await turn('bob', `make the summary\n${fake({ tool: 'make_file', args: { source: 'users/bob/payroll-w.csv', format: 'xlsx', output: 'users/bob/out-w.xlsx' } })}\n${fake({ tool: 'make_file', args: { content: 'a,b\n1,2\n', format: 'xlsx', output: 'users/bob/out-v.xlsx' } })}`)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users/bob/out-w.xlsx'))).toBe(true)
    // (the chat holds nothing written by others)
    expect((h.ctx.db.query("SELECT others_words AS o FROM chats WHERE id = ?").get(built.chatId) as { o: number }).o).toBe(0)
    const person = turnPerson({ spec: { userMessageId: built.messageId, turnId: built.turnId, locale: 'en', userId: 'bob', chatId: built.chatId }, rt: { db: h.ctx.db } } as unknown as TurnExec)
    expect(person.attachAsks!(['users/bob/out-w.xlsx'])).toBe(true)
    expect(person.attachAsks!(['users/bob/out-v.xlsx'])).toBe(false)
    // a file my message did not name, made before this answer: the card
    expect(person.attachAsks!(['users/bob/ledger-5.txt'])).toBe(true)
    // a chat with other people's words: the card for every attached file, also one the AI wrote itself
    const marked = turnPerson({ spec: { userMessageId: built.messageId, turnId: built.turnId, locale: 'en', userId: 'bob', chatId: built.chatId }, rt: { db: h.ctx.db }, othersWords: true } as unknown as TurnExec)
    expect(marked.attachAsks!(['users/bob/out-v.xlsx'])).toBe(true)
  })

  test('words that only mention telling or sharing are not an ask to send (no explicit-ask skip without Always allow)', async () => {
    dropAlways(h.ctx.db, 'bob', 'card:share_files')
    try {
      for (const [i, w] of ['read the notes and let me know what tess thinks', 'what did tess say in the message?', 'tell me about tess'].entries()) {
        const r = await turn('bob', `${w}\n${share({ paths: [`users/bob/ledger-${6 + i}.txt`], people: ['Tess Yoon'] })}`)
        expect([w, r.cards.length]).toEqual([w, 1])
      }
    } finally { keepAlways(h.ctx.db, 'bob', 'share_files', null) }
  })

  test('namesGroup: a group is named as a group, not by an ordinary word that is also its name', () => {
    const cases: [string, string, boolean][] = [
      ['\uC601\uC5C5 \uBCF4\uACE0\uC11C \uAE40\uB300\uB9AC\uD55C\uD14C \uACF5\uC720\uD574\uC918', '\uC601\uC5C5', false],
      ['\uB450 \uBA54\uBAA8 \uC601\uC5C5\uD300 \uADF8\uB8F9\uC774 \uBCFC \uC218 \uC788\uAC8C \uACF5\uC720\uD574\uC918', '\uC601\uC5C5', true],
      ['\uC601\uC5C5\uD300\uC7A5\uB2D8\uD55C\uD14C \uACF5\uC720\uD574\uC918', '\uC601\uC5C5', false],
      ['Share the sales report with Kim', 'Sales', false],
      ['share it with the Sales team', 'Sales', true],
      ['share it with @sales', 'Sales', true],
      ['share it with the Sales Team', 'Sales Team', true],
    ]
    for (const [said, name, named] of cases) expect([said, namesGroup(said, name)]).toEqual([said, named])
  })

  test('a name inside the ask\'s own words, or a common word, never counts as naming someone; a first name the AI was given does', () => {
    // (Korean as escapes: 보고서.md 김민수한테 공유해줘 / 해줘 / 공유 / 요약 영업방에 보내줘 / 보내 / 보고서 민수씨한테 공유해줘)
    const ko = '\uBCF4\uACE0\uC11C.md \uAE40\uBBFC\uC218\uD55C\uD14C \uACF5\uC720\uD574\uC918'
    expect(namedInFull(ko, ['\uD574\uC918'])).toBe(false)
    expect(namedInFull(ko, ['\uACF5\uC720'])).toBe(false)
    expect(namedInFull(ko, ['\uAE40\uBBFC\uC218'])).toBe(true)
    expect(namedInFull('share report.md with Jun', ['with'])).toBe(false)
    expect(namedInFull('share report.md with Jun', ['Jun'])).toBe(true)
    expect(namesRecipient('\uC694\uC57D \uC601\uC5C5\uBC29\uC5D0 \uBCF4\uB0B4\uC918', '\uBCF4\uB0B4', { names: ['\uBCF4\uB0B4'], person: false })).toBe(false)
    expect(namesRecipient('\uBCF4\uACE0\uC11C \uBBFC\uC218\uC528\uD55C\uD14C \uACF5\uC720\uD574\uC918', '\uBBFC\uC218', { names: ['\uAE40\uBBFC\uC218'], person: true })).toBe(true)
    expect(namesGroup('presales team sales numbers', 'Sales')).toBe(false)
    expect(namesGroup('team salesforce export sales deck', 'Sales')).toBe(false)
  })

  test('a recipient is named only where a recipient stands, by a name that points at them alone', () => {
    // (Korean as escapes: 이 파일 김대리한테 공유해줘 / 파일 / 김대리 / 거래처 목록 CSV 최하나님한테 볼 수 있게 공유해줘 / 있게 / 최하나)
    const ko1 = '\uC774 \uD30C\uC77C \uAE40\uB300\uB9AC\uD55C\uD14C \uACF5\uC720\uD574\uC918'
    expect(namedInFull(ko1, ['\uD30C\uC77C'])).toBe(false)
    expect(namedInFull(ko1, ['\uAE40\uB300\uB9AC'])).toBe(true)
    const ko2 = '\uAC70\uB798\uCC98 \uBAA9\uB85D CSV \uCD5C\uD558\uB098\uB2D8\uD55C\uD14C \uBCFC \uC218 \uC788\uAC8C \uACF5\uC720\uD574\uC918'
    for (const w of ['\uC788\uAC8C', 'csv']) expect([w, namedInFull(ko2, [w])]).toEqual([w, false])
    expect(namedInFull(ko2, ['\uCD5C\uD558\uB098'])).toBe(true)
    expect(namedInFull('post this report to tess', ['report'])).toBe(false)
    for (const said of ['send it to tess', 'send it to tess to review', 'share the report with tess, along with notes']) expect([said, namesRecipient(said, 'Tess Yoon', { names: ['Tess Yoon', 'tess'], person: true })]).toEqual([said, true])
    expect(namedInFull('send this to Hana Kimura', ['Hana Kimura'])).toBe(true)
    // a member who takes a colleague's name (or a part of it) is named by neither display name; usernames still count
    const db = h.ctx.db
    db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('kim1', 'kimd', '\uAE40\uB300\uB9AC', 'member', 'active', NULL), ('kim2', 'mal', '\uAE40\uB300\uB9AC\uB2D8', 'member', 'active', NULL), ('hana9', 'mal2', 'Tess', 'member', 'active', NULL)").run()
    try {
      expect(soleNames(db, 'kim1')).toEqual(['kimd'])
      expect(soleNames(db, 'kim2')).toEqual(['mal'])
      expect(soleNames(db, 'hana9')).toEqual(['mal2'])
      // (Tess's username is now another member's display name: only her display name counts)
      expect(soleNames(db, 'tess')).toEqual(['Tess Yoon'])
    } finally { db.query("DELETE FROM users WHERE id IN ('kim1', 'kim2', 'hana9')").run() }
    expect(soleNames(db, 'tess')).toEqual(['Tess Yoon', 'tess'])
    // a username that is a colleague's first name, a copy with punctuation, a title as a name
    db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('m1', 'yoon', 'Mal One', 'member', 'active', NULL), ('m2', 'mal3', 'Tess Yoon.', 'member', 'active', NULL), ('m3', 'mal4', '\uB300\uD45C', 'member', 'active', NULL), ('m4', 'mal5', 'the team', 'member', 'active', NULL)").run()
    try {
      expect(soleNames(db, 'm1')).toEqual(['Mal One'])
      expect(soleNames(db, 'm2')).toEqual(['mal3'])
      // (a copy of her full name holds her username too: neither names her, the card shows)
      expect(soleNames(db, 'tess')).toEqual([])
      expect(namedInFull('d.txt \uB300\uD45C\uB2D8\uAED8 \uACF5\uC720\uD574\uC918', soleNames(db, 'm3'))).toBe(false)
      expect(namedInFull('share e.txt with the team', soleNames(db, 'm4'))).toBe(false)
    } finally { db.query("DELETE FROM users WHERE id IN ('m1', 'm2', 'm3', 'm4')").run() }
  })

  test('words joined to a file, departments and group names are not a person; a chain of the call\'s own recipients is', () => {
    // (Korean as escapes: 보고서와 견적서 김대리한테 공유해줘 / 보고서 / 김대리 / 이 파일도 김대리한테 공유해줘 / 파일 /
    // 급여표 인사팀한테 공유해줘 / 인사팀 / 김대리와 이과장한테 공유해줘 / 이과장)
    expect(namedInFull('\uBCF4\uACE0\uC11C\uC640 \uACAC\uC801\uC11C \uAE40\uB300\uB9AC\uD55C\uD14C \uACF5\uC720\uD574\uC918', ['\uBCF4\uACE0\uC11C'], { peers: ['\uAE40\uB300\uB9AC'] })).toBe(false)
    expect(namedInFull('\uC774 \uD30C\uC77C\uB3C4 \uAE40\uB300\uB9AC\uD55C\uD14C \uACF5\uC720\uD574\uC918', ['\uD30C\uC77C'], { peers: ['\uAE40\uB300\uB9AC'] })).toBe(false)
    expect(namedInFull('share the notes and slides with Tess Yoon', ['slides'], { peers: ['Tess Yoon'] })).toBe(false)
    expect(namedInFull('send the contract to legal', ['legal'])).toBe(false)
    expect(namedInFull('share it with my boss', ['my boss'])).toBe(false)
    expect(namedInFull('\uAE09\uC5EC\uD45C \uC778\uC0AC\uD300\uD55C\uD14C \uACF5\uC720\uD574\uC918', ['\uC778\uC0AC\uD300'])).toBe(false)
    // 김대리님과 이과장님한테: a Korean chain needs 님 or 씨 on the name (김대리와 이과장한테 shows the card for 김대리)
    const both = '\uAE40\uB300\uB9AC\uB2D8\uACFC \uC774\uACFC\uC7A5\uB2D8\uD55C\uD14C \uACF5\uC720\uD574\uC918'
    expect(namedInFull(both, ['\uAE40\uB300\uB9AC'], { peers: ['\uC774\uACFC\uC7A5'] })).toBe(true)
    expect(namedInFull(both, ['\uAE40\uB300\uB9AC'])).toBe(false)
    // a thing next to a real recipient is not one: "… and the notes with bob", "보고서, 김대리한테", "계약서랑 김대리한테"
    expect(namedInFull('share the slides with tess and the notes with bob', ['the notes'], { peers: ['tess', 'bob'] })).toBe(false)
    expect(namedInFull('share the slides with tess and notes with bob', ['notes'], { peers: ['tess', 'bob'] })).toBe(false)
    expect(namedInFull('\uBCF4\uACE0\uC11C, \uAE40\uB300\uB9AC\uD55C\uD14C \uACF5\uC720\uD574\uC918', ['\uBCF4\uACE0\uC11C'], { peers: ['\uAE40\uB300\uB9AC'] })).toBe(false)
    expect(namedInFull('\uACC4\uC57D\uC11C\uB791 \uAE40\uB300\uB9AC\uD55C\uD14C \uACF5\uC720\uD574\uC918', ['\uACC4\uC57D\uC11C'], { peers: ['\uAE40\uB300\uB9AC'] })).toBe(false)
    expect(namedInFull('send it to tess and bob', ['bob'], { peers: ['tess'] })).toBe(true)
    expect(namedInFull('send it to tess, bob and carl', ['carl'], { peers: ['tess', 'bob'] })).toBe(true)
    expect(namesRecipient('post this to everyone', 'Everyone', { names: ['Everyone'], person: false })).toBe(true)
    // a member who takes a group's name: named by their username only
    const db = h.ctx.db
    db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('f1', 'mal6', 'Finance', 'member', 'active', NULL)").run()
    try { expect(soleNames(db, 'f1')).toEqual(['mal6']) } finally { db.query("DELETE FROM users WHERE id = 'f1'").run() }
  })

  test('a purpose, a manner or an adverb next to a named recipient is not another one; titles are not people', () => {
    // (Korean as escapes: 보고서 김대리한테 바로 볼 수 있게 공유해줘 / 바로 / 이 보고서 책임님께 공유해줘 / 책임 / tess가 볼 수 있게)
    expect(namedInFull('\uBCF4\uACE0\uC11C \uAE40\uB300\uB9AC\uD55C\uD14C \uBC14\uB85C \uBCFC \uC218 \uC788\uAC8C \uACF5\uC720\uD574\uC918', ['\uBC14\uB85C'], { peers: ['\uAE40\uB300\uB9AC'] })).toBe(false)
    for (const [said, w] of [['share budget.txt with tess to approve', 'approve'], ['send the report to tess with comments', 'comments'], ['share it with Tess Yoon to sign', 'sign']] as const) expect([said, namedInFull(said, [w], { peers: ['tess', 'Tess Yoon'] })]).toEqual([said, false])
    expect(namedInFull('\uC774 \uBCF4\uACE0\uC11C \uCC45\uC784\uB2D8\uAED8 \uACF5\uC720\uD574\uC918', ['\uCC45\uC784'])).toBe(false)
    expect(namedInFull('send the bug report to QA', ['qa'])).toBe(false)
    expect(namedInFull('I want to share it with bob', ['bob'])).toBe(true)
    expect(namedInFull('share budget.txt with tess to review', ['tess'])).toBe(true)
    expect(namedInFull('tess\uAC00 \uBCFC \uC218 \uC788\uAC8C \uACF5\uC720\uD574\uC918', ['tess'])).toBe(true)
  })
})
