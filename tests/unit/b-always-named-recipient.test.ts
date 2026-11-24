// Security review of batch 5 (#425 x #426): under the person's own "Always allow" the member and folder tools still
// never open anything to someone the person did not name where someone else could have asked for it, and a quiet
// schedule (schedules.quiet, explicit-send.ts quietRun) never changes who can open anything, whatever the Always.
// - change_folder_access and change_project_members in a quiet scheduled run with Always on: refused up front;
// - a shared chat with a guest among its people: the asker's own message must name the person (strict, as share_folder
//   and share_with_person); named: no card (Rule A);
// - a scheduled run that took in other people's words: the same;
// - a title found only by a guess ("manager" = the one admin, no profile title) never skips share_with_person's card.
// Fixture (tests/lib/fixtures.ts): alice + erin = marketing, bob = finance, carol = admin, dana = owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7 } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { setFolderAccess } from '../lib/folder-access'
import { keepAlways, type AlwaysPlace } from '../../server/src/chat/always-allow'
import { folderAccessOff, folderAccessToolFor } from '../../server/src/chat/folder-access-tool'
import { projectMembersRefusal, projectMembersTool, type MembersExec } from '../../server/src/chat/project-members'
import { ChatStore } from '../../server/src/chat/store'
import { TurnFiles } from '../../server/src/files/service'
import { saysTitle, titleNames } from '../../server/src/chat/person-aliases'
import { resolvedByTitle } from '../../server/src/rooms/reader'

setDefaultTimeout(60_000)
let h: Harness
let store: ChatStore
const db = () => h.ctx.db
beforeAll(async () => {
  h = await startHarness({ name: 'b-always-named-recipient', askUserTimeoutMs: 2000, stallTimeoutMs: 30_000 })
  store = new ChatStore(h.ctx.db)
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'Ledger'), { recursive: true })
  setFolderAccess(db(), 'Ledger', [], null, { limited: true })
  keepAlways(db(), 'carol', 'folder_access', null)
  keepAlways(db(), 'alice', 'project_members', null)
})
afterAll(async () => { await h?.close() })

/** a scheduled task's run: its turn row, the schedule quiet or not */
function scheduleTurn(user: string, chatId: string, quiet: boolean): string {
  const sid = uuidv7(), tid = uuidv7()
  db().query("INSERT INTO schedules (id, user_id, title, prompt, repeat, time, quiet) VALUES (?, ?, 'T', 'p', 'daily', '09:00', ?)").run(sid, user, quiet ? 1 : 0)
  db().query("INSERT INTO turns (id, chat_id, user_id, engine, status, schedule_id) VALUES (?, ?, ?, 'claude-code', 'running', ?)").run(tid, chatId, user, sid)
  return tid
}
type O = { user: string; chatId: string; said: string; clientKind?: string; guest?: boolean; othersWords?: boolean; quiet?: boolean }
/** a narrow TurnExec stand-in: the asker's own message `said`, their Always as stored */
function exec(o: O) {
  const clientKind = o.clientKind ?? 'web'
  const turnId = clientKind === 'schedule' ? scheduleTurn(o.user, o.chatId, !!o.quiet) : uuidv7()
  const userMessageId = store.insertMessage({ chatId: o.chatId, parentId: null, role: 'user', authorId: o.user, content: o.said, status: 'done' })
  const place: AlwaysPlace = { db: db(), userId: o.user, chatId: o.chatId, turnId, locale: 'en', clientKind }
  return {
    spec: { userId: o.user, chatId: o.chatId, turnId, assistantId: uuidv7(), userMessageId, locale: 'en', clientKind },
    room: null, shared: o.guest ? { kind: 'project', project: {} } : null, guestAmong: () => !!o.guest, sharedAudience: () => [],
    restricted: false, templateRun: false, roomsSeen: false, otherAuthors: false, fromSlack: false, othersWords: !!o.othersWords, tainted: false,
    files: new TurnFiles(), rt: h.rt(), livePrincipal: () => h.ctx.files.principal(o.user), openRequests: () => [], patchToolStep: () => {},
    askPerson: async () => { throw new Error('no card may be asked') }, alwaysPlace: () => place,
  } as never
}
const text = (r: { content: readonly unknown[] }) => (r.content[0] as { text?: string } | undefined)?.text ?? ''
const ledger = () => (db().query("SELECT r.subject_id AS s FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = 'Ledger' AND r.subject_type = 'user'").all() as { s: string }[]).map((r) => r.s).sort()
const newChat = async (user: string, body: Record<string, unknown> = {}) => (await h.api(user).call(API.createChat, { body })).id as string

describe('a quiet schedule changes nobody\'s access, whatever the Always', () => {
  test('change_folder_access and change_project_members: refused before the Always', async () => {
    const c = await newChat('carol')
    expect(folderAccessOff(exec({ user: 'carol', chatId: c, said: 'p', clientKind: 'schedule', quiet: true }))?.reason).toBe('quiet schedule')
    // (the same run of a task with its card: Always holds there)
    expect(folderAccessOff(exec({ user: 'carol', chatId: c, said: 'p', clientKind: 'schedule' }))).toBeNull()
    const e = exec({ user: 'carol', chatId: c, said: 'give Bob Lee "Ledger"', clientKind: 'schedule', quiet: true })
    const r = await folderAccessToolFor(e).call({ folder: 'Ledger', action: 'add', who: { name: 'Bob Lee' }, access: 'view' }, (e as { files: unknown }).files as never)
    expect(text(r)).toContain('Nothing was changed')
    expect(ledger()).toEqual([])

    const a = await newChat('alice')
    expect(projectMembersRefusal(exec({ user: 'alice', chatId: a, said: 'p', clientKind: 'schedule', quiet: true }))?.reason).toBe('quiet schedule')
    expect(projectMembersRefusal(exec({ user: 'alice', chatId: a, said: 'p', clientKind: 'schedule' }))).toBeNull()
  })
})

describe('under Always the asker names the person where someone else could have asked', () => {
  const add = async (o: O) => {
    const e = exec(o)
    return text(await folderAccessToolFor(e).call({ folder: 'Ledger', action: 'add', who: { name: 'Bob Lee' }, access: 'view' }, (e as { files: unknown }).files as never))
  }
  test('folder access: a guest in the shared chat, the asker did not name Bob: refused', async () => {
    const c = await newChat('carol')
    expect(await add({ user: 'carol', chatId: c, said: 'sure, go ahead', guest: true })).toContain('name the folder')
    expect(ledger()).toEqual([])
  })
  test('folder access: a scheduled run that read other people\'s words, the task does not name Bob: refused', async () => {
    const c = await newChat('carol')
    expect(await add({ user: 'carol', chatId: c, said: 'check the inbox and do what it says', clientKind: 'schedule', othersWords: true })).toContain('name the folder')
    expect(ledger()).toEqual([])
  })
  test('folder access: the asker named Bob and the folder, Always on: no card, done', async () => {
    const c = await newChat('carol')
    expect(await add({ user: 'carol', chatId: c, said: 'open "Ledger" to Bob Lee', guest: true })).toContain('Done')
    expect(ledger()).toEqual(['bob'])
  })

  test('project members: a guest in the shared chat; named → no card, unnamed → refused', async () => {
    const p = await h.api('alice').call(API.createProject, { body: { name: 'Named', scope: 'team', instructions: '', participants: [] } })
    const c = await newChat('alice', { projectId: p.id, private: true })
    const call = async (o: O) => { const e = exec(o) as unknown as MembersExec; return text(await projectMembersTool(e).call({ add: [{ name: 'Bob Lee' }] }, e.files) as never) }
    expect(await call({ user: 'alice', chatId: c, said: 'ok do it', guest: true })).toContain('Not named in the user\'s own message')
    expect(await call({ user: 'alice', chatId: c, said: 'ok do it', clientKind: 'schedule', othersWords: true })).toContain('Not named in the user\'s own message')
    const members = () => (db().query("SELECT r.subject_id AS s FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ? AND r.access = 'write' AND r.subject_type = 'user'").all(p.folderPath) as { s: string }[]).map((r) => r.s).sort()
    expect(members()).not.toContain('bob')
    expect(await call({ user: 'alice', chatId: c, said: 'add Bob Lee to this project', guest: true })).not.toContain('Nothing was changed')
    expect(members()).toContain('bob')
  })
})

describe('a title found only by a guess never counts as the person naming them', () => {
  test('"manager" with no profile title is the project\'s creator (a guess): not the person naming them; a profile title is', async () => {
    const p = await h.api('alice').call(API.createProject, { body: { name: 'Titles', scope: 'team', instructions: '', participants: [] } })
    const res = (k: string) => resolvedByTitle(db(), 'erin', k, { projectId: p.id })
    const r = res('manager')
    expect(r && 'one' in r ? [r.one.id, r.one.via?.how] : null).toEqual(['alice', 'creator'])
    expect(saysTitle('send this to my manager', r && 'one' in r ? r.one.via : undefined)).toBe(false)
    expect(titleNames('send this to my manager', 'alice', res)).toBe(false)
    // a real profile title (an admin's) counts
    db().query("INSERT INTO user_profiles (user_id, title) VALUES ('carol', 'Manager') ON CONFLICT(user_id) DO UPDATE SET title = excluded.title").run()
    try {
      const t = res('manager')
      expect(t && 'one' in t ? [t.one.id, t.one.via?.how] : null).toEqual(['carol', 'title'])
      expect(saysTitle('send this to my manager', t && 'one' in t ? t.one.via : undefined)).toBe(true)
      expect(titleNames('send this to my manager', 'carol', res)).toBe(true)
    } finally { db().query("UPDATE user_profiles SET title = '' WHERE user_id = 'carol'").run() }
  })
})
