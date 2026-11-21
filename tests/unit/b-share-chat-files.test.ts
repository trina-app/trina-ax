// A chat's own files, shared with the chat (docs/decisions/20261121-share-chat-files.md; server/src/chat/
// chat-files-share.ts, people-share.ts, access-requests.ts). Alice's private chat makes files in her own folder; she
// shares it with bob. Covered: which files the Share step lists (made here, her own folder, unchanged; not a team
// folder, not another chat's, not one written over since), "Share with files" copies them attached to the answers that
// made them and the originals stay, sharing again copies nothing twice, the re-check at the press (bytes changed on disk:
// nothing saved or copied, asked again), the sweep leaves attached copies, the panel's file-access answers one generic
// 'no' for every probe, bob's ask and alice's [Add to the chat] (the same check again), his AI reading the copy, and
// waiting asks closed when he leaves.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Attachment, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { chatFilesOf, UNSENT_CHAT_FILE_MS } from '../../server/src/chat/chat-files'
import { madeFilesOf } from '../../server/src/chat/chat-files-share'
import { labelledTranscript } from '../../server/src/chat/shared'
import { getChatRuntime } from '../../server/src/chat/runtime'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const write = (file_path: string, content: string) => ({ tool: 'write', args: { file_path, content } })

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-share-chat-files', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const bob: Sub = { subjectType: 'user', subjectId: 'bob' }
const put = (user: string, chatId: string, subjects: Sub[], o: { confirmKey?: string; withFiles?: boolean } = {}): Promise<PutChatAudienceResult> =>
  h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...o } })
const preview = (chatId: string, subjects: Sub[]) => h.api('alice').call(API.previewChatAudience, { params: { id: chatId }, body: { subjects } })
async function ask(user: string, chatId: string, content: string) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm() } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return { started, done: done.data.message }
}
const team = (rel: string) => path.join(h.team, ...rel.split('/'))
let n = 0
/** A private chat of alice's whose first answer writes `files` in her own folder; its id, the folder and that answer */
async function madeChat(files: Record<string, string>, extra: unknown[] = []) {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  const dir = `users/alice/quotes-${++n}-${crypto.randomUUID().slice(0, 6)}`
  const r = await ask('alice', c.id, `make the quote\n${fake(...Object.entries(files).map(([name, body]) => write(`${dir}/${name}`, body)), ...extra, { say: 'made' })}`)
  return { id: c.id, dir, answer: r.started.assistantMessage.id }
}
const access = async (user: string, chatId: string, p: string) => {
  const res = await h.req(user, `/api/chats/${chatId}/file-access?path=${encodeURIComponent(p)}`)
  return { status: res.status, body: res.status === 200 ? await res.json() : null }
}
const askFor = async (user: string, chatId: string, p: string) => {
  const res = await h.req(user, `/api/chats/${chatId}/file-access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const fileStatus = async (user: string, chatId: string, id: string) => (await h.req(user, `/api/chats/${chatId}/files/${id}`)).status
const fileText = async (user: string, chatId: string, id: string) => (await h.req(user, `/api/chats/${chatId}/files/${id}`)).text()
const copiesOf = (chatId: string): (Attachment & { messageId: string })[] =>
  (db().query("SELECT id, attachments FROM messages WHERE chat_id = ? AND role = 'assistant'").all(chatId) as { id: string; attachments: string }[])
    .flatMap((m) => (JSON.parse(m.attachments) as Attachment[]).filter((a) => a.origin === 'shared-copy').map((a) => ({ ...a, messageId: m.id })))
/** Share with bob and the files, through the preview's key */
async function shareWithFiles(chatId: string) {
  const p = await preview(chatId, [bob])
  return { p, r: await put('alice', chatId, [bob], { confirmKey: p.previewKey, withFiles: true }) }
}

describe('the Share step lists the files the chat made in my own folder', () => {
  test('made here and unchanged: listed with the folder in my words; a team folder, another chat\'s file and one written over since: not', async () => {
    const other = await madeChat({ 'other.md': 'from another chat' })
    const shared = `shared/share-files-${crypto.randomUUID().slice(0, 6)}.md`
    const c = await madeChat({ 'quote.md': '# Quote\npen 6,000', 'quote.html': '<h1>Quote</h1>', 'gone.md': 'x' }, [write(shared, 'team file'), { tool: 'read', args: { file_path: `${other.dir}/other.md` } }, write(`${other.dir}/other.md`, 'written over')])
    // a later answer writes over gone.md from another chat: not this chat's file any more
    await ask('alice', other.id, `${fake({ tool: 'read', args: { file_path: `${c.dir}/gone.md` } }, write(`${c.dir}/gone.md`, 'written over by the other chat'), { say: 'ok' })}`)
    expect(fs.readFileSync(team(`${c.dir}/gone.md`), 'utf8')).toBe('written over by the other chat')
    expect(fs.readFileSync(team(`${other.dir}/other.md`), 'utf8')).toBe('written over')
    const p = await preview(c.id, [bob])
    expect(p.check.madeFiles?.map((f) => f.name).sort()).toEqual(['quote.html', 'quote.md'])
    expect(p.check.madeFiles![0]!.place).toContain(c.dir.split('/')[2]!)
    expect(p.check.madeFiles![0]!.place).not.toContain('users/')
    // the other chat lists only what it made itself and nothing else wrote over (other.md was, by c's answer)
    expect(madeFilesOf(h.ctx, { id: other.id, user_id: 'alice' }).map((f) => f.name)).toEqual([])
  })

  test('Share with files: copies attached to the answer that made them, everyone opens them, the originals stay; sharing again copies nothing twice', async () => {
    const c = await madeChat({ 'quote.md': '# Quote\npen 6,000', 'quote.html': '<h1>Quote</h1>' })
    const { r } = await shareWithFiles(c.id)
    expect(r.status).toBe('saved')
    if (r.status !== 'saved') return
    expect(r.filesAdded).toBe(2)
    const copies = copiesOf(c.id)
    expect(copies.map((a) => a.name).sort()).toEqual(['quote.html', 'quote.md'])
    for (const a of copies) {
      expect(a).toMatchObject({ source: 'chat', origin: 'shared-copy', from: `${c.dir}/${a.name}` })
      expect(a.messageId).toBe(c.answer)
      expect(a.fromSha256).toMatch(/^[0-9a-f]{64}$/)
      for (const u of ['alice', 'bob']) expect(await fileStatus(u, c.id, a.id)).toBe(200)
      for (const u of ['carol', 'dana']) expect(await fileStatus(u, c.id, a.id)).toBe(404)
    }
    expect(await fileText('bob', c.id, copies.find((a) => a.name === 'quote.md')!.id)).toBe('# Quote\npen 6,000')
    // bob sees the copies on the answer
    const msgs = await h.api('bob').call(API.listMessages, { params: { id: c.id } })
    expect(msgs.items.find((m) => m.id === c.answer)!.attachments.filter((a) => a.origin === 'shared-copy')).toHaveLength(2)
    // the originals are where they were, unchanged, and still alice's alone
    expect(fs.readFileSync(team(`${c.dir}/quote.md`), 'utf8')).toBe('# Quote\npen 6,000')
    expect((await h.req('bob', `/api/files/download?path=${encodeURIComponent(`${c.dir}/quote.md`)}`)).status).toBe(404)
    // audited with counts only
    const audit = db().query("SELECT detail FROM audit_log WHERE action = 'chat.files_added' AND target = ? ORDER BY id DESC LIMIT 1").get(c.id) as { detail: string }
    expect(JSON.parse(audit.detail)).toEqual({ count: 2, via: 'share' })
    // already shared, nothing new: the audience offers no files, and a save with files has nothing to copy
    const aud = await h.api('alice').call(API.getChatAudience, { params: { id: c.id } })
    expect(aud.madeFiles).toBeUndefined()
    const again = await put('alice', c.id, [bob], { withFiles: true })
    expect(again.status).toBe('confirm')
    if (again.status === 'confirm') expect(again.check.madeFiles).toBeUndefined()
    expect(copiesOf(c.id)).toHaveLength(2)
  })

  test('an already-shared chat: the audience lists the files with a key; withFiles with that key adds them', async () => {
    const c = await madeChat({ 'brief.md': 'brief' })
    // shared without the files (the owner's case)
    const p = await preview(c.id, [bob])
    expect(p.check.madeFiles).toHaveLength(1)
    const r = await put('alice', c.id, [bob], { confirmKey: p.previewKey })
    expect(r.status).toBe('saved')
    expect(copiesOf(c.id)).toHaveLength(0)
    const aud = await h.api('alice').call(API.getChatAudience, { params: { id: c.id } })
    expect(aud.madeFiles?.map((f) => f.name)).toEqual(['brief.md'])
    expect(aud.madeFilesKey).toBeTruthy()
    // bob, who is in it, never gets the list
    expect((await h.api('bob').call(API.getChatAudience, { params: { id: c.id } })).madeFiles).toBeUndefined()
    // without the key: the step (confirm), nothing copied
    const noKey = await put('alice', c.id, [bob], { withFiles: true })
    expect(noKey).toMatchObject({ status: 'confirm', reason: 'unchecked', check: { added: 0, madeFiles: [{ name: 'brief.md' }] } })
    expect(copiesOf(c.id)).toHaveLength(0)
    const ok = await put('alice', c.id, [bob], { withFiles: true, confirmKey: aud.madeFilesKey })
    expect(ok).toMatchObject({ status: 'saved', filesAdded: 1 })
    expect(copiesOf(c.id).map((a) => a.name)).toEqual(['brief.md'])
  })

  test('the re-check at the press: bytes changed on disk since the step was shown: nothing saved or copied, asked again without that file', async () => {
    const c = await madeChat({ 'a.md': 'first', 'b.md': 'second' })
    const p = await preview(c.id, [bob])
    expect(p.check.madeFiles).toHaveLength(2)
    // changed outside the file layer (no file event): the record still says the old sha256
    fs.writeFileSync(team(`${c.dir}/a.md`), 'CHANGED AFTER THE STEP')
    const r = await put('alice', c.id, [bob], { confirmKey: p.previewKey, withFiles: true })
    expect(r.status).toBe('confirm')
    if (r.status !== 'confirm') return
    expect(r.reason).toBe('changed')
    expect(r.check.madeFiles?.map((f) => f.name)).toEqual(['b.md'])
    // nothing was saved: bob does not see the chat, and nothing was copied
    expect((await h.req('bob', `/api/chats/${c.id}`)).status).toBe(404)
    expect(copiesOf(c.id)).toHaveLength(0)
    // with the new key: only b.md
    const ok = await put('alice', c.id, [bob], { confirmKey: r.confirmKey, withFiles: true })
    expect(ok).toMatchObject({ status: 'saved', filesAdded: 1 })
    expect(copiesOf(c.id).map((a) => a.name)).toEqual(['b.md'])
  })

  test('a file saved on the Files screen after the step was shown: no longer the chat\'s file, the key no longer fits, asked again', async () => {
    const c = await madeChat({ 'plan.md': 'v1' })
    await put('alice', c.id, [bob], { confirmKey: (await preview(c.id, [bob])).previewKey })
    const aud = await h.api('alice').call(API.getChatAudience, { params: { id: c.id } })
    expect(aud.madeFiles).toHaveLength(1)
    const base = (db().query("SELECT sha256 FROM file_events WHERE path = ? ORDER BY id DESC LIMIT 1").get(`${c.dir}/plan.md`) as { sha256: string }).sha256
    await h.api('alice').call(API.saveContent, { body: { path: `${c.dir}/plan.md`, content: 'v2 by hand', baseSha256: base } })
    const r = await put('alice', c.id, [bob], { withFiles: true, confirmKey: aud.madeFilesKey })
    expect(r).toMatchObject({ status: 'confirm', reason: 'changed', check: { added: 0 } })
    if (r.status === 'confirm') expect(r.check.madeFiles).toBeUndefined()
    expect(copiesOf(c.id)).toHaveLength(0)
  })

  test('the sweep of unsent uploads leaves the attached copies', async () => {
    const c = await madeChat({ 'keep.md': 'keep me' })
    await shareWithFiles(c.id)
    const [copy] = copiesOf(c.id)
    chatFilesOf(h.ctx).sweep(Date.now() + UNSENT_CHAT_FILE_MS * 3)
    expect(await fileStatus('bob', c.id, copy!.id)).toBe(200)
    expect(db().query('SELECT 1 FROM chat_files WHERE id = ?').get(copy!.id)).toBeTruthy()
  })
})

describe('the panel: a file link that does not open, and the ask', () => {
  test('a probe gets one generic answer: a path the chat never made, a missing one, a team file, someone else\'s; the creator too; outsiders the chat\'s 404', async () => {
    const c = await madeChat({ 'real.md': 'real' })
    fs.mkdirSync(team('users/alice/private'), { recursive: true })
    fs.writeFileSync(team('users/alice/private/salary.md'), 'not in the chat')
    await put('alice', c.id, [bob], { confirmKey: (await preview(c.id, [bob])).previewKey })
    const no = { status: 200, body: { status: 'no' } }
    for (const p of ['users/alice/private/salary.md', 'users/alice/private/none.md', 'shared/whatever.md', 'users/bob/x.md', `${c.dir}/../private/salary.md`, '']) {
      if (!p) continue
      expect(await access('bob', c.id, p)).toEqual(no)
    }
    // the creator opens her own files: nothing to ask
    expect(await access('alice', c.id, `${c.dir}/real.md`)).toEqual(no)
    // the made file: ask, with the creator's name and the name the chat recorded
    expect(await access('bob', c.id, `${c.dir}/real.md`)).toEqual({ status: 200, body: { status: 'ask', by: 'Alice Kim', name: 'real.md' } })
    // someone not in the chat: the chat's 404
    expect((await access('carol', c.id, `${c.dir}/real.md`)).status).toBe(404)
    // an ask for a path it never made: the same 404 as any other
    expect((await askFor('bob', c.id, 'users/alice/private/salary.md')).status).toBe(404)
    expect(db().query("SELECT COUNT(*) n FROM access_requests WHERE requester_id = 'bob' AND target_id LIKE ?").get(`${c.id}/%`)).toEqual({ n: 0 })
  })

  test('bob asks, alice adds it from Activity (the same check), bob opens the copy and his AI reads it', async () => {
    const c = await madeChat({ '견적서.pdf.md': '견적 금액 6,000' })
    const p = `${c.dir}/견적서.pdf.md`
    await put('alice', c.id, [bob], { confirmKey: (await preview(c.id, [bob])).previewKey })
    const sent = await askFor('bob', c.id, p)
    expect(sent.status).toBe(200)
    expect(sent.body.status).toBe('sent')
    expect((await askFor('bob', c.id, p)).body.status).toBe('already')
    expect((await access('bob', c.id, p)).body).toMatchObject({ status: 'asked', name: '견적서.pdf.md' })
    // alice's Activity: who, which file (the recorded name), which chat; no path, no note
    const items = (await (await h.req('alice', '/api/notifications?limit=100')).json()).items as any[]
    const row = items.find((i) => i.code === 'access.requested' && i.accessRequest?.file)
    expect(row.accessRequest).toMatchObject({ kind: 'chat', by: 'Bob Lee', targetId: c.id, file: { name: '견적서.pdf.md' }, state: 'pending', canAnswer: true })
    expect(row.accessRequest.note).toBeUndefined()
    expect(JSON.stringify(row)).not.toContain(c.dir)
    // bob cannot answer his own ask
    expect((await h.req('bob', `/api/access-requests/${row.accessRequest.requestId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'approve' }) })).status).toBe(404)
    const ans = await h.req('alice', `/api/access-requests/${row.accessRequest.requestId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'approve' }) })
    expect(await ans.json()).toEqual({ state: 'approved' })
    const [copy] = copiesOf(c.id)
    expect(copy).toMatchObject({ name: '견적서.pdf.md', from: p, messageId: c.answer })
    expect(await access('bob', c.id, p)).toEqual({ status: 200, body: { status: 'copy', fileId: copy!.id, name: '견적서.pdf.md' } })
    expect(await fileText('bob', c.id, copy!.id)).toBe('견적 금액 6,000')
    // bob hears it in Activity, with the file's name and a link to the chat
    const bobs = (await (await h.req('bob', '/api/notifications?limit=100')).json()).items as any[]
    expect(bobs.find((i) => i.code === 'access.answered')).toMatchObject({ link: 'chat', chatId: c.id, accessRequest: { state: 'approved', file: { name: '견적서.pdf.md' } } })
    // the transcript tells bob's AI the copy's file_id, and chat_file reads it as bob
    const rt = getChatRuntime(h.ctx)
    const t = labelledTranscript(rt.store, c.answer, 'bob', new Set())
    expect(t.find((m) => m.id === c.answer)!.content).toContain(`file_id=${copy!.id}`)
    const r = await ask('bob', c.id, `${fake({ tool: 'chat_file', args: { file: copy!.id }, sayResult: true })}`)
    expect(r.done.content).toContain('견적 금액 6,000')
  })

  test('an ask whose file changed after it: [Add to the chat] runs the check again and copies nothing', async () => {
    const c = await madeChat({ 'x.md': 'x' })
    const p = `${c.dir}/x.md`
    await put('alice', c.id, [bob], { confirmKey: (await preview(c.id, [bob])).previewKey })
    await askFor('bob', c.id, p)
    const q = db().query("SELECT id FROM access_requests WHERE requester_id = 'bob' AND target_id LIKE ? AND state = 'pending'").get(`${c.id}/%`) as { id: string }
    // someone else's save over it (a person on the Files screen, outside this chat): not this chat's file any more
    fs.writeFileSync(team(p), 'swapped')
    const ans = await h.req('alice', `/api/access-requests/${q.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'approve' }) })
    expect(await ans.json()).toEqual({ state: 'closed' })
    expect(copiesOf(c.id)).toHaveLength(0)
  })

  test('bob leaves the chat: his waiting asks there close', async () => {
    const c = await madeChat({ 'y.md': 'y', 'z.md': 'z' })
    await put('alice', c.id, [bob], { confirmKey: (await preview(c.id, [bob])).previewKey })
    await askFor('bob', c.id, `${c.dir}/y.md`)
    await askFor('bob', c.id, `${c.dir}/z.md`)
    const pending = () => (db().query("SELECT COUNT(*) n FROM access_requests WHERE requester_id = 'bob' AND target_id LIKE ? AND state = 'pending'").get(`${c.id}/%`) as { n: number }).n
    expect(pending()).toBe(2)
    expect((await put('alice', c.id, [])).status).toBe('saved')
    expect(pending()).toBe(0)
  })
})
