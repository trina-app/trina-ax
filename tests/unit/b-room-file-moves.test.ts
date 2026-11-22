// The files of a conversation made a project move to the project's Chat attachments (rooms/file-moves.ts,
// docs/AGENTS/plan/20261121-0619-structure-polish.md A "Which files move" and "The file move"): which files move and
// which stay (a team pick, an answer's copy by its scope or its origin, a thread reply under a root older than a
// member's start, a quarantined file); the names they take ("(2)", a case-only clash, CLAUDE.md and _FILES.md taken, a
// refused name made safe); a crash at each step ends as the plan's table says, a rerun changes nothing and no file has
// two links; the moved file opens for the AI's read, a zip and an MCP download link; adopting a placed file; a message
// deleted mid-move (cancelled, nothing left); a narrowed Chat attachments (kept); the sender as the uploader, the actor
// when the sender cannot write; the chip opens while staged; the closing line; a held project waits, a gone one keeps;
// disk full and five failures go back; the start's reconcile; the rooms line of the quota.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CHAT_FILES_FOLDER, PRODUCT } from '@mycel/shared'
import type { RoomFile } from '@mycel/shared/api'
import { ensureFolderRow, writeFolderAccess } from '../../server/src/admin/folders'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { challenge } from '../../server/src/connectors/remote-mcp/policy'
import { linkDownload } from '../../server/src/connectors/remote-mcp/download-link'
import { RemoteTools } from '../../server/src/connectors/remote-mcp/tools'
import { TurnFiles } from '../../server/src/files/service'
import { makeHandler } from '../../server/src/mcp/protocol'
import { MoveCrash, RoomFileMoves, roomFileMovesOf, type MoveStep } from '../../server/src/rooms/file-moves'
import { roomFilesOf } from '../../server/src/rooms/files'
import { componentC } from '../../server/src/team-files/component'
import { makeZip } from '../../server/src/tools/make-zip'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()
const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  roomFileMovesOf(h.ctx).auto = false
  const roomId = (await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Quotes' })).id as string
  return { owner, mia, nora, otto, roomId }
}
const at = (rel: string) => path.join(h.ctx.files.fx.root, ...rel.split('/'))
const roomStore = (roomId: string) => { try { return fs.readdirSync(path.join(h.ctx.files.fx.root, '.system', 'rooms', roomId)).filter((n) => !/\.thumb\./.test(n)) } catch { return [] } }
const staging = () => { try { return fs.readdirSync(path.join(h.ctx.files.fx.root, '.system', 'room-moves')) } catch { return [] } }
async function up(userId: string, roomId: string, name: string, text = `content of ${name} ${crypto.randomUUID()}`): Promise<RoomFile> {
  const src = path.join(h.ctx.config.dataDir, `upload-${crypto.randomUUID()}`)
  fs.writeFileSync(src, text)
  return roomFilesOf(h.ctx).create(userId, roomId, name, src, sha(text))
}
const send = (c: Client, roomId: string, fileIds: string[], extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body: '', clientMessageId: cm(), fileIds, ...extra })
async function convert(c: Client, roomId: string, name = 'Quote work') {
  const i = await c.call('GET', `/api/rooms/${roomId}/make-project`)
  const r = await c.call('POST', `/api/rooms/${roomId}/make-project`, { name, membersHash: i.membersHash })
  return { info: i, project: r.project as { id: string; folderPath: string }, chat: `${r.project.folderPath}/${CHAT_FILES_FOLDER[teamDefaultLocale(h.ctx.db)]}` }
}
const moves = (roomId: string) => h.ctx.db.query('SELECT * FROM room_file_moves WHERE room_id = ? ORDER BY created_at, id').all(roomId) as any[]
const moveOf = (fileId: string) => h.ctx.db.query('SELECT * FROM room_file_moves WHERE room_file_id = ?').get(fileId) as any
const refOf = (fileId: string) => h.ctx.db.query('SELECT path FROM room_file_refs WHERE room_file_id = ?').get(fileId) as { path: string } | null
const fileGet = async (c: Client, roomId: string, fileId: string) => { const r = await c.raw('GET', `/api/rooms/${roomId}/files/${fileId}`); return { status: r.status, body: await r.text() } }
/** a restart: a new mover over the same database and disk */
const restarted = () => { const m = new RoomFileMoves(h.ctx); m.auto = false; return m }
const crashAt = (m: RoomFileMoves, step: MoveStep) => { m.fault = (s) => { if (s === step) throw new MoveCrash(step) } }
function singleLinks(dir: string) { for (const n of fs.readdirSync(at(dir))) { const st = fs.lstatSync(path.join(at(dir), n)); if (st.isFile()) expect(st.nlink).toBe(1) } }

test('which files move: room-visible and seen by all; a team pick, an answer copy (scope or origin), an older thread root and a quarantined file stay', async () => {
  const { mia, nora, otto, roomId } = await setup('b-room-file-moves-which')
  const plain = await up(mia.id, roomId, 'plan.pdf', 'the plan')
  const root = await send(mia.client, roomId, [plain.id], { body: 'the plan' })
  // a copy of a team file (a phone's team pick): marked with team_path
  await componentC(h.ctx).files.mkdir(mia.id, 'shared/docs')
  fs.writeFileSync(at('shared/docs/rates.txt'), 'rates')
  const pick = await mia.client.call('POST', `/api/rooms/${roomId}/team-file`, { path: 'shared/docs/rates.txt' })
  await send(mia.client, roomId, [pick.file.id])
  // an answer's copy: an older row named in its message's scope (no origin), a newer row by its origin
  const oldCopy = await up(mia.id, roomId, 'answer-old.txt', 'old copy')
  const m1 = await send(mia.client, roomId, [oldCopy.id])
  h.ctx.db.query('UPDATE room_files SET origin = NULL WHERE id = ?').run(oldCopy.id)
  h.ctx.db.query('UPDATE room_messages SET source_scope = ? WHERE id = ?').run(JSON.stringify({ attached: [{ file: oldCopy.id, path: 'shared/docs/a.txt', links: [] }] }), m1.id)
  const newCopy = await up(mia.id, roomId, 'answer-new.txt', 'new copy')
  await send(mia.client, roomId, [newCopy.id])
  h.ctx.db.query("UPDATE room_files SET origin = 'answer_copy' WHERE id = ?").run(newCopy.id)
  const q = await up(mia.id, roomId, 'flagged.bin', 'flagged bytes')
  await send(mia.client, roomId, [q.id])
  h.ctx.db.query("INSERT INTO safe_ops_artifacts (hash, size, kind) VALUES (?, 13, 'file')").run(sha('flagged bytes'))
  // otto joins later; a reply under the old root then stays (he does not see the root), a new message's file moves
  await mia.client.call('POST', `/api/rooms/${roomId}/members`, { userIds: [otto.id] })
  const reply = await up(nora.id, roomId, 'reply.txt', 'in the thread')
  await send(nora.client, roomId, [reply.id], { threadRootId: root.id })
  const after = await up(nora.id, roomId, 'after.txt', 'after otto')
  const afterMsg = await send(nora.client, roomId, [after.id])
  // a message deleted: its file is not a candidate
  const gone = await up(nora.id, roomId, 'gone.txt', 'deleted')
  const goneMsg = await send(nora.client, roomId, [gone.id])
  await nora.client.call('DELETE', `/api/rooms/${roomId}/messages/${goneMsg.id}`)
  const { info, chat } = await convert(mia.client, roomId)
  // otto does not see `plan.pdf` either (sent before he joined)
  expect([info.filesMoving, info.filesStaying]).toEqual([1, 6])
  // by why (QA TC-7046): 3 copies (the pick, both answer copies), 1 download-only, the other 2 not seen by everyone
  expect([info.filesStayingCopies, info.filesStayingOther]).toEqual([3, 1])
  expect(moves(roomId).map((m) => m.room_file_id)).toEqual([after.id])
  const r = await roomFileMovesOf(h.ctx).run()
  expect(r).toMatchObject({ done: 1, kept: 0 })
  expect(refOf(after.id)?.path).toBe(`${chat}/after.txt`)
  // those that stay carry the label and are the room's Files list; the moved one is a team file
  const page = (await nora.client.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]
  const fileOf = (id: string) => page.flatMap((m) => m.files as RoomFile[]).find((f) => f.id === id)
  expect(fileOf(after.id)).toMatchObject({ teamFile: true, teamPath: `${chat}/after.txt` })
  expect(fileOf(after.id)?.roomOnly).toBeUndefined()
  expect(fileOf(plain.id)?.roomOnly).toBe(true)
  const list = await nora.client.call('GET', `/api/rooms/${roomId}/files`)
  expect((list.items as any[]).map((i) => i.file.name).sort()).toEqual(['answer-new.txt', 'answer-old.txt', 'flagged.bin', 'plan.pdf', 'rates.txt', 'reply.txt'].sort())
  expect((list.items as any[]).every((i) => i.file.roomOnly === true)).toBe(true)
  const room = await nora.client.call('GET', `/api/rooms/${roomId}`)
  expect(room).toMatchObject({ roomFiles: true })
  expect(room.filesMoving).toBeUndefined()
  // the closing line: 1 moved, 6 stay (by the system)
  const line = page.find((m) => m.event?.type === 'project_files_moved')
  expect(line).toMatchObject({ author: null, event: { moved: 1, kept: 6 } })
  void afterMsg
})

test('QA TC-7046: a copy of the sender\'s own file made from their own files and this room moves; any other copy stays', async () => {
  const { mia, nora, roomId } = await setup('b-room-file-moves-own-copy')
  // a copy on mia's own message, with its kept scope (chat/answer-share.ts) as sendShare writes it
  const copyWith = async (name: string, kept: (id: string) => unknown, by = mia) => {
    const f = await up(by.id, roomId, name, `copy ${name}`)
    const m = await send(by.client, roomId, [f.id])
    h.ctx.db.query("UPDATE room_files SET origin = 'answer_copy' WHERE id = ?").run(f.id)
    h.ctx.db.query('UPDATE room_messages SET source_scope = ? WHERE id = ?').run(JSON.stringify(kept(f.id)), m.id)
    return f
  }
  const own = (id: string, sources: unknown[], unknown = false, at = `users/${mia.id}/notes/${id}.md`) => ({ sources, unknown, attached: [{ file: id, path: at, links: [] }] })
  // moves: made from mia's own folder and this room (an AI post of a file it made in her folder)
  const a = await copyWith('own-a.md', (id) => own(id, [{ type: 'user', id: mia.id }, { type: 'room', id: roomId }, { type: 'name', path: `users/${mia.id}/notes` }]))
  // stays: made from a team folder; from another room; not all known; a copy of someone else's folder; nora's message
  const b = await copyWith('own-b.md', (id) => own(id, [{ type: 'user', id: mia.id }, { type: 'folder', id: 'f1' }]))
  const c = await copyWith('own-c.md', (id) => own(id, [{ type: 'room', id: crypto.randomUUID() }]))
  const d = await copyWith('own-d.md', (id) => own(id, [{ type: 'user', id: mia.id }], true))
  const e = await copyWith('own-e.md', (id) => own(id, [], false, `users/${nora.id}/x/${id}.md`))
  const g = await copyWith('own-g.md', (id) => own(id, [], false, 'shared/docs/x.md'))
  // stays: made from what her personal connection returned
  const v = await copyWith('own-v.md', (id) => own(id, [{ type: 'user', id: mia.id, via: 'connection' }]))
  const k = await copyWith('own-k.md', (id) => ({ sources: [], unknown: false, attached: [{ file: id, path: `users/${mia.id}/n/${id}.md`, links: [] }] }), nora)
  const { info, chat } = await convert(mia.client, roomId)
  expect([info.filesMoving, info.filesStaying, info.filesStayingCopies]).toEqual([1, 7, 7])
  expect(moves(roomId).map((m) => m.room_file_id)).toEqual([a.id])
  await roomFileMovesOf(h.ctx).run()
  expect(refOf(a.id)?.path).toBe(`${chat}/own-a.md`)
  for (const f of [b, c, d, e, g, k, v]) expect(refOf(f.id)).toBeNull()
})

test('names: "(2)", the same name twice, a case-only clash, CLAUDE.md and _FILES.md taken, a refused name made safe', async () => {
  const { mia, roomId, nora } = await setup('b-room-file-moves-names')
  const files = [await up(mia.id, roomId, 'brief.pdf', 'one'), await up(mia.id, roomId, 'brief.pdf', 'two'), await up(nora.id, roomId, 'Brief.PDF', 'three'),
    await up(mia.id, roomId, 'CLAUDE.md', '# not instructions'), await up(mia.id, roomId, '_FILES.md', 'not the list'), await up(mia.id, roomId, 'odd.txt', 'odd')]
  for (const f of files) await send(f.name === 'Brief.PDF' ? nora.client : mia.client, roomId, [f.id])
  // a name the team folder refuses (an older row could have one)
  h.ctx.db.query('UPDATE room_files SET name = ? WHERE id = ?').run('a<b>.txt', files[5]!.id)
  const { chat } = await convert(mia.client, roomId)
  // a file already there by that name
  await roomFileMovesOf(h.ctx).run()
  const names = files.map((f) => refOf(f.id)!.path.slice(chat.length + 1))
  expect(names.slice(0, 2)).toEqual(['brief.pdf', 'brief (2).pdf'])
  expect(names[2]!.toLowerCase()).toBe('brief (3).pdf')
  expect(names[3]).toBe('CLAUDE (2).md')
  expect(names[4]).toBe('_FILES (2).md')
  expect(names[5]).toBe('file.txt')
  expect(fs.existsSync(at(`${chat}/CLAUDE.md`))).toBe(false)
  expect(fs.readFileSync(at(`${chat}/brief (2).pdf`), 'utf8')).toBe('two')
  // the room file's name follows the placed one
  expect((h.ctx.db.query('SELECT name FROM room_files WHERE id = ?').get(files[3]!.id) as { name: string }).name).toBe('CLAUDE (2).md')
  singleLinks(chat)
  expect(roomStore(roomId)).toEqual([])
  // the same rule for a file sent from the computer in the project room now (rooms/files.ts createInProject)
  const direct = [await up(mia.id, roomId, '_FILES.md', 'a list?'), await up(mia.id, roomId, 'AGENTS.md', 'rules?')]
  expect(direct.map((f) => f.name)).toEqual(['_FILES (3).md', 'AGENTS (2).md'])
})

test('a crash at each step ends as the table says; a rerun is a no-op and no file has two links', async () => {
  for (const step of ['stage-write', 'stage-rename', 'place', 'commit', 'after-commit'] as const) {
    const { mia, roomId } = await setup(`b-room-file-moves-crash-${step}`)
    const f = await up(mia.id, roomId, 'deck.pdf', `deck for ${step}`)
    await send(mia.client, roomId, [f.id])
    const { chat } = await convert(mia.client, roomId)
    const first = restarted()
    crashAt(first, step)
    await expect(first.run()).rejects.toBeInstanceOf(MoveCrash)
    const state = moveOf(f.id).state
    expect(state).toBe(step === 'stage-write' ? 'pending' : step === 'after-commit' ? 'done' : 'placing')
    // the chip opens all along
    expect((await fileGet(mia.client, roomId, f.id)).body).toBe(`deck for ${step}`)
    // the start after the crash
    const again = restarted()
    roomFilesOf(h.ctx).reconcile()
    again.reconcile()
    await again.run()
    expect(moveOf(f.id).state).toBe('done')
    expect(fs.readdirSync(at(chat))).toEqual(['deck.pdf'])
    singleLinks(chat)
    expect(roomStore(roomId)).toEqual([])
    expect(staging()).toEqual([])
    // one upload event, naming the move
    const evs = h.ctx.db.query("SELECT detail FROM file_events WHERE action = 'upload' AND json_extract(detail, '$.moved') = ?").all(moveOf(f.id).id)
    expect(evs.length).toBe(1)
    // a rerun changes nothing
    expect(await restarted().run()).toEqual({ done: 0, kept: 0, cancelled: 0, left: 0 })
    expect((await fileGet(mia.client, roomId, f.id)).body).toBe(`deck for ${step}`)
    await h.close()
  }
})

test('a crash inside placeUpload (renamed, no event): found by its inode and adopted; a temp name goes back to staging', async () => {
  const { mia, roomId } = await setup('b-room-file-moves-inode')
  const a = await up(mia.id, roomId, 'a.txt', 'aaa')
  const b = await up(mia.id, roomId, 'b.txt', 'bbb')
  await send(mia.client, roomId, [a.id, b.id])
  const { chat } = await convert(mia.client, roomId)
  // both staged, then the process stops (once each)
  const m = restarted()
  m.fault = (s) => { if (s === 'place') throw new Error('stopped before placing') }
  await m.run()
  expect(staging().length).toBe(2)
  // what placeUpload did before it stopped: a under its final name with no event, b under a temp name
  if (!fs.existsSync(at(chat))) componentC(h.ctx).files.mkdir(mia.id, chat)
  fs.renameSync(at(moveOf(a.id).staged), at(`${chat}/a.txt`))
  fs.renameSync(at(moveOf(b.id).staged), at(`${chat}/.mycel-tmp-0123456789abcdef`))
  await restarted().run()
  expect(moveOf(a.id).state).toBe('done')
  expect(moveOf(b.id).state).toBe('done')
  expect(fs.readdirSync(at(chat)).sort()).toEqual(['a.txt', 'b.txt'])
  expect(refOf(a.id)?.path).toBe(`${chat}/a.txt`)
  singleLinks(chat)
})

test('after the move: one link at its team path, the AI reads it, a zip of the folder and an MCP download link work', async () => {
  const { mia, roomId } = await setup('b-room-file-moves-readers')
  const f = await up(mia.id, roomId, 'notes.txt', 'moved notes')
  await send(mia.client, roomId, [f.id])
  const { chat, project } = await convert(mia.client, roomId)
  await roomFileMovesOf(h.ctx).run()
  const rel = `${chat}/notes.txt`
  expect(fs.lstatSync(at(rel)).nlink).toBe(1)
  // the AI's read tool
  const handler = makeHandler(h.ctx.files, h.ctx.db, { user: h.ctx.files.principal(mia.id), turnId: null, files: new TurnFiles() } as any)
  const read = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { file_path: rel } } })
  expect(read.result.isError).toBeUndefined()
  expect(JSON.stringify(read.result.content)).toContain('moved notes')
  // make_zip of the project folder
  const z = await makeZip(h.ctx, componentC(h.ctx).files, { user: h.ctx.files.principal(mia.id), turnId: null, files: new TurnFiles() } as any, { paths: [project.folderPath], output: `${project.folderPath}/all.zip` } as any)
  expect(z.files.map((x) => x.from)).toContain(rel)
  expect(z.skipped).toEqual([])
  // an MCP download link
  const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie: mia.client.cookie! } }), { ip: '10.0.0.7', via: 'test' }))!
  const oauth = new RemoteOAuth(h.ctx.db, { origin: 'https://team.example' }), tools = new RemoteTools(h.ctx, () => oauth)
  const redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'v'.repeat(43)
  const c = oauth.register({ redirect_uris: [redirect] })
  const id = new URL(oauth.authorize({ client_id: c.client_id, redirect_uri: redirect, resource: oauth.resource(), response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope: 'mcp:read offline_access' })).searchParams.get('id')!
  const code = new URL(oauth.decide(id, auth, true).redirectUrl).searchParams.get('code')!
  const token = oauth.token({ client_id: c.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: oauth.resource() }).access_token
  const link = await tools.call(token, 'create_download_link', { path: rel })
  expect(link.isError).toBeFalsy()
  const url = JSON.parse(link.content[0]!.text).url as string
  const res = await linkDownload(h.ctx, new Request(url), url.split('/').pop()!, '10.0.0.7', {}, oauth)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('moved notes')
})

test('a message deleted mid-move: cancelled, nothing left in the folder; staged then deleted: the staged bytes go', async () => {
  const { mia, roomId } = await setup('b-room-file-moves-cancel')
  const a = await up(mia.id, roomId, 'a.txt', 'aaa')
  const ma = await send(mia.client, roomId, [a.id])
  const b = await up(mia.id, roomId, 'b.txt', 'bbb')
  const mb = await send(mia.client, roomId, [b.id])
  const { chat } = await convert(mia.client, roomId)
  // a: deleted while placeUpload runs (after it placed the file, before the commit)
  const m = restarted()
  let deleted = false
  m.fault = (s, row) => {
    if (s === 'commit' && row.room_file_id === a.id && !deleted) { deleted = true; roomFilesOf(h.ctx).removeForMessage(ma.id); h.ctx.db.query('UPDATE room_messages SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), ma.id) }
    if (s === 'place' && row.room_file_id === b.id) throw new MoveCrash('b staged')
  }
  await expect(m.run()).rejects.toBeInstanceOf(MoveCrash)
  expect(h.ctx.db.query('SELECT state, room_file_id, placed_path FROM room_file_moves WHERE id = (SELECT id FROM room_file_moves WHERE sha256 = ?)').get(sha('aaa'))).toEqual({ state: 'cancelled', room_file_id: null, placed_path: null })
  expect(fs.existsSync(at(`${chat}/a.txt`))).toBe(false)
  // b: staged, then its message is deleted
  expect(staging().length).toBe(1)
  await mia.client.call('DELETE', `/api/rooms/${roomId}/messages/${mb.id}`)
  await restarted().run()
  expect(h.ctx.db.query('SELECT state FROM room_file_moves WHERE sha256 = ?').get(sha('bbb'))).toEqual({ state: 'cancelled' })
  expect(staging()).toEqual([])
  expect(fs.existsSync(at(`${chat}/b.txt`))).toBe(false)
})

test('a narrowed Chat attachments keeps the file; the sender is the uploader, the actor when the sender cannot write', async () => {
  const { mia, nora, roomId } = await setup('b-room-file-moves-who')
  const fromNora = await up(nora.id, roomId, 'nora.txt', 'from nora')
  await send(nora.client, roomId, [fromNora.id])
  const { chat, project } = await convert(mia.client, roomId)
  // nora reads the project only: the actor (mia) places her file, the history says nora sent it
  h.ctx.db.query("UPDATE folder_rules SET access = 'read' WHERE subject_type = 'user' AND subject_id = ? AND folder_id = (SELECT id FROM folders WHERE path = ?)").run(nora.id, project.folderPath)
  await roomFileMovesOf(h.ctx).run()
  const ev = h.ctx.db.query("SELECT user_id, detail FROM file_events WHERE action = 'upload' AND path = ?").get(`${chat}/nora.txt`) as { user_id: string; detail: string }
  expect(ev.user_id).toBe(mia.id)
  expect(JSON.parse(ev.detail)).toMatchObject({ attachment: fromNora.id, roomId, sentBy: nora.id })
  // the sender who may write is the uploader
  h.ctx.db.query("UPDATE folder_rules SET access = 'write' WHERE subject_type = 'user' AND subject_id = ?").run(nora.id)
  const { roomId: room2, chat: chat2 } = await (async () => {
    const r2 = (await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Second' })).id as string
    const f2 = await up(nora.id, r2, 'second.txt', 'second')
    await send(nora.client, r2, [f2.id])
    const c = await convert(mia.client, r2, 'Second work')
    await roomFileMovesOf(h.ctx).run()
    return { roomId: r2, chat: c.chat }
  })()
  expect((h.ctx.db.query("SELECT user_id FROM file_events WHERE action = 'upload' AND path = ?").get(`${chat2}/second.txt`) as { user_id: string }).user_id).toBe(nora.id)
  // a third: Chat attachments narrowed to mia before the move → kept, readable in the room
  const r3 = (await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Third' })).id as string
  const f3 = await up(mia.id, r3, 'third.txt', 'third')
  await send(mia.client, r3, [f3.id])
  const c3 = await convert(mia.client, r3, 'Third work')
  await componentC(h.ctx).files.mkdir(mia.id, c3.chat)
  h.ctx.db.transaction(() => writeFolderAccess(h.ctx.db, ensureFolderRow(h.ctx.db, c3.chat).id, { rules: [{ subjectType: 'user', subjectId: mia.id, access: 'write' }], limited: true }, mia.id))()
  await roomFileMovesOf(h.ctx).run()
  expect(moveOf(f3.id)).toMatchObject({ state: 'kept', reason: 'narrowed' })
  expect((await fileGet(nora.client, r3, f3.id)).body).toBe('third')
  expect(fs.readdirSync(at(c3.chat))).toEqual([])
  void room2
})

test('a held project waits, a gone one keeps; disk full and five failures send the bytes back; the chip opens while staged', async () => {
  const { mia, nora, roomId } = await setup('b-room-file-moves-wait')
  const f = await up(mia.id, roomId, 'big.bin', 'bytes')
  const g = await up(mia.id, roomId, 'flaky.bin', 'flaky')
  const k = await up(mia.id, roomId, 'late.txt', 'late')
  await send(mia.client, roomId, [f.id, g.id, k.id])
  const { project, chat } = await convert(mia.client, roomId)
  // held: the project in the trash
  h.ctx.db.query("UPDATE projects SET trashed_with = 'trash-x' WHERE id = ?").run(project.id)
  expect(await restarted().run()).toMatchObject({ done: 0, kept: 0 })
  expect([f, g, k].map((x) => moveOf(x.id).state)).toEqual(['pending', 'pending', 'pending'])
  h.ctx.db.query('UPDATE projects SET trashed_with = NULL WHERE id = ?').run(project.id)
  // a project gone for good (this row's): kept
  h.ctx.db.query('UPDATE room_file_moves SET project_id = ? WHERE room_file_id = ?').run(crypto.randomUUID(), k.id)
  // disk full while placing f: back in the room, kept; g fails every time
  const m = restarted()
  m.fault = (s, row) => {
    if (s !== 'place') return
    if (row.room_file_id === f.id) { const e = new Error('no space') as NodeJS.ErrnoException; e.code = 'ENOSPC'; throw e }
    if (row.room_file_id === g.id) throw new Error('flaky disk')
  }
  await m.run()
  expect(moveOf(f.id)).toMatchObject({ state: 'kept', reason: 'disk_full' })
  expect(moveOf(k.id)).toMatchObject({ state: 'kept', reason: 'project_gone' })
  expect((await fileGet(nora.client, roomId, f.id)).body).toBe('bytes')
  for (let i = 0; i < 6 && moveOf(g.id).state !== 'kept'; i++) {
    // staged between tries: the chip still opens, from the staging folder
    expect(moveOf(g.id).state).toBe('placing')
    expect(roomStore(roomId)).not.toContain(g.id)
    expect((await fileGet(nora.client, roomId, g.id)).body).toBe('flaky')
    await m.run()
  }
  expect(moveOf(g.id)).toMatchObject({ state: 'kept', reason: 'failed' })
  expect((await fileGet(nora.client, roomId, g.id)).body).toBe('flaky')
  expect(roomStore(roomId).sort()).toEqual([f.id, g.id, k.id].sort())
  expect(staging()).toEqual([])
  expect(fs.existsSync(at(chat)) ? fs.readdirSync(at(chat)) : []).toEqual([])
  // all settled: the closing line says 0 moved, 3 stay
  const page = (await nora.client.call('GET', `/api/rooms/${roomId}/messages`)).items as any[]
  expect(page.find((x) => x.event?.type === 'project_files_moved')?.event).toMatchObject({ moved: 0, kept: 3 })
})

test('the start\'s reconcile: a second link of a moved file in room storage is unlinked, not set aside; a kept file staged goes back', async () => {
  const { mia, roomId } = await setup('b-room-file-moves-reconcile')
  const f = await up(mia.id, roomId, 'keep.txt', 'keep')
  await send(mia.client, roomId, [f.id])
  // one that stays (an answer's copy)
  const g = await up(mia.id, roomId, 'back.txt', 'back')
  await send(mia.client, roomId, [g.id])
  h.ctx.db.query("UPDATE room_files SET origin = 'answer_copy' WHERE id = ?").run(g.id)
  const { chat } = await convert(mia.client, roomId)
  await roomFileMovesOf(h.ctx).run()
  // a second link left in room storage (an interrupted older step): unlinked
  fs.mkdirSync(path.join(h.ctx.files.fx.root, '.system', 'rooms', roomId), { recursive: true })
  fs.linkSync(at(`${chat}/keep.txt`), path.join(h.ctx.files.fx.root, '.system', 'rooms', roomId, f.id))
  const r = roomFilesOf(h.ctx).reconcile()
  expect(r.orphansMoved).toBe(0)
  expect(roomStore(roomId)).toEqual([g.id])
  expect(fs.lstatSync(at(`${chat}/keep.txt`)).nlink).toBe(1)
  // a kept row whose bytes are still staged (a stop between the two writes): they go back to room storage
  const id = crypto.randomUUID()
  fs.mkdirSync(path.join(h.ctx.files.fx.root, '.system', 'room-moves'), { recursive: true })
  fs.renameSync(path.join(h.ctx.files.fx.root, '.system', 'rooms', roomId, g.id), path.join(h.ctx.files.fx.root, '.system', 'room-moves', id))
  h.ctx.db.query("INSERT INTO room_file_moves (id, room_file_id, room_id, project_id, actor, state, staged, sha256, created_at, updated_at) VALUES (?, ?, ?, (SELECT project_id FROM room_project_links WHERE room_id = ?), ?, 'kept', NULL, ?, ?, ?)")
    .run(id, g.id, roomId, roomId, mia.id, sha('back'), new Date().toISOString(), new Date().toISOString())
  expect(restarted().reconcile()).toMatchObject({ restored: 1 })
  expect(roomStore(roomId)).toEqual([g.id])
  expect(staging()).toEqual([])
})

test('the quota line moves: the rooms folder shrinks, the team folder holds the bytes, nothing doubles', async () => {
  const { mia, roomId } = await setup('b-room-file-moves-quota')
  const big = 'x'.repeat(200_000)
  const f = await up(mia.id, roomId, 'big.txt', big)
  await send(mia.client, roomId, [f.id])
  const size = (dir: string) => { let n = 0; const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else n += fs.statSync(p).size } }; try { walk(dir) } catch {} return n }
  const roomsDir = path.join(h.ctx.files.fx.root, '.system', 'rooms')
  const before = size(roomsDir)
  const { chat } = await convert(mia.client, roomId)
  await roomFileMovesOf(h.ctx).run()
  expect(before - size(roomsDir)).toBe(200_000)
  expect(fs.statSync(at(`${chat}/big.txt`)).size).toBe(200_000)
  expect(size(path.join(h.ctx.files.fx.root, '.system', 'room-moves'))).toBe(0)
})

// review of #221 (crash review probes A–D, P4): each turned into the behaviour it must have
test('C1: an error inside installFile after its first rename keeps the only copy: back at staging, placed on the next pass', async () => {
  const { mia, nora, roomId } = await setup('b-room-file-moves-install-error')
  const f = await up(mia.id, roomId, 'deck.pdf', 'the only copy')
  await send(mia.client, roomId, [f.id])
  const { chat } = await convert(mia.client, roomId)
  const orig = fs.chmodSync
  let once = false
  ;(fs as any).chmodSync = (p: fs.PathLike, m: fs.Mode) => {
    // team-files/place.ts installFile: the chmod of its temp name, after src was renamed there
    if (!once && String(p).includes(PRODUCT.tmpPrefix)) { once = true; const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
    return orig(p, m)
  }
  try { await restarted().run() } finally { (fs as any).chmodSync = orig }
  expect(once).toBe(true)
  expect(moveOf(f.id).state).toBe('placing')
  expect(fs.readFileSync(at(moveOf(f.id).staged), 'utf8')).toBe('the only copy')
  expect((await fileGet(nora.client, roomId, f.id)).body).toBe('the only copy')
  await restarted().run()
  expect(moveOf(f.id).state).toBe('done')
  expect(fs.readFileSync(at(`${chat}/deck.pdf`), 'utf8')).toBe('the only copy')
  expect((await fileGet(nora.client, roomId, f.id)).body).toBe('the only copy')
  expect(staging()).toEqual([])
})

test('C2: an inode used again by another file is never adopted (size and sha256 checked)', async () => {
  const { mia, nora, roomId } = await setup('b-room-file-moves-inode-reuse')
  const f = await up(mia.id, roomId, 'deck.pdf', 'mine')
  await send(mia.client, roomId, [f.id])
  const { chat } = await convert(mia.client, roomId)
  const first = restarted()
  crashAt(first, 'place')
  await expect(first.run()).rejects.toBeInstanceOf(MoveCrash)
  // the bytes are gone and another person's file now has the inode number the move recorded
  fs.rmSync(at(moveOf(f.id).staged))
  if (!fs.existsSync(at(chat))) componentC(h.ctx).files.mkdir(mia.id, chat)
  fs.writeFileSync(at(`${chat}/nora-private.txt`), 'someone else')
  const st = fs.lstatSync(at(`${chat}/nora-private.txt`))
  h.ctx.db.query('UPDATE room_file_moves SET ino = ?, dev = ? WHERE id = ?').run(st.ino, st.dev, moveOf(f.id).id)
  await restarted().run()
  expect(moveOf(f.id)).toMatchObject({ state: 'kept', reason: 'lost' })
  expect(refOf(f.id)).toBeNull()
  expect(fs.readFileSync(at(`${chat}/nora-private.txt`), 'utf8')).toBe('someone else')
  void nora
})

test('C3: a placed, uncommitted file whose folder was narrowed meanwhile goes back to the conversation, not into the project', async () => {
  const { mia, nora, roomId } = await setup('b-room-file-moves-narrowed-placed')
  const f = await up(mia.id, roomId, 'deck.pdf', 'deck')
  await send(mia.client, roomId, [f.id])
  const { chat } = await convert(mia.client, roomId)
  const first = restarted()
  crashAt(first, 'commit')
  await expect(first.run()).rejects.toBeInstanceOf(MoveCrash)
  expect(fs.existsSync(at(`${chat}/deck.pdf`))).toBe(true)
  h.ctx.db.transaction(() => writeFolderAccess(h.ctx.db, ensureFolderRow(h.ctx.db, chat).id, { rules: [{ subjectType: 'user', subjectId: mia.id, access: 'write' }], limited: true }, mia.id))()
  await restarted().run()
  expect(moveOf(f.id)).toMatchObject({ state: 'kept', reason: 'narrowed' })
  expect(refOf(f.id)).toBeNull()
  expect(fs.existsSync(at(`${chat}/deck.pdf`))).toBe(false)
  expect(roomStore(roomId)).toEqual([f.id])
  expect((await fileGet(nora.client, roomId, f.id)).body).toBe('deck')
})

test('C4: a deleted message\'s placed file leaves the project even when nobody may write there; a trash that keeps failing is settled', async () => {
  const { mia, nora, roomId } = await setup('b-room-file-moves-cancel-trash')
  const f = await up(mia.id, roomId, 'deck.pdf', 'deck')
  const m = await send(mia.client, roomId, [f.id])
  const g = await up(mia.id, roomId, 'other.pdf', 'other')
  const mg = await send(mia.client, roomId, [g.id])
  const { chat, project } = await convert(mia.client, roomId)
  const first = restarted()
  // both placed, neither committed (a failure right after placeUpload, for each)
  first.fault = (s) => { if (s === 'commit') throw new Error('stopped after placing') }
  await first.run()
  expect(fs.readdirSync(at(chat)).sort()).toEqual(['deck.pdf', 'other.pdf'])
  // f: both may only read now; the server trashes it itself
  h.ctx.db.query("UPDATE folder_rules SET access = 'read' WHERE subject_type = 'user' AND folder_id = (SELECT id FROM folders WHERE path = ?)").run(project.folderPath)
  await mia.client.call('DELETE', `/api/rooms/${roomId}/messages/${m.id}`)
  await mia.client.call('DELETE', `/api/rooms/${roomId}/messages/${mg.id}`)
  const team = componentC(h.ctx).files as any
  const orig = team.remove.bind(team)
  // g: every trash fails
  team.remove = (who: string, rel: string, turn: string | null, o: any) => { if (rel.endsWith('other.pdf')) throw new Error('denied'); return orig(who, rel, turn, o) }
  try { for (let i = 0; i < 8; i++) await restarted().run() } finally { team.remove = orig }
  expect(fs.readdirSync(at(chat))).toEqual(['other.pdf'])
  const rows = h.ctx.db.query('SELECT sha256, state, reason, placed_path, staged, ino FROM room_file_moves WHERE room_id = ? ORDER BY sha256').all(roomId) as any[]
  const bySha = new Map(rows.map((r) => [r.sha256, r]))
  expect(bySha.get(sha('deck'))).toMatchObject({ state: 'cancelled', placed_path: null, staged: null, ino: null })
  expect(bySha.get(sha('other'))).toMatchObject({ state: 'cancelled', reason: 'trash_failed', placed_path: null, staged: null, ino: null })
  // settled: the room's moves end (nothing moved, nothing stays: no closing line is needed) and a rerun is a no-op
  expect(await restarted().run()).toEqual({ done: 0, kept: 0, cancelled: 0, left: 0 })
  expect((await nora.client.call('GET', `/api/rooms/${roomId}`)).filesMoving).toBeUndefined()
})

test('P4: a Chat attachments folder wider than the project keeps the file in the conversation', async () => {
  const { mia, otto, roomId } = await setup('b-room-file-moves-wider')
  const f = await up(mia.id, roomId, 'deck.pdf', 'deck')
  await send(mia.client, roomId, [f.id])
  const { chat } = await convert(mia.client, roomId)
  if (!fs.existsSync(at(chat))) componentC(h.ctx).files.mkdir(mia.id, chat)
  // otto is no project person but reads Chat attachments by a rule of its own
  h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_at) VALUES (?, ?, 'user', ?, 'read', ?)").run(crypto.randomUUID(), ensureFolderRow(h.ctx.db, chat).id, otto.id, new Date().toISOString())
  await restarted().run()
  expect(moveOf(f.id)).toMatchObject({ state: 'kept', reason: 'wider' })
  expect(fs.readdirSync(at(chat))).toEqual([])
  expect(roomStore(roomId)).toEqual([f.id])
})

test('nit: going back with both a staged and a room copy keeps the move\'s own inode only', async () => {
  const { mia, nora, roomId } = await setup('b-room-file-moves-both')
  const f = await up(mia.id, roomId, 'deck.pdf', 'original')
  await send(mia.client, roomId, [f.id])
  await convert(mia.client, roomId)
  const first = restarted()
  crashAt(first, 'place')
  await expect(first.run()).rejects.toBeInstanceOf(MoveCrash)
  // something else appeared at the room path meanwhile; the move then fails for good
  fs.writeFileSync(path.join(h.ctx.files.fx.root, '.system', 'rooms', roomId, f.id), 'stray')
  const m = restarted()
  m.fault = (s) => { if (s === 'place') { const e = new Error('full') as NodeJS.ErrnoException; e.code = 'SQLITE_FULL'; throw e } }
  await m.run()
  expect(moveOf(f.id)).toMatchObject({ state: 'kept', reason: 'disk_full' })
  expect((await fileGet(nora.client, roomId, f.id)).body).toBe('original')
  expect(staging()).toEqual([])
})

// second crash review of #221
test('R1: a cross-disk install (EXDEV) that fails after its copy keeps the source: bytes still staged, placed on the next pass', async () => {
  const { mia, nora, roomId } = await setup('b-room-file-moves-exdev')
  const f = await up(mia.id, roomId, 'deck.pdf', 'the only copy, across disks')
  await send(mia.client, roomId, [f.id])
  const { chat } = await convert(mia.client, roomId)
  const origRename = fs.renameSync
  const origChmod = fs.chmodSync
  let exdev = 0, eperm = false
  // every rename from staging to a temp name crosses disks; the first chmod of the copy fails
  ;(fs as any).renameSync = (a: fs.PathLike, b: fs.PathLike) => {
    if (String(a).includes(`${path.sep}room-moves${path.sep}`) && String(b).includes(PRODUCT.tmpPrefix)) { exdev++; const e = new Error('EXDEV') as NodeJS.ErrnoException; e.code = 'EXDEV'; throw e }
    return origRename(a, b)
  }
  ;(fs as any).chmodSync = (p: fs.PathLike, m: fs.Mode) => {
    if (!eperm && String(p).includes(PRODUCT.tmpPrefix)) { eperm = true; const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
    return origChmod(p, m)
  }
  try {
    await restarted().run()
    expect([exdev, eperm]).toEqual([1, true])
    expect(moveOf(f.id).state).toBe('placing')
    expect(fs.readFileSync(at(moveOf(f.id).staged), 'utf8')).toBe('the only copy, across disks')
    expect(fs.existsSync(at(chat)) ? fs.readdirSync(at(chat)) : []).toEqual([])
    expect((await fileGet(nora.client, roomId, f.id)).body).toBe('the only copy, across disks')
    // the next pass copies again and only then removes the staged source
    await restarted().run()
  } finally { (fs as any).renameSync = origRename; (fs as any).chmodSync = origChmod }
  expect(exdev).toBe(2)
  expect(moveOf(f.id)).toMatchObject({ state: 'done', staged: null })
  expect(fs.readFileSync(at(`${chat}/deck.pdf`), 'utf8')).toBe('the only copy, across disks')
  expect(fs.lstatSync(at(`${chat}/deck.pdf`)).nlink).toBe(1)
  expect(staging()).toEqual([])
  expect((await fileGet(nora.client, roomId, f.id)).body).toBe('the only copy, across disks')
})

test('R2: a kept file still staged (restore_failed) is not counted missing, goes back with `staged` cleared; one whose message went is deleted', async () => {
  const { mia, nora, roomId } = await setup('b-room-file-moves-kept-staged')
  const f = await up(mia.id, roomId, 'a.pdf', 'aaa')
  await send(mia.client, roomId, [f.id])
  const g = await up(mia.id, roomId, 'b.pdf', 'bbb')
  const mg = await send(mia.client, roomId, [g.id])
  await convert(mia.client, roomId)
  const first = restarted()
  // a failure right before placing, for each: both staged, waiting
  first.fault = (st) => { if (st === 'place') throw new Error('stopped before placing') }
  await first.run()
  // both staged; each settled as a way back that kept failing (failed(): kept, restore_failed, staged left)
  expect(staging().length).toBe(2)
  h.ctx.db.query("UPDATE room_file_moves SET state = 'kept', reason = 'restore_failed' WHERE room_id = ?").run(roomId)
  // g's message is deleted afterwards: its row loses the file, the staged bytes stay behind
  await mia.client.call('DELETE', `/api/rooms/${roomId}/messages/${mg.id}`)
  const gRow = h.ctx.db.query('SELECT * FROM room_file_moves WHERE sha256 = ?').get(sha('bbb')) as any
  expect(gRow).toMatchObject({ state: 'kept', room_file_id: null })
  expect(gRow.staged).not.toBeNull()
  // the room's own reconcile does not call f missing (its bytes are staged)
  expect(roomFilesOf(h.ctx).reconcile().missingFiles).toBe(0)
  expect(restarted().reconcile()).toMatchObject({ restored: 1, removed: 1, left: 0 })
  expect(moveOf(f.id)).toMatchObject({ state: 'kept', staged: null })
  expect(h.ctx.db.query('SELECT staged FROM room_file_moves WHERE id = ?').get(gRow.id)).toEqual({ staged: null })
  expect(staging()).toEqual([])
  expect(roomStore(roomId)).toEqual([f.id])
  expect((await fileGet(nora.client, roomId, f.id)).body).toBe('aaa')
  // a second start has nothing left to report
  expect(restarted().reconcile()).toMatchObject({ restored: 0, removed: 0, left: 0 })
})

test('R3: a placed file taken back out of Chat attachments gets a delete in its history and a files change', async () => {
  const { mia, roomId } = await setup('b-room-file-moves-back-event')
  const f = await up(mia.id, roomId, 'deck.pdf', 'deck')
  await send(mia.client, roomId, [f.id])
  const { chat } = await convert(mia.client, roomId)
  const first = restarted()
  crashAt(first, 'commit')
  await expect(first.run()).rejects.toBeInstanceOf(MoveCrash)
  expect(fs.existsSync(at(`${chat}/deck.pdf`))).toBe(true)
  const changed: string[][] = []
  const onTree = (e: { paths: string[] }) => changed.push(e.paths)
  h.ctx.files.events.on('tree-changed', onTree)
  h.ctx.db.transaction(() => writeFolderAccess(h.ctx.db, ensureFolderRow(h.ctx.db, chat).id, { rules: [{ subjectType: 'user', subjectId: mia.id, access: 'write' }], limited: true }, mia.id))()
  try { await restarted().run() } finally { h.ctx.files.events.off('tree-changed', onTree) }
  expect(moveOf(f.id)).toMatchObject({ state: 'kept', reason: 'narrowed' })
  expect(fs.existsSync(at(`${chat}/deck.pdf`))).toBe(false)
  const ev = h.ctx.db.query("SELECT user_id, action, json_extract(detail, '$.movedBack') moved_back FROM file_events WHERE path = ? ORDER BY id DESC LIMIT 1").get(`${chat}/deck.pdf`) as any
  expect(ev).toEqual({ user_id: mia.id, action: 'delete', moved_back: moveOf(f.id).id })
  expect(changed.some((p) => p.includes(`${chat}/deck.pdf`))).toBe(true)
})

// TC-6730: the header's "Moving files…" (Room.filesMoving) goes at once when the mover settles: every member gets
// room.updated, also when no closing line is written (the only file's message was deleted: nothing moved, nothing kept).
test('when the moves settle every member is told the room changed, with or without a closing line', async () => {
  const { mia, nora, roomId } = await setup('b-room-file-moves-settled-event')
  const f = await up(mia.id, roomId, 'only.txt', 'only')
  const msg = await send(mia.client, roomId, [f.id])
  await convert(mia.client, roomId)
  expect((await nora.client.call('GET', `/api/rooms/${roomId}`)).filesMoving).toBe(true)
  // every window open: the hub is asked for each person, and what it would send is kept
  const sent: { to: string; ev: any }[] = []
  h.ctx.services.realtime.publishEach = (build) => {
    for (const r of h.ctx.db.query('SELECT id FROM users').all() as { id: string }[]) { const ev = build(r.id); if (ev) sent.push({ to: r.id, ev }) }
  }
  await mia.client.call('DELETE', `/api/rooms/${roomId}/messages/${msg.id}`)
  await roomFileMovesOf(h.ctx).run()
  expect((await nora.client.call('GET', `/api/rooms/${roomId}`)).filesMoving).toBeUndefined()
  const told = (id: string) => sent.some((e) => e.to === id && e.ev.type === 'room.updated' && e.ev.data.roomId === roomId && !e.ev.data.room.filesMoving)
  expect(told(nora.id) && told(mia.id)).toBe(true)
  // no closing line: nothing moved and nothing stays
  expect((h.ctx.db.query("SELECT COUNT(*) n FROM room_messages WHERE room_id = ? AND json_extract(event, '$.type') = 'project_files_moved'").get(roomId) as { n: number }).n).toBe(0)
})
