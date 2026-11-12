// "팀 파일" in a room's message box (a phone's attach sheet; shared/src/api/rooms.ts attachRoomTeamFile, the route in
// server/src/routes/rooms.ts): a team file I may read now becomes my upload in a room I am in, the copy "대화방에 보내기"
// makes of a linked file (rooms/files.ts fromTeamFile), and is sent by id like any upload. Covered: the copy and the
// count of other members who cannot open the team file (never who; a disabled account counts), my read access now
// (another group's file, a missing one, a folder, a link, a quarantined file: all 404 alike), a room I am not in, the
// 50 MB limit, a bad path, the copy readable by the room only once sent, the same file picked again (its copy again),
// the cap on a person's unsent copies (also for picks at the same time), my read access checked again at the send (taken
// out of the group meanwhile: nothing goes, the copy is removed), and the audit row when it is sent (the path, the room
// as room audits name it, never the contents). The fixture team: alice and erin in marketing, bob in finance, carol admin, dana
// owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, SMALL_UPLOAD_MAX, uuidv7, type Room, type RoomMessage, type RoomTeamFile } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { roomFilesOf, TEAM_COPIES_UNSENT_MAX } from '../../server/src/rooms/files'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let rooms: { all: string; marketing: string; finance: string; dm: string }
let marketingGroup: string
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-rooms-team-file' })
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  const list = async (u: string) => (await h.api(u).call(API.listRooms)).items as Room[]
  const alice = await list('alice')
  marketingGroup = alice.find((r) => r.kind === 'team' && r.name === 'Marketing')!.groupId!
  rooms = {
    all: alice.find((r) => r.kind === 'all')!.id,
    marketing: alice.find((r) => r.kind === 'team' && r.name === 'Marketing')!.id,
    finance: (await list('bob')).find((r) => r.kind === 'team' && r.name === 'Finance')!.id,
    dm: (await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'bob' } })).id,
  }
})
afterAll(async () => { await h.close() })

/** a team file on disk */
function put(rel: string, text: string): string {
  const abs = path.join(h.ctx.files.fx.root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  return abs
}
const attach = (user: string, roomId: string, p: string) =>
  h.req(user, `/api/rooms/${roomId}/team-file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
async function copy(user: string, roomId: string, p: string): Promise<RoomTeamFile> {
  const r = await attach(user, roomId, p)
  expect(r.status).toBe(201)
  return (await r.json()) as RoomTeamFile
}
const send = (user: string, roomId: string, fileIds: string[]) =>
  h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body: '', clientMessageId: cm(), mentions: [], fileIds } }) as Promise<RoomMessage>
const read = (user: string, roomId: string, fileId: string) => h.req(user, `/api/rooms/${roomId}/files/${fileId}`)
/** `user`'s unsent copies of files named `name` */
const unsent = (user: string, name: string) => (h.ctx.db.query('SELECT COUNT(*) n FROM room_files WHERE user_id = ? AND name = ? AND message_id IS NULL').get(user, name) as { n: number }).n
const auditOf = (fileId: string) => h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'room.team_file' AND json_extract(detail, '$.file') = ?").get(fileId) as { actor_id: string; target: string; detail: string } | null

describe('a team file sent in a room', () => {
  test('my own file: a copy as my upload, the others who cannot open it counted; sent, the room reads the copy', async () => {
    put('users/alice/plan-room.md', '# 기획안\n비밀 메모\n')
    const r = await copy('alice', rooms.all, 'users/alice/plan-room.md')
    expect(r.file).toMatchObject({ name: 'plan-room.md', thumb: false })
    expect(r.file.size).toBe(Buffer.byteLength('# 기획안\n비밀 메모\n'))
    // bob, carol, dana and erin cannot open alice's own folder
    expect(r.unable).toBe(4)
    // not sent yet: only mine
    expect((await read('bob', rooms.all, r.file.id)).status).toBe(404)
    expect((await read('alice', rooms.all, r.file.id)).status).toBe(200)
    const m = await send('alice', rooms.all, [r.file.id])
    expect(m.files.map((f) => f.name)).toEqual(['plan-room.md'])
    const got = await read('bob', rooms.all, r.file.id)
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('# 기획안\n비밀 메모\n')
    // the team file itself stays where it was, closed to bob
    expect((await h.req('bob', '/api/files/download?path=users/alice/plan-room.md')).status).not.toBe(200)
  })

  test('a file everyone in the room may read already: nobody counted', async () => {
    expect((await copy('alice', rooms.marketing, 'shared/glossary.md')).unable).toBe(0)
    // marketing's own folder in the marketing room: erin reads it; in the everyone room bob does not
    put('groups/marketing/brief-room.md', '# 브리프\n')
    expect((await copy('alice', rooms.marketing, 'groups/marketing/brief-room.md')).unable).toBe(0)
    expect((await copy('alice', rooms.all, 'groups/marketing/brief-room.md')).unable).toBe(1)
    expect((await copy('alice', rooms.dm, 'groups/marketing/brief-room.md')).unable).toBe(1)
  })

  test('a disabled member still in the room counts as one who cannot open it; never named', async () => {
    const db = h.ctx.db
    db.query("INSERT INTO users (id, username, name, role, status) VALUES ('gus', 'gus', 'Gus Ko', 'member', 'disabled')").run()
    const dm = uuidv7(), now = new Date().toISOString()
    db.query("INSERT INTO rooms (id, kind, dm_key, created_by, created_at, activity_at) VALUES (?, 'dm', 'alice|gus', 'alice', ?, ?)").run(dm, now, now)
    for (const u of ['alice', 'gus']) db.query('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(dm, u, now)
    const r = await attach('alice', dm, 'shared/glossary.md')
    expect(r.status).toBe(201)
    const text = await r.text()
    expect(JSON.parse(text).unable).toBe(1)
    for (const n of ['gus', 'Gus']) expect(text).not.toContain(n)
  })

  test('only what I may read now, and only a plain file: everything else 404, alike', async () => {
    put('groups/finance/budget-room.md', '# 예산\n')
    // another group's file, a missing one, a folder, a link (the fixture's shared/abs-budget.md points into finance)
    for (const p of ['groups/finance/budget-room.md', 'shared/no-such-file.md', 'shared/policies', 'shared/abs-budget.md', 'users/bob/x.md']) {
      const r = await attach('alice', rooms.all, p)
      expect(r.status).toBe(404)
    }
    // a quarantined file (the safety check's download-only list)
    const held = put('shared/held-room.bin', 'held bytes')
    h.ctx.files.quarantine.add(fs.readFileSync(held), 'pptx')
    expect((await attach('alice', rooms.all, 'shared/held-room.bin')).status).toBe(404)
    // nothing was copied for any of them
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM room_files WHERE user_id = 'alice' AND name IN ('budget-room.md', 'held-room.bin', 'policies')").get() as { n: number }).n).toBe(0)
  })

  test('a room I am not in answers like one that does not exist; a bad path is refused', async () => {
    expect((await attach('alice', rooms.finance, 'shared/glossary.md')).status).toBe(404)
    expect((await attach('alice', '019a5f00-0000-7000-8000-00000000dead', 'shared/glossary.md')).status).toBe(404)
    for (const p of ['../etc/passwd', '/shared/glossary.md', 'shared/../users/bob/x.md']) expect((await attach('alice', rooms.all, p)).status).toBe(400)
  })

  test('over 50 MB: 413, nothing kept', async () => {
    const abs = put('users/alice/huge-room.bin', '')
    fs.truncateSync(abs, SMALL_UPLOAD_MAX + 1)
    expect((await attach('alice', rooms.all, 'users/alice/huge-room.bin')).status).toBe(413)
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM room_files WHERE name = 'huge-room.bin'").get() as { n: number }).n).toBe(0)
  })

  test('audited when sent, not when copied: who, the path, the room (a DM by its kind only), the count; never the contents', async () => {
    put('users/alice/audit-room.md', '아무도 보면 안 되는 내용\n')
    const team = await copy('alice', rooms.all, 'users/alice/audit-room.md')
    // picked, not sent (maybe taken out of the box again): nothing in the log
    expect(auditOf(team.file.id)).toBeNull()
    const m = await send('alice', rooms.all, [team.file.id])
    const row = auditOf(team.file.id)!
    expect(row.actor_id).toBe('alice')
    expect(row.target).toBe('users/alice/audit-room.md')
    expect(JSON.parse(row.detail)).toEqual({ roomId: rooms.all, message: m.id, file: team.file.id, unable: 4 })
    const dm = await copy('alice', rooms.dm, 'users/alice/audit-room.md')
    const dmMessage = await send('alice', rooms.dm, [dm.file.id])
    const dmDetail = JSON.parse(auditOf(dm.file.id)!.detail)
    expect(dmDetail).toEqual({ kind: 'dm', message: dmMessage.id, file: dm.file.id, unable: 1 })
    expect(JSON.stringify([row, dmDetail])).not.toContain('보면 안 되는')
    // an upload from the phone in the same message is no team file
    const up = await roomFilesOf(h.ctx).create('alice', rooms.all, 'photo-note.txt', (() => { const p = path.join(h.dataDir, `up-${uuidv7()}`); fs.writeFileSync(p, 'x'); return p })(), 'b'.repeat(64))
    await send('alice', rooms.all, [up.id])
    expect(auditOf(up.id)).toBeNull()
  })

  test('the same file picked again before sending: the same copy, no new one; changed or sent: a new copy', async () => {
    put('users/alice/again-room.md', '# 1\n')
    const a = await copy('alice', rooms.all, 'users/alice/again-room.md')
    const b = await copy('alice', rooms.all, 'users/alice/again-room.md')
    expect(b.file.id).toBe(a.file.id)
    expect(unsent('alice', 'again-room.md')).toBe(1)
    // another room, or another person: copies of their own
    expect((await copy('alice', rooms.dm, 'users/alice/again-room.md')).file.id).not.toBe(a.file.id)
    expect((await copy('erin', rooms.marketing, 'shared/glossary.md')).file.id).not.toBe((await copy('alice', rooms.marketing, 'shared/glossary.md')).file.id)
    // the file changed meanwhile: a new copy, with the new bytes
    put('users/alice/again-room.md', '# 2 — 고친 내용\n')
    const c = await copy('alice', rooms.all, 'users/alice/again-room.md')
    expect(c.file.id).not.toBe(a.file.id)
    expect(await (await read('alice', rooms.all, c.file.id)).text()).toBe('# 2 — 고친 내용\n')
    // sent: the next pick is a new copy (a sent one is the message's)
    await send('alice', rooms.all, [c.file.id])
    expect((await copy('alice', rooms.all, 'users/alice/again-room.md')).file.id).not.toBe(c.file.id)
  })

  test('a person\'s unsent copies are capped: past 200 MB the next copy is refused with a plain line; sending frees it', async () => {
    put('users/bob/cap-room.md', '# 예산 메모\n')
    // bob's unsent copies, as big as the cap less a little (rows as teamCopy keeps them; their files are not read here)
    const big = uuidv7()
    h.ctx.db.query("INSERT INTO room_files (id, room_id, user_id, name, size, mime, kind, sha256, thumb, created_at, team_path, team_stamp) VALUES (?, ?, 'bob', 'big.bin', ?, 'application/octet-stream', 'other', ?, 0, ?, 'users/bob/big.bin', 'x')")
      .run(big, rooms.dm, TEAM_COPIES_UNSENT_MAX - 5, 'c'.repeat(64), new Date().toISOString())
    const r = await h.req('bob', `/api/rooms/${rooms.all}/team-file`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'ko' }, body: JSON.stringify({ path: 'users/bob/cap-room.md' }) })
    expect(r.status).toBe(409)
    const err = (await r.json()) as { error: { message: string; params: { reason: string } } }
    expect(err.error.params.reason).toBe('team_copies_full')
    expect(err.error.message).toContain('200 MB')
    expect(unsent('bob', 'cap-room.md')).toBe(0)
    // copies once sent do not count, nor do uploads from the phone (the send checks bob may still open its team file)
    put('users/bob/big.bin', 'x')
    await send('bob', rooms.dm, [big])
    h.ctx.db.query("INSERT INTO room_files (id, room_id, user_id, name, size, mime, kind, sha256, thumb, created_at) VALUES (?, ?, 'bob', 'upload.bin', ?, 'application/octet-stream', 'other', ?, 0, ?)")
      .run(uuidv7(), rooms.dm, TEAM_COPIES_UNSENT_MAX, 'd'.repeat(64), new Date().toISOString())
    expect((await copy('bob', rooms.all, 'users/bob/cap-room.md')).file.name).toBe('cap-room.md')
  })
  test('sent while I may still open the team file: it goes, and the room reads it', async () => {
    put('groups/marketing/kept-room.md', '# 캠페인 일정\n')
    const r = await copy('alice', rooms.all, 'groups/marketing/kept-room.md')
    expect(r.unable).toBe(1)
    const m = await send('alice', rooms.all, [r.file.id])
    expect(m.files.map((f) => f.id)).toEqual([r.file.id])
    expect(await (await read('bob', rooms.all, r.file.id)).text()).toBe('# 캠페인 일정\n')
  })

  test('taken out of the group after the pick: the send is refused (nothing goes), the copy is removed, the box is told which', async () => {
    put('groups/marketing/revoked-room.md', '# 마케팅만 보는 메모\n')
    const team = await copy('alice', rooms.all, 'groups/marketing/revoked-room.md')
    // an upload in the same message stays for the next try
    const up = await roomFilesOf(h.ctx).create('alice', rooms.all, 'kept-upload.txt', (() => { const p = path.join(h.dataDir, `up-${uuidv7()}`); fs.writeFileSync(p, 'x'); return p })(), 'e'.repeat(64))
    const before = (await h.api('alice').call(API.listRoomMessages, { params: { id: rooms.all }, query: {} })).items.length
    await h.api('dana').call(API.updateGroup, { params: { id: marketingGroup }, body: { memberIds: ['erin'] } })
    try {
      const r = await h.req('alice', `/api/rooms/${rooms.all}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'ko' }, body: JSON.stringify({ body: '메모 보내요', mentions: [], fileIds: [team.file.id, up.id], clientMessageId: cm() }) })
      expect(r.status).toBe(403)
      const err = (await r.json()) as { error: { message: string; params: { reason: string; files: string } } }
      expect(err.error.params).toMatchObject({ reason: 'team_file_access', files: team.file.id })
      expect(err.error.message).toContain('revoked-room.md')
      // nothing went: no message, no audit row; the copy is gone (row and bytes), even for alice; the upload stays
      expect((await h.api('alice').call(API.listRoomMessages, { params: { id: rooms.all }, query: {} })).items.length).toBe(before)
      expect(auditOf(team.file.id)).toBeNull()
      expect(h.ctx.db.query('SELECT 1 FROM room_files WHERE id = ?').get(team.file.id)).toBeNull()
      expect(fs.existsSync(path.join(roomFilesOf(h.ctx).root(), rooms.all, team.file.id))).toBe(false)
      expect((await read('alice', rooms.all, team.file.id)).status).toBe(404)
      expect((await read('bob', rooms.all, team.file.id)).status).toBe(404)
      expect(h.ctx.db.query('SELECT message_id FROM room_files WHERE id = ?').get(up.id)).toEqual({ message_id: null })
      // the same send without it goes
      expect((await send('alice', rooms.all, [up.id])).files.map((f) => f.id)).toEqual([up.id])
    } finally {
      await h.api('dana').call(API.updateGroup, { params: { id: marketingGroup }, body: { memberIds: ['alice', 'erin'] } })
    }
  })

  test('the team file moved or deleted after the pick: refused the same way (where it went is not mine to check)', async () => {
    put('users/alice/moved-room.md', '# 옮길 메모\n')
    const team = await copy('alice', rooms.all, 'users/alice/moved-room.md')
    fs.rmSync(path.join(h.ctx.files.fx.root, 'users', 'alice', 'moved-room.md'))
    const r = await h.req('alice', `/api/rooms/${rooms.all}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '', mentions: [], fileIds: [team.file.id], clientMessageId: cm() }) })
    expect(r.status).toBe(403)
    expect(h.ctx.db.query('SELECT 1 FROM room_files WHERE id = ?').get(team.file.id)).toBeNull()
  })

  test('picks at the same time cannot pass the cap together; the same pick twice at once is one copy', async () => {
    const png = fs.readFileSync(path.join(import.meta.dir, '../../web/public/icons/icon-192.png'))
    const names = [1, 2, 3, 4, 5].map((i) => `users/carol/pic-${i}.png`)
    for (const n of names) { const abs = path.join(h.ctx.files.fx.root, ...n.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, png) }
    // carol's unsent copies leave room for two of these pictures, not three
    h.ctx.db.query("INSERT INTO room_files (id, room_id, user_id, name, size, mime, kind, sha256, thumb, created_at, team_path, team_stamp) VALUES (?, ?, 'carol', 'big.bin', ?, 'application/octet-stream', 'other', ?, 0, ?, 'users/carol/big.bin', 'x')")
      .run(uuidv7(), rooms.all, TEAM_COPIES_UNSENT_MAX - Math.floor(png.length * 2.5), 'f'.repeat(64), new Date().toISOString())
    const results = await Promise.all(names.map((n) => attach('carol', rooms.all, n)))
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409, 409, 409])
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM room_files WHERE user_id = 'carol' AND message_id IS NULL AND name LIKE 'pic-%'").get() as { n: number }).n).toBe(2)
    // a double tap: two requests for one file at once give one copy
    put('users/carol/twice-room.md', '# 한 번만\n')
    const [a, b] = await Promise.all([copy('carol', rooms.all, 'users/carol/twice-room.md'), copy('carol', rooms.all, 'users/carol/twice-room.md')])
    expect(b.file.id).toBe(a.file.id)
    expect(unsent('carol', 'twice-room.md')).toBe(1)
  })
})
