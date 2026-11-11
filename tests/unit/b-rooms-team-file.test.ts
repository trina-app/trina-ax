// "팀 파일" in a room's message box (a phone's attach sheet; shared/src/api/rooms.ts attachRoomTeamFile, the route in
// server/src/routes/rooms.ts): a team file I may read now becomes my upload in a room I am in, the copy "대화방에 보내기"
// makes of a linked file (rooms/files.ts fromTeamFile), and is sent by id like any upload. Covered: the copy and the
// count of other members who cannot open the team file (never who; a disabled account counts), my read access now
// (another group's file, a missing one, a folder, a link, a quarantined file: all 404 alike), a room I am not in, the
// 50 MB limit, a bad path, the copy readable by the room only once sent, and the audit row (the path, the room as room
// audits name it, never the contents). The fixture team: alice and erin in marketing, bob in finance, carol admin, dana
// owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, SMALL_UPLOAD_MAX, uuidv7, type Room, type RoomMessage, type RoomTeamFile } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let rooms: { all: string; marketing: string; finance: string; dm: string }
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

  test('audited: who, the path, the room (a DM by its kind only), the count; never the contents', async () => {
    put('users/alice/audit-room.md', '아무도 보면 안 되는 내용\n')
    const team = await copy('alice', rooms.all, 'users/alice/audit-room.md')
    const row = auditOf(team.file.id)!
    expect(row.actor_id).toBe('alice')
    expect(row.target).toBe('users/alice/audit-room.md')
    expect(JSON.parse(row.detail)).toEqual({ roomId: rooms.all, file: team.file.id, unable: 4 })
    const dm = await copy('alice', rooms.dm, 'users/alice/audit-room.md')
    const dmDetail = JSON.parse(auditOf(dm.file.id)!.detail)
    expect(dmDetail).toEqual({ kind: 'dm', file: dm.file.id, unable: 1 })
    expect(JSON.stringify([row, dmDetail])).not.toContain('보면 안 되는')
  })
})
