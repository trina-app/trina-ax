// A project room's files are project files (rooms/files.ts createInProject, rooms/file-refs.ts;
// docs/decisions/20261120-project-is-room.md D3): a file sent from the computer lands in the project's Chat attachments
// folder ("(2)" names, an instruction file's name taken), with a room_file_refs row and no bytes in room storage; the
// room's limits stay (a guest's 100 MB, over 50 MB through an upload session); a team file picked there is a reference,
// never a copy. Deleting a message deletes only the message (never the team file: its bytes, its history, another
// message showing it); a file trashed in Files shows "File deleted" and a restore brings it back; moves and renames are
// followed; a narrowed subfolder shows "unavailable". The four delete paths: the row goes and nothing on disk does, but
// an unsent upload of one's own that nothing else shows goes to the trash (the ✕ and the abandoned sweep). "Files you
// sent" leaves them out, the search gives them only where readable, the quota counts them as team files, the team
// export names them by their team path (and still skips a room-stored row without bytes, as an older build would see
// a project room's row).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CHAT_FILES_FOLDER } from '@mycel/shared'
import { UPLOAD_CHUNK_SIZE, type RoomFile } from '@mycel/shared/api'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { HttpError } from '../../server/src/http/errors'
import { roomFilesOf, TEAM_REFS_UNSENT_MAX } from '../../server/src/rooms/files'
import { searchRooms } from '../../server/src/rooms/reader'
import { componentC } from '../../server/src/team-files/component'
import { roomsOf } from '../../server/src/rooms/service'
import { teamExportEntries } from '../../server/src/system/team-export-zip'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

const MB = 1024 * 1024
const user = (id: string) => ({ subjectType: 'user', subjectId: id })
const cm = () => 'cm-' + crypto.randomUUID()

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const launch = await mia.client.call('POST', '/api/projects', { name: 'Launch site', participants: [user(nora.id)] })
  const room = await mia.client.call('POST', `/api/projects/${launch.id}/room`)
  const root = (h.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(launch.id) as { folder_path: string }).folder_path
  // the project's chat attachments folder, named in the team's language (uploads/shared-chat.ts)
  return { owner, mia, nora, otto, launch, roomId: room.id as string, root, chat: `${root}/${CHAT_FILES_FOLDER[teamDefaultLocale(h.ctx.db)]}` }
}
const team = () => componentC(h.ctx).files
const at = (rel: string) => path.join(h.ctx.files.fx.root, ...rel.split('/'))
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
/** a file from the computer as the upload routes hand it over (rooms/files.ts create) */
async function up(userId: string, roomId: string, name: string, text = `content of ${name} ${crypto.randomUUID()}`): Promise<RoomFile> {
  const bytes = new TextEncoder().encode(text)
  const src = path.join(h.ctx.config.dataDir, `upload-${crypto.randomUUID()}`)
  fs.writeFileSync(src, bytes)
  return roomFilesOf(h.ctx).create(userId, roomId, name, src, sha(bytes))
}
const sparse = (size: number) => {
  const p = path.join(h.ctx.config.dataDir, `sparse-${crypto.randomUUID()}`)
  fs.writeFileSync(p, '')
  fs.truncateSync(p, size)
  return p
}
const send = (c: Client, roomId: string, fileIds: string[], body = '') => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), fileIds })
const filesOf = async (c: Client, roomId: string, messageId: string): Promise<RoomFile[]> => ((await c.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]).find((m) => m.id === messageId)?.files ?? []
const fileGet = async (c: Client, roomId: string, fileId: string) => { const r = await c.raw('GET', `/api/rooms/${roomId}/files/${fileId}`); return { status: r.status, body: await r.text() } }
const refRow = (id: string) => h.ctx.db.query('SELECT * FROM room_file_refs WHERE room_file_id = ?').get(id) as { path: string; path_at_attach: string } | null
const roomStore = (roomId: string) => { try { return fs.readdirSync(path.join(h.ctx.files.fx.root, '.system', 'rooms', roomId)) } catch { return [] } }

test('a file from the computer lands in Chat attachments ("(2)" names, an instruction name taken), no room copy; members see and open it, others nothing', async () => {
  const { mia, nora, otto, roomId, chat } = await setup('b-project-room-files-place')
  const a = await up(mia.id, roomId, 'brief.pdf', 'first brief')
  const b = await up(mia.id, roomId, 'brief.pdf', 'second brief')
  const c = await up(mia.id, roomId, 'CLAUDE.md', '# not an instruction file here')
  expect([a.name, b.name, c.name]).toEqual(['brief.pdf', 'brief (2).pdf', 'CLAUDE (2).md'])
  expect(a).toMatchObject({ teamFile: true, teamPath: `${chat}/brief.pdf`, thumb: false })
  expect(a.state).toBeUndefined()
  expect(fs.readFileSync(at(`${chat}/brief (2).pdf`), 'utf8')).toBe('second brief')
  expect(fs.existsSync(at(`${chat}/CLAUDE.md`))).toBe(false)
  // nothing in room storage; each row carries its reference and the upload event names the file and the room
  expect(roomStore(roomId)).toEqual([])
  for (const f of [a, b, c]) {
    expect(refRow(f.id)?.path).toBe(`${chat}/${f.name}`)
    const ev = h.ctx.db.query("SELECT detail FROM file_events WHERE path = ? AND action = 'upload'").get(`${chat}/${f.name}`) as { detail: string }
    expect(JSON.parse(ev.detail)).toMatchObject({ attachment: f.id, roomId })
  }
  const m = await send(mia.client, roomId, [a.id, b.id, c.id], 'the briefs')
  const seen = await filesOf(nora.client, roomId, m.id)
  expect(seen.map((f) => [f.name, f.teamPath, f.teamFile])).toEqual([['brief.pdf', `${chat}/brief.pdf`, true], ['brief (2).pdf', `${chat}/brief (2).pdf`, true], ['CLAUDE (2).md', `${chat}/CLAUDE (2).md`, true]])
  const got = await fileGet(nora.client, roomId, b.id)
  expect(got.status).toBe(200)
  expect(String(got.body)).toContain('second brief')
  // someone outside the project (and the room): the room's missing answer
  expect((await fileGet(otto.client, roomId, b.id)).status).toBe(404)
  // the start check counts no ref row as missing; room storage has no address for one
  expect(roomFilesOf(h.ctx).reconcile().missingFiles).toBe(0)
  expect(() => (roomFilesOf(h.ctx) as any).abs({ id: a.id, room_id: roomId })).toThrow()
  // "Files you sent" leaves project files out (they are managed in Files); the search finds them where readable
  expect((await mia.client.call('GET', '/api/room-files/mine')).items).toEqual([])
  const found = await nora.client.call('GET', `/api/room-files?q=brief`)
  expect((found.items as any[]).map((i) => i.file.name).sort()).toEqual(['brief (2).pdf', 'brief.pdf'])
})

test('limits: a guest of the project 100 MB, a member over 50 MB through an upload session into the project', async () => {
  const { mia, launch, roomId, chat } = await setup('b-project-room-files-limits')
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'project', id: launch.id } })
  // the guest may add files to the project (their person rule raised to write)
  h.ctx.db.query("UPDATE folder_rules SET access = 'write' WHERE subject_type = 'user' AND subject_id = ?").run(g.id)
  roomsOf(h.ctx).sync({ projects: 'all' })
  expect(h.ctx.db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, g.id)).toBeTruthy()
  const kept = async (userId: string, size: number, name: string) => {
    try { return (await roomFilesOf(h.ctx).create(userId, roomId, name, sparse(size), 'b'.repeat(64))).teamPath } catch (e) { return e instanceof HttpError ? `${e.code}: ${e.message}` : `threw ${String(e)}` }
  }
  expect(await kept(g.id, 100 * MB + 1, 'big.mov')).toMatch(/^payload_too_large: .*100 MB/)
  expect(fs.existsSync(at(`${chat}/big.mov`))).toBe(false)
  expect(await kept(g.id, 100 * MB, 'ok.mov')).toBe(`${chat}/ok.mov`)
  // a member: 60 MB through a session (8 MB chunks), completed into the project's Chat attachments
  const size = 60 * MB
  const zeros = new Uint8Array(size)
  const s = componentC(h.ctx).uploads.create(mia.id, { kind: 'room', roomId, name: 'site.mov' }, size, sha(zeros))
  for (let n = 0; n * UPLOAD_CHUNK_SIZE < size; n++) {
    const part = zeros.subarray(n * UPLOAD_CHUNK_SIZE, Math.min(size, (n + 1) * UPLOAD_CHUNK_SIZE))
    await componentC(h.ctx).uploads.putChunk(mia.id, s.id, n, (async function* () { yield part })())
  }
  const done = await componentC(h.ctx).uploads.complete(mia.id, s.id)
  expect(done.kind).toBe('room')
  const file = (done as { file: RoomFile }).file
  expect(file).toMatchObject({ name: 'site.mov', teamFile: true, teamPath: `${chat}/site.mov`, size })
  expect(fs.statSync(at(`${chat}/site.mov`)).size).toBe(size)
  expect(roomStore(roomId)).toEqual([])
})

test('deleting a message deletes only the message: its room rows go, the team file stays (bytes, history, another message with it)', async () => {
  const { mia, nora, roomId, chat } = await setup('b-project-room-files-delete')
  const f = await up(mia.id, roomId, 'plan.pdf', 'the plan')
  const m1 = await send(mia.client, roomId, [f.id], 'plan attached')
  // nora picks the same file from Files: a reference, never a copy
  const pick = await nora.client.call('POST', `/api/rooms/${roomId}/team-file`, { path: `${chat}/plan.pdf` })
  expect(pick.file).toMatchObject({ teamFile: true, teamPath: `${chat}/plan.pdf` })
  expect(roomStore(roomId)).toEqual([])
  const m2 = await send(nora.client, roomId, [pick.file.id], 'same plan')
  const events = (h.ctx.db.query('SELECT COUNT(*) n FROM file_events WHERE path = ?').get(`${chat}/plan.pdf`) as { n: number }).n
  await mia.client.call('DELETE', `/api/rooms/${roomId}/messages/${m1.id}`)
  expect(h.ctx.db.query('SELECT 1 FROM room_files WHERE id = ?').get(f.id)).toBeNull()
  expect(refRow(f.id)).toBeNull()
  expect(fs.readFileSync(at(`${chat}/plan.pdf`), 'utf8')).toBe('the plan')
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM file_events WHERE path = ?').get(`${chat}/plan.pdf`) as { n: number }).n).toBe(events)
  expect((await fileGet(nora.client, roomId, f.id)).status).toBe(404)
  const still = await filesOf(mia.client, roomId, m2.id)
  expect(still.map((x) => [x.name, x.state])).toEqual([['plan.pdf', undefined]])
  expect((await fileGet(mia.client, roomId, pick.file.id)).status).toBe(200)
})

test('trashed in Files: "File deleted", a restore brings it back; moved and renamed: followed; a narrowed subfolder: unavailable to those it leaves out', async () => {
  const { mia, nora, roomId, root, chat } = await setup('b-project-room-files-follow')
  const f = await up(mia.id, roomId, 'notes.txt', 'meeting notes')
  const m = await send(mia.client, roomId, [f.id])
  const { trashId } = team().remove(mia.id, `${chat}/notes.txt`)
  const gone = (await filesOf(nora.client, roomId, m.id))[0]!
  expect(gone).toMatchObject({ id: f.id, name: '', size: 0, teamFile: true, state: 'deleted' })
  expect(gone.teamPath).toBeUndefined()
  expect((await fileGet(nora.client, roomId, f.id)).status).toBe(404)
  team().restoreTrash(mia.id, trashId)
  expect((await filesOf(nora.client, roomId, m.id))[0]).toMatchObject({ name: 'notes.txt', teamPath: `${chat}/notes.txt` })
  // moved into a folder of the project, then renamed: followed
  team().mkdir(mia.id, `${root}/Minutes`)
  team().move(mia.id, `${chat}/notes.txt`, `${root}/Minutes/notes.txt`, 'fail')
  expect((await filesOf(nora.client, roomId, m.id))[0]).toMatchObject({ name: 'notes.txt', teamPath: `${root}/Minutes/notes.txt` })
  team().move(mia.id, `${root}/Minutes/notes.txt`, `${root}/Minutes/2026-11-20 notes.txt`, 'fail')
  expect((await filesOf(nora.client, roomId, m.id))[0]).toMatchObject({ name: '2026-11-20 notes.txt', teamPath: `${root}/Minutes/2026-11-20 notes.txt` })
  expect(String((await fileGet(nora.client, roomId, f.id)).body)).toContain('meeting notes')
  // the AI's room search never matches a project file by the name it was sent with
  expect(searchRooms(h.ctx.db, nora.id, 'UTC', { query: 'notes.txt' }).count ?? 0).toBe(0)
  // Minutes narrowed to mia only: unavailable to nora (nothing about it), still there for mia
  const fid = 'f_' + crypto.randomUUID()
  // (a limited folder cuts what comes from above; mia's own rule keeps her in)
  h.ctx.db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run(fid, `${root}/Minutes`)
  h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', ?, 'write')").run(crypto.randomUUID(), fid, mia.id)
  expect((await filesOf(nora.client, roomId, m.id))[0]).toMatchObject({ name: '', size: 0, state: 'unavailable' })
  expect((await fileGet(nora.client, roomId, f.id)).status).toBe(404)
  expect((await filesOf(mia.client, roomId, m.id))[0]).toMatchObject({ name: '2026-11-20 notes.txt' })
  // and the search gives it only to whom may read it
  expect((await nora.client.call('GET', '/api/room-files?q=notes')).items).toEqual([])
  expect(((await mia.client.call('GET', '/api/room-files?q=notes')).items as any[]).length).toBe(1)
})

test('unsent: the ✕ and the abandoned sweep trash my own unchanged upload shown nowhere else; anything else stays; the archived purge leaves team files alone', async () => {
  const { mia, roomId, chat } = await setup('b-project-room-files-unsent')
  const files = roomFilesOf(h.ctx)
  const trashed = (rel: string) => !fs.existsSync(at(rel)) && !!h.ctx.db.query('SELECT 1 FROM trash_items WHERE original_path = ? AND restored_at IS NULL').get(rel)
  // the ✕ on an unsent chip (a cancelled upload): to the trash
  const a = await up(mia.id, roomId, 'a.txt')
  files.discardUnsent(mia.id, roomId, [a.id])
  expect(h.ctx.db.query('SELECT 1 FROM room_files WHERE id = ?').get(a.id)).toBeNull()
  expect(trashed(`${chat}/a.txt`)).toBe(true)
  // another chat's reference to the very file (team_file_refs): stays
  const b = await up(mia.id, roomId, 'b.txt')
  const st = fs.lstatSync(at(`${chat}/b.txt`))
  const chatId = crypto.randomUUID()
  h.ctx.db.exec('PRAGMA foreign_keys = OFF')
  h.ctx.db.query(`INSERT INTO team_file_refs (id, user_id, chat_id, path, path_at_attach, name, size, mime, kind, sha256, mtime_ms, ino, dev, event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
    .run(crypto.randomUUID(), mia.id, chatId, `${chat}/b.txt`, `${chat}/b.txt`, 'b.txt', st.size, 'text/plain', 'text', 'x', Math.floor(st.mtimeMs), st.ino, st.dev)
  h.ctx.db.exec('PRAGMA foreign_keys = ON')
  files.discardUnsent(mia.id, roomId, [b.id])
  expect(fs.existsSync(at(`${chat}/b.txt`))).toBe(true)
  // changed since it was put there: stays
  const c = await up(mia.id, roomId, 'c.txt', 'short')
  fs.writeFileSync(at(`${chat}/c.txt`), 'edited in Files, longer now')
  files.discardUnsent(mia.id, roomId, [c.id])
  expect(fs.existsSync(at(`${chat}/c.txt`))).toBe(true)
  // a team file picked from Files (no upload of this room): stays
  fs.writeFileSync(at(`${chat}/picked.txt`), 'picked')
  const pick = await files.teamCopy(mia.id, roomId, `${chat}/picked.txt`, 'en')
  expect(pick.teamFile).toBe(true)
  files.discardUnsent(mia.id, roomId, [pick.id])
  expect(fs.existsSync(at(`${chat}/picked.txt`))).toBe(true)
  // abandoned for a day: the sweep handles it as the ✕
  const d = await up(mia.id, roomId, 'd.txt')
  const old = new Date(Date.now() - 2 * 86400_000).toISOString()
  h.ctx.db.query('UPDATE room_files SET created_at = ? WHERE id = ?').run(old, d.id)
  fs.utimesSync(at(`${chat}/d.txt`), new Date(Date.now() - 3 * 86400_000), new Date(Date.now() - 3 * 86400_000))
  files.sweep()
  expect(h.ctx.db.query('SELECT 1 FROM room_files WHERE id = ?').get(d.id)).toBeNull()
  expect(trashed(`${chat}/d.txt`)).toBe(true)
  // a sent file in a conversation archived long ago: its row goes, the team file stays
  const e = await up(mia.id, roomId, 'e.txt')
  await send(mia.client, roomId, [e.id])
  const longAgo = new Date(Date.now() - 40 * 86400_000).toISOString()
  h.ctx.db.query('UPDATE room_files SET created_at = ? WHERE id = ?').run(longAgo, e.id)
  h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(longAgo, roomId)
  h.ctx.db.query('DELETE FROM room_members WHERE room_id = ?').run(roomId)
  fs.mkdirSync(path.join(h.ctx.files.fx.root, '.system', 'rooms'), { recursive: true })
  expect(files.purgeArchived().files).toBeGreaterThanOrEqual(1)
  expect(h.ctx.db.query('SELECT 1 FROM room_files WHERE id = ?').get(e.id)).toBeNull()
  expect(refRow(e.id)).toBeNull()
  expect(fs.existsSync(at(`${chat}/e.txt`))).toBe(true)
})

/** the plain ZIP's entries, the text ones read */
async function exportText(): Promise<Map<string, string | null>> {
  const dbFile = path.join(h.ctx.config.dataDir, `export-${crypto.randomUUID()}.db`)
  h.ctx.db.exec(`VACUUM INTO '${dbFile}'`)
  const out = new Map<string, string | null>()
  for await (const e of teamExportEntries({ dbFile, teamRoot: h.ctx.files.fx.root })) {
    if (e.dir || !e.name.endsWith('.txt') || !e.name.startsWith('chats/')) { out.set(e.name, null); continue }
    const parts: Uint8Array[] = []
    for await (const b of (e as any).data()) parts.push(b)
    out.set(e.name, Buffer.concat(parts).toString('utf8'))
  }
  return out
}

test('quota and export: counted as team files (nothing in room storage); the export names them by team path, copies nothing again, and skips a room row without bytes', async () => {
  const { mia, nora, otto, roomId, chat } = await setup('b-project-room-files-export')
  const f = await up(mia.id, roomId, 'deck.pdf', 'the deck')
  await send(mia.client, roomId, [f.id], 'deck for the launch')
  expect(roomStore(roomId)).toEqual([])
  // a plain group chat whose file row has no bytes (an older build reading a project room's row sees just that)
  const group = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name: 'Plain group' })
  const g = await up(mia.id, group.id, 'kept.txt', 'room stored')
  const lost = await up(mia.id, group.id, 'lost.txt', 'room stored too')
  await send(mia.client, group.id, [g.id, lost.id], 'two files')
  fs.rmSync(path.join(h.ctx.files.fx.root, '.system', 'rooms', group.id, lost.id))
  const zip = await exportText()
  const roomText = [...zip].find(([n]) => n.startsWith('chats/Channels/Launch site'))?.[1] ?? ''
  expect(roomText).toContain('deck for the launch')
  expect(roomText).toContain(`[files: files/${chat}/deck.pdf]`)
  expect([...zip.keys()].some((n) => n.startsWith('chats/Channels/Launch site - files'))).toBe(false)
  expect(zip.has(`files/${chat}/deck.pdf`)).toBe(true)
  // the plain room: its stored file copied as before, the one without bytes left out
  const names = [...zip.keys()].filter((n) => n.startsWith('chats/Channels/Plain group - files/'))
  expect(names).toEqual(['chats/Channels/Plain group - files/kept.txt'])
})

test('team picks in a project room: no bytes against the 200 MB copy cap, one pick on its way at a time, at most 50 unsent and the attach rate', async () => {
  const { mia, nora, otto, roomId, root } = await setup('b-project-room-files-picks')
  const files = roomFilesOf(h.ctx)
  // a 210 MB file picked in the project room is a reference: a small copy in a plain group chat still goes
  fs.writeFileSync(at(`${root}/big.bin`), '')
  fs.truncateSync(at(`${root}/big.bin`), 210 * MB)
  expect((await files.teamCopy(mia.id, roomId, `${root}/big.bin`, 'en')).teamFile).toBe(true)
  fs.writeFileSync(at(`${root}/small.txt`), 'hi')
  const group = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name: 'Copies' })
  expect((await files.teamCopy(mia.id, group.id, `${root}/small.txt`, 'en')).teamFile).toBeUndefined()
  // a double tap: one reference
  fs.writeFileSync(at(`${root}/twice.txt`), 'twice')
  const [a, b] = await Promise.all([files.teamCopy(mia.id, roomId, `${root}/twice.txt`, 'en'), files.teamCopy(mia.id, roomId, `${root}/twice.txt`, 'en')])
  expect(a.id).toBe(b.id)
  // at most TEAM_REFS_UNSENT_MAX not sent yet (409 team_refs_full)
  for (let i = 2; i < TEAM_REFS_UNSENT_MAX; i++) { fs.writeFileSync(at(`${root}/p${i}.txt`), `p${i}`); await files.teamCopy(mia.id, roomId, `${root}/p${i}.txt`, 'en') }
  fs.writeFileSync(at(`${root}/over.txt`), 'over')
  let err: unknown = null
  try { await files.teamCopy(mia.id, roomId, `${root}/over.txt`, 'en') } catch (e) { err = e }
  expect([(err as HttpError).code, (err as HttpError).extra.params?.reason]).toEqual(['conflict', 'team_refs_full'])
  // sent ones count against the attach rate (each new reference hashes its file): 429
  const sent = h.ctx.db.query('SELECT f.id FROM room_files f JOIN room_file_refs r ON r.room_file_id = f.id WHERE f.user_id = ? AND f.message_id IS NULL').all(mia.id) as { id: string }[]
  await send(mia.client, roomId, sent.map((x) => x.id).slice(0, 10))
  const more = h.ctx.db.query('INSERT INTO room_files (id, room_id, user_id, message_id, name, size, mime, kind, sha256, created_at, team_path, team_stamp) SELECT ?, room_id, user_id, message_id, name, size, mime, kind, sha256, created_at, team_path, team_stamp FROM room_files WHERE id = ?')
  const moreRef = h.ctx.db.query('INSERT INTO room_file_refs (room_file_id, path, path_at_attach, ino, dev, sha256, event_id) SELECT ?, path, path_at_attach, ino, dev, sha256, event_id FROM room_file_refs WHERE room_file_id = ?')
  const sentRow = (h.ctx.db.query('SELECT id FROM room_files WHERE user_id = ? AND message_id IS NOT NULL LIMIT 1').get(mia.id) as { id: string }).id
  for (let i = 0; i < 120; i++) { const id = crypto.randomUUID(); more.run(id, sentRow); moreRef.run(id, sentRow) }
  h.ctx.db.query('DELETE FROM room_files WHERE id IN (SELECT f.id FROM room_files f JOIN room_file_refs r ON r.room_file_id = f.id WHERE f.user_id = ? AND f.message_id IS NULL)').run(mia.id)
  err = null
  try { await files.teamCopy(mia.id, roomId, `${root}/over.txt`, 'en') } catch (e) { err = e }
  expect(err instanceof HttpError && err.code === 'rate_limited').toBe(true)
})

test('export: a project file moved since the row last followed it is named where it is now', async () => {
  const { mia, roomId, root, chat } = await setup('b-project-room-files-export-moved')
  const f = await up(mia.id, roomId, 'moved.pdf', 'moved deck')
  await send(mia.client, roomId, [f.id], 'moved one')
  team().mkdir(mia.id, `${root}/Decks`)
  team().move(mia.id, `${chat}/moved.pdf`, `${root}/Decks/moved.pdf`, 'fail')
  expect(refRow(f.id)?.path).toBe(`${chat}/moved.pdf`)
  const zip = await exportText()
  const roomText = [...zip].find(([n]) => n.startsWith('chats/Channels/Launch site'))?.[1] ?? ''
  expect(roomText).toContain(`[files: files/${root}/Decks/moved.pdf]`)
})
