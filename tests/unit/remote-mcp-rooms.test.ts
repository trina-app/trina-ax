// The person's team chat rooms through the MCP connector (docs/DECISIONS.md "AI 앱에서 대화 읽고 쓰기"): the scopes
// (mcp:rooms ticked at first, mcp:rooms.write its own box and only with reading; an older grant never gains them),
// reads that are the app's own view (the same text as the person's own AI chat reader), room_send through Rooms.send
// (membership, threads, mentions of members named in the text, no "@everyone", the send rate, no label), the
// connection's read scope (nothing sent where people who could not see what was read would read it), no audit line or
// count, and no message text, name or room id in the log. Synthetic people and rooms only.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { RemoteTools } from '../../server/src/connectors/remote-mcp/tools'
import { challenge, OAuthError } from '../../server/src/connectors/remote-mcp/policy'
import { mentionsEveryone, ROOM_TOOLS } from '../../server/src/connectors/remote-mcp/rooms'
import { listRooms, readRoom, searchRooms } from '../../server/src/rooms/reader'
import { roomFilesOf } from '../../server/src/rooms/files'
import { SEND_BURST } from '../../server/src/rooms/service'
import { teamTimeZone } from '../../server/src/admin/settings'
import type { Logger } from '../../server/src/log'
import { addMember, harness, withOwner, type Harness } from './a-lib'

const live: Harness[] = []
afterEach(async () => { for (const h of live.splice(0)) await h.close() })
const redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'v'.repeat(43)
const READS = ['rooms', 'room_read', 'room_file']
type Res = { content: { text: string }[]; isError?: boolean }
const text = (r: Res) => r.content[0]!.text
const cm = () => 'cm-' + crypto.randomUUID()

/** everything the server logged, to check that no message, name or room id is in it */
function recorder() {
  const lines: unknown[] = []
  const log: Logger = { debug: (m, f) => { lines.push([m, f]) }, info: (m, f) => { lines.push([m, f]) }, warn: (m, f) => { lines.push([m, f]) }, error: (m, f) => { lines.push([m, f]) }, child: () => log }
  let from = 0
  /** from here on (the app's own access log names the rooms of the test's own API calls before) */
  const mark = () => { from = lines.length }
  return { log, mark, all: () => JSON.stringify(lines.slice(from), (_k, v) => v instanceof Error ? v.message : v) }
}

async function setup(name: string) {
  const rec = recorder()
  const h = await harness('remote-rooms-' + name, {}, { log: rec.log }); live.push(h)
  const owner = await withOwner(h)
  const reader = await addMember(h, owner, { username: 'reader' }), helper = await addMember(h, owner, { username: 'helper' })
  const third = await addMember(h, owner, { username: 'third' }), outsider = await addMember(h, owner, { username: 'outsider' })
  const oauth = new RemoteOAuth(h.ctx.db, { origin: 'https://team.example' }), tools = new RemoteTools(h.ctx, () => oauth)
  const client = oauth.register({ redirect_uris: [redirect] })
  const request = (scope: string) => new URL(oauth.authorize({ client_id: client.client_id, redirect_uri: redirect, resource: oauth.resource(), response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope })).searchParams.get('id')!
  /** the person with `cookie` allows with the boxes as given (left out: as a page without the conversation boxes) */
  const connect = async (cookie: string, choice: { write?: boolean; rooms?: boolean; roomsWrite?: boolean } = { rooms: true }, scope = 'mcp:read offline_access') => {
    const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie } }), { ip: '10.0.0.7', via: 'test' }))!
    const id = request(scope), consent = oauth.consent(id, auth)
    const code = new URL(oauth.decide(id, auth, true, choice).redirectUrl).searchParams.get('code')!
    const issued = oauth.token({ client_id: client.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: oauth.resource() })
    return { optional: consent.optional, token: issued.access_token, refresh: issued.refresh_token, scope: issued.scope, grant: () => oauth.authenticate(issued.access_token) }
  }
  const names = (token: string) => tools.list(oauth.authenticate(token)).map(t => t.name)
  const call = (token: string, name: string, args: unknown = {}) => tools.call(token, name, args) as Promise<Res>
  const room = async (by: typeof reader, body: Record<string, unknown>) => (await by.client.call('POST', '/api/rooms', body)).id as string
  const say = async (by: typeof reader, roomId: string, body: string, o: { threadRootId?: string; fileIds?: string[] } = {}) =>
    (await by.client.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), mentions: [], fileIds: o.fileIds ?? [], ...(o.threadRootId ? { threadRootId: o.threadRootId } : {}) })) as { id: string; seq: number }
  const rows = (roomId: string) => h.ctx.db.query('SELECT id, author_kind, author_id, body, mentions, thread_root_id FROM room_messages WHERE room_id = ? AND event IS NULL ORDER BY seq').all(roomId) as { id: string; author_kind: string; author_id: string; body: string; mentions: string; thread_root_id: string | null }[]
  const toolAudits = () => (h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'remote_mcp.tool'").all() as { detail: string }[]).map(r => JSON.parse(r.detail) as { tool: string })
  const tz = () => teamTimeZone(h.ctx.db)
  return { h, rec, owner, reader, helper, third, outsider, oauth, tools, client, connect, names, call, room, say, rows, toolAudits, tz }
}

test('the consent offers reading conversations and writing in them; an older page grants neither; writing needs reading', async () => {
  const f = await setup('scopes')
  expect(f.oauth.metadata().scopes_supported).toEqual(expect.arrayContaining(['mcp:rooms', 'mcp:rooms.write']))
  // a page from before (no conversation boxes) or an app that asks for them: the person's boxes decide, never the app
  const old = await f.connect(f.reader.client.cookie!, {}, 'mcp:read mcp:rooms mcp:rooms.write offline_access')
  expect(old.optional).toEqual(['mcp:write', 'mcp:rooms', 'mcp:rooms.write'])
  expect(old.scope).toBe('mcp:read offline_access')
  expect(f.names(old.token).filter(n => ROOM_TOOLS.has(n))).toEqual([])
  for (const n of [...READS, 'room_send']) expect(text(await f.call(old.token, n, { room: 'x', text: 'x', file: 'x' }))).toContain('no permission')
  // such a grant never gains them: a refresh can only narrow
  expect(() => f.oauth.token({ client_id: f.client.client_id, grant_type: 'refresh_token', refresh_token: old.refresh, scope: 'mcp:read mcp:rooms offline_access', resource: f.oauth.resource() })).toThrow(OAuthError)
  expect(JSON.parse(old.grant().scopes)).toEqual(['mcp:read', 'offline_access'])
  // reading only: the three read tools, and room_send is refused
  const reads = await f.connect(f.reader.client.cookie!, { rooms: true })
  expect(reads.scope).toBe('mcp:read mcp:rooms offline_access')
  expect(f.names(reads.token)).toEqual(['list', 'glob', 'grep', 'read', 'skills_list', ...READS])
  const dm = await f.room(f.reader, { kind: 'dm', userId: f.helper.id })
  expect(text(await f.call(reads.token, 'room_send', { room: dm, text: 'hello' }))).toContain('no permission')
  expect(f.rows(dm)).toEqual([])
  // writing without reading is no grant of either
  const odd = await f.connect(f.reader.client.cookie!, { rooms: false, roomsWrite: true })
  expect(odd.scope).toBe('mcp:read offline_access')
  const both = await f.connect(f.reader.client.cookie!, { rooms: true, roomsWrite: true })
  expect(both.scope).toBe('mcp:read mcp:rooms mcp:rooms.write offline_access')
  expect(f.names(both.token)).toEqual(['list', 'glob', 'grep', 'read', 'skills_list', ...READS, 'room_send'])
  const listed = f.tools.list(both.grant())
  for (const n of READS) expect(listed.find(t => t.name === n)!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
  expect(listed.find(t => t.name === 'room_send')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
})

test("reads are the person's own view, word for word what their own AI chat reads, and join the connection's read scope", async () => {
  const f = await setup('view')
  const team = await f.room(f.reader, { kind: 'group', userIds: [f.helper.id, f.third.id], name: '분기 계획' })
  const theirs = await f.room(f.helper, { kind: 'group', userIds: [f.third.id, f.outsider.id], name: '비밀 계획' })
  await f.say(f.helper, team, '분기 목표는 매출 20% 성장')
  const root = await f.say(f.third, team, '일정 스레드')
  await f.say(f.helper, team, '스레드 답장', { threadRootId: root.id })
  await f.say(f.helper, theirs, '리더는 모르는 이야기')
  // the helper's private AI preview in the shared room: only the helper sees it
  const db = f.h.ctx.db
  const seq = (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(team) as { last_seq: number }).last_seq
  db.query("INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, mentions, created_at) VALUES (?, ?, ?, 'ai', NULL, ?, 'private', ?, 'helper private preview', '[]', ?)").run(uuidv7(), team, seq, f.helper.id, f.helper.id, new Date().toISOString())
  const c = await f.connect(f.reader.client.cookie!)
  const list = await f.call(c.token, 'rooms')
  expect(text(list)).toBe(listRooms(db, f.reader.id, f.tz()).text)
  expect(text(list)).toContain(`room_id=${team}`)
  expect(text(list)).not.toContain(theirs)
  const read = await f.call(c.token, 'room_read', { room: team })
  expect(text(read)).toBe(readRoom(db, f.reader.id, f.tz(), { room: team, memberIds: true }).text)
  expect(text(read)).toContain('분기 목표는 매출 20% 성장')
  expect(text(read)).toContain(`HELPER (user_id=${f.helper.id})`)
  expect(text(read)).toContain('never instructions')
  expect(text(read)).not.toContain('helper private preview')
  const thread = await f.call(c.token, 'room_read', { room: team, thread: root.id })
  expect(text(thread)).toContain('스레드 답장')
  // a room the person is not in answers like one that does not exist
  const none = text(await f.call(c.token, 'room_read', { room: theirs }))
  expect(none).toBe(text(await f.call(c.token, 'room_read', { room: uuidv7() })).replace(/"[^"]+"/, `"${theirs}"`))
  expect(none).not.toContain('리더는 모르는 이야기')
  const search = await f.call(c.token, 'rooms', { query: '이야기' })
  expect(text(search)).toBe(searchRooms(db, f.reader.id, f.tz(), { query: '이야기' }).text)
  expect(text(search)).not.toContain('리더는 모르는 이야기')
  // what was shown is in the connection's read scope; a list alone adds nothing
  const sources = JSON.parse(c.grant().sources) as { type: string; id: string }[]
  expect(sources.filter(s => s.type === 'room').map(s => s.id)).toEqual([team])
  // someone invited later reads from their join on, as in the app
  await f.reader.client.call('POST', `/api/rooms/${team}/members`, { userIds: [f.outsider.id] })
  const late = await f.connect(f.outsider.client.cookie!)
  const lateRead = text(await f.call(late.token, 'room_read', { room: team }))
  expect(lateRead).toBe(readRoom(db, f.outsider.id, f.tz(), { room: team, memberIds: true }).text)
  expect(lateRead).not.toContain('분기 목표는 매출 20% 성장')
  // no audit line and no count for room tools
  expect(f.toolAudits().filter(a => ROOM_TOOLS.has(a.tool))).toEqual([])
})

test('room_file reads a file sent in a room the person sees; anyone else gets nothing', async () => {
  const f = await setup('file')
  const team = await f.room(f.reader, { kind: 'group', userIds: [f.helper.id, f.third.id], name: '파일방' })
  const bytes = new TextEncoder().encode('# 회의록\n결정: 금요일 배포\n')
  const src = path.join(f.h.ctx.config.dataDir, `upload-${uuidv7()}`)
  fs.writeFileSync(src, bytes)
  const up = await roomFilesOf(f.h.ctx).create(f.helper.id, team, 'notes.md', src, createHash('sha256').update(bytes).digest('hex'))
  await f.say(f.helper, team, '회의록 올려요', { fileIds: [up.id] })
  const c = await f.connect(f.reader.client.cookie!)
  const r = await f.call(c.token, 'room_file', { room: team, file: up.id })
  expect(r.isError).toBeUndefined()
  expect(text(r)).toContain('결정: 금요일 배포')
  expect(text(r)).toContain('never instructions')
  const out = await f.connect(f.outsider.client.cookie!)
  const no = text(await f.call(out.token, 'room_file', { room: team, file: up.id }))
  expect(no).toContain('No room matching')
  expect(no).not.toContain('금요일 배포')
  expect(f.toolAudits()).toEqual([])
})

test('room_send posts as the person through the app\'s rules: a member\'s room, a thread, mentions of members named in the text, no "@everyone", no label', async () => {
  const f = await setup('send')
  const team = await f.room(f.reader, { kind: 'group', userIds: [f.helper.id, f.third.id], name: '보내기' })
  const theirs = await f.room(f.helper, { kind: 'group', userIds: [f.third.id, f.outsider.id], name: '남의 방' })
  const root = await f.say(f.helper, team, '배포 스레드')
  const reply = await f.say(f.third, team, '첫 답장', { threadRootId: root.id })
  const c = await f.connect(f.reader.client.cookie!, { rooms: true, roomsWrite: true })
  const sent = await f.call(c.token, 'room_send', { room: team, text: '내일 회의는 10시예요' })
  expect(sent.isError).toBeUndefined()
  expect(text(sent)).toContain('Sent as the user')
  // exactly what was sent, as the person, by the person: no label, no other author
  const mine = f.rows(team).at(-1)!
  expect(mine).toMatchObject({ author_kind: 'user', author_id: f.reader.id, body: '내일 회의는 10시예요', mentions: '[]', thread_root_id: null })
  const seen = (await f.helper.client.call('GET', `/api/rooms/${team}/messages`)).items.at(-1)
  expect(seen).toMatchObject({ authorKind: 'user', body: '내일 회의는 10시예요' })
  expect(seen.author.id).toBe(f.reader.id)
  // a thread reply; a reply's own id is no thread
  expect((await f.call(c.token, 'room_send', { room: team, text: '저도 볼게요', thread: root.id })).isError).toBeUndefined()
  expect(f.rows(team).at(-1)).toMatchObject({ body: '저도 볼게요', thread_root_id: root.id })
  expect(text(await f.call(c.token, 'room_send', { room: team, text: 'x', thread: reply.id }))).toContain('No thread')
  // mentions: members only, never themselves, and named in the text as the app writes them
  expect((await f.call(c.token, 'room_send', { room: team, text: '@HELPER 확인 부탁해요', mentions: [f.helper.id] })).isError).toBeUndefined()
  expect(JSON.parse(f.rows(team).at(-1)!.mentions)).toEqual([f.helper.id])
  const before = f.rows(team).length
  expect(text(await f.call(c.token, 'room_send', { room: team, text: '@OUTSIDER 안녕', mentions: [f.outsider.id] }))).toContain('Mention only members')
  expect(text(await f.call(c.token, 'room_send', { room: team, text: '확인 부탁해요', mentions: [f.helper.id] }))).toContain('"@HELPER"')
  expect(text(await f.call(c.token, 'room_send', { room: team, text: '@READER 나', mentions: [f.reader.id] }))).toContain('themselves')
  // "@everyone" in any language is not offered here
  for (const t of ['@전체 공지입니다', '공지 @everyone!', '@全員 確認', '(@todos) hola', '@semua cek', '@ALL hands']) expect(text(await f.call(c.token, 'room_send', { room: team, text: t }))).toContain('@everyone')
  // only by id, and only a room the person is in; an empty message is nothing
  expect(text(await f.call(c.token, 'room_send', { room: '보내기', text: 'by name' }))).toContain('room_id')
  expect(text(await f.call(c.token, 'room_send', { room: theirs, text: '들어가기' }))).toContain('No room with that room_id')
  expect(text(await f.call(c.token, 'room_send', { room: team, text: '   ' }))).toContain('empty')
  expect(f.rows(team).length).toBe(before)
  expect(f.rows(theirs).map(r => r.body)).toEqual([])
  expect(f.toolAudits()).toEqual([])
})

test('"@everyone" is found where a mention may start, a person whose name starts the same is not', () => {
  for (const t of ['@전체', '다들 @전체에게', '@Everyone', '"@all"', '(@semua)', '@全員']) expect(mentionsEveryone(t)).toBe(true)
  for (const t of ['@allison 안녕', 'mail@all.example', '@everyones', '전체 회의', 'e@전체']) expect(mentionsEveryone(t)).toBe(false)
})

test('the send rate is the app\'s: a burst, then refused with the seconds to wait', async () => {
  const f = await setup('rate')
  const dm = await f.room(f.reader, { kind: 'dm', userId: f.helper.id })
  const c = await f.connect(f.reader.client.cookie!, { rooms: true, roomsWrite: true })
  let refused: string | null = null, sent = 0
  for (let i = 0; i < SEND_BURST + 5 && !refused; i++) {
    const r = await f.call(c.token, 'room_send', { room: dm, text: `메시지 ${i}` })
    if (r.isError) refused = text(r); else sent++
  }
  expect(sent).toBeLessThanOrEqual(SEND_BURST)
  expect(refused).toMatch(/Too many messages at once: try again in \d+ seconds/)
  expect(f.rows(dm).length).toBe(sent)
})

test('nothing read through the connection is sent where people who could not see it would read it', async () => {
  const f = await setup('widening')
  const team = await f.room(f.reader, { kind: 'group', userIds: [f.helper.id, f.third.id], name: '넓은 방' })
  const dm = await f.room(f.reader, { kind: 'dm', userId: f.helper.id })
  await f.say(f.helper, dm, '우리끼리 이야기')
  // a file of the person's own folder: only they read it
  const mine = `users/${f.reader.id}/note.txt`
  fs.mkdirSync(path.dirname(path.join(f.h.ctx.config.teamRoot, mine)), { recursive: true })
  fs.writeFileSync(path.join(f.h.ctx.config.teamRoot, mine), 'synthetic private note')
  const a = await f.connect(f.reader.client.cookie!, { rooms: true, roomsWrite: true })
  expect((await f.call(a.token, 'read', { file_path: mine })).isError).toBeUndefined()
  const refused = await f.call(a.token, 'room_send', { room: team, text: 'synthetic private note' })
  expect(refused.isError).toBe(true)
  expect(text(refused)).toContain('Not sent')
  expect(f.rows(team)).toEqual([])
  // a new connection has read nothing; reading the 1:1 then sending there is fine, to a room with more people not
  const b = await f.connect(f.reader.client.cookie!, { rooms: true, roomsWrite: true })
  expect((await f.call(b.token, 'room_send', { room: team, text: '안녕하세요' })).isError).toBeUndefined()
  await f.call(b.token, 'room_read', { room: dm })
  expect((await f.call(b.token, 'room_send', { room: dm, text: '읽었어요' })).isError).toBeUndefined()
  expect(text(await f.call(b.token, 'room_send', { room: team, text: '우리끼리 이야기 요약' }))).toContain('Not sent')
  // in a thread, its readers are those who see its first message
  const root = await f.say(f.helper, team, '스레드 시작')
  const c = await f.connect(f.reader.client.cookie!, { rooms: true, roomsWrite: true })
  await f.call(c.token, 'room_read', { room: team, thread: root.id })
  expect((await f.call(c.token, 'room_send', { room: team, text: '스레드에 답해요', thread: root.id })).isError).toBeUndefined()
  // the read scope holds one source per room, from the oldest message read there
  await f.call(c.token, 'room_read', { room: team })
  const rooms = (JSON.parse(c.grant().sources) as { type: string; id: string; fromSeq?: number }[]).filter(s => s.type === 'room')
  expect(rooms.length).toBe(1)
})

test('no message, name or room id reaches the log', async () => {
  const f = await setup('log')
  const team = await f.room(f.reader, { kind: 'group', userIds: [f.helper.id, f.third.id], name: '로그 비밀방' })
  await f.say(f.helper, team, '로그에 남으면 안 되는 문장')
  const c = await f.connect(f.reader.client.cookie!, { rooms: true, roomsWrite: true })
  f.rec.mark()
  await f.call(c.token, 'rooms', { query: '문장' })
  await f.call(c.token, 'room_read', { room: team })
  await f.call(c.token, 'room_file', { room: team, file: uuidv7() })
  await f.call(c.token, 'room_send', { room: team, text: '보낸 비밀 문장', mentions: [f.helper.id] })
  await f.call(c.token, 'room_send', { room: team, text: '@HELPER 보낸 비밀 문장 둘', mentions: [f.helper.id] })
  const logged = f.rec.all()
  expect(f.rows(team).map(r => r.body)).toContain('@HELPER 보낸 비밀 문장 둘')
  for (const secret of ['로그에 남으면 안 되는 문장', '보낸 비밀 문장', '로그 비밀방', team, 'HELPER']) expect(logged).not.toContain(secret)
})
