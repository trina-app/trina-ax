import { CSRF_HEADER } from '@mycel/shared/api'
import type { Spec } from './cases'
import { leaks } from './matrix'
import { C, PNG, USER_OF, type World } from './world'
import { atLeast } from '../../../server/src/policy/access'
import { findRoomFile, readRoom } from '../../../server/src/rooms/reader'

// Team chat rooms (docs/DECISIONS.md "대화방 v1"). The world has a DM of alice (memberIn) and erin (other) with a
// message and an image only they may see (C.dmMsg, C.dmFileName): every room route aimed at it is 'room-dm', so the
// owner and the admin are refused like everyone else outside it (admins cannot read rooms they are not in). Editing and
// deleting are alice's own message only ('own-alice': erin, a member, is refused too). A body naming an author is
// refused for everyone (the schema is strict), checked on the allowed send. Threads and reactions are 'room-dm' too.
const cm = () => 'cm-' + crypto.randomUUID()
/** A retired endpoint (docs/decisions/20261120-project-is-room.md): 410 gone for a signed-in caller, naming nothing. */
const goneCheck = (r: { status: number; text: string; json: any }, w: World, who: string) => {
  if (who === 'anon' || who === 'pwchange') return
  if (r.status !== 410 || r.json?.error?.code !== 'gone') throw new Error(`${who}: a retired endpoint answered ${r.status} ${r.text.slice(0, 200)}`)
  for (const x of ['Team plan', C.groupName, w.ids.projTeam, w.ids.groupRoom, w.ids.dmRoom]) if (x && r.text.includes(x)) throw new Error(`${who}: a retired endpoint names something: ${r.text.slice(0, 200)}`)
}
/**
 * Once, with the project room alice opened (docs/decisions/20261120-project-is-room.md D3, D4):
 *   - the project's shared AI chat's room tools are scoped to its room: alice's DM with erin, by id, is a room that is
 *     not there for them (rooms/reader.ts `only`), its message and file never given;
 *   - a file alice sent there lands in the project folder; after she deletes the message, the room file endpoint answers
 *     404 for that file to everyone, and the team file is governed by its folder rules only (each caller's read access
 *     on its path decides whether they can open it in Files).
 */
let projectRoomChecked = false
async function projectRoomCases(w: World, roomId: string) {
  if (projectRoomChecked) return
  projectRoomChecked = true
  const db = w.inst.ctx.db
  const read = readRoom(db, 'alice', 'UTC', { room: w.ids.dmRoom, only: roomId })
  if (!read.text.includes('No room matching') || read.text.includes(C.dmMsg)) throw new Error(`the project room's read reached another room: ${read.text.slice(0, 200)}`)
  const file = findRoomFile(db, 'alice', w.ids.dmRoom, w.ids.dmFile, 'UTC', { only: roomId })
  if (!('text' in file) || file.text.includes(C.dmFileName)) throw new Error('the project room\'s file read reached another room')
  const f = new FormData()
  f.set('file', new File([new TextEncoder().encode('project room security file')], 'sec-plan.txt', { type: 'text/plain' }))
  const up = await w.as.memberIn.ok('POST', `/api/rooms/${roomId}/files`, undefined, { form: f })
  const teamPath = up?.teamPath as string | undefined
  if (!up?.teamFile || !teamPath) throw new Error(`a project room upload is not a project file: ${JSON.stringify(up).slice(0, 200)}`)
  const m = await w.as.memberIn.ok('POST', `/api/rooms/${roomId}/messages`, { body: 'with a file', clientMessageId: cm(), fileIds: [up.id] })
  await w.as.memberIn.ok('DELETE', `/api/rooms/${roomId}/messages/${m.id}`)
  const rules = w.inst.ctx.files.rules()
  for (const who of ['memberIn', 'other', 'owner', 'admin', 'memberOut'] as const) {
    const c = w.as[who]
    const rf = await c.get(`/api/rooms/${roomId}/files/${up.id}?download=1`)
    if (rf.status !== 404 || rf.text.includes('project room security file')) throw new Error(`${who}: a deleted message's room file answered ${rf.status}`)
    const me = await c.get('/api/me')
    const id = me.json?.user?.id as string | undefined
    if (!id) continue
    const p = w.inst.ctx.files.principal(id)
    const may = atLeast(rules.access(p, teamPath.split('/')), 'read')
    const tf = await c.get(`/api/files/content?path=${encodeURIComponent(teamPath)}`)
    if (may !== (tf.status === 200)) throw new Error(`${who}: the team file after the message delete answered ${tf.status}, folder rules say ${may ? 'read' : 'none'}`)
    if (!may && tf.text.includes('project room security file')) throw new Error(`${who}: the team file leaked`)
  }
}
/**
 * Once, for "Make it a project" (rooms/make-project.ts), nothing made: alice's DM with erin, her team room, the everyone
 * room and a project's chat room are refused with 409 not_convertible (the read and the conversion alike); a group chat
 * that was archived (its people left) is a room she is not in (404). No project is made by any of it.
 */
let makeProjectChecked = false
async function makeProjectCases(w: World) {
  if (makeProjectChecked) return
  makeProjectChecked = true
  const db = w.inst.ctx.db
  const alice = w.as.memberIn
  const before = (db.query('SELECT COUNT(*) n FROM projects').get() as { n: number }).n
  const team = (db.query("SELECT r.id FROM rooms r JOIN room_members m ON m.room_id = r.id JOIN users u ON u.id = m.user_id WHERE r.kind = 'team' AND r.archived_at IS NULL AND u.username = 'alice' LIMIT 1").get() as { id: string } | null)?.id
  if (!team) throw new Error('alice has no team room')
  const projRoom = (await alice.ok('POST', `/api/projects/${w.ids.projTeam}/room`)).id as string
  for (const [what, id] of [['the DM', w.ids.dmRoom], ['a team room', team], ['the everyone room', w.ids.allRoom], ['a project room', projRoom]] as const) {
    const info = await alice.get(`/api/rooms/${id}/make-project`)
    const make = await alice.post(`/api/rooms/${id}/make-project`, { name: 'Never made', membersHash: 'x' })
    for (const r of [info, make]) if (r.status !== 409 || r.json?.error?.params?.reason !== 'not_convertible') throw new Error(`${what}: make-project answered ${r.status} ${r.text.slice(0, 200)}`)
  }
  const gone = (await alice.ok('POST', '/api/rooms', { kind: 'group', userIds: ['erin'], name: 'Archived talk' })).id as string
  await alice.ok('POST', `/api/rooms/${gone}/leave`)
  await w.as.other.ok('POST', `/api/rooms/${gone}/leave`)
  const archived = await alice.post(`/api/rooms/${gone}/make-project`, { name: 'Never made', membersHash: 'x' })
  if (archived.status !== 404) throw new Error(`an archived room: make-project answered ${archived.status}`)
  if ((db.query('SELECT COUNT(*) n FROM projects').get() as { n: number }).n !== before) throw new Error('a refused make-project made a project')
}
/**
 * Once, for a room's Files list and ⌘K's recent files (rooms/search.ts listRoomFiles, recentRoomFiles; D8), each on
 * rooms of its own so the world stays as it was:
 *   - a former member: bob in a group chat with alice and erin sees its file in both, and after leaving gets the list's
 *     404 (as for a room he was never in) and no longer finds it in recent;
 *   - a member when the folder is narrowed: a file alice sent in Team plan's chat room (a project file, a ref row) is in
 *     erin's recent while she reads it, and gone (never "unavailable", never its name) once its folder is narrowed to
 *     alice; the project room has no list of its own (404) for either. The narrowing is taken off again;
 *   - a guest of a group chat: their room's list and recent, never alice's DM with erin (404, nothing named).
 */
let roomFilesChecked = false
async function roomFilesCases(w: World) {
  if (roomFilesChecked) return
  roomFilesChecked = true
  const db = w.inst.ctx.db
  const alice = w.as.memberIn, erin = w.as.other, bob = w.as.memberOut
  const sendFile = async (roomId: string, name: string) => {
    const f = new FormData()
    f.set('file', new File([new TextEncoder().encode(`room files list ${name}`)], name, { type: 'text/plain' }))
    const up = await alice.ok('POST', `/api/rooms/${roomId}/files`, undefined, { form: f })
    await alice.ok('POST', `/api/rooms/${roomId}/messages`, { body: '', clientMessageId: cm(), fileIds: [up.id] })
    return up as { id: string; teamPath?: string }
  }
  const has = async (c: typeof alice, p: string, name: string) => { const r = await c.get(p); return { status: r.status, text: r.text, found: r.text.includes(name) } }
  // a former member
  const left = (await alice.ok('POST', '/api/rooms', { kind: 'group', userIds: ['erin', 'bob'] })).id as string
  const leftName = 'SEC-FILES-LEFT-4c1.txt'
  await sendFile(left, leftName)
  if (!(await has(bob, `/api/rooms/${left}/files`, leftName)).found || !(await has(bob, '/api/room-files/recent', leftName)).found) throw new Error('bob, a member, does not see the group chat\'s file')
  await bob.ok('POST', `/api/rooms/${left}/leave`)
  const gone = await has(bob, `/api/rooms/${left}/files`, leftName)
  if (gone.status !== 404 || gone.found) throw new Error(`a former member's list answered ${gone.status} ${gone.text.slice(0, 200)}`)
  if ((await has(bob, '/api/room-files/recent', leftName)).found) throw new Error('a former member still finds the file in recent')
  // a member when the folder is narrowed (a project room's ref row)
  const room = (await alice.ok('POST', `/api/projects/${w.ids.projTeam}/room`)).id as string
  const refName = 'SEC-FILES-REF-7e3.txt'
  const up = await sendFile(room, refName)
  if (!up.teamPath) throw new Error('the project room file is not a project file')
  if (!(await has(erin, '/api/room-files/recent', refName)).found) throw new Error('erin, a reader, does not find the project room file in recent')
  for (const c of [alice, erin]) {
    const r = await c.get(`/api/rooms/${room}/files`)
    if (r.status !== 404 || r.text.includes(refName)) throw new Error(`a project room's list answered ${r.status} ${r.text.slice(0, 200)}`)
  }
  const fid = 'f_' + crypto.randomUUID()
  const folder = up.teamPath.split('/').slice(0, -1).join('/')
  db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run(fid, folder)
  db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'alice', 'write')").run(crypto.randomUUID(), fid)
  try {
    const narrowed = await erin.get('/api/room-files/recent')
    if (narrowed.status !== 200 || narrowed.text.includes(refName) || narrowed.text.includes('"unavailable"') || narrowed.text.includes(folder)) throw new Error(`erin's recent after the narrowing: ${narrowed.text.slice(0, 300)}`)
    if (!(await has(alice, '/api/room-files/recent', refName)).found) throw new Error('alice lost her own readable project file from recent')
  } finally {
    db.query('DELETE FROM folder_rules WHERE folder_id = ?').run(fid)
    db.query('DELETE FROM folders WHERE id = ?').run(fid)
  }
  // a guest of a group chat
  const chat = (await alice.ok('POST', '/api/rooms', { kind: 'group', userIds: ['erin', 'bob'], name: 'SEC-FILES-GUEST-ROOM' })).id as string
  const inv = await alice.ok('POST', '/api/guest-invites', { place: { kind: 'room', id: chat } })
  const guest = w.inst.client('room-files-guest')
  await guest.ok('POST', `/api/invites/${String(inv.url).split('/invite/')[1]}/accept`, { username: 'secfilesguest', name: 'Files Guest', password: 'guest river lamp 77' })
  const guestName = 'SEC-FILES-GUEST-9a0.txt'
  await sendFile(chat, guestName)
  if (!(await has(guest, `/api/rooms/${chat}/files`, guestName)).found) throw new Error('the guest does not see their room\'s file')
  const dm = await guest.get(`/api/rooms/${w.ids.dmRoom}/files`)
  if (dm.status !== 404 || leaks('pwchange', dm.text).length || dm.text.includes(C.dmFileName)) throw new Error(`a guest's list of the DM answered ${dm.status} ${dm.text.slice(0, 200)}`)
  const rec = await guest.get('/api/room-files/recent')
  if (rec.status !== 200 || !rec.text.includes(guestName)) throw new Error(`a guest's recent: ${rec.status} ${rec.text.slice(0, 200)}`)
  for (const x of [C.dmFileName, leftName, refName]) if (rec.text.includes(x)) throw new Error(`a guest's recent names ${x}`)
  if ((rec.json?.rooms as { id: string }[]).some((r) => r.id !== chat)) throw new Error('a guest\'s recent names another room')
}
/**
 * Once, for a department's team room (docs/AGENTS/plan/20261121-0619-structure-polish.md B; rooms/team-place.ts): the
 * marketing room (alice and erin):
 *   - an upload while the group folder has a reader outside the room (bob, by a person rule) stays in room storage: no
 *     team file, no room_file_refs row, "Only in this conversation";
 *   - an upload without one goes to the folder's Chat attachments; the room's file endpoint gives it to alice and erin
 *     only: the admin and the owner outside the room (who read the folder in Files, as accepted) and bob get 404, for
 *     the file and for the room's Files list;
 *   - Room.project.sameAsGroup (Team plan's people are marketing's) is in nobody's room list, GET /api/rooms/:id or
 *     room.updated unless they are in marketing's room.
 * The messages are deleted again (the folder file stays, as a deleted message's folder file does).
 */
let teamRoomFolderChecked = false
async function teamRoomFolderCases(w: World) {
  if (teamRoomFolderChecked) return
  teamRoomFolderChecked = true
  const db = w.inst.ctx.db
  const alice = w.as.memberIn
  const teamRoom = (db.query("SELECT id FROM rooms WHERE kind = 'team' AND group_id = ? AND archived_at IS NULL").get(w.groups.marketing) as { id: string }).id
  const upload = async (name: string) => {
    const f = new FormData()
    f.set('file', new File([new TextEncoder().encode(`team room ${name}`)], name, { type: 'text/plain' }))
    return await alice.ok('POST', `/api/rooms/${teamRoom}/files`, undefined, { form: f }) as { id: string; teamFile?: true; teamPath?: string; roomOnly?: true }
  }
  const folderId = (db.query('SELECT f.id FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(w.groups.marketing) as { id: string }).id
  const ruleId = crypto.randomUUID()
  db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'bob', 'read')").run(ruleId, folderId)
  let stays: Awaited<ReturnType<typeof upload>>
  try { stays = await upload('SEC-TEAMROOM-WIDE-1b7.txt') } finally { db.query('DELETE FROM folder_rules WHERE id = ?').run(ruleId) }
  if (stays.teamFile || stays.teamPath || stays.roomOnly !== true || db.query('SELECT 1 FROM room_file_refs WHERE room_file_id = ?').get(stays.id)) throw new Error(`a team room upload with an outside reader left room storage: ${JSON.stringify(stays)}`)
  const placed = await upload('SEC-TEAMROOM-FOLDER-5d2.txt')
  if (!placed.teamFile || !placed.teamPath?.startsWith(`${w.groups.mktFolder}/`)) throw new Error(`a team room upload did not go to the group folder: ${JSON.stringify(placed)}`)
  const m = await alice.ok('POST', `/api/rooms/${teamRoom}/messages`, { body: 'team room files', clientMessageId: cm(), fileIds: [stays.id, placed.id] })
  try {
    for (const who of ['memberIn', 'other', 'owner', 'admin', 'memberOut'] as const) {
      const r = await w.as[who].get(`/api/rooms/${teamRoom}/files/${placed.id}?download=1`)
      const inRoom = who === 'memberIn' || who === 'other'
      if (inRoom !== (r.status === 200)) throw new Error(`${who}: a team room's folder file answered ${r.status}`)
      if (!inRoom && r.text.includes('team room SEC-TEAMROOM')) throw new Error(`${who}: a team room's file leaked`)
    }
    // the team room's Files list: 404 for everyone outside the room (it lists the file kept in room storage)
    for (const who of ['owner', 'admin', 'memberOut'] as const) {
      const r = await w.as[who].get(`/api/rooms/${teamRoom}/files`)
      if (r.status !== 404 || r.text.includes('SEC-TEAMROOM')) throw new Error(`${who}: a team room's Files list answered ${r.status} to someone outside it`)
    }
    // sameAsGroup: only ever to someone in that team room, in the room list, the room itself and room.updated
    const marks = Object.fromEntries(Object.entries(w.sockets).map(([k, s]) => [k, s.frames.length]))
    const projectRoom = (await alice.ok('POST', `/api/projects/${w.ids.projTeam}/room`)) as { id: string }
    const inTeamRoom = (username: string) => {
      const id = (db.query('SELECT id FROM users WHERE username = ?').get(username) as { id: string } | null)?.id ?? ''
      return (roomId: string) => !!db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, id)
    }
    for (const who of ['memberIn', 'other', 'owner', 'admin', 'memberOut', 'pwchange'] as const) {
      const r = await w.as[who].get(`/api/rooms/${projectRoom.id}`)
      const same = (r.json?.project as { sameAsGroup?: { roomId: string } } | undefined)?.sameAsGroup
      if (same && !inTeamRoom(USER_OF[who]!)(same.roomId)) throw new Error(`${who}: GET /api/rooms/:id names a team room they are not in`)
      if (r.status === 200 && who !== 'memberIn' && who !== 'other') throw new Error(`${who}: opened a project room they are not in (${r.status})`)
    }
    // every room.updated sent since the project room was made (its members' copies of it, the sync's fan-out): none
    // names a team room to someone outside it (the sockets are alice, bob, carol, dana and erin)
    await new Promise((r) => setTimeout(r, 300))
    for (const [name, sock] of Object.entries(w.sockets)) {
      for (const f of sock.frames.slice(marks[name])) {
        const same = (f as { type: string; data?: { room?: { project?: { sameAsGroup?: { roomId: string } } } } }).data?.room?.project?.sameAsGroup
        if (f.type === 'room.updated' && same && !inTeamRoom(name)(same.roomId)) throw new Error(`${name}: room.updated names a team room they are not in`)
      }
    }
    for (const who of ['memberIn', 'other', 'owner', 'admin', 'memberOut', 'pwchange'] as const) {
      const r = await w.as[who].get('/api/rooms')
      if (r.status !== 200) continue
      const id = (w.inst.ctx.db.query('SELECT id FROM users WHERE username = ?').get(USER_OF[who]!) as { id: string } | null)?.id ?? ''
      for (const room of (r.json?.items ?? []) as { project?: { sameAsGroup?: { roomId: string } } }[]) {
        const same = room.project?.sameAsGroup
        if (same && !db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(same.roomId, id)) throw new Error(`${who}: sameAsGroup names a team room they are not in`)
      }
      if (who === 'memberIn' && !((r.json?.items ?? []) as { project?: { sameAsGroup?: { roomId: string } } }[]).some((x) => x.project?.sameAsGroup?.roomId === teamRoom)) throw new Error('alice: Team plan\'s room does not say it has marketing\'s people')
    }
  } finally {
    await alice.ok('DELETE', `/api/rooms/${teamRoom}/messages/${m.id}`)
  }
}
const form = () => { const f = new FormData(); f.set('file', new File([PNG], 'room.png', { type: 'image/png' })); return f }
export const ROOM_SPECS: Record<string, Spec> = {
  listRooms: { build: (c) => c.get('/api/rooms'), scope: 'self' },
  // "이 방에서는 항상 허용" (rooms/ai-grants.ts): each person lists their own; an id that is not theirs answers like one that
  // is not there (another person's grant)
  listAiAllowances: { build: (c) => c.get('/api/ai-allowances'), scope: 'self' },
  deleteAiAllowance: { build: (c) => c.del('/api/ai-allowances/019a0000-0000-7000-8000-00000000a11f'), scope: 'nobody' },
  // everyone opens their DM with frank (an active member); the DM itself is checked by the cases below
  createRoom: {
    build: (c) => c.post('/api/rooms', { kind: 'dm', userId: 'frank' }), scope: 'self',
    // a group chat needs two other active people of this team; a body that names more is refused
    check: async (r, w, who) => {
      if (r.status !== 201) return
      const one = await w.as[who].req('POST', '/api/rooms', { kind: 'group', userIds: ['frank'] })
      if (one.status !== 400) throw new Error(`a group chat with one other person was made: ${one.status}`)
      const spoof = await w.as[who].req('POST', '/api/rooms', { kind: 'group', userIds: ['frank', 'bob'], createdBy: 'dana' })
      if (spoof.status !== 400) throw new Error(`a body naming the maker was not refused: ${spoof.status}`)
    },
  },
  getRoom: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}`), scope: 'room-dm' },
  updateRoom: {
    build: (c, w) => c.patch(`/api/rooms/${w.ids.dmRoom}`, { muted: false }), scope: 'room-dm',
    // renaming: never a DM (403 for its members); a group chat's members may (its name stays the same here)
    check: async (r, w, who) => {
      if (r.status !== 200) return
      const dm = await w.as[who].req('PATCH', `/api/rooms/${w.ids.dmRoom}`, { name: 'renamed' })
      if (dm.status !== 403) throw new Error(`a DM was renamed: ${dm.status}`)
      const g = await w.as[who].req('PATCH', `/api/rooms/${w.ids.groupRoom}`, { name: C.groupName })
      if (g.status !== 200) throw new Error(`a group chat member could not rename it: ${g.status}`)
      // a group room with a name is a private channel and keeps one: '' or null is refused (TC-4554)
      for (const name of ['', null]) {
        const e = await w.as[who].req('PATCH', `/api/rooms/${w.ids.groupRoom}`, { name })
        if (e.status !== 400) throw new Error(`a private channel's name was emptied: ${e.status}`)
      }
      // my own notification level for the room (docs/DECISIONS.md "대화방 알림 설정"): a member sets it, back to the default
      for (const notifyLevel of ['mentions', null]) {
        const n = await w.as[who].req('PATCH', `/api/rooms/${w.ids.dmRoom}`, { notifyLevel })
        if (n.status !== 200) throw new Error(`a member could not set their level: ${n.status}`)
      }
      const both = await w.as[who].req('PATCH', `/api/rooms/${w.ids.dmRoom}`, { notifyLevel: 'off', muted: true })
      if (both.status !== 400) throw new Error(`muted with notifyLevel was taken: ${both.status}`)
    },
  },
  listRoomMessages: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/messages`), scope: 'room-dm' },
  sendRoomMessage: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/messages`, { body: 'hello', clientMessageId: cm() }), scope: 'room-dm',
    check: async (r, w, who) => {
      if (r.status !== 201) return
      if (r.json.author?.id !== (who === 'memberIn' ? 'alice' : 'erin')) throw new Error(`the message's author is not the caller: ${JSON.stringify(r.json.author)}`)
      const spoof = await w.as[who].req('POST', `/api/rooms/${w.ids.dmRoom}/messages`, { body: 'spoof', authorId: 'dana', clientMessageId: cm() })
      if (spoof.status !== 400) throw new Error(`a body naming an author was not refused: ${spoof.status}`)
    },
  },
  // threads and reactions (docs/DECISIONS.md "스레드와 반응"): the DM's message as a thread's root. Reading the thread
  // and my place in it, and a reaction, are the DM's two people's only; a body naming another person is refused
  listRoomThread: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/thread`), scope: 'room-dm' },
  markRoomThreadRead: { build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/thread/read`, { seq: 1 }), scope: 'room-dm' },
  // "Ask to view" on a team-file link in a message (rooms/file-ask.ts, QA S-120), aimed at the DM's message (no link in
  // it) and a finance file: the DM's two people get the one generic 'no', everyone else the room's 404; the ask is
  // nobody's (404 for all), and never leaves a request row
  roomFileAccess: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/file-access?path=${encodeURIComponent('groups/finance/budget.md')}`), scope: 'room-dm',
    check: (r, _w, who) => {
      if (r.status === 200 && r.json?.status !== 'no') throw new Error(`${who}: file-access answered ${r.json?.status} for a path the message does not link`)
    } },
  requestRoomFile: { build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/file-access`, { path: 'groups/finance/budget.md' }), scope: 'nobody',
    check: (_r, w, who) => {
      const n = w.inst.ctx.db.query("SELECT COUNT(*) n FROM file_access_requests r JOIN file_shares s ON s.id = r.share_id WHERE s.path = 'groups/finance/budget.md'").get() as { n: number }
      if (n.n) throw new Error(`${who}: an ask on a path the message does not link left a request`)
    } },
  reactRoomMessage: {
    build: (c, w) => c.req('PUT', `/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/reactions`, { emoji: '👍', on: true }), scope: 'room-dm',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      if (!r.json.reactions?.some((x: { emoji: string; mine: boolean }) => x.emoji === '👍' && x.mine)) throw new Error(`the reaction is not the caller's: ${JSON.stringify(r.json)}`)
      const spoof = await w.as[who].req('PUT', `/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/reactions`, { emoji: '👍', on: true, userId: 'dana' })
      if (spoof.status !== 400) throw new Error(`a body naming a person was not refused: ${spoof.status}`)
      // any one emoji, never text or markup
      const odd = await w.as[who].req('PUT', `/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/reactions`, { emoji: '<b>👍</b>', on: true })
      if (odd.status !== 400) throw new Error(`a reaction that is not one emoji was taken: ${odd.status}`)
    },
  },
  editRoomMessage: { build: (c, w) => c.patch(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}`, { body: `${C.dmMsg} (edited)` }), scope: 'own-alice' },
  deleteRoomMessage: { build: (c, w) => c.del(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsgDel}`), scope: 'own-alice' },
  markRoomRead: { build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/read`, { seq: 1 }), scope: 'room-dm' },
  // message links (docs/DECISIONS.md "Message links and their previews", rooms/link-previews.ts). The composer's question
  // in the everyone room (everyone is in it) about a link to the DM's message: alice and erin (who see it) are told
  // that someone there cannot; everyone else gets the answer of a message that is not there, byte for byte. Their own
  // "Show message" of it stores nothing, and a link to it in the everyone room shows them nothing of it
  roomMessageLinkAudience: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.allRoom}/message-links/audience`, { links: [{ roomId: w.ids.dmRoom, messageId: w.ids.dmMsg }] }), scope: 'self',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      const inDm = who === 'memberIn' || who === 'other'
      const items = r.json.items as { messageId: string }[]
      if (inDm !== (items.length === 1 && items[0]!.messageId === w.ids.dmMsg)) throw new Error(`${who}: the audience answered ${r.text.slice(0, 300)}`)
      if (inDm) return
      const none = await w.as[who].req('POST', `/api/rooms/${w.ids.allRoom}/message-links/audience`, { links: [{ roomId: w.ids.dmRoom, messageId: '019a0000-0000-7000-8000-0000000fffff' }] })
      if (none.text !== r.text || none.status !== r.status) throw new Error(`${who}: a DM message they cannot see answered unlike one that is not there: ${r.text} / ${none.text}`)
      const sent = await w.as[who].req('POST', `/api/rooms/${w.ids.allRoom}/messages`, { body: `see https://acme.example/rooms/${w.ids.dmRoom}?m=${w.ids.dmMsg}`, showMessages: [w.ids.dmMsg], clientMessageId: cm() })
      if (sent.status !== 201 || sent.json.linkPreviews !== undefined || leaks(who, sent.text).length) throw new Error(`${who}: a send with Show message of a DM message answered ${sent.status} ${sent.text.slice(0, 300)}`)
      const list = await w.as[who].req('GET', `/api/rooms/${w.ids.allRoom}/messages`)
      if (leaks(who, list.text).length) throw new Error(`${who}: the everyone room shows the DM: ${leaks(who, list.text).join(', ')}`)
    },
  },
  // "Remove preview": a message of my own with that link only; the DM's message has none (alice too gets 404)
  hideRoomLinkPreview: { build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/hide-preview`, { linkedMessageId: w.ids.dmMsgDel }), scope: 'nobody' },
  listRoomMembers: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/members`), scope: 'room-dm' },
  // group chats (docs/DECISIONS.md "그룹 대화와 방 이름"): alice and erin are in it (frank too, held back by his
  // password change); the owner and the admin are not, so they get 404 like everyone outside it. Inviting someone who
  // is in it already changes nothing (the world stays as it is); a disabled or unknown id is refused alike.
  // a guest invite into that group chat (docs/DECISIONS.md "Guests: only what they were invited to"): only the people
  // in it; the owner and the admin, not in it, are refused (403)
  createGuestInvite: { build: (c, w) => c.post('/api/guest-invites', { place: { kind: 'room', id: w.ids.groupRoom } }), scope: 'room-group' },
  // whether one more guest fits the plan (read before the invite dialog's form): anyone signed in who may invite; the
  // seats and the plan page only for the owner and admins
  guestInviteLimit: {
    build: (c) => c.get('/api/guest-invites/limit'), scope: 'byLevel',
    check: (r, _w, who) => {
      if (r.status !== 200) return
      const staff = who === 'owner' || who === 'admin'
      if (!staff && ('seatsFull' in r.json || 'manageUrl' in r.json)) throw new Error(`${who} was told the seats or the plan page`)
      if (staff && typeof r.json.seatsFull !== 'boolean') throw new Error(`${who} was not told the seats`)
    },
  },
  inviteRoomMembers: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.groupRoom}/members`, { userIds: ['frank'] }), scope: 'room-group',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      if (r.json.memberCount !== 3) throw new Error(`inviting someone already in it changed the room: ${r.json.memberCount}`)
      const unknown = await w.as[who].req('POST', `/api/rooms/${w.ids.groupRoom}/members`, { userIds: ['nobody-here'] })
      if (unknown.status !== 400) throw new Error(`an unknown person was not refused: ${unknown.status}`)
      // a DM keeps its two people: inviting there is refused for its members
      const dm = await w.as[who].req('POST', `/api/rooms/${w.ids.dmRoom}/members`, { userIds: ['frank'] })
      if (dm.status !== 403) throw new Error(`inviting into a DM was not refused: ${dm.status}`)
    },
  },
  // the manager (alice, who made it) may take someone out, never herself; erin, a plain member, is refused. The target is
  // alice herself, so nobody is ever taken out of the shared world: alice gets 400 (that is leaving), erin 403, everyone
  // outside 404.
  removeRoomMember: {
    build: (c, w) => c.del(`/api/rooms/${w.ids.groupRoom}/members/alice`), scope: 'own-alice',
    check: async (r, w, who) => {
      if (who === 'memberIn' && r.status !== 400) throw new Error(`the manager took herself out: ${r.status}`)
      if (who === 'other') {
        if (r.status !== 403) throw new Error(`a plain member took out the manager: ${r.status}`)
      }
    },
  },
  // leaving: alice and erin each leave a group chat of their own (frank stays, so it is never archived under the others)
  leaveRoom: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.groupLeaveRoom}/leave`), scope: 'room-group',
    check: async (r, w, who) => {
      if (r.status !== 204) return
      const again = await w.as[who].req('GET', `/api/rooms/${w.ids.groupLeaveRoom}`)
      if (again.status !== 404) throw new Error(`the room is still there after leaving: ${again.status}`)
      // a DM is not left like that
      const dm = await w.as[who].req('POST', `/api/rooms/${w.ids.dmRoom}/leave`)
      if (dm.status !== 403) throw new Error(`leaving a DM was not refused: ${dm.status}`)
    },
  },
  // hiding a conversation from my own lists (docs/DECISIONS.md "대화 숨기기"): the DM's two people, each for themselves.
  // The check shows it again first (the world stays as it was), then: the other person's view is untouched, a group
  // chat is left rather than hidden (403 for its members), a body naming anyone or nothing is refused (strict)
  setRoomHidden: {
    build: (c, w) => c.put(`/api/rooms/${w.ids.dmRoom}/hidden`, { hidden: true }), scope: 'room-dm',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      const me = w.as[who]
      const back = await me.put(`/api/rooms/${w.ids.dmRoom}/hidden`, { hidden: false })
      if (r.json?.id !== w.ids.dmRoom || r.json?.hidden !== true) throw new Error(`the DM was not hidden for the caller: ${r.text.slice(0, 200)}`)
      if (back.status !== 200 || back.json?.hidden !== undefined) throw new Error(`the DM was not shown again: ${back.status} ${back.text.slice(0, 200)}`)
      const peer = await w.as[who === 'memberIn' ? 'other' : 'memberIn'].get(`/api/rooms/${w.ids.dmRoom}`)
      if (peer.status !== 200 || peer.json?.hidden !== undefined) throw new Error(`hiding changed the other person's view: ${peer.status} ${peer.text.slice(0, 200)}`)
      const group = await me.put(`/api/rooms/${w.ids.groupRoom}/hidden`, { hidden: true })
      if (group.status !== 403) throw new Error(`a group chat was hidden: ${group.status}`)
      for (const body of [{ hidden: true, userId: 'dana' }, {}]) {
        const bad = await me.put(`/api/rooms/${w.ids.dmRoom}/hidden`, body)
        if (bad.status !== 400) throw new Error(`a body ${JSON.stringify(body)} was not refused: ${bad.status}`)
      }
      const still = await me.get(`/api/rooms/${w.ids.dmRoom}`)
      if (still.json?.hidden !== undefined) throw new Error('the DM is left hidden for the caller')
    },
  },
  // pinning a conversation to the top of my own list (docs/DECISIONS.md "Pinned conversations"): the DM's two people,
  // each for themselves. The check takes the pin off again (the world stays as it was), and the other person's view is
  // untouched
  pinRoom: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/pin`), scope: 'room-dm',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      const me = w.as[who]
      if (r.json?.id !== w.ids.dmRoom || typeof r.json?.pinnedAt !== 'string') throw new Error(`the DM was not pinned for the caller: ${r.text.slice(0, 200)}`)
      const peer = await w.as[who === 'memberIn' ? 'other' : 'memberIn'].get(`/api/rooms/${w.ids.dmRoom}`)
      if (peer.status !== 200 || peer.json?.pinnedAt !== undefined) throw new Error(`pinning changed the other person's view: ${peer.status} ${peer.text.slice(0, 200)}`)
      const back = await me.req('DELETE', `/api/rooms/${w.ids.dmRoom}/pin`)
      if (back.status !== 200 || back.json?.pinnedAt !== undefined) throw new Error(`the DM was not unpinned: ${back.status} ${back.text.slice(0, 200)}`)
    },
  },
  unpinRoom: { build: (c, w) => c.del(`/api/rooms/${w.ids.dmRoom}/pin`), scope: 'room-dm' },
  uploadRoomFile: { build: (c, w) => c.req('POST', `/api/rooms/${w.ids.dmRoom}/files`, undefined, { form: form(), headers: { [CSRF_HEADER]: '1' } }), scope: 'room-dm' },
  // a team file copied into the DM ("팀 파일", a phone's attach sheet): the DM's two people, and each only with a file
  // they may read now. shared/readme.md: both, and nobody is told they cannot open it; a file NAME in users/alice/:
  // alice (erin cannot open it: unable 1), erin gets the plain 404 like a missing file
  attachRoomTeamFile: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/team-file`, { path: 'shared/readme.md' }), scope: 'room-dm',
    check: async (r, w, who) => {
      if (who !== 'memberIn' && who !== 'other') return
      // both files stay put through the matrix, so the DM's two people must get the copy (an allowed write's 404 is let
      // through by the matrix itself)
      if (r.status !== 201 || r.json?.unable !== 0) throw new Error(`${who}: shared/readme.md into the DM answered ${r.status} ${r.text.slice(0, 200)}`)
      const to = (p: string) => w.as[who].post(`/api/rooms/${w.ids.dmRoom}/team-file`, { path: p })
      const own = await to(`users/alice/${C.aliceFileName}.md`)
      if (who === 'memberIn') {
        if (own.status !== 201 || own.json?.unable !== 1) throw new Error(`alice: her file into the DM answered ${own.status} ${own.text.slice(0, 200)}`)
        return
      }
      const none = await to('users/alice/no-such-file.md')
      const same = own.status === 404 && none.status === 404 && own.json?.error?.code === none.json?.error?.code && own.json?.error?.message === none.json?.error?.message
      if (!same || leaks(who, own.text).length) throw new Error(`erin: alice's file into the DM answered ${own.status} ${own.text.slice(0, 200)} (a missing one: ${none.status} ${none.text.slice(0, 200)})`)
    },
  },
  // the AI in rooms: the DM's count and my own runs (both people), alice's preview and her question's turn (alice only;
  // erin, in the DM, is refused like everyone else), the sources of a message (both)
  roomFile: {
    build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/files/${w.ids.dmFile}?download=1`), scope: 'room-dm',
    check: (r) => { if (r.status === 200 && !r.headers.get('content-disposition')?.includes(C.dmFileName)) throw new Error('the member did not get the room file') },
  },
  // "Save to team folder" (rooms/save-to-team.ts): the DM's two people only, the owner and the admin outside it get 404
  // like a room they are not in. The copy goes to shared/ (both may write it): the first caller copies, the second finds
  // the same bytes there; either way the team file holds the DM picture's bytes and the saved list names it
  // a room's Files list (D8): the DM's two people, with its file; everyone else, the owner and the admin included, the
  // room's 404. Then, once, a former member, a narrowed project folder and a guest (roomFilesCases)
  listRoomFiles: {
    build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/files`), scope: 'room-dm',
    check: async (r, w, who) => {
      if ((who === 'memberIn' || who === 'other') && (r.status !== 200 || !r.text.includes(C.dmFileName))) throw new Error(`${who}: the DM's list answered ${r.status} without its file`)
      if (who === 'memberIn') { await roomFilesCases(w); await teamRoomFolderCases(w) }
    },
  },
  // ⌘K's recent files: each person's own rooms; the DM's file only for its two people (the canary check for the rest)
  recentRoomFiles: {
    build: (c) => c.get('/api/room-files/recent'), scope: 'self',
    check: (r, _w, who) => { if (r.status === 200 && (who === 'memberIn' || who === 'other') && !r.json?.rooms) throw new Error(`${who}: recent without its rooms`) },
  },
  roomSavedFiles: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/saved-files`), scope: 'room-dm' },
  roomSavePlan: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/save-plan`, { fileIds: [w.ids.dmFile] }), scope: 'room-dm',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      if (r.json?.files?.[0]?.name !== `${C.dmFileName}.png`) throw new Error(`${who}: the plan did not name the DM file`)
      // a folder of another group: not found, never its audience
      const fin = await w.as[who].req('POST', `/api/rooms/${w.ids.dmRoom}/save-plan`, { fileIds: [w.ids.dmFile], folder: 'groups/finance' })
      if (fin.status !== 404) throw new Error(`${who}: another group's folder in the plan answered ${fin.status}`)
    },
  },
  saveRoomFilesToTeam: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/save-to-team`, { fileIds: [w.ids.dmFile], folder: 'shared' }), scope: 'room-dm',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      const saved = r.json?.saved?.[0]
      if (saved?.path !== `shared/${C.dmFileName}.png`) throw new Error(`${who}: saved as ${JSON.stringify(saved)}`)
      const list = await w.as[who].req('GET', `/api/rooms/${w.ids.dmRoom}/saved-files`)
      if (!list.json?.items?.some((i: { path: string }) => i.path === saved.path)) throw new Error(`${who}: the saved list does not name it`)
      // into another group's folder or skills/: refused
      for (const folder of ['groups/finance', 'skills', '.system']) {
        const no = await w.as[who].req('POST', `/api/rooms/${w.ids.dmRoom}/save-to-team`, { fileIds: [w.ids.dmFile], folder })
        if (no.status < 400) throw new Error(`${who}: saved into ${folder}: ${no.status}`)
      }
    },
  },
  // a Hangul file's pages (the HWP Preview plugin): the room file's checks first, so the DM's two people pass them and
  // are told the picture is no Hangul file (503 unsupported, never the plugin's state); everyone else, the owner and
  // the admin included, gets 404 as for the file itself
  roomFileHwpPreview: {
    build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/files/${w.ids.dmFile}/hwp-preview?page=1`), scope: 'room-dm',
    check: (r, _w, who) => {
      const status = who === 'anon' ? 401 : who === 'pwchange' ? 403 : who === 'memberIn' || who === 'other' ? 503 : 404
      if (r.status !== status) throw new Error(`${who} roomFileHwpPreview status: ${r.status}`)
      if (status === 503 && r.json?.error?.params?.reason !== 'unsupported') throw new Error(`${who}: expected unsupported, got ${r.text.slice(0, 200)}`)
    },
  },
  // a team project's own chat room (docs/decisions/20261120-project-is-room.md): Team plan's readers alice and erin get it
  // (made the first time, the same room after); the owner and the admin outside it, bob (outside it) and frank get the
  // missing project's 404, which never names it
  openProjectRoom: {
    build: (c, w) => c.post(`/api/projects/${w.ids.projTeam}/room`), scope: 'team-chat',
    check: async (r, w, who) => {
      if (r.status === 200) {
        if (r.json?.project?.room !== true || r.json?.project?.id === undefined) throw new Error(`${who}: not the project's room: ${r.text.slice(0, 200)}`)
        if (who === 'memberIn') return projectRoomCases(w, r.json.id)
        return
      }
      if (who === 'memberIn' || who === 'other') throw new Error(`${who}: openProjectRoom answered ${r.status} ${r.text.slice(0, 200)}`)
      if ((who === 'owner' || who === 'admin' || who === 'memberOut') && r.status !== 404) throw new Error(`${who}: openProjectRoom answered ${r.status}, not 404`)
      if (r.text.includes('Team plan')) throw new Error(`${who}: a refusal names the project: ${r.text.slice(0, 200)}`)
    },
  },
  // "Make it a project" (rooms/make-project.ts): what the confirm shows, for the group chat's members alice and erin
  // only; the owner, the admin and bob outside it get the room's 404, which names nothing (frank still has to change
  // his password)
  makeProjectInfo: {
    build: (c, w) => c.get(`/api/rooms/${w.ids.groupRoom}/make-project`), scope: 'room-group',
    check: (r, w, who) => {
      if (who === 'memberIn' || who === 'other') {
        if (r.status !== 200 || typeof r.json?.membersHash !== 'string' || r.json?.suggestedName !== C.groupName) throw new Error(`${who}: the confirm's read answered ${r.status} ${r.text.slice(0, 200)}`)
        return
      }
      if ((who === 'owner' || who === 'admin' || who === 'memberOut') && r.status !== 404) throw new Error(`${who}: the confirm's read answered ${r.status}, not 404`)
      if (r.text.includes(C.groupName) || r.text.includes('membersHash')) throw new Error(`${who}: a refusal names the room: ${r.text.slice(0, 200)}`)
    },
  },
  // the conversion itself, sent with a stale members hash so the world stays as it is: alice and erin pass every check
  // up to the hash (409 members_changed), everyone else gets the room's 404. Then, once, every kind that is refused
  // (makeProjectCases)
  makeProject: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.groupRoom}/make-project`, { name: 'Plan work', membersHash: 'stale-members-hash' }), scope: 'nobody',
    check: async (r, w, who) => {
      if (who === 'anon' || who === 'pwchange') return
      if (who === 'memberIn' || who === 'other') {
        if (r.status !== 409 || r.json?.error?.params?.reason !== 'members_changed') throw new Error(`${who}: a stale hash answered ${r.status} ${r.text.slice(0, 200)}`)
        if (who === 'memberIn') await makeProjectCases(w)
        return
      }
      if (r.status !== 404 || r.text.includes(C.groupName)) throw new Error(`${who}: make-project answered ${r.status} ${r.text.slice(0, 200)}`)
    },
  },
  // the 0.5.21 project link's endpoints are retired: 410 gone for everyone who passes the auth level, before any check,
  // naming nothing (not the channel, not the project, no id)
  linkRoomProject: { build: (c, w) => c.req('PUT', `/api/rooms/${w.ids.groupRoom}/project`, { projectId: w.ids.projTeam }), scope: 'nobody', check: (r, w, who) => goneCheck(r, w, who) },
  unlinkRoomProject: { build: (c, w) => c.del(`/api/rooms/${w.ids.groupRoom}/project`), scope: 'nobody', check: (r, w, who) => goneCheck(r, w, who) },
  undoRoomSave: { build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/save-undo`, { token: 'never-given-token-0000000000' }), scope: 'nobody', check: (r, w, who) => goneCheck(r, w, who) },
  createProjectChannel: { build: (c, w) => c.post(`/api/projects/${w.ids.projTeam}/channel`, { name: 'Plan talk', userIds: ['erin', 'alice'] }), scope: 'nobody', check: (r, w, who) => goneCheck(r, w, who) },
}
