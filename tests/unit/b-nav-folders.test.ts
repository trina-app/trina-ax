// List folders (docs/DECISIONS.md "List folders", server/src/chat/nav-folders.ts, migration 289): a person's own folders
// for their AI chats (kind 'chats') and conversations (kind 'rooms'). Covered: make, rename, order (any subset, two
// devices at once), delete (its chats and rooms stay); names (NFC, any letter case, 40 characters as people see them,
// no invisible characters); the limits (30 folders a kind, 500 a folder, rows of things no longer seen make room); the
// composite key (no item in another person's folder or a folder of the other kind); filing a chat (mine with no
// project only; a project chat 409; a server draft, a chat in the trash or someone else's 404; moving; out); filing a
// room (members only; hidden 409, archived 404); what a folder shows (never a chat in the trash or a project, a stale
// row of someone else's chat or a shared chat, a room left, archived or hidden; a hidden room comes back); clean-up
// (trash, a project, leaving, the account deleted); per-person: another member, an admin and the owner get 404 for
// everything of mine and see nothing of it; my windows hear changes, nobody else's.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { NAV_FOLDER_ITEMS_MAX, NAV_FOLDERS_MAX } from '@mycel/shared/api'
import { newId } from '../../server/src/db'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

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
  const events = (uid: string, type = 'navFolders.changed') => h.hub.events.filter((e) => e.kind === 'publish' && e.target === uid && (e.data as { type: string }).type === type)
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
  h.hub.events = []
  for (const id of ids) {
    const r = await fileChat(mia.client, id, f1)
    expect([r.status, r.body.folderId]).toEqual([200, f1])
  }
  // my windows heard the chat (with its folder) and the folders
  expect(h.hub.events.filter((e) => e.target === mia.id && (e.data as any).type === 'chat.updated' && (e.data as any).data.chat.folderId === f1).length).toBe(5)
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

test('a project chat stays in its project (409); a chat that gets a project leaves its folder in the same change', async () => {
  const { mia, make, chat, fileChat, folders, db, events } = await setup()
  const f = (await make(mia.client, 'chats', 'f')).body.id
  const project = await mia.client.call('POST', '/api/projects', { name: 'Plan', scope: 'personal' })
  const inProject = await chat(mia.client, { projectId: project.id })
  const no = await fileChat(mia.client, inProject, f)
  expect([no.status, no.body.error.params.reason]).toEqual([409, 'folder_project_chat'])
  const c = await chat(mia.client)
  await fileChat(mia.client, c, f)
  h.hub.events = []
  const moved = await mia.client.call('PATCH', `/api/chats/${c}`, { projectId: project.id })
  expect(moved.folderId).toBeUndefined()
  expect(db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE chat_id = ?').get(c)).toEqual({ n: 0 })
  expect((await folders(mia.client)).find((x) => x.id === f).count).toBe(0)
  expect(events(mia.id).length).toBe(1)
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

test('what a folder shows is checked on every read: a stale row of someone else\'s chat, a shared or a project chat, a chat in the trash never shows', async () => {
  const { mia, nora, make, chat, folders, db } = await setup()
  const f = (await make(mia.client, 'chats', 'f')).body.id
  const theirs = await chat(nora.client, { title: 'NORA-SECRET-TITLE' })
  const shared = await chat(mia.client, { title: 'lost shared' })
  const project = await mia.client.call('POST', '/api/projects', { name: 'P', scope: 'personal' })
  const inProject = await chat(mia.client, { title: 'in project' })
  const trashed = await chat(mia.client, { title: 'trashed' })
  const put = (id: string) => db.query("INSERT INTO nav_folder_items (folder_id, user_id, kind, chat_id, room_id, added_at) VALUES (?, ?, 'chats', ?, NULL, ?)").run(f, mia.id, id, new Date().toISOString())
  for (const id of [theirs, shared, inProject, trashed]) put(id)
  // as if each changed behind the folder's back: a shared chat (one she lost), a project, the trash
  db.query("UPDATE chats SET shared_at = ?, project_id = ? WHERE id = ?").run(new Date().toISOString(), project.id, shared)
  db.query('UPDATE chats SET project_id = ? WHERE id = ?').run(project.id, inProject)
  db.query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), trashed)
  const list = await folders(mia.client)
  expect(list.find((x) => x.id === f)).toMatchObject({ count: 0, top: [] })
  expect(JSON.stringify(list)).not.toContain('NORA-SECRET-TITLE')
  expect((await mia.client.call('GET', `/api/chats?folderId=${f}`)).items).toEqual([])
  // nor does the chat carry the folder for anyone
  expect((await nora.client.call('GET', `/api/chats/${theirs}`)).folderId).toBeUndefined()
  expect((await mia.client.call('GET', `/api/chats/${inProject}`)).folderId).toBeUndefined()
})

test(`at most ${NAV_FOLDER_ITEMS_MAX} a folder; rows of chats I no longer see make room first`, async () => {
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
  h.hub.events = []
  const r = await fileRoom(mia.client, dm.id, f)
  expect([r.status, r.body.folderId]).toEqual([200, f])
  expect((await fileRoom(mia.client, group.id, f)).status).toBe(200)
  expect(events(mia.id).length).toBe(2)
  expect(events(nora.id)).toEqual([])
  // nobody else's copy of the room carries my folder (the list, the room, their events)
  expect((await nora.client.call('GET', `/api/rooms/${dm.id}`)).folderId).toBeUndefined()
  expect(((await nora.client.call('GET', '/api/rooms')).items as any[]).every((x) => x.folderId === undefined)).toBe(true)
  expect(h.hub.events.filter((e) => e.target !== mia.id && JSON.stringify(e.data).includes(f))).toEqual([])
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
  h.hub.events = []
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
  h.hub.events = []
  // someone else, the owner and an admin cannot
  expect((await nora.client.try('DELETE', `/api/nav-folders/${fc}`)).status).toBe(404)
  await mia.client.call('DELETE', `/api/nav-folders/${fc}`)
  await mia.client.call('DELETE', `/api/nav-folders/${fr}`)
  expect((await mia.client.call('GET', `/api/chats/${c}`))).toMatchObject({ id: c, deletedAt: null })
  expect((await mia.client.call('GET', `/api/chats/${c}`)).folderId).toBeUndefined()
  expect((await mia.client.call('GET', `/api/rooms/${dm.id}`)).folderId).toBeUndefined()
  expect(db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE user_id = ?').get(mia.id)).toEqual({ n: 0 })
  // my windows got the chat and the room again, without the folder
  expect(h.hub.events.some((e) => e.target === mia.id && (e.data as any).type === 'chat.updated' && (e.data as any).data.chatId === c)).toBe(true)
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
  // a person who lost access: taken out of the group chat, it leaves their folder; anything after is 404
  await mia.client.call('DELETE', `/api/rooms/${group.id}/members/${otto.id}`)
  const ottoF = (await make(otto.client, 'rooms', 'otto')).body.id
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
