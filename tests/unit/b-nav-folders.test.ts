// List folders (docs/DECISIONS.md "List folders", server/src/chat/nav-folders.ts, migration 289): a person's own folders
// for their AI chats (kind 'chats') and conversations (kind 'rooms'). Covered: make, rename, order (any subset, two
// devices at once), delete (its chats and rooms stay); names (NFC, any letter case, 40 characters as people see them,
// no invisible characters); the limits (30 folders a kind, 500 a folder, rows of things no longer seen make room); the
// composite key (no item in another person's folder or a folder of the other kind); filing a chat (any chat of my Trina
// history, owner 2026-11-22: mine, project chats included, a shared project chat I wrote in, a chat shared with me; a
// shared project chat I never wrote in 409; a server draft, a chat in the trash or someone else's 404; moving; out; a
// move into a project keeps it); filing a room (members only; hidden 409, archived 404); what a folder shows (only
// while the chat is in my history: never a chat in the trash, a stale row of someone else's chat, a chat I lost (left
// the project, unshared, hidden from my list), a room left, archived or hidden; a hidden room comes back); clean-up
// (trash, leaving, the account deleted); per-person: another member, an admin and the owner get 404 for everything of
// mine and see nothing of it, my folder id is never in their copy of a chat; my windows hear changes, nobody else's.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { NAV_FOLDER_ITEMS_MAX, NAV_FOLDERS_MAX } from '@mycel/shared/api'
import { newId } from '../../server/src/db'
import { API, type Chat, type NavFolder } from '@mycel/shared/api'
import { updateGroupAs } from '../../server/src/admin/groups'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { startHarness, type Harness as BHarness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { getChatRuntime } from '../../server/src/chat/runtime'
import { listNavFolders, visibleChatItems } from '../../server/src/chat/nav-folders'
import { chatGroups } from '../../server/src/chat/chat-groups'
import { chatView } from '../../server/src/chat/shared'

setDefaultTimeout(60_000)
let h: Harness | undefined
afterEach(async () => { await h?.close(); h = undefined })

async function setup(name = 'b-nav-folders') {
  h = await harness(name)
  const owner = await withOwner(h)
  const admin = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const ownerId = (await owner.call('GET', '/api/me')).user.id as string
  const db = h.ctx.db
  const folders = async (c: Client) => (await c.call('GET', '/api/nav-folders')).items as any[]
  const make = (c: Client, kind: 'chats' | 'rooms', name: string) => c.try('POST', '/api/nav-folders', { kind, name })
  const chat = async (c: Client, body: Record<string, unknown> = {}) => (await c.call('POST', '/api/chats', body)).id as string
  const fileChat = (c: Client, id: string, folderId: string | null) => c.try('PUT', `/api/chats/${id}/folder`, { folderId })
  const fileRoom = (c: Client, id: string, folderId: string | null) => c.try('PUT', `/api/rooms/${id}/folder`, { folderId })
  const rows = (userId: string) => (db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE user_id = ?').get(userId) as { n: number }).n
  const events = (uid: string, type = 'navFolders.changed') => h!.hub.events.filter((e) => e.kind === 'publish' && e.target === uid && (e.data as { type: string }).type === type)
  return { owner, ownerId, admin, mia, nora, otto, db, folders, make, chat, fileChat, fileRoom, rows, events }
}

test('make, rename and delete my folders; names are unique per kind in any letter case; my windows hear it, nobody else', async () => {
  const { mia, nora, make, folders, events, ownerId, admin, otto } = await setup()
  const a = await make(mia.client, 'chats', '  Reports  ')
  expect(a.status).toBe(201)
  expect(a.body).toMatchObject({ kind: 'chats', name: 'Reports', position: 0, count: 0, top: [] })
  const b = (await make(mia.client, 'chats', '견적')).body
  expect(b.position).toBe(1)
  // the same name in another letter case, or the same letters written apart (NFD), is the same name
  for (const name of ['REPORTS', 'reports ']) {
    const r = await make(mia.client, 'chats', name)
    expect([r.status, r.body.error.params.reason]).toEqual([409, 'nav_folder_name_taken'])
  }
  const cafe = await make(mia.client, 'chats', 'Café')
  expect(cafe.status).toBe(201)
  expect((await make(mia.client, 'chats', 'Café')).status).toBe(409)
  // the other kind and another person may use it
  expect((await make(mia.client, 'rooms', 'Reports')).status).toBe(201)
  expect((await make(nora.client, 'chats', 'Reports')).status).toBe(201)
  // rename (its own name in another case is fine; another folder's is taken)
  expect((await mia.client.try('PATCH', `/api/nav-folders/${a.body.id}`, { name: 'reports' })).body.name).toBe('reports')
  expect((await mia.client.try('PATCH', `/api/nav-folders/${a.body.id}`, { name: '견적' })).status).toBe(409)
  // only my windows heard each change
  expect(events(mia.id).length).toBeGreaterThanOrEqual(5)
  for (const u of [ownerId, admin.id, otto.id]) expect(events(u)).toEqual([])
  // delete: the rest close up in their order
  expect((await mia.client.try('DELETE', `/api/nav-folders/${a.body.id}`)).status).toBe(204)
  expect((await folders(mia.client)).filter((f) => f.kind === 'chats').map((f) => [f.name, f.position])).toEqual([['견적', 0], ['Café', 1]])
  expect((await mia.client.try('DELETE', `/api/nav-folders/${a.body.id}`)).status).toBe(404)
})

test('names: trimmed, 1–40 characters as people see them, no invisible or control characters, strict bodies', async () => {
  const { mia, make } = await setup()
  expect((await make(mia.client, 'chats', '👍🏽'.repeat(40))).status).toBe(201)
  expect((await make(mia.client, 'chats', '가'.repeat(40))).status).toBe(201)
  for (const bad of ['', '   ', 'a'.repeat(41), '👍🏽'.repeat(41), 'line\nbreak', 'tab\tname', 'zero​width', 'rtl‮override', 'ㅤ'])
    expect([bad, (await make(mia.client, 'chats', bad)).status]).toEqual([bad, 400])
  expect((await mia.client.try('POST', '/api/nav-folders', { kind: 'chats', name: 'x', userId: 'someone' })).status).toBe(400)
  expect((await mia.client.try('POST', '/api/nav-folders', { kind: 'files', name: 'x' })).status).toBe(400)
})

test(`at most ${NAV_FOLDERS_MAX} folders a kind`, async () => {
  const { mia, make } = await setup()
  for (let i = 0; i < NAV_FOLDERS_MAX; i++) expect((await make(mia.client, 'chats', `f${i}`)).status).toBe(201)
  const full = await make(mia.client, 'chats', 'one more')
  expect([full.status, full.body.error.params.reason]).toEqual([409, 'nav_folders_full'])
  expect((await make(mia.client, 'rooms', 'one more')).status).toBe(201)
})

test('order: any subset of my folders first, the rest after in their order; ids not mine or of the other kind are ignored', async () => {
  const { mia, nora, make, folders, db } = await setup()
  const ids: string[] = []
  for (const n of ['a', 'b', 'c', 'd']) ids.push((await make(mia.client, 'chats', n)).body.id)
  const [a, , c, d] = ids as [string, string, string, string]
  const room = (await make(mia.client, 'rooms', 'r')).body.id
  const theirs = (await make(nora.client, 'chats', 'theirs')).body.id
  const names = async () => (await folders(mia.client)).filter((f) => f.kind === 'chats').sort((x, y) => x.position - y.position).map((f) => f.name)
  expect(await names()).toEqual(['a', 'b', 'c', 'd'])
  // one device moves d to the top while another (that never saw d) moves c up: both succeed, the last one wins
  const one = await mia.client.try('PUT', '/api/nav-folders/order', { kind: 'chats', ids: [d] })
  expect(one.status).toBe(200)
  expect(one.body.items.filter((f: any) => f.kind === 'chats').sort((x: any, y: any) => x.position - y.position).map((f: any) => f.name)[0]).toBe('d')
  const two = await mia.client.try('PUT', '/api/nav-folders/order', { kind: 'chats', ids: [c, a, theirs, room, newId()] })
  expect(two.status).toBe(200)
  const after = await names()
  expect(after).toEqual(['c', 'a', 'd', 'b'])
  // positions stay 0..n-1; nora's folder and mia's rooms folder were not touched
  expect((await folders(mia.client)).filter((f) => f.kind === 'chats').map((f) => f.position).sort()).toEqual([0, 1, 2, 3])
  expect(db.query('SELECT position FROM nav_folders WHERE id = ?').get(theirs)).toEqual({ position: 0 })
  expect(db.query('SELECT position FROM nav_folders WHERE id = ?').get(room)).toEqual({ position: 0 })
})

test('the composite key: no item in another person\'s folder or a folder of the other kind, whatever the code does', async () => {
  const { mia, nora, make, chat, db } = await setup()
  const miaChats = (await make(mia.client, 'chats', 'mine')).body.id
  const miaRooms = (await make(mia.client, 'rooms', 'rooms')).body.id
  const noraChat = await chat(nora.client)
  const miaChat = await chat(mia.client)
  const ins = (folder: string, user: string, kind: string, chatId: string | null, roomId: string | null) => () =>
    db.query('INSERT INTO nav_folder_items (folder_id, user_id, kind, chat_id, room_id, added_at) VALUES (?, ?, ?, ?, ?, ?)').run(folder, user, kind, chatId, roomId, new Date().toISOString())
  // nora's item in mia's folder
  expect(ins(miaChats, nora.id, 'chats', noraChat, null)).toThrow(/FOREIGN KEY/)
  // a chat in a rooms folder
  expect(ins(miaRooms, mia.id, 'chats', miaChat, null)).toThrow(/FOREIGN KEY/)
  // a row of the wrong shape
  expect(ins(miaChats, mia.id, 'chats', null, null)).toThrow(/CHECK/)
  // one folder per item
  ins(miaChats, mia.id, 'chats', miaChat, null)()
  const second = (await make(mia.client, 'chats', 'second')).body.id
  expect(ins(second, mia.id, 'chats', miaChat, null)).toThrow(/UNIQUE/)
})

test('filing a chat: my own without a project; moving; taking out; the list, counts, top rows and ?folderId', async () => {
  const { mia, nora, make, chat, fileChat, folders, db, events } = await setup()
  const f1 = (await make(mia.client, 'chats', 'one')).body.id
  const f2 = (await make(mia.client, 'chats', 'two')).body.id
  const ids: string[] = []
  for (let i = 0; i < 5; i++) {
    const id = await chat(mia.client, { title: `chat ${i}` })
    db.query('UPDATE chats SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - (10 - i) * 60_000).toISOString(), id)
    ids.push(id)
  }
  h!.hub.events = []
  for (const id of ids) {
    const r = await fileChat(mia.client, id, f1)
    expect([r.status, r.body.folderId]).toEqual([200, f1])
  }
  // my windows heard the chat (with its folder) and the folders
  expect(h!.hub.events.filter((e) => e.target === mia.id && (e.data as any).type === 'chat.updated' && (e.data as any).data.chat.folderId === f1).length).toBe(5)
  expect(events(mia.id).length).toBe(5)
  expect(events(nora.id)).toEqual([])
  let list = await folders(mia.client)
  const one = list.find((f) => f.id === f1)
  expect(one.count).toBe(5)
  // the three most recently active first
  expect(one.top.map((c: any) => c.id)).toEqual([ids[4], ids[3], ids[2]])
  expect(one.top.every((c: any) => c.folderId === f1)).toBe(true)
  // the folder's own page
  const page = await mia.client.call('GET', `/api/chats?folderId=${f1}&limit=2`)
  expect(page.items.map((c: any) => c.id)).toEqual([ids[4], ids[3]])
  const rest = await mia.client.call('GET', `/api/chats?folderId=${f1}&limit=10&cursor=${encodeURIComponent(page.nextCursor)}`)
  expect(rest.items.map((c: any) => c.id)).toEqual([ids[2], ids[1], ids[0]])
  // the chat shows its folder wherever it comes
  expect((await mia.client.call('GET', `/api/chats/${ids[0]}`)).folderId).toBe(f1)
  // moving: one folder at a time
  expect((await fileChat(mia.client, ids[0], f2)).body.folderId).toBe(f2)
  list = await folders(mia.client)
  expect([list.find((f) => f.id === f1).count, list.find((f) => f.id === f2).count]).toEqual([4, 1])
  // the same again changes nothing
  expect((await fileChat(mia.client, ids[0], f2)).status).toBe(200)
  // out
  const out = await fileChat(mia.client, ids[0], null)
  expect([out.status, out.body.folderId]).toEqual([200, undefined])
  expect((await folders(mia.client)).find((f) => f.id === f2).count).toBe(0)
  // a folder id of the other kind, not mine, or unknown: 404
  const rooms = (await make(mia.client, 'rooms', 'r')).body.id
  const theirs = (await make(nora.client, 'chats', 'theirs')).body.id
  for (const f of [rooms, theirs, '019a0000-0000-7000-8000-000000000001']) expect((await fileChat(mia.client, ids[0], f)).status).toBe(404)
  // ?folderId of someone else's folder: 404, and not with projectId or the trash
  expect((await mia.client.try('GET', `/api/chats?folderId=${theirs}`)).status).toBe(404)
  expect((await mia.client.try('GET', `/api/chats?folderId=${f1}&trash=1`)).status).toBe(400)
})

test('a project chat can be filed; a chat moved into a project or out of one stays in its folder', async () => {
  const { mia, make, chat, fileChat, folders, db } = await setup()
  const f = (await make(mia.client, 'chats', 'f')).body.id
  const project = await mia.client.call('POST', '/api/projects', { name: 'Plan', scope: 'personal' })
  const inProject = await chat(mia.client, { projectId: project.id, title: 'in project' })
  const yes = await fileChat(mia.client, inProject, f)
  expect([yes.status, yes.body.folderId, yes.body.projectId]).toEqual([200, f, project.id])
  const c = await chat(mia.client, { title: 'moved' })
  await fileChat(mia.client, c, f)
  const moved = await mia.client.call('PATCH', `/api/chats/${c}`, { projectId: project.id })
  expect([moved.folderId, moved.projectId]).toEqual([f, project.id])
  expect(db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE chat_id = ?').get(c)).toEqual({ n: 1 })
  expect((await folders(mia.client)).find((x) => x.id === f).count).toBe(2)
  expect((await mia.client.call('GET', `/api/chats?folderId=${f}`)).items.map((x: any) => x.id).sort()).toEqual([inProject, c].sort())
  // out of the project again: still there
  expect((await mia.client.call('PATCH', `/api/chats/${c}`, { projectId: null })).folderId).toBe(f)
  // the history's groups: in the folder's group, not the project's
  const g = await mia.client.call('GET', '/api/chats/groups')
  expect(g.folders.find((x: any) => x.id === f).count).toBe(2)
  expect(g.projects.flatMap((p: any) => p.top).map((x: any) => x.id)).not.toContain(inProject)
  // a rename keeps it where it is
  const d = await chat(mia.client)
  await fileChat(mia.client, d, f)
  await mia.client.call('PATCH', `/api/chats/${d}`, { title: 'renamed' })
  expect((await mia.client.call('GET', `/api/chats/${d}`)).folderId).toBe(f)
})

test('a server draft chat, a chat in the trash and someone else\'s chat cannot be filed (404); the trash drops the row for good', async () => {
  const { mia, nora, owner, admin, make, chat, fileChat, folders, db } = await setup()
  const f = (await make(mia.client, 'chats', 'f')).body.id
  const draft = await chat(mia.client)
  db.query("INSERT INTO onboarding_profile_drafts (chat_id, user_id, source, website, site, created_at) VALUES (?, ?, 'website', 'https://acme.example/', 'acme.example', ?)").run(draft, mia.id, new Date().toISOString())
  expect((await fileChat(mia.client, draft, f)).status).toBe(404)
  expect((await fileChat(mia.client, draft, null)).status).toBe(404)
  // anyone else on my chat, the owner and an admin included: 404, never 403
  const mine = await chat(mia.client)
  for (const c of [nora.client, owner, admin.client]) {
    expect((await fileChat(c, mine, f)).status).toBe(404)
    expect((await fileChat(c, mine, null)).status).toBe(404)
  }
  // a draft row slipped in by hand is never shown or counted
  db.query("INSERT INTO nav_folder_items (folder_id, user_id, kind, chat_id, room_id, added_at) VALUES (?, ?, 'chats', ?, NULL, ?)").run(f, mia.id, draft, new Date().toISOString())
  expect((await folders(mia.client)).find((x) => x.id === f).count).toBe(0)
  expect((await mia.client.call('GET', `/api/chats?folderId=${f}`)).items).toEqual([])
  // the trash: out of the folder; restored, it is in no folder
  await fileChat(mia.client, mine, f)
  await mia.client.call('DELETE', `/api/chats/${mine}`)
  expect(db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE chat_id = ?').get(mine)).toEqual({ n: 0 })
  expect((await fileChat(mia.client, mine, f)).status).toBe(404)
  await mia.client.call('POST', `/api/chats/${mine}/restore`)
  expect((await mia.client.call('GET', `/api/chats/${mine}`)).folderId).toBeUndefined()
})

test('what a folder shows is checked on every read: a stale row of someone else\'s chat, a chat in the trash, a room\'s session never shows', async () => {
  const { mia, nora, make, chat, folders, db } = await setup()
  const f = (await make(mia.client, 'chats', 'f')).body.id
  const theirs = await chat(nora.client, { title: 'NORA-SECRET-TITLE' })
  const project = await mia.client.call('POST', '/api/projects', { name: 'P', scope: 'personal' })
  const inProject = await chat(mia.client, { title: 'in project' })
  const trashed = await chat(mia.client, { title: 'trashed' })
  const session = await chat(mia.client, { title: 'ROOM-SESSION-CANARY' })
  const put = (id: string) => db.query("INSERT INTO nav_folder_items (folder_id, user_id, kind, chat_id, room_id, added_at) VALUES (?, ?, 'chats', ?, NULL, ?)").run(f, mia.id, id, new Date().toISOString())
  for (const id of [theirs, inProject, trashed, session]) put(id)
  // as if each changed behind the folder's back: a project (still hers: it stays), the trash, a room's AI session
  db.query('UPDATE chats SET project_id = ? WHERE id = ?').run(project.id, inProject)
  db.query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), trashed)
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  db.query('UPDATE chats SET room_id = ? WHERE id = ?').run(dm.id, session)
  const list = await folders(mia.client)
  expect(list.find((x) => x.id === f)).toMatchObject({ count: 1, top: [{ id: inProject }] })
  expect(JSON.stringify(list)).not.toContain('NORA-SECRET-TITLE')
  expect(JSON.stringify(list)).not.toContain('ROOM-SESSION-CANARY')
  expect((await mia.client.call('GET', `/api/chats?folderId=${f}`)).items.map((x: any) => x.id)).toEqual([inProject])
  // nor does the chat carry the folder for anyone else
  expect((await nora.client.call('GET', `/api/chats/${theirs}`)).folderId).toBeUndefined()
  expect((await mia.client.call('GET', `/api/chats/${inProject}`)).folderId).toBe(f)
})

test(`at most ${NAV_FOLDER_ITEMS_MAX} a folder; rows of chats in the trash make room first`, async () => {
  const { mia, make, chat, fileChat, db } = await setup()
  const f = (await make(mia.client, 'chats', 'big')).body.id
  const now = new Date().toISOString()
  const ins = db.query("INSERT INTO chats (id, user_id, project_id, title, title_source, engine, model, created_at, updated_at) VALUES (?, ?, NULL, 'x', 'user', 'claude-code', NULL, ?, ?)")
  const file = db.query("INSERT INTO nav_folder_items (folder_id, user_id, kind, chat_id, room_id, added_at) VALUES (?, ?, 'chats', ?, NULL, ?)")
  const made: string[] = []
  db.transaction(() => { for (let i = 0; i < NAV_FOLDER_ITEMS_MAX; i++) { const id = newId(); ins.run(id, mia.id, now, now); file.run(f, mia.id, id, now); made.push(id) } })()
  const extra = await chat(mia.client)
  const full = await fileChat(mia.client, extra, f)
  expect([full.status, full.body.error.params.reason]).toEqual([409, 'nav_folder_full'])
  // two of them go to the trash behind the folder's back: their rows make room
  db.query('UPDATE chats SET deleted_at = ? WHERE id IN (?, ?)').run(now, made[0]!, made[1]!)
  expect((await fileChat(mia.client, extra, f)).status).toBe(200)
  expect((db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE folder_id = ?').get(f) as { n: number }).n).toBe(NAV_FOLDER_ITEMS_MAX - 1)
})

test('rooms: members only, each their own folder; hidden 409 and kept while hidden; archived and left never show', async () => {
  const { owner, mia, nora, otto, make, fileRoom, folders, db, events } = await setup()
  const f = (await make(mia.client, 'rooms', 'people')).body.id
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const group = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name: 'GROUP-NAME-CANARY' })
  h!.hub.events = []
  const r = await fileRoom(mia.client, dm.id, f)
  expect([r.status, r.body.folderId]).toEqual([200, f])
  expect((await fileRoom(mia.client, group.id, f)).status).toBe(200)
  expect(events(mia.id).length).toBe(2)
  expect(events(nora.id)).toEqual([])
  // nobody else's copy of the room carries my folder (the list, the room, their events)
  expect((await nora.client.call('GET', `/api/rooms/${dm.id}`)).folderId).toBeUndefined()
  expect(((await nora.client.call('GET', '/api/rooms')).items as any[]).every((x) => x.folderId === undefined)).toBe(true)
  expect(h!.hub.events.filter((e) => e.target !== mia.id && JSON.stringify(e.data).includes(f))).toEqual([])
  expect(((await mia.client.call('GET', '/api/rooms')).items as any[]).filter((x) => x.folderId === f).length).toBe(2)
  expect((await folders(mia.client)).find((x) => x.id === f)).toMatchObject({ count: 2, top: [] })
  // a room I am not in (the owner is not in the DM), someone else's folder, an unknown room: 404
  expect((await fileRoom(owner, dm.id, null)).status).toBe(404)
  const noraF = (await make(nora.client, 'rooms', 'nora')).body.id
  expect((await fileRoom(mia.client, dm.id, noraF)).status).toBe(404)
  expect((await fileRoom(nora.client, dm.id, f)).status).toBe(404)
  // hidden: kept, but not shown or counted, and the room carries no folder; filing a hidden room: 409
  await mia.client.call('PUT', `/api/rooms/${dm.id}/hidden`, { hidden: true })
  expect(db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE room_id = ? AND user_id = ?').get(dm.id, mia.id)).toEqual({ n: 1 })
  expect((await folders(mia.client)).find((x) => x.id === f).count).toBe(1)
  expect((await mia.client.call('GET', `/api/rooms/${dm.id}`)).folderId).toBeUndefined()
  const no = await fileRoom(mia.client, dm.id, f)
  expect([no.status, no.body.error.params.reason]).toEqual([409, 'room_hidden'])
  // shown again (nora writes): back in its folder
  await nora.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: 'hi', clientMessageId: 'cm-' + crypto.randomUUID() })
  expect((await mia.client.call('GET', `/api/rooms/${dm.id}`)).folderId).toBe(f)
  expect((await folders(mia.client)).find((x) => x.id === f).count).toBe(2)
  // leaving the group chat: its row goes, and my windows hear the folders changed
  h!.hub.events = []
  await mia.client.call('POST', `/api/rooms/${group.id}/leave`)
  expect(db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE room_id = ?').get(group.id)).toEqual({ n: 0 })
  expect(events(mia.id).length).toBe(1)
  const list = await folders(mia.client)
  expect(list.find((x) => x.id === f).count).toBe(1)
  expect(JSON.stringify(list)).not.toContain('GROUP-NAME-CANARY')
  // archived: not counted, cannot be filed
  db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), dm.id)
  expect((await folders(mia.client)).find((x) => x.id === f).count).toBe(0)
  expect((await fileRoom(mia.client, dm.id, f)).status).toBe(404)
})

test(`a full room folder keeps a hidden room's row (it comes back) and drops rows of rooms that are gone`, async () => {
  const { mia, nora, otto, make, fileRoom, db } = await setup()
  const f = (await make(mia.client, 'rooms', 'full')).body.id
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const other = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: otto.id })
  await fileRoom(mia.client, dm.id, f)
  await mia.client.call('PUT', `/api/rooms/${dm.id}/hidden`, { hidden: true })
  // fill it up with rows of archived rooms she was in
  const now = new Date().toISOString()
  db.transaction(() => {
    for (let i = 0; i < NAV_FOLDER_ITEMS_MAX - 1; i++) {
      const id = newId()
      db.query("INSERT INTO rooms (id, kind, created_at, activity_at, archived_at) VALUES (?, 'group', ?, ?, ?)").run(id, now, now, now)
      db.query('INSERT INTO room_members (room_id, user_id, joined_at, last_read_seq, visible_from_seq, history_from_seq) VALUES (?, ?, ?, 0, 0, 0)').run(id, mia.id, now)
      db.query("INSERT INTO nav_folder_items (folder_id, user_id, kind, chat_id, room_id, added_at) VALUES (?, ?, 'rooms', NULL, ?, ?)").run(f, mia.id, id, now)
    }
  })()
  expect((await fileRoom(mia.client, other.id, f)).status).toBe(200)
  // the archived rooms' rows went, the hidden DM's stayed
  expect(db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE folder_id = ?').get(f)).toEqual({ n: 2 })
  await mia.client.call('PUT', `/api/rooms/${dm.id}/hidden`, { hidden: false })
  expect((await mia.client.call('GET', `/api/rooms/${dm.id}`)).folderId).toBe(f)
})

test('a room row from before I joined again never shows (a stale row)', async () => {
  const { mia, nora, otto, make, folders, db } = await setup()
  const f = (await make(mia.client, 'rooms', 'f')).body.id
  const group = await nora.client.call('POST', '/api/rooms', { kind: 'group', userIds: [mia.id, otto.id] })
  db.query("INSERT INTO nav_folder_items (folder_id, user_id, kind, chat_id, room_id, added_at) VALUES (?, ?, 'rooms', NULL, ?, ?)").run(f, mia.id, group.id, '2000-01-01T00:00:00.000Z')
  expect((await folders(mia.client)).find((x) => x.id === f).count).toBe(0)
  expect((await mia.client.call('GET', `/api/rooms/${group.id}`)).folderId).toBeUndefined()
})

test('deleting a folder: only the folder goes; its chats and rooms stay where they were and say no folder', async () => {
  const { mia, nora, make, chat, fileChat, fileRoom, db } = await setup()
  const fc = (await make(mia.client, 'chats', 'c')).body.id
  const fr = (await make(mia.client, 'rooms', 'r')).body.id
  const c = await chat(mia.client)
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  await fileChat(mia.client, c, fc)
  await fileRoom(mia.client, dm.id, fr)
  h!.hub.events = []
  // someone else, the owner and an admin cannot
  expect((await nora.client.try('DELETE', `/api/nav-folders/${fc}`)).status).toBe(404)
  await mia.client.call('DELETE', `/api/nav-folders/${fc}`)
  await mia.client.call('DELETE', `/api/nav-folders/${fr}`)
  expect((await mia.client.call('GET', `/api/chats/${c}`))).toMatchObject({ id: c, deletedAt: null })
  expect((await mia.client.call('GET', `/api/chats/${c}`)).folderId).toBeUndefined()
  expect((await mia.client.call('GET', `/api/rooms/${dm.id}`)).folderId).toBeUndefined()
  expect(db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE user_id = ?').get(mia.id)).toEqual({ n: 0 })
  // my windows got the chat and the room again, without the folder
  expect(h!.hub.events.some((e) => e.target === mia.id && (e.data as any).type === 'chat.updated' && (e.data as any).data.chatId === c)).toBe(true)
})

test('route matrix: the folder\'s owner, another member, an admin, the owner, a person who lost access, a deleted account', async () => {
  const { owner, admin, mia, nora, otto, make, chat, fileChat, fileRoom, folders, db, rows } = await setup()
  const fc = (await make(mia.client, 'chats', 'MIA-FOLDER-CANARY')).body.id
  const fr = (await make(mia.client, 'rooms', 'MIA-ROOMS-CANARY')).body.id
  const c = await chat(mia.client, { title: 'MIA-CHAT-CANARY' })
  await fileChat(mia.client, c, fc)
  const group = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  await fileRoom(mia.client, group.id, fr)
  const others: [string, Client][] = [['member', nora.client], ['admin', admin.client], ['owner', owner]]
  for (const [who, cl] of others) {
    // their list names nothing of mine
    const list = await cl.try('GET', '/api/nav-folders')
    expect([who, list.status]).toEqual([who, 200])
    expect(JSON.stringify(list.body)).not.toContain('CANARY')
    // every route aimed at my folder or my chat: 404 (never 403), nothing changed
    const tries = [
      await cl.try('PATCH', `/api/nav-folders/${fc}`, { name: 'taken over' }),
      await cl.try('DELETE', `/api/nav-folders/${fc}`),
      await cl.try('GET', `/api/chats?folderId=${fc}`),
      await cl.try('PUT', `/api/chats/${c}/folder`, { folderId: null }),
      await cl.try('PUT', `/api/chats/${c}/folder`, { folderId: fc }),
      await cl.try('PUT', `/api/chats/${await chat(cl)}/folder`, { folderId: fc }),
    ]
    expect([who, tries.map((t) => t.status)]).toEqual([who, [404, 404, 404, 404, 404, 404]])
    for (const t of tries) expect(JSON.stringify(t.body ?? '')).not.toContain('CANARY')
    // ordering with my id: ignored, my order and name untouched
    const ord = await cl.try('PUT', '/api/nav-folders/order', { kind: 'chats', ids: [fc] })
    expect(ord.status).toBe(200)
    expect(JSON.stringify(ord.body)).not.toContain('CANARY')
  }
  // nora is in the group chat, yet cannot use my rooms folder; the owner and the admin are not in it
  expect((await fileRoom(nora.client, group.id, fr)).status).toBe(404)
  expect((await fileRoom(admin.client, group.id, null)).status).toBe(404)
  expect((await fileRoom(owner, group.id, null)).status).toBe(404)
  expect(db.query('SELECT name FROM nav_folders WHERE id = ?').get(fc)).toEqual({ name: 'MIA-FOLDER-CANARY' })
  // the folder's owner: everything works
  expect((await folders(mia.client)).map((f) => [f.name, f.count])).toEqual([['MIA-FOLDER-CANARY', 1], ['MIA-ROOMS-CANARY', 1]])
  // a person who lost access: otto filed the group chat, mia takes him out; his row goes, his windows hear it, and
  // anything after is 404
  const ottoF = (await make(otto.client, 'rooms', 'otto')).body.id
  expect((await fileRoom(otto.client, group.id, ottoF)).status).toBe(200)
  h!.hub.events = []
  await mia.client.call('DELETE', `/api/rooms/${group.id}/members/${otto.id}`)
  expect(db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE user_id = ?').get(otto.id)).toEqual({ n: 0 })
  expect(h!.hub.events.some((e) => e.target === otto.id && (e.data as any).type === 'navFolders.changed')).toBe(true)
  expect((await folders(otto.client)).find((x) => x.id === ottoF).count).toBe(0)
  expect((await fileRoom(otto.client, group.id, ottoF)).status).toBe(404)
  // a deleted account: its folders and rows go (the users row stays as a tombstone)
  expect(rows(mia.id)).toBe(2)
  await owner.call('DELETE', `/api/admin/users/${mia.id}`)
  expect(rows(mia.id)).toBe(0)
  expect(db.query('SELECT COUNT(*) n FROM nav_folders WHERE user_id = ?').get(mia.id)).toEqual({ n: 0 })
  expect(db.query('SELECT COUNT(*) n FROM users WHERE id = ?').get(mia.id)).toEqual({ n: 1 })
  // and nothing about folders was audited
  expect(db.query("SELECT COUNT(*) n FROM audit_log WHERE action LIKE '%folder%' AND detail LIKE '%CANARY%'").get()).toEqual({ n: 0 })
  // signed out for good: the old session gets 401
  expect((await mia.client.try('GET', '/api/nav-folders')).status).toBe(401)
})

// Any chat of my Trina history can go in my section (owner decision 2026-11-22), and it shows there only while the
// history shows it. projects/falcon shares its chats: alice writes it, the finance group (bob) reads it.
describe('every chat of my history: shared project chats and chats shared with me', () => {
  let b: BHarness
  const ws: Record<string, TestSocket> = {}
  let projectId: string
  beforeAll(async () => {
    b = await startHarness({ name: 'b-nav-folders-shared', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
    for (const u of ['alice', 'bob']) { ws[u] = await b.ws(u); await ws[u]!.next('hello') }
    projectId = (await oldProject(b, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
    await b.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  })
  afterAll(async () => { for (const s of Object.values(ws)) s.close(); await b.close() })

  const reason = async (p: Promise<unknown>) => { try { await p } catch (e: any) { return [e.status, e.body?.params?.reason ?? e.body?.code] } throw new Error('expected an error') }
  const ask = async (user: string, chatId: string, content: string) => {
    const started = await b.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  }
  const section = (user: string, name: string) => b.api(user).call(API.createNavFolder, { body: { kind: 'chats', name } })
  const file = (user: string, id: string, folderId: string | null) => b.api(user).call(API.setChatFolder, { params: { id }, body: { folderId } })
  const mine = async (user: string, id: string): Promise<NavFolder> => ((await b.api(user).call(API.listNavFolders, {})).items as NavFolder[]).find((f) => f.id === id)!
  const inFolder = async (user: string, folderId: string) => (await b.api(user).call(API.listChats, { query: { folderId } })).items.map((c: Chat) => c.id)
  const grouped = async (user: string, folderId: string) => (await b.api(user).call(API.listChatGroups, {})).folders.find((f) => f.id === folderId)!
  const raw = async (user: string, path: string) => (await b.req(user, path)).text()
  /** alice shares a new chat (one answer) with these subjects */
  const sharedWith = async (title: string, subjects: { subjectType: 'user' | 'group'; subjectId: string }[]) => {
    const c = await b.api('alice').call(API.createChat, { body: { title } })
    await ask('alice', c.id, 'hello')
    let r = await b.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects } })
    if (r.status === 'confirm') r = await b.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects, confirmKey: r.confirmKey } })
    expect(r.status).toBe('saved')
    return c
  }
  /** bob's section shows nothing of this chat, by every read: count, top, ?folderId, the groups, the chat itself */
  const nothingOf = async (folderId: string, chatId: string, title: string, count = 0) => {
    const f = await mine('bob', folderId)
    expect([f.count, f.top.map((c) => c.id)]).toEqual([count, []])
    expect(await inFolder('bob', folderId)).toEqual([])
    const g = await grouped('bob', folderId)
    expect([g.count, g.top.map((c) => c.id)]).toEqual([count, []])
    for (const path of ['/api/nav-folders', '/api/chats/groups', `/api/chats?folderId=${folderId}`]) expect(await raw('bob', path)).not.toContain(title)
    const got = await b.req('bob', `/api/chats/${chatId}`)
    if (got.status === 200) expect(((await got.json()) as Chat).folderId).toBeUndefined()
  }

  test('a shared project chat: filed once I wrote in it; out while I lost the project, back after; nobody else sees my folder', async () => {
    const f = await section('bob', 'BOB-FOLDER-CANARY')
    const shared = await b.api('alice').call(API.createChat, { body: { projectId, title: 'falcon plan' } })
    expect(shared.shared).toBeTruthy()
    // bob never wrote in it: it is on the project's page, not in his history
    expect(await reason(file('bob', shared.id, f.id))).toEqual([409, 'folder_not_in_history'])
    await ask('bob', shared.id, 'BOB-QUESTION')
    const filed = await file('bob', shared.id, f.id)
    expect([filed.folderId, filed.projectId]).toEqual([f.id, projectId])
    // alice files it too, in her own section
    const af = await section('alice', 'ALICE-FOLDER-CANARY')
    expect((await file('alice', shared.id, af.id)).folderId).toBe(af.id)
    // each sees only their own folder on the chat, wherever it comes
    expect((await b.api('bob').call(API.getChat, { params: { id: shared.id } })).folderId).toBe(f.id)
    expect((await b.api('alice').call(API.getChat, { params: { id: shared.id } })).folderId).toBe(af.id)
    for (const [who, other, path] of [['alice', f.id, '/api/chats'], ['alice', f.id, '/api/chats/groups'], ['alice', f.id, `/api/chats/${shared.id}`], ['bob', af.id, '/api/chats'], ['bob', af.id, '/api/chats/groups'], ['bob', af.id, '/api/nav-folders']] as const) {
      const text = await raw(who, path)
      expect([who, path, text.includes(other)]).toEqual([who, path, false])
      expect(text).not.toContain(who === 'alice' ? 'BOB-FOLDER-CANARY' : 'ALICE-FOLDER-CANARY')
    }
    expect(await mine('bob', f.id)).toMatchObject({ count: 1, top: [{ id: shared.id, folderId: f.id }] })
    expect(await grouped('bob', f.id)).toMatchObject({ count: 1, top: [{ id: shared.id }] })
    // a message in it reaches each person's windows with their own folder only
    for (const u of ['alice', 'bob']) ws[u]!.frames = []
    await ask('alice', shared.id, 'again')
    await ws.bob!.next('chat.updated', (x) => x.data.chatId === shared.id && !!x.data.chat)
    for (const [u, own] of [['alice', af.id], ['bob', f.id]] as const) {
      const got = ws[u]!.frames.filter((x: any) => x.type === 'chat.updated' && x.data.chatId === shared.id && x.data.chat)
      expect(got.length).toBeGreaterThan(0)
      for (const x of got as any[]) expect([u, x.data.chat.folderId]).toEqual([u, own])
    }

    // bob leaves the finance group: he loses projects/falcon and the chat drops out of his section
    updateGroupAs(b.ctx, 'dana', 'finance', { memberIds: [] }, 'en')
    try {
      expect(await mine('bob', f.id)).toMatchObject({ count: 0, top: [] })
      expect(await inFolder('bob', f.id)).toEqual([])
      expect(await grouped('bob', f.id)).toMatchObject({ count: 0, top: [] })
      for (const path of ['/api/nav-folders', '/api/chats/groups', `/api/chats?folderId=${f.id}`]) expect(await raw('bob', path)).not.toContain('falcon plan')
      expect((await reason(file('bob', shared.id, f.id)))[0]).toBe(404)
    } finally { updateGroupAs(b.ctx, 'dana', 'finance', { memberIds: ['bob'] }, 'en') }
    // back in the project: back in his section (the row stayed)
    expect(await mine('bob', f.id)).toMatchObject({ count: 1 })
    expect(await inFolder('bob', f.id)).toEqual([shared.id])
  })

  test('a chat shared with me by name: filed; hidden from my list or unshared, it drops out; its creator never sees my folder', async () => {
    const f = await section('bob', 'people')
    const c = await b.api('alice').call(API.createChat, { body: { title: 'shared with bob' } })
    await ask('alice', c.id, 'hello')
    const subjects = [{ subjectType: 'user' as const, subjectId: 'bob' }]
    let r = await b.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects } })
    if (r.status === 'confirm') r = await b.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects, confirmKey: r.confirmKey } })
    expect(r.status).toBe('saved')
    expect((await file('bob', c.id, f.id)).folderId).toBe(f.id)
    expect((await b.api('alice').call(API.getChat, { params: { id: c.id } })).folderId).toBeUndefined()
    expect(await raw('alice', '/api/chats')).not.toContain(f.id)
    // hidden from my list: out of the section too (and cannot be filed while hidden); shown again: back
    await b.api('bob').call(API.hideChat, { params: { id: c.id } })
    expect(await mine('bob', f.id)).toMatchObject({ count: 0, top: [] })
    expect(await inFolder('bob', f.id)).toEqual([])
    expect((await b.api('bob').call(API.getChat, { params: { id: c.id } })).folderId).toBeUndefined()
    expect(await reason(file('bob', c.id, f.id))).toEqual([409, 'folder_not_in_history'])
    await b.api('bob').call(API.unhideChat, { params: { id: c.id } })
    expect(await mine('bob', f.id)).toMatchObject({ count: 1, top: [{ id: c.id }] })
    // unshared: gone from his section, its title nowhere in his answers
    await b.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects: [] } })
    expect(await mine('bob', f.id)).toMatchObject({ count: 0, top: [] })
    for (const path of ['/api/nav-folders', '/api/chats/groups', `/api/chats?folderId=${f.id}`]) expect(await raw('bob', path)).not.toContain('shared with bob')
    // the trash drops every row of a chat
    const d = await b.api('alice').call(API.createChat, { body: { projectId, title: 'to the trash' } })
    await ask('bob', d.id, 'hi')
    await file('bob', d.id, f.id)
    await b.api('alice').call(API.deleteChat, { params: { id: d.id } })
    expect(b.ctx.db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE chat_id = ?').get(d.id)).toEqual({ n: 0 })
  })

  test('a chat shared with a group: filed; out of the group, it drops out (no count, top, page, group row or folderId); back after', async () => {
    // bob joins marketing (alice's group) for this test
    const before = (b.ctx.db.query("SELECT user_id FROM group_members WHERE group_id = 'marketing'").all() as { user_id: string }[]).map((r) => r.user_id)
    updateGroupAs(b.ctx, 'dana', 'marketing', { memberIds: [...before, 'bob'] }, 'en')
    try {
      const f = await section('bob', 'groups')
      const c = await sharedWith('GROUP-SHARED-CANARY', [{ subjectType: 'group', subjectId: 'marketing' }])
      expect((await file('bob', c.id, f.id)).folderId).toBe(f.id)
      expect(await inFolder('bob', f.id)).toEqual([c.id])
      // out of the group: out of his section by every read
      updateGroupAs(b.ctx, 'dana', 'marketing', { memberIds: before }, 'en')
      await nothingOf(f.id, c.id, 'GROUP-SHARED-CANARY')
      expect((await reason(file('bob', c.id, f.id)))[0]).toBe(404)
      // back in the group: back in his section (the row stayed)
      updateGroupAs(b.ctx, 'dana', 'marketing', { memberIds: [...before, 'bob'] }, 'en')
      expect(await inFolder('bob', f.id)).toEqual([c.id])
    } finally { updateGroupAs(b.ctx, 'dana', 'marketing', { memberIds: before }, 'en') }
  })

  test('a deactivated person: their section counts and shows no chat shared with them (by the server\'s own reads)', async () => {
    const f = await section('bob', 'before leaving')
    const c = await sharedWith('DEACTIVATED-CANARY', [{ subjectType: 'user', subjectId: 'bob' }])
    expect((await file('bob', c.id, f.id)).folderId).toBe(f.id)
    const rt = getChatRuntime(b.ctx)
    b.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'bob'").run()
    try {
      expect(listNavFolders(rt, 'bob').find((x) => x.id === f.id)).toMatchObject({ count: 0, top: [] })
      expect(visibleChatItems(rt, 'bob', f.id)).toEqual([])
      expect(JSON.stringify(chatGroups(rt, 'bob'))).not.toContain('DEACTIVATED-CANARY')
      expect(chatView(rt, 'bob', rt.store.chatRow(c.id)!).folderId).toBeUndefined()
      // nor does the creator's copy ever carry it
      expect(chatView(rt, 'alice', rt.store.chatRow(c.id)!).folderId).toBeUndefined()
    } finally { b.ctx.db.query("UPDATE users SET status = 'active' WHERE id = 'bob'").run() }
    expect(listNavFolders(rt, 'bob').find((x) => x.id === f.id)).toMatchObject({ count: 1 })
  })

  test('a guest who wrote in a project\'s shared chat: it is not theirs to file (404/409) and nothing of it is counted', async () => {
    const f = await section('bob', 'as a guest')
    const shared = await b.api('alice').call(API.createChat, { body: { projectId, title: 'GUEST-SHARED-CANARY' } })
    await ask('bob', shared.id, 'hi')
    expect((await file('bob', shared.id, f.id)).folderId).toBe(f.id)
    b.ctx.db.query("UPDATE users SET guest = 1 WHERE id = 'bob'").run()
    try {
      await nothingOf(f.id, shared.id, 'GUEST-SHARED-CANARY')
      expect([404, 409]).toContain((await reason(file('bob', shared.id, f.id)))[0])
    } finally { b.ctx.db.query("UPDATE users SET guest = 0 WHERE id = 'bob'").run() }
    expect(await inFolder('bob', f.id)).toEqual([shared.id])
  })

  test('a full section: the trash makes room first (rows of chats I hid or lost stay); still full, those rows go before a 409', async () => {
    const f = await section('bob', 'full')
    const hidden = await sharedWith('kept hidden', [{ subjectType: 'user', subjectId: 'bob' }])
    const lost = await sharedWith('kept lost', [{ subjectType: 'user', subjectId: 'bob' }])
    await file('bob', hidden.id, f.id)
    await file('bob', lost.id, f.id)
    await b.api('bob').call(API.hideChat, { params: { id: hidden.id } })
    await b.api('alice').call(API.putChatAudience, { params: { id: lost.id }, body: { subjects: [] } })
    const db = b.ctx.db, now = new Date().toISOString()
    const ins = db.query("INSERT INTO chats (id, user_id, project_id, title, title_source, engine, model, created_at, updated_at) VALUES (?, 'bob', NULL, 'x', 'user', 'claude-code', NULL, ?, ?)")
    const put = db.query("INSERT INTO nav_folder_items (folder_id, user_id, kind, chat_id, room_id, added_at) VALUES (?, 'bob', 'chats', ?, NULL, ?)")
    const made: string[] = []
    db.transaction(() => { for (let i = 0; i < NAV_FOLDER_ITEMS_MAX - 2; i++) { const id = newId(); ins.run(id, now, now); put.run(f.id, id, now); made.push(id) } })()
    const rowsOf = (id: string) => (db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE chat_id = ?').get(id) as { n: number }).n
    // one of bob's own goes to the trash behind the folder's back: its row makes room, the hidden and lost rows stay
    db.query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(now, made[0]!)
    const extra = await b.api('bob').call(API.createChat, { body: { title: 'one more' } })
    expect((await file('bob', extra.id, f.id)).folderId).toBe(f.id)
    expect([rowsOf(hidden.id), rowsOf(lost.id), rowsOf(made[0]!)]).toEqual([1, 1, 0])
    // full again with nothing in the trash: the rows of the chats bob hid or lost go (he sees fewer than the limit, so
    // the section is not full to him: review of #387), never a row of a chat he sees
    const more = await b.api('bob').call(API.createChat, { body: { title: 'and one more' } })
    expect((await file('bob', more.id, f.id)).folderId).toBe(f.id)
    expect([rowsOf(hidden.id), rowsOf(lost.id), rowsOf(extra.id), rowsOf(made[1]!)]).toEqual([0, 0, 1, 1])
    expect((await mine('bob', f.id)).count).toBe(NAV_FOLDER_ITEMS_MAX - 1)
    // a section full of chats bob sees: 409
    const last = await b.api('bob').call(API.createChat, { body: { title: 'the last' } })
    expect((await file('bob', last.id, f.id)).folderId).toBe(f.id)
    const over = await b.api('bob').call(API.createChat, { body: { title: 'over' } })
    expect(await reason(file('bob', over.id, f.id))).toEqual([409, 'nav_folder_full'])
  })

  test('taking out the row of a chat I lost: my row goes, and the answer is the same 404 as for any chat I cannot open', async () => {
    const f = await section('bob', 'lost rows')
    const lost = await sharedWith('lost one', [{ subjectType: 'user', subjectId: 'bob' }])
    await file('bob', lost.id, f.id)
    await b.api('alice').call(API.putChatAudience, { params: { id: lost.id }, body: { subjects: [] } })
    const db = b.ctx.db
    const rowsOf = (id: string) => (db.query("SELECT COUNT(*) n FROM nav_folder_items WHERE chat_id = ? AND user_id = 'bob'").get(id) as { n: number }).n
    expect(rowsOf(lost.id)).toBe(1)
    const out = await b.req('bob', `/api/chats/${lost.id}/folder`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId: null }) })
    expect(out.status).toBe(404)
    expect(rowsOf(lost.id)).toBe(0)
    // the answer never says whether a row was there: the same chat again (no row now) answers the same; a chat that
    // never had one and one that does not exist answer 404 as before
    const body = async (r: Response) => { const j = (await r.json()) as { error?: Record<string, unknown> }; delete j.error?.requestId; return j }
    const again = await b.req('bob', `/api/chats/${lost.id}/folder`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId: null }) })
    expect(again.status).toBe(404)
    expect(await body(again)).toEqual(await body(out))
    const never = await b.api('alice').call(API.createChat, { body: { title: 'never filed' } })
    const a = await b.req('bob', `/api/chats/${never.id}/folder`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId: null }) })
    const none = await b.req('bob', `/api/chats/${newId()}/folder`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId: null }) })
    expect([a.status, none.status]).toEqual([404, 404])
    // alice's own rows are never touched by bob's request
    const af = await section('alice', 'alice keeps')
    await file('alice', never.id, af.id)
    await b.req('bob', `/api/chats/${never.id}/folder`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId: null }) })
    expect((await mine('alice', af.id)).count).toBe(1)
  })
})
