// "Who can open this" and the one-tap next steps (docs/decisions/20261116-ai-share-who-can-open.md; plan
// docs/AGENTS/plan/20261116-1150-ai-share-who-can-open.md): files/access-routes.ts (every route), chat/who-can-open.ts
// (the tool and what each asker may learn), files/share-fixes.ts (each tap's own checks), chat/share-next-steps.ts
// (what post_to_room and share_with_person hang under their step), FileShares.requestFor and grantedLinkId.
// The fixture team: alice and erin in Marketing, bob in Finance, carol admin, dana owner (tests/lib/fixtures.ts);
// tess (a member in no group) and gus (a guest) are added here.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, FILE_SHARE_EVERYONE, type Room, type StepFix, type StepShared } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { addTestPerson, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { accessRouteFor, fileAccess, folderAccess, routeWords } from '../../server/src/files/access-routes'
import { currentFixes, shareFixesOf } from '../../server/src/files/share-fixes'
import { fileSharesOf } from '../../server/src/files/shares'
import { WHO_CAN_OPEN_DESCRIPTION, whoCanOpenOff } from '../../server/src/chat/who-can-open'
import { WHO_CAN_OPEN_RULE } from '../../server/src/chat/prompt'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { GUEST_TURN_TOOLS } from '../../server/src/chat/guest-tools'
import { OWN_WORDS_TOOLS, ROOMS_SEEN_READ_ONLY_TOOLS, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { roomsOf } from '../../server/src/rooms/service'
import { notificationsOf } from '../../server/src/notifications/service'
import { getChatRuntime } from '../../server/src/chat/runtime'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const who = (args: Record<string, unknown>) => fake({ tool: 'who_can_open', args, sayResult: true })
const post = (args: Record<string, unknown>) => fake({ tool: 'post_to_room', args, sayResult: true })
const share = (args: Record<string, unknown>) => fake({ tool: 'share_with_person', args, sayResult: true })

let h: Harness
const socks: Record<string, TestSocket> = {}
let rooms: { all: string; marketing: string }
let clock = Date.now()
const groups = { marketing: '', finance: '' }
const put = (rel: string, body: string, by?: string) => {
  const abs = path.join(h.ctx.files.fx.root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  // who added a team file (files/shares.ts creatorOf reads the file events)
  if (by) h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action) VALUES (NULL, ?, ?, 'create')").run(by, rel)
}
beforeAll(async () => {
  h = await startHarness({ name: 'c-who-can-open', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  const db = h.ctx.db
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance'] as const) {
    const id = uuidv7()
    groups[g] = id
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('tess', 'tess', 'Tess Yoon', 'member', 'active', NULL)").run()
  addTestPerson('tess', { id: 'tess', name: 'Tess Yoon', role: 'member', locale: 'en' })
  const list = async (u: string) => (await h.api(u).call(API.listRooms)).items as Room[]
  const mine = await list('alice')
  rooms = { all: mine.find((r) => r.kind === 'all')!.id, marketing: mine.find((r) => r.kind === 'team' && r.name === 'Marketing')!.id }
  db.query("INSERT INTO users (id, username, name, role, status, deleted_at, guest) VALUES ('gus', 'gus', 'Gus Guest', 'member', 'active', NULL, 1)").run()
  for (const u of ['alice', 'bob', 'carol']) {
    socks[u] = await h.ws(u, { windowId: `win-wco-${u}` })
    await socks[u]!.next('hello')
  }
  put('users/alice/quote.txt', 'the quote')
  put('users/alice/plan.txt', 'the plan')
  put('users/alice/all-hands.txt', 'for everyone')
  put('groups/marketing/erins-brief.txt', 'erin made this', 'erin')
  put('groups/marketing/alices-brief.txt', 'alice made this', 'alice')
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

type StepOut = { tool?: string; label: string; detail?: string; fixes?: StepFix[]; shared?: StepShared }
async function turn(user: string, content: string, o: { chat?: string; answer?: string | null; project?: string } = {}) {
  const chatId = o.chat ?? (await h.api(user).call(API.createChat, { body: o.project ? { projectId: o.project } : {} })).id
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  if (o.answer !== undefined) {
    const c = await socks[user]!.next('turn.request', (f) => f.data.turnId === r.turnId)
    if (o.answer !== null) await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: o.answer } })
  }
  const done = await socks[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  const steps = JSON.parse((h.ctx.db.query('SELECT steps FROM messages WHERE id = ?').get(r.assistantMessage.id) as { steps: string | null }).steps ?? '[]') as StepOut[]
  return { chatId, turnId: r.turnId as string, answerId: r.assistantMessage.id as string, content: done.data.message.content as string, steps }
}
const fixesOf = (steps: StepOut[], tool: string) => steps.find((s) => s.tool === tool)?.fixes ?? []
const run = (user: string, id: string) => h.api(user).call(API.runShareFix, { params: { id } })
const route = (person: string, p: string) => accessRouteFor(h.ctx, person, p)
const shares = () => fileSharesOf(h.ctx)
const grants = (rel: string) => (h.ctx.db.query('SELECT g.subject_id FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.path = ? ORDER BY g.subject_id').all(rel) as { subject_id: string }[]).map((r) => r.subject_id)

describe('accessRouteFor: every route', () => {
  test('their own folder; the owner and admins; a folder by a group and by everyone; nobody else\'s folder', () => {
    expect(route('alice', 'users/alice/quote.txt')).toEqual({ kind: 'own' })
    expect(route('carol', 'groups/marketing/erins-brief.txt')).toEqual({ kind: 'staff' })
    expect(route('alice', 'groups/marketing/erins-brief.txt')).toEqual({ kind: 'folder', folder: 'groups/marketing', by: 'group', group: 'Marketing' })
    expect(route('bob', 'shared/glossary.md')).toEqual({ kind: 'folder', folder: 'shared', by: 'everyone' })
    expect(route('bob', 'groups/marketing/erins-brief.txt')).toBeNull()
    expect(route('bob', 'users/alice/quote.txt')).toBeNull()
    // an account that is off, and one that does not exist: nothing
    expect(route('nobody', 'shared/glossary.md')).toBeNull()
  })

  test('a file share: by name, through a group, with everyone; a guest never; the folder route wins when both apply', () => {
    shares().change('alice', 'users/alice/quote.txt', [{ subjectType: 'user', subjectId: 'bob' }], [], 'en')
    expect(route('bob', 'users/alice/quote.txt')).toEqual({ kind: 'shared', by: 'person' })
    expect(route('tess', 'users/alice/quote.txt')).toBeNull()
    shares().change('alice', 'users/alice/plan.txt', [{ subjectType: 'group', subjectId: groups.marketing }], [], 'en')
    expect(route('erin', 'users/alice/plan.txt')).toEqual({ kind: 'shared', by: 'group', group: 'Marketing' })
    expect(route('bob', 'users/alice/plan.txt')).toBeNull()
    shares().change('alice', 'users/alice/all-hands.txt', [{ subjectType: 'group', subjectId: FILE_SHARE_EVERYONE }], [], 'en')
    expect(route('tess', 'users/alice/all-hands.txt')).toEqual({ kind: 'shared', by: 'everyone' })
    expect(route('gus', 'users/alice/all-hands.txt')).toBeNull()
    // a team file alice added, shared with erin by name: erin reads it through the folder anyway
    shares().change('alice', 'groups/marketing/alices-brief.txt', [{ subjectType: 'user', subjectId: 'erin' }, { subjectType: 'user', subjectId: 'bob' }], [], 'en')
    expect(route('erin', 'groups/marketing/alices-brief.txt')).toMatchObject({ kind: 'folder', by: 'group' })
    expect(route('bob', 'groups/marketing/alices-brief.txt')).toEqual({ kind: 'shared', by: 'person' })
  })

  test('the words for the AI name the folder as the Files screen does, never a path', () => {
    const w = routeWords(h.ctx, route('alice', 'groups/marketing/erins-brief.txt')!, 'alice')
    expect(w).toContain('"Marketing" group')
    expect(w).not.toContain('groups/marketing')
    expect(routeWords(h.ctx, route('bob', 'users/alice/quote.txt')!, 'alice')).toContain('shared with them by name')
  })
})

describe('what each asker may learn', () => {
  test('a file\'s owner gets the Share dialog\'s rows and the totals; a reader who is not the owner only their own access', () => {
    const mine = fileAccess(h.ctx, 'alice', 'users/alice/quote.txt')!
    expect(mine).toMatchObject({ mine: true, full: true, canShare: true, self: { kind: 'own' }, total: 2, byFolder: null })
    expect(mine.shared).toEqual([{ who: 'Bob Lee', kind: 'person' }])
    expect(mine.place).not.toContain('users/')
    const team = fileAccess(h.ctx, 'alice', 'groups/marketing/erins-brief.txt')!
    expect(team).toMatchObject({ mine: false, full: false, canShare: false, shared: [], total: null, byFolder: null, owner: { id: 'erin', name: 'Erin Yoo' } })
    // the member who added a team file: the count of the people its folder lets in, no names; an admin: the names
    const own = fileAccess(h.ctx, 'alice', 'groups/marketing/alices-brief.txt')!
    expect(own.byFolder).toEqual({ people: 3, names: null })
    const admin = fileAccess(h.ctx, 'carol', 'groups/marketing/alices-brief.txt')!
    expect(admin.byFolder!.names!.sort()).toEqual(['Alice Kim', 'Dana Choi', 'Erin Yoo'])
    // a file they cannot open, a missing one, a guest: the same nothing
    expect(fileAccess(h.ctx, 'bob', 'groups/marketing/erins-brief.txt')).toBeNull()
    expect(fileAccess(h.ctx, 'bob', 'groups/marketing/none.txt')).toBeNull()
    expect(fileAccess(h.ctx, 'gus', 'shared/glossary.md')).toBeNull()
  })

  test('a folder: a member gets the count, the owner and admins the names; an own folder is theirs alone', () => {
    const m = folderAccess(h.ctx, 'alice', 'groups/marketing')!
    expect(m).toMatchObject({ full: false, personal: false, people: 4, names: null })
    const a = folderAccess(h.ctx, 'carol', 'groups/marketing')!
    expect(a.full).toBe(true)
    expect(a.names!.sort()).toEqual(['Alice Kim', 'Dana Choi', 'Erin Yoo'])
    expect(folderAccess(h.ctx, 'alice', 'users/alice')).toMatchObject({ personal: true, people: 1 })
    expect(folderAccess(h.ctx, 'bob', 'groups/marketing')).toBeNull()
  })
})

describe('who_can_open, the tool', () => {
  test('where it is offered: not in a scheduled run, from Slack, in a restricted or template run; never to a guest or a sub-agent; a shared chat lists it', () => {
    const base = { restricted: false, templateRun: null, rt: { db: h.ctx.db }, spec: { clientKind: 'web', chatId: 'none' } }
    expect(whoCanOpenOff(base as never)).toBeNull()
    expect(whoCanOpenOff({ ...base, spec: { clientKind: 'schedule', chatId: 'none' } } as never)?.summary).toContain('schedule')
    expect(whoCanOpenOff({ ...base, spec: { clientKind: 'slack', chatId: 'none' } } as never)?.summary).toContain('slack')
    expect(whoCanOpenOff({ ...base, restricted: true } as never)?.summary).toContain('restricted')
    expect(whoCanOpenOff({ ...base, templateRun: {} } as never)?.summary).toContain('restricted')
    expect(GUEST_TURN_TOOLS.has('who_can_open')).toBe(false)
    expect(PARENT_ONLY_TOOLS.has('who_can_open')).toBe(true)
    expect(SHARED_TOOLS.has('who_can_open')).toBe(true)
    expect(ROOMS_SEEN_READ_ONLY_TOOLS.has('who_can_open')).toBe(true)
    // its answer holds names other people chose (people, groups, folders, files): it is not one of the tools that bring
    // nothing of others into the chat, so a call marks the chat (chats.others_words) like any tool not listed there
    expect(OWN_WORDS_TOOLS.has('who_can_open')).toBe(false)
  })

  test('a call marks the chat as holding other people\'s words; no tool of a turn runs an offer', async () => {
    const r = await turn('alice', who({ path: 'users/alice/quote.txt' }))
    expect((h.ctx.db.query('SELECT others_words AS o FROM chats WHERE id = ?').get(r.chatId) as { o: number }).o).toBe(1)
    // the offers are run by the person's own press (POST /api/share-fixes/:id/run): the AI has no tool for it
    const tools = (await turn('alice', fake({ echo: 'tools' }))).content
    expect(tools).not.toMatch(/fix/i)
  })

  test('my own file: who it is shared with; "Bob can already open it"; "Tess cannot, share it with them"; no path in the answer', async () => {
    const r = await turn('alice', who({ path: 'users/alice/quote.txt', person: 'Bob Lee' }))
    expect(r.content).toContain('"quote.txt"')
    expect(r.content).toContain('Shared with (view only): Bob Lee')
    expect(r.content).toContain('Bob Lee can already open it: the file is shared with them by name')
    expect(r.content).not.toContain('users/alice')
    expect(fixesOf(r.steps, 'who_can_open')).toEqual([])
    const t = await turn('alice', who({ path: 'users/alice/quote.txt', person: 'Tess Yoon' }))
    expect(t.content).toContain('Tess Yoon cannot open it')
    expect(t.content).toContain('share_with_person')
  })

  test('someone else\'s file: my own access, not the list; asked about a person, "Ask <owner>" shows under the step and the request is for that person', async () => {
    const r = await turn('alice', who({ path: 'groups/marketing/erins-brief.txt', person: 'Bob Lee' }))
    expect(r.content).toContain("Erin Yoo's file")
    expect(r.content).toContain('Who else can open it is for its owner (Erin Yoo) to see')
    expect(r.content).toContain('"Ask Erin Yoo"')
    const [fix] = fixesOf(r.steps, 'who_can_open')
    expect(fix).toMatchObject({ kind: 'ask_owner', file: 'erins-brief.txt', owner: 'Erin Yoo', people: ['Bob Lee'], count: 1, state: 'open' })
    // only alice runs it
    await expect(run('bob', fix!.id)).rejects.toMatchObject({ status: 404 })
    expect(await run('alice', fix!.id)).toMatchObject({ state: 'done', doneCount: 1 })
    const q = h.ctx.db.query("SELECT requester_id, asked_by, state FROM file_access_requests WHERE asked_by = 'alice' ORDER BY created_at DESC").get() as { requester_id: string; asked_by: string; state: string }
    expect(q).toEqual({ requester_id: 'bob', asked_by: 'alice', state: 'pending' })
    // erin's Activity row: alice asked, for bob; Share gives bob view access (and nothing more)
    const row = (await h.api('erin').call(API.listNotifications, { query: {} })).items.find((n) => n.code === 'file.access_requested')!
    expect(row.fileShare).toMatchObject({ by: 'Alice Kim', for: 'Bob Lee', name: 'erins-brief.txt', state: 'pending', canAnswer: true })
    await h.api('erin').call(API.answerFileRequest, { params: { id: row.fileShare!.requestId! }, body: { answer: 'approve' } })
    expect(route('bob', 'groups/marketing/erins-brief.txt')).toEqual({ kind: 'shared', by: 'person' })
    expect((h.ctx.db.query("SELECT role FROM file_share_grants WHERE subject_id = 'bob' AND share_id = (SELECT id FROM file_shares WHERE path = 'groups/marketing/erins-brief.txt')").get() as { role: string }).role).toBe('view')
    // run again: nothing happens twice
    expect(await run('alice', fix!.id)).toMatchObject({ state: 'done' })
  })

  test('a file I cannot open reads like one that is not there', async () => {
    const a = await turn('bob', who({ path: 'groups/marketing/campaign-brief.md' }))
    const b = await turn('bob', who({ path: 'groups/marketing/not-there.md' }))
    expect(a.content).toBe(b.content)
    expect(a.content).toContain('Not found, or the user cannot open it')
  })

  test('a team folder as a member: the count, and "Ask an admin" that sends my own message to the owner and admins; an admin gets the names and no button', async () => {
    const r = await turn('alice', who({ path: 'groups/marketing', person: 'Bob Lee' }))
    expect(r.content).toContain('4 people on the team can open it')
    expect(r.content).not.toContain('Erin Yoo')
    expect(r.content).toContain('"Ask an admin"')
    const [fix] = fixesOf(r.steps, 'who_can_open')
    expect(fix).toMatchObject({ kind: 'ask_admin', file: 'marketing', people: ['Bob Lee'], owner: 'Dana Choi and Carol Park' })
    expect(await run('alice', fix!.id)).toMatchObject({ state: 'done', doneCount: 2 })
    // dana got alice's own 1:1 message naming the folder (a link to it) and bob; bob's access did not change
    const dm = h.ctx.db.query("SELECT m.body FROM room_messages m JOIN rooms r ON r.id = m.room_id WHERE r.kind = 'dm' AND r.dm_key = 'alice|dana' AND m.author_id = 'alice' ORDER BY m.seq DESC").get() as { body: string }
    expect(dm.body).toContain('Bob Lee')
    expect(dm.body).toContain('[marketing](/files/view?path=groups%2Fmarketing)')
    expect(route('bob', 'groups/marketing')).toBeNull()
    const admin = await turn('carol', who({ path: 'groups/marketing', person: 'Bob Lee' }))
    expect(admin.content).toContain('Erin Yoo')
    expect(admin.content).toContain('Bob Lee cannot open it')
    expect(fixesOf(admin.steps, 'who_can_open')).toEqual([])
    // a plain "who can open it?" (nobody asked about) is a question: no "Ask an admin", whose message would ask to share
    // the folder with more people (the coordinator's fix 6, 2026-11-16)
    const plainQ = await turn('alice', who({ path: 'groups/marketing' }))
    expect(fixesOf(plainQ.steps, 'who_can_open')).toEqual([])
    expect(plainQ.content).not.toContain('"Ask an admin"')
    expect(plainQ.content).toContain('Only the team\'s owner and admins can change who can open a team folder.')
  })

  test('this chat: private says only me; in a team project it offers "Share with project"; once shared the offer reads done', async () => {
    const plain = await turn('alice', who({ person: 'Bob Lee' }))
    expect(plain.content).toContain('Only the user can see this chat')
    expect(plain.content).toContain('Bob Lee cannot see this chat')
    expect(fixesOf(plain.steps, 'who_can_open')).toEqual([])
    // a team project of alice's with bob in it; the chat is moved in and stays private
    const project = await h.api('alice').call(API.createProject, { body: { name: 'Launch', participants: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }] } as never })
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const first = await turn('alice', 'hello', { chat })
    expect(first.chatId).toBe(chat)
    await h.api('alice').call(API.updateChat, { params: { id: chat }, body: { projectId: project.id } as never })
    expect((h.ctx.db.query('SELECT shared_at FROM chats WHERE id = ?').get(chat) as { shared_at: string | null }).shared_at).toBeNull()
    const r = await turn('alice', who({ person: 'Bob Lee' }), { chat })
    expect(r.content).toContain('It is in the project "Launch" but was not shared with it')
    expect(r.content).toContain('although they are in the project')
    const [fix] = fixesOf(r.steps, 'who_can_open')
    expect(fix).toMatchObject({ kind: 'share_project', file: 'Launch', chatId: chat, state: 'open' })
    // the button runs the app's own share flow; here the server only says it is still open
    expect(await run('alice', fix!.id)).toMatchObject({ state: 'open' })
    let res = await h.api('alice').call(API.shareChat, { params: { id: chat }, body: {} })
    if (res.status === 'confirm') res = await h.api('alice').call(API.shareChat, { params: { id: chat }, body: { confirmKey: res.confirmKey } })
    expect(res.status).toBe('shared')
    expect(currentFixes(h.ctx.db, [fix!])[0]!.state).toBe('done')
    // the shared chat: who sees it, for anyone in it; other viewers never get the runner's offers
    const shared = await turn('alice', who({ person: 'Bob Lee' }), { chat })
    expect(shared.content).toContain('shared with the project "Launch"')
    expect(shared.content).toContain('Bob Lee can see this chat: they are in the project')
    const rt = getChatRuntime(h.ctx)
    const stored = JSON.parse((h.ctx.db.query('SELECT steps FROM messages WHERE id = ?').get(r.answerId) as { steps: string }).steps)
    const forBob = rt.store.viewSteps({ chat_id: chat, turn_id: r.turnId }, stored, { runner: false, canList: () => true, canRead: () => true, failed: '', locale: 'en' } as never)
    expect(forBob.some((s) => s.fixes)).toBe(false)
    const forAlice = rt.store.viewSteps({ chat_id: chat, turn_id: r.turnId }, stored, { runner: true, canList: () => true, canRead: () => true, failed: '', locale: 'en' } as never)
    expect(forAlice.find((s) => s.fixes)!.fixes![0]!.state).toBe('done')
    // in the shared chat a file works only when the asker named or attached it themselves
    const other = await turn('alice', who({ path: 'users/alice/plan.txt' }), { chat })
    expect(other.content).toContain('only for the chat itself and for a file the user named or attached')
    const named = await turn('alice', `who can open plan.txt?\n${who({ path: 'users/alice/plan.txt' })}`, { chat })
    expect(named.content).toContain('"plan.txt"')
  })
})

describe('post to a room: who cannot open the file, one card for the post and the view', () => {
  const link = (rel: string) => `[${rel.split('/').pop()}](/files/view?path=${encodeURIComponent(rel)})`

  const cardsOf = (turnId: string) => socks.alice!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === turnId) as unknown as { data: { request: { question: string; options: { value: string }[] } } }[]
  const shareAudits = () => (h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'file.share' AND actor_id = 'alice'").get() as { n: number }).n
  const postedIn = (room: string, turnId: string) => (h.ctx.db.query("SELECT COUNT(*) n FROM room_messages WHERE room_id = ? AND author_id = 'alice' AND client_id LIKE ? AND deleted_at IS NULL").get(room, `ai-${turnId}-%`) as { n: number }).n

  // one card for the post and the view (docs/decisions/20261117-post-to-room-one-card.md; FL-08 step 1 showed the room
  // card and then a separate "Let them view" for the same step)
  test('my own file: ONE card says who will be able to open it; its yes posts AND shares with exactly them, via ai; a guest never', async () => {
    put('users/alice/offer.txt', 'the offer')
    // gus the guest is in the room too (he cannot open the file and is never given it)
    h.ctx.db.query("INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) SELECT ?, 'gus', joined_at FROM room_members WHERE room_id = ? LIMIT 1").run(rooms.marketing, rooms.marketing)
    try {
      const before = shareAudits()
      const r = await turn('alice', post({ room: rooms.marketing, text: `Here it is: ${link('users/alice/offer.txt')}` }), { answer: 'send' })
      // exactly one card in the whole turn, and it names the view: the count and the file, from the server's records
      const cards = cardsOf(r.turnId)
      expect(cards).toHaveLength(1)
      const q = cards[0]!.data.request.question
      expect(q).toContain('1 person there will be able to open offer.txt.')
      // the same card does not also say they can't open it, and names nobody
      expect(q).not.toContain("2 people can't open")
      expect(q).toContain("1 person can't open 1 linked file.")
      expect(q).not.toContain('Erin')
      expect(cards[0]!.data.request.options.map((o) => o.value)).toContain('send')
      // both effects: the post went, and erin (only erin) can open the file now
      const out = JSON.parse(r.content)
      expect(out.status).toBe('sent')
      expect(postedIn(rooms.marketing, r.turnId)).toBe(1)
      expect(grants('users/alice/offer.txt')).toEqual(['erin'])
      expect(route('erin', 'users/alice/offer.txt')).not.toBeNull()
      expect(route('gus', 'users/alice/offer.txt')).toBeNull()
      expect(shareAudits()).toBe(before + 1)
      const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'file.share' AND actor_id = 'alice' ORDER BY id DESC").get() as { detail: string }
      expect(JSON.parse(a.detail)).toMatchObject({ via: 'ai', people: 1 })
      // the AI is told it is done (no names), and there is no button left to press: the step shows it done
      expect(out.can_open_now).toContain('1 person there can now open the file')
      expect(out.can_open_now).not.toContain('Erin')
      expect(out.cannot_open).toBeUndefined()
      const fixes = fixesOf(r.steps, 'post_to_room')
      expect(fixes).toHaveLength(1)
      expect(fixes[0]).toMatchObject({ kind: 'let_view', file: 'offer.txt', state: 'done', doneCount: 1, guests: 1 })
      expect(fixes.some((f) => f.state === 'open')).toBe(false)
      // erin opens the path link of the room message through her share
      expect((await h.api('erin').call(API.grantedFileLink, { query: { path: 'users/alice/offer.txt' } })).id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    } finally { h.ctx.db.query("DELETE FROM room_members WHERE room_id = ? AND user_id = 'gus'").run(rooms.marketing) }
  })

  test('no on the one card: nothing posted and nothing shared', async () => {
    put('users/alice/offer-no.txt', 'not this one')
    const before = shareAudits()
    const r = await turn('alice', post({ room: rooms.marketing, text: `Not this: ${link('users/alice/offer-no.txt')}` }), { answer: 'no' })
    expect(cardsOf(r.turnId)).toHaveLength(1)
    expect(postedIn(rooms.marketing, r.turnId)).toBe(0)
    expect(grants('users/alice/offer-no.txt')).toEqual([])
    expect(shareAudits()).toBe(before)
    expect(fixesOf(r.steps, 'post_to_room')).toEqual([])
  })

  test('Always allow stays final: no card, the post goes, nothing is shared without a tap (the button stays, as before)', async () => {
    put('users/alice/offer-always.txt', 'always')
    const { keepAlways } = await import('../../server/src/chat/always-allow')
    h.ctx.db.query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run()
    keepAlways(h.ctx.db, 'alice', 'post_files', null)
    keepAlways(h.ctx.db, 'alice', 'post_to_room', null)
    try {
      // (own words: no "send with the files" choice, so the file stays a link)
      const r = await turn('alice', post({ room: rooms.marketing, own_words: true, text: `Always: ${link('users/alice/offer-always.txt')}` }))
      expect(cardsOf(r.turnId)).toHaveLength(0)
      expect(postedIn(rooms.marketing, r.turnId)).toBe(1)
      expect(grants('users/alice/offer-always.txt')).toEqual([])
      const [fix] = fixesOf(r.steps, 'post_to_room')
      expect(fix).toMatchObject({ kind: 'let_view', people: ['Erin Yoo'], state: 'open' })
    } finally { h.ctx.db.query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run() }
  })

  test('the grant fails after the post went (the team turned off members\' sharing while the card waited): the post stays, nothing is shared, the AI is told', async () => {
    put('users/alice/offer-3.txt', 'third')
    const { updateTeamSettings } = await import('../../server/src/admin/settings')
    const chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
    const s = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content: post({ room: rooms.marketing, text: `Third: ${link('users/alice/offer-3.txt')}` }), clientMessageId: cm(), attachmentIds: [] } })
    const c = await socks.alice!.next('turn.request', (f) => f.data.turnId === s.turnId)
    expect((c.data.request as { question: string }).question).toContain('1 person there will be able to open offer-3.txt.')
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    try {
      await h.api('alice').call(API.answerTurn, { params: { id: s.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: 'send' } })
      const done = await socks.alice!.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 30_000)
      const out = JSON.parse(done.data.message.content as string)
      expect(out.status).toBe('sent')
      expect(postedIn(rooms.marketing, s.turnId)).toBe(1)
      expect(grants('users/alice/offer-3.txt')).toEqual([])
      expect(out.cannot_open).toContain('The post went, but giving those people access to the file did not work for everyone')
      expect(out.can_open_now).toBeUndefined()
      // no offer of that card is left behind
      expect((h.ctx.db.query("SELECT COUNT(*) n FROM share_fix_offers WHERE chat_id = ? AND kind = 'let_view' AND state = 'open'").get(chatId) as { n: number }).n).toBe(0)
    } finally { updateTeamSettings(h.ctx.db, { memberFileShares: true }) }
  })

  test('someone who joins the room while the card waits: nothing is posted or shared (the card named the people)', async () => {
    put('users/alice/offer-join.txt', 'join')
    const chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
    const s = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content: post({ room: rooms.marketing, text: `Join: ${link('users/alice/offer-join.txt')}` }), clientMessageId: cm(), attachmentIds: [] } })
    const c = await socks.alice!.next('turn.request', (f) => f.data.turnId === s.turnId)
    h.ctx.db.query("INSERT INTO room_members (room_id, user_id, joined_at) SELECT ?, 'tess', joined_at FROM room_members WHERE room_id = ? LIMIT 1").run(rooms.marketing, rooms.marketing)
    try {
      await h.api('alice').call(API.answerTurn, { params: { id: s.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: 'send' } })
      const done = await socks.alice!.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 30_000)
      expect(done.data.message.content as string).toContain('changed while the card waited')
      expect(postedIn(rooms.marketing, s.turnId)).toBe(0)
      expect(grants('users/alice/offer-join.txt')).toEqual([])
    } finally { h.ctx.db.query("DELETE FROM room_members WHERE room_id = ? AND user_id = 'tess'").run(rooms.marketing) }
  })

  test('the "Let them view" button itself (Always allow, a new 1:1 chat): only its person runs it, once; someone who joined since is not granted', async () => {
    put('users/alice/offer-tap.txt', 'tap')
    const chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
    const [fix] = shareFixesOf(h.ctx).forFiles('alice', chatId, [{ path: 'users/alice/offer-tap.txt', people: ['erin'] }], { roomId: rooms.marketing, place: '#Marketing' })
    expect(fix).toMatchObject({ kind: 'let_view', file: 'offer-tap.txt', people: ['Erin Yoo'], count: 1, state: 'open' })
    // tess joins the room after the offer
    h.ctx.db.query("INSERT INTO room_members (room_id, user_id, joined_at) SELECT ?, 'tess', joined_at FROM room_members WHERE room_id = ? LIMIT 1").run(rooms.marketing, rooms.marketing)
    try {
      await expect(run('erin', fix!.id)).rejects.toMatchObject({ status: 404 })
      expect(await run('alice', fix!.id)).toEqual({ state: 'done', doneCount: 1, left: 1 })
      expect(grants('users/alice/offer-tap.txt')).toEqual(['erin'])
      expect(route('tess', 'users/alice/offer-tap.txt')).toBeNull()
      expect(currentFixes(h.ctx.db, [fix!])[0]).toMatchObject({ state: 'done', doneCount: 1 })
      expect(await run('alice', fix!.id)).toMatchObject({ state: 'done', doneCount: 1 })
      expect(grants('users/alice/offer-tap.txt')).toEqual(['erin'])
      expect((await h.api('tess').call(API.grantedFileLink, { query: { path: 'users/alice/offer-tap.txt' } })).id).toBeNull()
    } finally { h.ctx.db.query("DELETE FROM room_members WHERE room_id = ? AND user_id = 'tess'").run(rooms.marketing) }
  })

  test('the button: someone who left the room before the tap is not granted; with nobody left the offer is gone', async () => {
    put('users/alice/offer-2.txt', 'the second offer')
    const chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
    const [fix] = shareFixesOf(h.ctx).forFiles('alice', chatId, [{ path: 'users/alice/offer-2.txt', people: ['erin'] }], { roomId: rooms.marketing })
    const kept = h.ctx.db.query("SELECT * FROM room_members WHERE room_id = ? AND user_id = 'erin'").get(rooms.marketing) as Record<string, unknown>
    h.ctx.db.query("DELETE FROM room_members WHERE room_id = ? AND user_id = 'erin'").run(rooms.marketing)
    try {
      expect(await run('alice', fix!.id)).toMatchObject({ state: 'gone' })
      expect(grants('users/alice/offer-2.txt')).toEqual([])
    } finally {
      const cols = Object.keys(kept)
      h.ctx.db.query(`INSERT INTO room_members (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(Object.values(kept) as never[]))
    }
  })

  test('the button: a let_view offer whose owner lost the right is refused at the tap and stays open', async () => {
    put('users/alice/offer-4.txt', 'fourth')
    const chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
    const [fix] = shareFixesOf(h.ctx).forFiles('alice', chatId, [{ path: 'users/alice/offer-4.txt', people: ['erin'] }], { roomId: rooms.marketing })
    expect(fix!.kind).toBe('let_view')
    const { updateTeamSettings } = await import('../../server/src/admin/settings')
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    try {
      await expect(run('alice', fix!.id)).rejects.toMatchObject({ status: 403 })
      expect(currentFixes(h.ctx.db, [fix!])[0]!.state).toBe('open')
      expect(grants('users/alice/offer-4.txt')).toEqual([])
    } finally { updateTeamSettings(h.ctx.db, { memberFileShares: true }) }
    expect(await run('alice', fix!.id)).toMatchObject({ state: 'done', doneCount: 1 })
  })

  test('not my file: the people are counted, not named; Ask <owner> sends the request for them; I cannot use Let them view on it', async () => {
    put('groups/marketing/erins-rates.txt', 'rates', 'erin')
    const r = await turn('alice', post({ room: rooms.all, text: `Rates: ${link('groups/marketing/erins-rates.txt')}` }), { answer: 'send' })
    const [fix] = fixesOf(r.steps, 'post_to_room')
    // bob and tess cannot open it (carol and dana are admins, erin is in Marketing)
    expect(fix).toMatchObject({ kind: 'ask_owner', file: 'erins-rates.txt', owner: 'Erin Yoo', count: 2, state: 'open' })
    expect(fix!.people).toBeUndefined()
    // the button by its own label (the coordinator's fix 3)
    expect(JSON.parse(r.content).cannot_open).toContain('labelled "Ask Erin Yoo"')
    expect(await run('alice', fix!.id)).toMatchObject({ state: 'done', doneCount: 2 })
    expect(grants('groups/marketing/erins-rates.txt')).toEqual([])
    const asked = (h.ctx.db.query("SELECT requester_id FROM file_access_requests WHERE asked_by = 'alice' AND share_id = (SELECT id FROM file_shares WHERE path = 'groups/marketing/erins-rates.txt') ORDER BY requester_id").all() as { requester_id: string }[]).map((x) => x.requester_id)
    expect(asked).toEqual(['bob', 'tess'])
    // a let_view offer cannot be made for a file that is not mine, and the share itself refuses a non-owner
    expect(shareFixesOf(h.ctx).forFiles('alice', r.chatId, [{ path: 'groups/marketing/erins-rates.txt', people: ['bob'] }]).every((f) => f.kind !== 'let_view')).toBe(true)
    expect(() => shares().change('alice', 'groups/marketing/erins-rates.txt', [{ subjectType: 'user', subjectId: 'bob' }], [], 'en', 'ai')).toThrow()
    // erin declines one: alice (who asked) is told, not tess
    const rows = (await h.api('erin').call(API.listNotifications, { query: {} })).items.filter((n) => n.code === 'file.access_requested' && n.fileShare?.name === 'erins-rates.txt')
    const forTess = rows.find((n) => n.fileShare?.for === 'Tess Yoon')!
    await h.api('erin').call(API.answerFileRequest, { params: { id: forTess.fileShare!.requestId! }, body: { answer: 'decline' } })
    const told = (h.ctx.db.query("SELECT user_id FROM file_share_notices WHERE event_type = 'file.access_answered' AND source_id = ?").all(forTess.fileShare!.requestId!) as { user_id: string }[]).map((x) => x.user_id)
    expect(told).toEqual(['alice'])
    // a request someone asked for bob does not use up bob's own asks
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM file_access_requests WHERE requester_id = 'bob' AND asked_by IS NULL").get() as { n: number }).n).toBe(0)
  })

  test('everyone there can open it: no line, no button', async () => {
    const r = await turn('alice', post({ room: rooms.marketing, text: `Brief: ${link('groups/marketing/alices-brief.txt')}` }), { answer: 'send' })
    expect(JSON.parse(r.content).cannot_open).toBeUndefined()
    expect(fixesOf(r.steps, 'post_to_room')).toEqual([])
  })
})

describe('share_with_person: already open, and someone else\'s file', () => {
  test('"Bob can already open it": nothing is shared again and no card is raised', async () => {
    const before = grants('users/alice/quote.txt')
    const r = await turn('alice', share({ paths: ['users/alice/quote.txt'], people: ['Bob Lee'] }))
    const out = JSON.parse(r.content)
    expect(out.status).toBe('already_open')
    expect(out.note).toContain('Bob Lee can already open it: the file is shared with them by name')
    expect(grants('users/alice/quote.txt')).toEqual(before)
    // the card's record says it (docs/decisions/20261116-ai-sharing-integration.md): nobody added, who already had it
    const rec = r.steps.find((s) => s.tool === 'share_with_person')!.shared!
    expect(rec).toMatchObject({ op: 'share', outcome: 'done', who: [], already: [{ subjectType: 'user', subjectId: 'bob', name: 'Bob Lee' }], files: [{ name: 'quote.txt' }] })
    expect(rec.files[0]!.linkId).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  test('someone else\'s file: the refusal carries "Ask <owner> to share it" for the people named', async () => {
    put('groups/marketing/erins-deck.txt', 'deck', 'erin')
    const r = await turn('alice', share({ paths: ['groups/marketing/erins-deck.txt'], people: ['Bob Lee'] }))
    // (integrated with the card, docs/decisions/20261116-ai-sharing-integration.md: the offer is the refusal card's button,
    // and the words point at it)
    expect(r.content).toContain('so only Erin Yoo can add people to it')
    expect(r.content).toContain('a card under your answer with an "Ask Erin Yoo" button')
    const [fix] = fixesOf(r.steps, 'share_with_person')
    expect(fix).toMatchObject({ kind: 'ask_owner', file: 'erins-deck.txt', owner: 'Erin Yoo', people: ['Bob Lee'] })
    const card = r.steps.find((s) => s.tool === 'share_with_person')!.shared!
    expect(card).toMatchObject({ outcome: 'refused', refusal: { reason: 'not_owner' }, next: { kind: 'ask_owner', fixId: fix!.id, name: 'Erin Yoo' } })
    expect(await run('alice', fix!.id)).toMatchObject({ state: 'done', doneCount: 1 })
    expect(notificationsOf(h.ctx)).toBeTruthy()
  })

  test('a team folder asked by a member: "Ask an admin"', async () => {
    const r = await turn('alice', share({ paths: ['groups/marketing/campaigns'], people: ['Bob Lee'] }))
    expect(r.content).toContain('"Ask an admin"')
    expect(fixesOf(r.steps, 'share_with_person')[0]).toMatchObject({ kind: 'ask_admin', file: 'campaigns', people: ['Bob Lee'] })
  })
})

describe('asking for other people keeps the limits', () => {
  test('someone who may share the file cannot ask; a guest and someone who can open it are left out; five asks a day to one owner', () => {
    put('groups/marketing/erins-limit.txt', 'x', 'erin')
    const id = shares().linkFor('alice', 'groups/marketing/erins-limit.txt').id
    // erin owns it: she shares, she does not ask
    expect(() => shares().requestFor('erin', id, ['bob'], 'en')).toThrow()
    // bob cannot open it: he cannot ask for others (the same 404 as a link he does not know)
    expect(() => shares().requestFor('bob', id, ['tess'], 'en')).toThrow()
    const r = shares().requestFor('alice', id, ['gus', 'erin', 'carol', 'tess', 'alice'], 'en')
    expect(r.asked).toEqual(['tess'])
    // the same people again: nothing new
    expect(shares().requestFor('alice', id, ['tess'], 'en')).toMatchObject({ asked: [], already: ['tess'] })
  })
})

// The integration of the packages (docs/decisions/20261116-ai-sharing-integration.md): a file the person has only through
// a share (someone else's, shared with them) refuses like someone else's file, with "Ask <owner>" as the card's button;
// a /f/ link to such a file in a post gets "Ask <owner>" for the people there who cannot open it.
describe('a file shared with me (by a grant only): share and post', () => {
  test('share it on: the refusal card names its owner and its one button is the server\'s Ask <owner> offer', async () => {
    put('users/erin/erin-deck.txt', 'erin\'s deck')
    const id = shares().change('erin', 'users/erin/erin-deck.txt', [{ subjectType: 'user', subjectId: 'alice' }], [], 'en').share.id
    for (const p of ['users/erin/erin-deck.txt', `/f/${id}`]) {
      const r = await turn('alice', share({ paths: [p], people: ['Bob Lee'] }))
      expect(r.content).toContain('so only Erin Yoo can add people to it')
      expect(r.content).toContain('a card under your answer with an "Ask Erin Yoo" button')
      const [fix] = fixesOf(r.steps, 'share_with_person')
      expect(fix).toMatchObject({ kind: 'ask_owner', owner: 'Erin Yoo', people: ['Bob Lee'] })
      const card = r.steps.find((s) => s.tool === 'share_with_person')!.shared!
      expect(card).toMatchObject({ outcome: 'refused', refusal: { reason: 'not_owner', owner: 'Erin Yoo' }, next: { kind: 'ask_owner', fixId: fix!.id } })
      // the owner's folder is not said
      expect(card.failed![0]).toMatchObject({ linkId: id, name: 'erin-deck.txt', place: '' })
      expect(grants('users/erin/erin-deck.txt')).toEqual(['alice'])
    }
  })

  test('post its /f/ link to a room: the people there who cannot open it get "Ask <owner>"', async () => {
    const id = shares().liveRow('users/erin/erin-deck.txt')!.id
    const r = await turn('alice', post({ room: rooms.all, text: `Deck: [erin-deck.txt](/f/${id})` }), { answer: 'send' })
    const out = JSON.parse(r.content)
    expect(out.status).toBe('sent')
    const fix = fixesOf(r.steps, 'post_to_room').find((f) => f.kind === 'ask_owner')
    expect(fix).toMatchObject({ kind: 'ask_owner', file: 'erin-deck.txt', owner: 'Erin Yoo', state: 'open' })
    expect(fix!.count).toBeGreaterThan(0)
    // the AI is given the button's own label (fix 3)
    expect(out.cannot_open).toContain('labelled "Ask Erin Yoo"')
    expect(out.cannot_open).not.toContain('Ask the owner')
    // the card said, in plain words, that people there cannot open the shared file (fix 5)
    const card = socks.alice!.frames.find((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === r.turnId) as { data: { request: { question: string } } } | undefined
    expect(card!.data.request.question).toMatch(/can't open erin-deck\.txt: it was shared with you, not with them\./)
    // its text on the card names the file, not its /f/ address (the message keeps the link)
    const details = (card!.data.request as unknown as { details: { text: string }[] }).details.map((d) => d.text).join('\n')
    expect(details).toContain('Deck: erin-deck.txt')
    expect(details).not.toContain('/f/')
    // the posted card's record says what went (fix 7)
    const step = r.steps.find((s) => s.tool === 'post_to_room') as { posted?: { preview?: string } }
    expect(step.posted!.preview).toContain('Deck: erin-deck.txt')
  })
})

// The coordinator's leftovers (2026-11-16): one "asked first" line, the sources count equal to the file line's
describe('the post card after reading a file shared with me', () => {
  test('one "asked first" line; the sources line counts the same people as the file line (the owner left out)', async () => {
    const id = shares().liveRow('users/erin/erin-deck.txt')!.id
    const r = await turn('alice', `${fake({ tool: 'read', args: { file_path: `/f/${id}` } })}\n${post({ room: rooms.all, text: `Deck: [erin-deck.txt](/f/${id})` })}`, { answer: 'no' })
    const card = socks.alice!.frames.find((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === r.turnId) as { data: { request: { question: string } } }
    const q = card.data.request.question
    const fileLine = /(\d+) (?:person|people) there can't open erin-deck\.txt/.exec(q)
    expect(fileLine).not.toBeNull()
    const src = /(\d+) (?:person|people) there can't see some of the sources of this \(a file shared with you\)/.exec(q)
    if (src) expect(src[1]).toBe(fileLine![1])
    // never two "asked first" sentences on one card
    expect((q.match(/asked first/g) ?? []).length).toBeLessThanOrEqual(1)
  })
})

test('who can open something is said only from who_can_open, never guessed (QA 2026-11-17: "only you can open it" about a file already shared)', () => {
  expect(WHO_CAN_OPEN_RULE).toContain('Never say who can or cannot open something')
  expect(WHO_CAN_OPEN_RULE).toContain('"only you can open it"')
  expect(WHO_CAN_OPEN_RULE).toContain("only from who_can_open's result in this answer")
  expect(WHO_CAN_OPEN_DESCRIPTION).toContain('who can or cannot open something')
})
