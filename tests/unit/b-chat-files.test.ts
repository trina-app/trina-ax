// Files from the computer in a chat shared with people and groups (docs/DECISIONS.md "Files from the computer in a chat
// shared with people", QA TC-1413; server/src/chat/chat-files.ts, chat-file-tool.ts). Alice (marketing) shares a chat
// with bob by name and the marketing group (erin); carol is an admin and dana the owner, neither in it. Covered: an
// upload is kept with the chat (no file under users/), its sender alone opens it before it is sent, then everyone in the
// chat and nobody else; another person's AI reads it with chat_file as themselves; ids from another chat or an upload of
// someone's own folder never open; removal and making the chat private take it away; earlier uploads are copied at the
// share; ✕ before sending, the sweep and deleting the chat for good remove it; safe operations refuse an upload.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Attachment, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { CHAT_FILE_ORPHAN_KEEP_MS, chatFilesOf, UNSENT_CHAT_FILE_MS } from '../../server/src/chat/chat-files'
import { composeMessage } from '../../server/src/chat/turn'
import { readScope } from '../../server/src/chat/read-scope'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-files', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  roomsOf(h.ctx).clock = () => (clock += 10_000)
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const bob: Sub = { subjectType: 'user', subjectId: 'bob' }
const marketing: Sub = { subjectType: 'group', subjectId: 'marketing' }
const put = (user: string, chatId: string, subjects: Sub[], confirmKey?: string): Promise<PutChatAudienceResult> =>
  h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
async function share(user: string, chatId: string, subjects: Sub[]) {
  let r = await put(user, chatId, subjects)
  if (r.status === 'confirm') r = await put(user, chatId, subjects, r.confirmKey)
  if (r.status !== 'saved') throw new Error('not saved')
  return r
}
async function ask(user: string, chatId: string, content: string, attachmentIds: string[] = []) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return { started, done: done.data.message }
}
async function upload(user: string, chatId: string, name: string, content: string | Buffer) {
  const form = new FormData()
  form.set('chatId', chatId)
  form.set('file', new File([typeof content === 'string' ? content : new Uint8Array(content)], name))
  const res = await h.req(user, '/api/uploads', { method: 'POST', body: form })
  return { status: res.status, body: (await res.json()) as Attachment & { error?: { params?: { reason?: string } } } }
}
const fileStatus = async (user: string, chatId: string, id: string, q = '') => (await h.req(user, `/api/chats/${chatId}/files/${id}${q}`)).status
const fileText = async (user: string, chatId: string, id: string) => (await h.req(user, `/api/chats/${chatId}/files/${id}`)).text()
async function sharedChat(text = 'hello') {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  await ask('alice', c.id, `${text}\n${fake({ say: `answer to ${text}` })}`)
  await share('alice', c.id, [bob, marketing])
  return c.id
}
const store = (chatId: string, id = '') => path.join(h.team, '.system', 'chat-files', chatId, id)
const lastMessage = async (user: string, chatId: string) => (await h.api(user).call(API.listMessages, { params: { id: chatId } })).items.filter((m) => m.role === 'user').at(-1)!

describe('a file from the computer in a chat shared with people', () => {
  test('kept with the chat: no file under users/, its sender alone before it is sent, then everyone in it and nobody else', async () => {
    const id = await sharedChat('budget')
    expect((await h.api('bob').call(API.getChat, { params: { id } })).shared?.canUpload).toBe(true)
    const up = await upload('alice', id, 'plan.txt', 'Q3 PLAN 41%')
    expect(up.status).toBe(201)
    expect(up.body).toMatchObject({ source: 'chat', path: '', name: 'plan.txt', kind: 'text' })
    const f = up.body.id
    expect(fs.existsSync(store(id, f))).toBe(true)
    expect(fs.existsSync(path.join(h.team, 'users', 'alice', '.attachments', id))).toBe(false)
    // audited without the name
    const a = db().query("SELECT target, detail FROM audit_log WHERE action = 'chat.file_add' ORDER BY id DESC LIMIT 1").get() as { target: string; detail: string }
    expect(a.target).toBe(id)
    expect(a.detail).not.toContain('plan.txt')
    // not sent yet: only alice
    expect(await fileStatus('alice', id, f)).toBe(200)
    for (const u of ['bob', 'erin', 'carol', 'dana']) expect(await fileStatus(u, id, f)).toBe(404)
    await ask('alice', id, `see the file\n${fake({ say: 'ok' })}`, [f])
    for (const u of ['alice', 'bob', 'erin']) {
      expect(await fileStatus(u, id, f)).toBe(200)
      expect(await fileText(u, id, f)).toBe('Q3 PLAN 41%')
      expect(await fileStatus(u, id, f, '?download=1')).toBe(200)
      // the message shows it to everyone in it (not blanked as someone else's upload)
      expect((await lastMessage(u, id)).attachments[0]).toMatchObject({ id: f, name: 'plan.txt', source: 'chat' })
    }
    for (const u of ['carol', 'dana']) expect(await fileStatus(u, id, f)).toBe(404)
  })

  test('bob uploads too; his AI reads alice\'s file with chat_file as himself; the read scope names the chat', async () => {
    const id = await sharedChat('report')
    const f = (await upload('alice', id, 'notes.md', '# Notes\nThe launch moves to Friday.')).body.id
    await ask('alice', id, `my notes\n${fake({ say: 'ok' })}`, [f])
    const mine = await upload('bob', id, 'bob.txt', 'from bob')
    expect(mine.body.source).toBe('chat')
    const r = await ask('bob', id, `what do the notes say?\n${fake({ tool: 'chat_file', args: { file: f }, sayResult: true })}`, [mine.body.id])
    expect(r.done.content).toContain('The launch moves to Friday.')
    expect(db().query('SELECT user_id FROM turns WHERE id = ?').get(r.started.turnId)).toEqual({ user_id: 'bob' })
    expect(readScope(db(), id)).toContainEqual({ type: 'chat', id })
    // by its exact name too
    const byName = await ask('erin', id, `${fake({ tool: 'chat_file', args: { file: 'bob.txt' }, sayResult: true })}`)
    expect(byName.done.content).toContain('from bob')
    expect(await fileText('alice', id, mine.body.id)).toBe('from bob')
    // the message the engine got names the file and the tool, not a team path
    expect(composeMessage({ content: 'q', attachments: JSON.stringify([mine.body]) })).toContain(`file_id=${mine.body.id}; read it with chat_file`)
  })

  test('ids from elsewhere never open: another chat\'s file, an upload of a private chat; nor can they be sent', async () => {
    const one = await sharedChat('one')
    const two = await sharedChat('two')
    const f = (await upload('alice', one, 'a.txt', 'secret one')).body.id
    await ask('alice', one, `x\n${fake({ say: 'ok' })}`, [f])
    // alice sees both chats: the file is still only through its own chat
    expect(await fileStatus('alice', two, f)).toBe(404)
    expect(await fileStatus('bob', two, f)).toBe(404)
    // an upload in alice's private chat (her own folder) is no chat file
    const priv = (await h.api('alice').call(API.createChat, { body: {} })).id
    const own = await upload('alice', priv, 'own.txt', 'mine alone')
    expect(own.body.source).toBeUndefined()
    expect(await fileStatus('alice', priv, own.body.id)).toBe(404)
    expect(await fileStatus('alice', one, own.body.id)).toBe(404)
    // sent into another chat, or by someone else: not found (the send is refused, nothing is attached)
    const refused = async (user: string, chatId: string) => {
      const r = await h.req(user, `/api/chats/${chatId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'y', clientMessageId: cm(), attachmentIds: [f] }) })
      return r.status
    }
    expect(await refused('alice', two)).toBe(400)
    expect(await refused('bob', one)).toBe(400)
    // the thumbnail by id goes through the file's chat
    expect((await h.req('carol', `/api/uploads/${f}/thumbnail`)).status).toBe(404)
  })

  test('someone taken out loses the files with the chat; private again: its creator alone', async () => {
    const id = await sharedChat('people')
    const f = (await upload('erin', id, 'erin.txt', 'by erin')).body.id
    await ask('erin', id, `mine\n${fake({ say: 'ok' })}`, [f])
    expect(await fileStatus('bob', id, f)).toBe(200)
    await share('alice', id, [marketing])
    expect(await fileStatus('bob', id, f)).toBe(404)
    expect(await fileStatus('erin', id, f)).toBe(200)
    const r = await put('alice', id, [])
    expect(r.status).toBe('saved')
    expect(await fileStatus('erin', id, f)).toBe(404)
    expect(await fileStatus('alice', id, f)).toBe(200)
  })

  test('the creator\'s earlier uploads are copied at the share; the messages point to the copies', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const own = await upload('alice', c, 'earlier.txt', 'from before the share')
    expect(own.body.path).toMatch(/^users\/alice\/\.attachments\//)
    await ask('alice', c, `before\n${fake({ say: 'ok' })}`, [own.body.id])
    // the check says the file will be visible to them, and asks even when nothing else would
    const asked = await put('alice', c, [bob])
    expect(asked).toMatchObject({ status: 'confirm', earlierFiles: 1 })
    const saved = await put('alice', c, [bob], asked.status === 'confirm' ? asked.confirmKey : undefined)
    expect(saved.status).toBe('saved')
    expect(saved.status === 'saved' && saved.filesNotCopied).toBeFalsy()
    const att = (await lastMessage('bob', c)).attachments[0]!
    expect(att).toMatchObject({ source: 'chat', name: 'earlier.txt', path: '' })
    expect(att.id).not.toBe(own.body.id)
    expect(await fileText('bob', c, att.id)).toBe('from before the share')
    expect(db().query('SELECT copied_from FROM chat_files WHERE id = ?').get(att.id)).toEqual({ copied_from: own.body.id })
    expect(db().query("SELECT detail FROM audit_log WHERE action = 'chat.files_copied' AND target = ?").get(c)).toEqual({ detail: JSON.stringify({ files: 1 }) })
    // the original stays where it was
    expect(fs.existsSync(path.join(h.team, ...own.body.path.split('/')))).toBe(true)
  })

  test('a chat made private and then given another audience: its files stay with the people-shared rule (creator alone)', async () => {
    const id = await sharedChat('later')
    const f = (await upload('bob', id, 'bob-only.txt', 'bob file')).body.id
    await ask('bob', id, `b\n${fake({ say: 'ok' })}`, [f])
    expect((await put('alice', id, [])).status).toBe('saved')
    // as if it were moved into a project and shared there (any audience other than its people)
    db().query("UPDATE chats SET shared_at = ? WHERE id = ?").run(new Date().toISOString(), id)
    const m = db().query("SELECT chat_id, attachments, author_id FROM messages WHERE chat_id = ? AND role = 'user' AND instr(attachments, ?) > 0").get(id, f) as { chat_id: string; attachments: string; author_id: string }
    // left out for someone who may not open it, never a nameless "0 B" tile (QA TC-2022)
    expect(h.rt().store.attachmentsOf(m, 'erin')).toEqual([])
    expect(h.rt().store.attachmentsOf(m, 'alice')[0]).toMatchObject({ id: f, name: 'bob-only.txt' })
    db().query('UPDATE chats SET shared_at = NULL WHERE id = ?').run(id)
  })

  test('an earlier upload edited since it was attached is not copied (it stays its sender\'s)', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const own = await upload('alice', c, 'edited.txt', 'as attached')
    await ask('alice', c, `before\n${fake({ say: 'ok' })}`, [own.body.id])
    fs.writeFileSync(path.join(h.team, ...own.body.path.split('/')), 'changed later')
    const r = await share('alice', c, [bob])
    // the creator is told
    expect(r.status === 'saved' && r.filesNotCopied).toBe(1)
    expect((await lastMessage('alice', c)).attachments[0]).toMatchObject({ id: own.body.id })
    expect((await lastMessage('alice', c)).attachments[0]!.source).toBeUndefined()
    expect(db().query('SELECT COUNT(*) AS n FROM chat_files WHERE chat_id = ?').get(c)).toEqual({ n: 0 })
    // bob does not get an empty tile for it (QA TC-2022)
    expect((await lastMessage('bob', c)).attachments).toEqual([])
  })

  test('the share check counts only the earlier uploads that will be copied (QA TC-2022)', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const kept = await upload('alice', c, 'kept.txt', 'as attached')
    const edited = await upload('alice', c, 'edited-later.txt', 'as attached')
    await ask('alice', c, `two\n${fake({ say: 'ok' })}`, [kept.body.id, edited.body.id])
    fs.writeFileSync(path.join(h.team, ...edited.body.path.split('/')), 'changed later')
    const asked = await put('alice', c, [bob])
    expect(asked).toMatchObject({ status: 'confirm', earlierFiles: 1 })
    const saved = await put('alice', c, [bob], asked.status === 'confirm' ? asked.confirmKey : undefined)
    expect(saved.status === 'saved' && saved.filesNotCopied).toBe(1)
    const seen = (await lastMessage('bob', c)).attachments
    expect(seen.map((a) => a.name)).toEqual(['kept.txt'])
    // the sender still sees both
    expect((await lastMessage('alice', c)).attachments.map((a) => a.name)).toEqual(['kept.txt', 'edited-later.txt'])
  })

  test('a photo with GPS: the upload says how many bytes arrived before the place was cut out, on both upload paths (QA TC-2023)', async () => {
    const photo = fs.readFileSync(path.join(import.meta.dir, '../fixtures/exif/portrait-o1.jpg'))
    const id = await sharedChat('gps')
    const up = await upload('alice', id, 'gps.jpg', photo)
    expect(up.status).toBe(201)
    expect(up.body.receivedSize).toBe(photo.length)
    expect(up.body.size).toBeLessThan(photo.length)
    // the chunked path: the sha256 of what arrived is checked before the cut, and the answer says the same
    const sha = new Bun.CryptoHasher('sha256').update(photo).digest('hex')
    const s = await h.api('alice').call(API.createUploadSession, { body: { target: { kind: 'attachment', chatId: id, name: 'gps2.jpg' }, size: photo.length, sha256: sha } })
    expect((await h.req('alice', `/api/upload-sessions/${s.id}/chunks/0`, { method: 'PUT', body: new Uint8Array(photo), headers: { 'content-type': 'application/octet-stream' } })).status).toBe(200)
    const done = await h.api('alice').call(API.completeUploadSession, { params: { id: s.id } })
    expect(done).toMatchObject({ kind: 'attachment', attachment: { source: 'chat', receivedSize: photo.length } })
    // a file kept as it came says nothing more
    const plain = await upload('alice', id, 'plain.txt', 'plain')
    expect(plain.body.receivedSize).toBeUndefined()
    // what others get has no receivedSize (it is the upload's answer only)
    await ask('alice', id, `p\n${fake({ say: 'ok' })}`, [up.body.id])
    expect((await lastMessage('bob', id)).attachments[0]!.receivedSize).toBeUndefined()
  })

  test('a photo\'s place and camera are cut out before others get it, on upload and on the copy at the share', async () => {
    const photo = fs.readFileSync(path.join(import.meta.dir, '../fixtures/exif/portrait-o1.jpg'))
    expect(Buffer.from(photo).toString('latin1')).toContain('GPSLatitude')
    const id = await sharedChat('photos')
    const up = await upload('alice', id, 'site.jpg', photo)
    expect(up.body).toMatchObject({ source: 'chat', kind: 'image' })
    await ask('alice', id, `p\n${fake({ say: 'ok' })}`, [up.body.id])
    const got = Buffer.from(await (await h.req('bob', `/api/chats/${id}/files/${up.body.id}`)).arrayBuffer()).toString('latin1')
    expect(got).not.toContain('GPSLatitude')
    expect(got).not.toContain('FixtureCam')
    // an earlier upload in a private chat, then shared
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const own = await upload('alice', c, 'before.jpg', photo)
    await ask('alice', c, `b\n${fake({ say: 'ok' })}`, [own.body.id])
    await share('alice', c, [bob])
    const copy = (await lastMessage('bob', c)).attachments[0]!
    expect(copy.source).toBe('chat')
    expect(Buffer.from(await (await h.req('bob', `/api/chats/${c}/files/${copy.id}`)).arrayBuffer()).toString('latin1')).not.toContain('GPSLatitude')
    // the original in alice's own folder is as she sent it
    expect(fs.readFileSync(path.join(h.team, ...own.body.path.split('/'))).toString('latin1')).toContain('GPSLatitude')
  })

  test('at most 50 MB a file in such a chat, a chunked upload too (refused when the session is made)', async () => {
    const id = await sharedChat('big')
    const r = await h.req('alice', '/api/upload-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { kind: 'attachment', chatId: id, name: 'big.bin' }, size: 60 * 1024 * 1024, sha256: 'a'.repeat(64) }) })
    expect(r.status).toBe(413)
    expect(((await r.json()) as { error: { params?: { reason?: string } } }).error.params?.reason).toBe('chat_file_too_large')
    // in a private chat a chunked attachment may still be larger
    const priv = (await h.api('alice').call(API.createChat, { body: {} })).id
    const ok = await h.req('alice', '/api/upload-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { kind: 'attachment', chatId: priv, name: 'big.bin' }, size: 60 * 1024 * 1024, sha256: 'a'.repeat(64) }) })
    expect(ok.status).toBe(201)
    await h.req('alice', `/api/upload-sessions/${((await ok.json()) as { id: string }).id}`, { method: 'DELETE' })
  })

  test('the sweep sets row-less files and the folders of chats that are gone aside for 30 days, never deletes them at once', async () => {
    const id = await sharedChat('orphans')
    const stray = store(id, 'not-a-row')
    fs.mkdirSync(store(id), { recursive: true })
    fs.writeFileSync(stray, 'stray')
    const gone = store('01900000-0000-7000-8000-0000000000aa')
    fs.mkdirSync(gone, { recursive: true })
    fs.writeFileSync(path.join(gone, 'x'), 'x')
    const orphans = path.join(h.team, '.system', 'chat-files-orphans')
    // a fresh row-less file stays (a create puts the file a moment before its row)
    chatFilesOf(h.ctx).sweep()
    expect(fs.existsSync(stray)).toBe(true)
    expect(fs.existsSync(gone)).toBe(false)
    chatFilesOf(h.ctx).sweep(Date.now() + 2 * 3600_000)
    expect(fs.existsSync(stray)).toBe(false)
    const found = (dir: string, name: string): boolean => fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.name === name || (e.isDirectory() && found(path.join(dir, e.name), name)))
    expect(found(orphans, 'not-a-row')).toBe(true)
    expect(found(orphans, '01900000-0000-7000-8000-0000000000aa')).toBe(true)
    // gone after 30 days
    chatFilesOf(h.ctx).sweep(Date.now() + CHAT_FILE_ORPHAN_KEEP_MS + 3 * 3600_000)
    expect(fs.readdirSync(orphans)).toEqual([])
  })

  test('the AI is told nothing about an attachment hidden from its person', () => {
    const out = composeMessage({ content: 'q', attachments: JSON.stringify([{ id: 'x', name: '', path: '', size: 0, mime: 'application/octet-stream', kind: 'other', source: 'chat', unavailable: true }]) })
    expect(out).toBe('q')
  })

  test('✕ before sending, the sweep and deleting the chat for good remove the files', async () => {
    const id = await sharedChat('cleanup')
    const a = (await upload('alice', id, 'drop.txt', 'drop me')).body.id
    // someone else's: not theirs to remove
    expect((await h.req('bob', `/api/attachments/${a}`, { method: 'DELETE' })).status).toBe(404)
    expect((await h.req('alice', `/api/attachments/${a}`, { method: 'DELETE' })).status).toBe(200)
    expect(fs.existsSync(store(id, a))).toBe(false)
    expect(chatFilesOf(h.ctx).has(a)).toBe(false)
    // never sent, a day old: swept
    const b = (await upload('alice', id, 'old.txt', 'old')).body.id
    chatFilesOf(h.ctx).sweep(Date.now() + UNSENT_CHAT_FILE_MS + 60_000)
    expect(chatFilesOf(h.ctx).has(b)).toBe(false)
    expect(fs.existsSync(store(id, b))).toBe(false)
    // sent, then the chat deleted and purged
    const c = (await upload('alice', id, 'kept.txt', 'kept')).body.id
    await ask('alice', id, `k\n${fake({ say: 'ok' })}`, [c])
    chatFilesOf(h.ctx).sweep(Date.now() + UNSENT_CHAT_FILE_MS + 60_000)
    expect(chatFilesOf(h.ctx).has(c)).toBe(true)
    await h.api('alice').call(API.deleteChat, { params: { id } })
    expect(await fileStatus('bob', id, c)).toBe(404)
    // the creator still opens it in the trash
    expect(await fileStatus('alice', id, c)).toBe(200)
    h.rt().purgeChat(id)
    expect(db().query('SELECT COUNT(*) AS n FROM chat_files WHERE chat_id = ?').get(id)).toEqual({ n: 0 })
    expect(fs.existsSync(store(id))).toBe(false)
  })

  test('safe operations: no upload into the chat (the chat is read-only)', async () => {
    const id = await sharedChat('safe')
    process.env.MYCEL_SAFE_OPS_1A = '1'
    try {
      const r = await upload('alice', id, 'x.txt', 'x')
      expect([r.status, r.body.error?.params?.reason]).toEqual([409, 'safe_ops'])
      expect((await h.api('bob').call(API.getChat, { params: { id } })).shared?.canUpload).toBe(false)
    } finally { delete process.env.MYCEL_SAFE_OPS_1A }
  })
})

