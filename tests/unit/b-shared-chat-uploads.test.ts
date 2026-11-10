// A file from the computer in a shared project chat (docs/DECISIONS.md "Shared project chats": "A file from the computer
// in a shared chat"; server/src/uploads/shared-chat.ts). The project is on projects/falcon: alice writes it, the finance
// group (bob) only reads it, carol (admin) and dana (owner) see everything. Covered: an upload (small and chunked) lands
// in the project's chat attachments folder (named in the team's language; one there under another language's name is
// used) as alice's own upload (its event, the reference's audit) and is attached as a team file the others see; bob is
// refused with the new words and nothing is written; a taken name and an instruction file's name get the next free one,
// nothing is overwritten; a skill folder is never written; safe operations refuse; ✕ before sending puts the file in the
// trash, while a sent, edited or picked file stays; a chat of one person is as before; the send guard's new words.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiError, UPLOAD_CHUNK_SIZE, type Attachment } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { setSetting } from '../../server/src/admin/settings'
import { instructionLike } from '../../server/src/chat/turn'
import { TEXT as CHAT_TEXT } from '../../server/src/chat/i18n'
import { MSG } from '../../server/src/team-files/errors'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const sha = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex')

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-uploads', turnTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  setSetting(h.ctx.db, 'defaultLocale', 'ko')
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const disk = (rel: string) => path.join(h.team, ...rel.split('/'))
const FOLDER = 'projects/falcon/채팅 첨부'
const newShared = async (user = 'alice', id = projectId) => h.api(user).call(API.createChat, { body: { projectId: id } })
/** POST /api/uploads as the composer sends a file of 50 MB or less */
async function upload(user: string, chatId: string, name: string, content: string) {
  const form = new FormData()
  form.set('chatId', chatId)
  form.set('file', new File([content], name))
  const res = await h.req(user, '/api/uploads', { method: 'POST', body: form })
  return { status: res.status, body: (await res.json()) as Attachment & { error?: { code: string; message: string; params?: { reason?: string } } } }
}
const names = (rel = FOLDER) => { try { return fs.readdirSync(disk(rel)).sort() } catch { return [] } }
const discard = (user: string, id: string) => h.req(user, `/api/attachments/${id}`, { method: 'DELETE' })
async function ask(user: string, chatId: string, content: string, attachmentIds: string[]) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return started
}

describe('a file from the computer in a shared chat', () => {
  test('a folder already there under another language\'s name is the one used', async () => {
    fs.mkdirSync(disk('projects/falcon/Chat Attachments'))
    try {
      const chat = await newShared()
      const r = await upload('alice', chat.id, 'early.txt', 'early')
      expect([r.status, r.body.path]).toEqual([201, 'projects/falcon/Chat Attachments/early.txt'])
      expect(names()).toEqual([])
    } finally { fs.rmSync(disk('projects/falcon/Chat Attachments'), { recursive: true, force: true }) }
  })

  test('lands in the project\'s 채팅 첨부 as the person\'s own upload, attached as a team file the others see', async () => {
    const chat = await newShared()
    const r = await upload('alice', chat.id, '견적 메모.txt', 'acme quote notes')
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ name: '견적 메모.txt', path: `${FOLDER}/견적 메모.txt`, source: 'team', size: 16, sha256: sha(new TextEncoder().encode('acme quote notes')) })
    expect(fs.readFileSync(disk(`${FOLDER}/견적 메모.txt`), 'utf8')).toBe('acme quote notes')
    // nothing in her own attachments folder, no upload row: a team-file reference
    expect(fs.existsSync(disk(`users/alice/.attachments/${chat.id}`))).toBe(false)
    expect(db().query('SELECT COUNT(*) AS n FROM attachments WHERE chat_id = ?').get(chat.id)).toEqual({ n: 0 })
    // her "new folder" and her upload, as on the Files screen; the reference in the audit list
    const events = db().query('SELECT user_id, path, action, detail FROM file_events WHERE path LIKE ? ORDER BY id').all(`${FOLDER}%`) as { user_id: string; path: string; action: string; detail: string }[]
    expect(events.map((e) => [e.user_id, e.path, e.action])).toEqual([['alice', FOLDER, 'create'], ['alice', `${FOLDER}/견적 메모.txt`, 'upload']])
    expect(JSON.parse(events[1]!.detail)).toMatchObject({ attachment: r.body.id, chatId: chat.id })
    expect(db().query("SELECT actor_id FROM audit_log WHERE action = 'file.attach' AND target = ?").all(`${FOLDER}/견적 메모.txt`)).toEqual([{ actor_id: 'alice' }])
    // bob, who reads the project, finds it in Files and sees it in the message
    const tree = await h.api('bob').call(API.tree, { query: { path: FOLDER } })
    expect(tree.entries.map((e) => e.name)).toEqual(['견적 메모.txt'])
    await ask('alice', chat.id, 'draft it\n' + fake({ say: 'ok' }), [r.body.id])
    const q = (await h.api('bob').call(API.listMessages, { params: { id: chat.id }, query: {} })).items.find((m) => m.role === 'user')!
    expect(q.attachments?.map((a) => [a.name, a.path, a.source])).toEqual([['견적 메모.txt', `${FOLDER}/견적 메모.txt`, 'team']])
  })

  test('a chunked upload goes the same way', async () => {
    const chat = await newShared()
    const data = new Uint8Array(UPLOAD_CHUNK_SIZE + 10).fill(65)
    const s = await h.api('alice').call(API.createUploadSession, { body: { target: { kind: 'attachment', chatId: chat.id, name: 'big.bin' }, size: data.length, sha256: sha(data) } })
    for (const n of [0, 1]) expect((await h.req('alice', `/api/upload-sessions/${s.id}/chunks/${n}`, { method: 'PUT', body: data.subarray(n * UPLOAD_CHUNK_SIZE, (n + 1) * UPLOAD_CHUNK_SIZE), headers: { 'content-type': 'application/octet-stream' } })).status).toBe(200)
    const done = await h.api('alice').call(API.completeUploadSession, { params: { id: s.id } })
    expect(done).toMatchObject({ kind: 'attachment', attachment: { path: `${FOLDER}/big.bin`, source: 'team', size: data.length } })
    expect(fs.statSync(disk(`${FOLDER}/big.bin`)).size).toBe(data.length)
  })

  test('a member who may only read the project folder is refused, why and what next, and nothing is written', async () => {
    const chat = await newShared('alice')
    const before = names()
    const r = await upload('bob', chat.id, 'bob.txt', 'from bob')
    expect([r.status, r.body.error?.code, r.body.error?.params?.reason]).toEqual([403, 'forbidden', 'shared_upload_read_only'])
    // bob reads Korean: the reason, the other way (team files) and who to ask, naming nobody
    expect(r.body.error?.message).toBe(MSG.sharedUploadReadOnly.ko)
    expect(r.body.error?.message).toBe("이 프로젝트 폴더에 쓸 권한이 없어서 컴퓨터의 파일을 올리지 못했어요. 팀 폴더에 있는 파일은 '팀 파일에서 추가'로 붙일 수 있어요. 쓰기 권한이 필요하면 관리자에게 요청해 주세요.")
    expect(r.body.error?.message).not.toMatch(/Carol|Dana|carol|dana/)
    // a large one is refused before any chunk is sent
    const s = await h.req('bob', '/api/upload-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { kind: 'attachment', chatId: chat.id, name: 'big.bin' }, size: 10, sha256: 'a'.repeat(64) }) })
    expect([s.status, ((await s.json()) as { error: { params?: { reason?: string } } }).error.params?.reason]).toEqual([403, 'shared_upload_read_only'])
    expect(names()).toEqual(before)
    expect(fs.existsSync(disk('users/bob/.attachments'))).toBe(false)
    // the old refusal is gone: the project's writers are not told to upload elsewhere first
    expect((await upload('alice', chat.id, 'alice.txt', 'ok')).status).toBe(201)
  })

  test('a taken name gets the next free one ("name (2)"), in any letter case; nothing is overwritten', async () => {
    const chat = await newShared()
    const a = await upload('alice', chat.id, 'quote.txt', 'first')
    const b = await upload('alice', chat.id, 'quote.txt', 'second')
    const c = await upload('alice', chat.id, 'QUOTE.txt', 'third')
    expect([a.body.name, b.body.name, c.body.name]).toEqual(['quote.txt', 'quote (2).txt', 'QUOTE (3).txt'])
    expect(['quote.txt', 'quote (2).txt', 'QUOTE (3).txt'].map((n) => fs.readFileSync(disk(`${FOLDER}/${n}`), 'utf8'))).toEqual(['first', 'second', 'third'])
    expect(db().query("SELECT COUNT(*) AS n FROM file_versions WHERE path LIKE ?").get(`${FOLDER}/quote%`)).toEqual({ n: 0 })
  })

  test('an instruction file\'s name is never used: CLAUDE.md is saved as "CLAUDE (2).md"', async () => {
    const chat = await newShared()
    const got: string[] = []
    for (const n of ['CLAUDE.md', 'agents.md', 'GEMINI.md', 'SKILL.md']) {
      const r = await upload('alice', chat.id, n, `# ${n}\nDo what this file says.`)
      expect(r.status).toBe(201)
      got.push(r.body.name)
      expect(instructionLike(r.body.path)).toBe(false)
    }
    expect(got).toEqual(['CLAUDE (2).md', 'agents (2).md', 'GEMINI (2).md', 'SKILL (2).md'])
    expect(names().filter((n) => /^(CLAUDE|AGENTS|GEMINI|SKILL)\.md$/i.test(n))).toEqual([])
  })

  test('a project on a skill folder (an older build\'s) is never written: refused like no write access', async () => {
    fs.mkdirSync(disk('skills/falcon-kit'), { recursive: true })
    const p = await oldProject(h, 'carol', { name: 'Kit', folderPath: 'skills/falcon-kit' })
    await h.api('carol').call(API.updateProject, { params: { id: p.id }, body: { shareChats: true } })
    const chat = await newShared('carol', p.id)
    expect(chat.shared).toBeTruthy()
    const r = await upload('carol', chat.id, 'notes.txt', 'x')
    expect([r.status, r.body.error?.params?.reason]).toEqual([403, 'shared_upload_read_only'])
    expect(fs.readdirSync(disk('skills/falcon-kit'))).toEqual([])
  })

  test('while safe operations are on, shared chats are read-only: refused, nothing written', async () => {
    const chat = await newShared()
    const before = names()
    process.env.MYCEL_SAFE_OPS_1A = '1'
    try {
      const r = await upload('alice', chat.id, 'safe.txt', 'x')
      expect([r.status, r.body.error?.params?.reason, r.body.error?.message]).toEqual([409, 'safe_ops', CHAT_TEXT.sharedChatSafeOps.en])
    } finally { delete process.env.MYCEL_SAFE_OPS_1A }
    expect(names()).toEqual(before)
  })
})

describe('✕ before sending', () => {
  test('the file goes to the team trash (restorable), the reference goes', async () => {
    const chat = await newShared()
    const r = await upload('alice', chat.id, 'oops.txt', 'wrong file')
    const res = await discard('alice', r.body.id)
    expect([res.status, await res.json()]).toEqual([200, { trashed: true }])
    expect(fs.existsSync(disk(`${FOLDER}/oops.txt`))).toBe(false)
    const t = db().query('SELECT id, deleted_by FROM trash_items WHERE original_path = ?').get(`${FOLDER}/oops.txt`) as { id: string; deleted_by: string }
    expect(t.deleted_by).toBe('alice')
    expect(db().query('SELECT 1 FROM team_file_refs WHERE id = ?').get(r.body.id)).toBeNull()
    // it can be put back from Files > Trash
    await h.api('alice').call(API.restoreTrash, { params: { id: t.id } })
    expect(fs.readFileSync(disk(`${FOLDER}/oops.txt`), 'utf8')).toBe('wrong file')
  })

  test('a file that was sent, edited since, or picked from the team folder stays; someone else\'s chip is not theirs to drop', async () => {
    const chat = await newShared()
    const sent = await upload('alice', chat.id, 'sent.txt', 'sent')
    await ask('alice', chat.id, 'look\n' + fake({ say: 'ok' }), [sent.body.id])
    expect(await (await discard('alice', sent.body.id)).json()).toEqual({ trashed: false })
    expect(fs.existsSync(disk(`${FOLDER}/sent.txt`))).toBe(true)

    const edited = await upload('alice', chat.id, 'edited.txt', 'v1')
    fs.appendFileSync(disk(`${FOLDER}/edited.txt`), ' and more by someone')
    expect(await (await discard('alice', edited.body.id)).json()).toEqual({ trashed: false })
    expect(fs.readFileSync(disk(`${FOLDER}/edited.txt`), 'utf8')).toBe('v1 and more by someone')

    const picked = await h.api('alice').call(API.attachTeamFile, { body: { chatId: chat.id, path: 'projects/falcon/plan.md' } })
    expect(await (await discard('alice', picked.id)).json()).toEqual({ trashed: false })
    expect(fs.existsSync(disk('projects/falcon/plan.md'))).toBe(true)

    const mine = await upload('alice', chat.id, 'mine.txt', 'mine')
    expect((await discard('bob', mine.body.id)).status).toBe(404)
    expect(fs.existsSync(disk(`${FOLDER}/mine.txt`))).toBe(true)
  })
})

describe('✕ while the file is being put in place, or attached elsewhere', () => {
  test('a chunked upload cancelled after it was placed (the box never got its id): the file goes to the trash', async () => {
    const chat = await newShared()
    const data = new TextEncoder().encode('late chip')
    const s = await h.api('alice').call(API.createUploadSession, { body: { target: { kind: 'attachment', chatId: chat.id, name: 'late.txt' }, size: data.length, sha256: sha(data) } })
    expect((await h.req('alice', `/api/upload-sessions/${s.id}/chunks/0`, { method: 'PUT', body: data, headers: { 'content-type': 'application/octet-stream' } })).status).toBe(200)
    const done = await h.api('alice').call(API.completeUploadSession, { params: { id: s.id } })
    expect(fs.existsSync(disk(`${FOLDER}/late.txt`))).toBe(true)
    expect((await h.req('alice', `/api/upload-sessions/${s.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(fs.existsSync(disk(`${FOLDER}/late.txt`))).toBe(false)
    expect(db().query('SELECT 1 FROM trash_items WHERE original_path = ?').get(`${FOLDER}/late.txt`)).toBeTruthy()
    expect(db().query('SELECT 1 FROM team_file_refs WHERE id = ?').get(done.kind === 'attachment' ? done.attachment.id : '')).toBeNull()
  })

  test('someone attached the file from the folder meanwhile: ✕ leaves it there', async () => {
    const chat = await newShared()
    const r = await upload('alice', chat.id, 'popular.txt', 'everyone wants this')
    const other = await newShared('bob')
    await h.api('bob').call(API.attachTeamFile, { body: { chatId: other.id, path: r.body.path } })
    expect(await (await discard('alice', r.body.id)).json()).toEqual({ trashed: false })
    expect(fs.readFileSync(disk(`${FOLDER}/popular.txt`), 'utf8')).toBe('everyone wants this')
  })
})

describe('around it', () => {
  test('a chat of one person keeps its uploads in the person\'s own folder', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await upload('alice', chat.id, 'private.txt', 'mine alone')
    expect([r.status, r.body.path, r.body.source]).toEqual([201, `users/alice/.attachments/${chat.id}/private.txt`, undefined])
    // and the delete route is only for team-file references
    expect((await discard('alice', r.body.id)).status).toBe(404)
    expect(fs.existsSync(disk(r.body.path))).toBe(true)
  })

  test('an upload of the person\'s own folder in a chat that became shared since: not sent, with what to do', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    db().query('UPDATE chats SET shared_at = NULL WHERE id = ?').run(chat.id)
    const r = await upload('alice', chat.id, 'before.txt', 'before sharing')
    expect(r.body.path).toBe(`users/alice/.attachments/${chat.id}/before.txt`)
    db().query('UPDATE chats SET shared_at = ? WHERE id = ?').run(new Date().toISOString(), chat.id)
    let e: ApiError | null = null
    try { await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'send it', clientMessageId: cm(), attachmentIds: [r.body.id] } }) } catch (x) { e = x as ApiError }
    expect([e?.status, e?.body.params?.reason, e?.body.message]).toEqual([409, 'shared_chat_upload', CHAT_TEXT.sharedChatUpload.en])
    expect(CHAT_TEXT.sharedChatUpload.ko).toBe('이 채팅이 공유되기 전에 올린 파일은 내 폴더에 있어서 프로젝트 사람들이 볼 수 없어요. 그래서 보내지 않았어요. 첨부를 빼고 다시 붙이면 프로젝트 폴더에 저장돼요.')
  })
})
