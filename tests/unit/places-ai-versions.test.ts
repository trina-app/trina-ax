// The AI changes a chat file by saving a new version of it (plan docs/AGENTS/plan/20261121-1240-places-ai-versions.md,
// P4 of 20261121-0615-chat-places-as-paths.md): write, edit, edit_files and edit_office (no output) on
// chat:files/<id>/<name> go through ChatFiles.putVersion with origin 'ai'. Alice shares a chat with bob and the
// marketing group (erin). Covered: a version made (the other member opens the new bytes from the same chip), an older
// id resolves to the head, read {versions} and {version: n}, read-before-write, a save beside someone else's, the k
// rule, a project chat, a sub-agent, guests, scheduled runs and remote MCP (rules), a hidden root stays hidden, the
// turn's write limits and the team's storage, edit_files, and the live-update hook.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { which } from '../../server/src/config'
import { readZip } from '../../server/src/files/zip-write'
import * as XLSX from '../../server/node_modules/xlsx'
import ExcelJS from '../../server/node_modules/exceljs'
import { API, type Attachment, type PutChatAudienceResult } from '@mycel/shared/api'
import { chatFilePath } from '@mycel/shared/places'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { setAnswerReads } from '../../server/src/chat/shared-answers'
import { chatFilesOf } from '../../server/src/chat/chat-files'
import { chatPlaces } from '../../server/src/chat/place-ctx'
import { getChatRuntime } from '../../server/src/chat/runtime'
import { versionText } from '../../server/src/files/place-output'
import { listenChatFileVersions } from '../../server/src/chat/chat-file-version-hook'
import { mayWriteChatVersion, PLACE_WORDS, type ResolveCtx } from '../../server/src/files/places'
import { FileService, TurnFiles } from '../../server/src/files/service'
import { configureStorageGuard } from '../../server/src/system/storage'
import { setAvailableMemoryForTests, setLimitsPlatformForTests, setPlanForTests } from '../../server/src/system/limits'
import { TurnExec } from '../../server/src/chat/turn'
import { sharedSection } from '../../server/src/chat/prompt'
import { EDIT_OFFICE_DESCRIPTION } from '../../server/src/tools/edit-office'
import { PDFDocument } from 'pdf-lib'
import { makePagedPdf } from '../lib/pdf'

import { expectNoRawPlace } from '../lib/card-places'
setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const enc = (s: string) => new TextEncoder().encode(s)
const GiB = 1024 ** 3

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'places-ai-versions', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const store = () => chatFilesOf(h.ctx)
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const put = (user: string, chatId: string, subjects: Sub[], confirmKey?: string): Promise<PutChatAudienceResult> =>
  h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
/** the audience route is rate limited: wait and ask again */
async function patient<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f() } catch (e) { if ((e as { status?: number }).status !== 429 || i > 20) throw e; await Bun.sleep(1100) }
  }
}
async function share(user: string, chatId: string, subjects: Sub[]) {
  let r = await patient(() => put(user, chatId, subjects))
  if (r.status === 'confirm') { const key = r.confirmKey; r = await patient(() => put(user, chatId, subjects, key)) }
  if (r.status !== 'saved') throw new Error('not saved')
}
type Card = { requestId: string; question: string }
async function run(user: string, chatId: string, content: string, attachmentIds: string[] = []) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds } })
  const cards: Card[] = []
  const end = Date.now() + 60_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === (x.data.request as Card).requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as unknown as Card
      cards.push(c)
      expectNoRawPlace(c)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: 'skip' } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, content: done.data.message.content as string }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}
async function upload(user: string, chatId: string, name: string, content: string) {
  const form = new FormData()
  form.set('chatId', chatId)
  form.set('file', new File([content], name))
  const res = await h.req(user, '/api/uploads', { method: 'POST', body: form })
  return { status: res.status, body: (await res.json()) as Attachment }
}
let chats = 0
async function sharedChat() {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  await run('alice', c.id, `hello ${++chats}\n${fake({ say: 'hi' })}`)
  await share('alice', c.id, [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'group', subjectId: 'marketing' }])
  return c.id as string
}
/** a chat alice shares with bob and marketing, with `name` sent in it by alice */
async function sent(name: string, content: string) {
  const chat = await sharedChat()
  const up = await upload('alice', chat, name, content)
  expect(up.status).toBe(201)
  await run('alice', chat, `here it is\n${fake({ say: 'ok' })}`, [up.body.id])
  return { chat, file: up.body.id, path: chatFilePath(up.body.id, name) }
}
const fileText = async (user: string, chat: string, id: string) => { const r = await h.req(user, `/api/chats/${chat}/files/${id}`); return r.status === 200 ? r.text() : `(${r.status})` }
const versionsOf = (chat: string, file: string) => store().chain(file).length
const readThenEdit = (p: string, o: string, n: string) => fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit', args: { file_path: p, old_string: o, new_string: n }, sayResult: true })

describe('a new version', () => {
  test('bob\'s AI edits the quote alice attached: version 2 by "Trina for bob", erin opens the new text from the same chip, the old one stays', async () => {
    const { chat, file, path: p } = await sent('견적서.md', '# 견적서\n날짜: 11월 21일\n합계: 100\n')
    const heard: string[] = []
    const stop = listenChatFileVersions((c, f) => heard.push(`${c}/${f}`))
    const r = await run('bob', chat, readThenEdit(p, '11월 21일', '12월 1일'))
    stop()
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('saved as version 2')
    expect(r.content).toContain('earlier versions stay')
    expect(r.content).toContain(`/c/${chat}?file=${file}`)
    expect(await fileText('erin', chat, file)).toContain('날짜: 12월 1일')
    expect(await fileText('alice', chat, file)).toContain('합계: 100')
    const vs = store().versions('erin', chat, file)
    expect(vs.map((v) => [v.version, v.by, !!v.ai, !!v.head])).toEqual([[1, 'alice', false, false], [2, 'bob', true, true]])
    expect(heard).toEqual([`${chat}/${file}`])
    // nobody outside the chat
    expect(await fileText('carol', chat, file)).not.toContain('12월')
  })

  test('an older answer\'s file id (a version\'s, or the root\'s) resolves to the newest version', async () => {
    const { chat, file, path: p } = await sent('notes.txt', 'line one\n')
    const v2 = await store().putVersion('alice', chat, file, { bytes: enc('line two\n') })
    await store().putVersion('alice', chat, file, { bytes: enc('line three\n') })
    // the AI names version 2's id (an older answer said it): it reads and changes the newest
    const old = chatFilePath(v2.row.id, 'notes.txt')
    const seen = await run('bob', chat, fake({ tool: 'read', args: { file_path: old }, sayResult: true }))
    expect(seen.content).toContain('line three')
    expect(seen.content).toContain(`file_id=${file}`)
    const r = await run('bob', chat, readThenEdit(old, 'three', 'four'))
    expect(r.content).toContain('saved as version 4')
    expect(r.content).not.toContain('Files screen')
    expect(await fileText('erin', chat, file)).toBe('line four\n')
    // by name too
    const n = await run('bob', chat, fake({ tool: 'read', args: { file_path: 'chat:files/notes.txt' }, sayResult: true }))
    expect(n.content).toContain('line four')
    expect(p).toContain(file)
  })

  test('read {versions} lists them; {version: n} reads that version as it was', async () => {
    const { chat, file, path: p } = await sent('plan.md', 'PLAN V1\n')
    await run('bob', chat, readThenEdit(p, 'V1', 'V2'))
    const l = await run('erin', chat, fake({ tool: 'read', args: { file_path: p, versions: true }, sayResult: true }))
    expect(l.content).toContain('has 2 versions')
    expect(l.content).toContain('version 2 (the newest')
    expect(l.content).toContain('Trina for')
    const one = await run('erin', chat, fake({ tool: 'read', args: { file_path: p, version: 1 }, sayResult: true }))
    expect(one.content).toContain('PLAN V1')
    expect(one.content).toContain('version 1 of 2')
    const none = await run('erin', chat, fake({ tool: 'read', args: { file_path: p, version: 9 }, sayResult: true }))
    expect(none.content).toContain('has no version 9')
    expect(file).toBeTruthy()
  })

  test('write needs a read first; a read of an earlier version does not count; no change is no version', async () => {
    const { chat, file, path: p } = await sent('w.txt', 'W1')
    const w = await run('bob', chat, fake({ tool: 'write', args: { file_path: p, content: 'W2' }, sayResult: true }))
    expect(w.content).toContain('first (with read)')
    const old = await run('bob', chat, fake({ tool: 'read', args: { file_path: p, version: 1 } }, { tool: 'write', args: { file_path: p, content: 'W2' }, sayResult: true }))
    expect(old.content).toContain('first (with read)')
    const same = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'write', args: { file_path: p, content: 'W1' }, sayResult: true }))
    expect(same.content).toContain('No change')
    expect(versionsOf(chat, file)).toBe(1)
    const ok = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'write', args: { file_path: p, content: 'W2' }, sayResult: true }))
    expect(ok.content).toContain('saved as version 2')
    expect(await fileText('alice', chat, file)).toBe('W2')
    // a read with chat_file counts too (QA: the AI read the quote with chat_file first)
    const cf = await run('bob', chat, fake({ tool: 'chat_file', args: { file } }, { tool: 'write', args: { file_path: p, content: 'W3' }, sayResult: true }))
    expect(cf.content).toContain('saved as version 3')
  })

  test('someone saved after the read: write saves beside theirs (nothing lost), an edit that no longer applies asks for a new read', async () => {
    const { chat, file, path: p } = await sent('race.txt', 'A\n')
    const hooks = { erin: () => store().putVersion('erin', chat, file, { bytes: enc('B\n') }) }
    // the read, then erin's save, then the write: one turn with a tool in between is not possible in the fake engine, so
    // the read is in its own answer and the write in the next (an earlier read of this chat counts for write too)
    await run('bob', chat, fake({ tool: 'read', args: { file_path: p }, sayResult: true }))
    await hooks.erin()
    const e = await run('bob', chat, fake({ tool: 'edit', args: { file_path: p, old_string: 'A', new_string: 'C' }, sayResult: true }))
    expect(e.content).toMatch(/no longer applies|first \(with read\)/)
    expect(await fileText('alice', chat, file)).toBe('B\n')
  })
})

describe('a save beside someone else\'s', () => {
  test('the head changed after the AI read it: its version is the newest, the other person\'s stays before it, and the result says so', async () => {
    const { chat, file } = await sent('beside.txt', 'B1')
    const files = new TurnFiles()
    const exec = { rt: getChatRuntime(h.ctx), spec: { userId: 'bob', chatId: chat, clientKind: 'web' }, files, shared: { kind: 'people' }, hiddenFromLater: false, livePrincipal: () => ({}) } as unknown as TurnExec
    const p = chatPlaces(exec, files)
    const read = p.head(file, 'beside.txt')
    expect(read.sha256).toBe(store().row(file)!.sha256)
    await store().putVersion('erin', chat, file, { bytes: enc('ERIN B2') })
    const v = await p.version(read.id, { bytes: enc('BOB B3') }, read.sha256, files)
    expect(v).toMatchObject({ id: file, version: 3, beside: true })
    expect(versionText(v, 'Updated')).toContain('nothing was lost')
    expect(store().chain(file).map((r) => [r.version ?? 1, r.user_id])).toEqual([[1, 'alice'], [2, 'erin'], [3, 'bob']])
    expect(await fileText('alice', chat, file)).toBe('BOB B3')
    // the AI now knows its own version: a next edit in this answer needs no new read
    expect(files.readHashes.get(read.path)).toBe(v.sha256)
  })
})

describe('the gate again at the insert (S2 security review: the bytes take time)', () => {
  const onDisk = (chat: string) => fs.readdirSync(path.join(store().root(), chat)).filter((n) => !n.includes('.thumb'))
  test('putVersion: a recheck that fails between the write and the insert refuses the save and removes the bytes', async () => {
    const { chat, file } = await sent('gate.txt', 'G1')
    const before = onDisk(chat).length
    let open = true
    let calls = 0
    const save = store().putVersion('bob', chat, file, { bytes: enc('G2') }, { origin: 'ai', recheck: () => { calls++; if (!open) throw new Error('gate closed') } })
    // the gate flips while the bytes are written (putVersion has not inserted the row yet)
    open = false
    await expect(save).rejects.toThrow('gate closed')
    expect(calls).toBe(1)
    expect(versionsOf(chat, file)).toBe(1)
    expect(onDisk(chat).length).toBe(before)
    // an open gate: the save goes, the recheck called once, right before the insert
    calls = 0
    open = true
    await store().putVersion('bob', chat, file, { bytes: enc('G2') }, { origin: 'ai', recheck: () => { calls++; if (!open) throw new Error('gate closed') } })
    expect(calls).toBe(1)
    expect(versionsOf(chat, file)).toBe(2)
  })

  test('the AI\'s save: a connection\'s (k) answer joining, or the chat moved to the trash, while the bytes are written refuses it', async () => {
    const { chat, file } = await sent('gate2.txt', 'H1')
    const files = new TurnFiles()
    const exec = { rt: getChatRuntime(h.ctx), spec: { userId: 'bob', chatId: chat, clientKind: 'web' }, files, shared: { kind: 'people' }, hiddenFromLater: false, livePrincipal: () => ({}) } as unknown as TurnExec & { hiddenFromLater: boolean }
    const p = chatPlaces(exec, files)
    const h1 = p.head(file, 'gate2.txt')
    const before = onDisk(chat).length
    const k = p.version(h1.id, { bytes: enc('H2') }, h1.sha256, files)
    exec.hiddenFromLater = true
    await expect(k).rejects.toThrow(PLACE_WORDS.hiddenVersion)
    exec.hiddenFromLater = false
    const t = p.version(h1.id, { bytes: enc('H3') }, h1.sha256, files)
    db().query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), chat)
    await expect(t).rejects.toThrow()
    db().query('UPDATE chats SET deleted_at = NULL WHERE id = ?').run(chat)
    expect(versionsOf(chat, file)).toBe(1)
    expect(onDisk(chat).length).toBe(before)
    // nothing counted against the turn for a refused save
    expect(files.bytesWritten).toBe(0)
  })
})

describe('a k mark after a save in the same answer (QA TC-6962 / TC-6835)', () => {
  test('an answer that saved a chat file version never becomes a k answer: a connection\'s answer after it is refused', async () => {
    // a real save first: the version is opened through its chain's root by everyone who sees the root, so its answer
    // must stay one they may see. TurnFiles.chatVersionsMade is set in the same step as the version's row.
    const { chat, file } = await sent('k-after.txt', 'K1')
    const files = new TurnFiles()
    const exec = { rt: getChatRuntime(h.ctx), spec: { userId: 'bob', chatId: chat, clientKind: 'web' }, files, shared: { kind: 'people' }, hiddenFromLater: false, livePrincipal: () => ({}) } as unknown as TurnExec
    const p = chatPlaces(exec, files)
    const h1 = p.head(file, 'k-after.txt')
    await p.version(h1.id, { bytes: enc('K2') }, h1.sha256, files)
    expect(files.chatVersionsMade.size).toBe(1)
    // the connection's k group (noteSharedReads kept) is refused for this answer, as after an attached file
    const note = (TurnExec.prototype as unknown as { noteSharedReads: (...a: unknown[]) => boolean }).noteSharedReads
    const self = { shared: { kind: 'people' }, attachedFiles: 0, attaching: 0, files, sharedReads: new Map() } as Record<string, unknown>
    expect(note.call(self, [{ type: 'url', url: 'https://example.com' }], ['alice', 'bob'], false, true)).toBe(false)
    expect((self.sharedReads as Map<string, unknown>).size).toBe(0)
    // an answer without a version is not held back by this rule (the k group joins it; the record write is its own)
    const fresh = { shared: { kind: 'people' }, attachedFiles: 0, attaching: 0, files: new TurnFiles(), sharedReads: new Map(), rt: { db: db(), log: { warn: () => {} } }, spec: { chatId: chat, assistantId: 'none' }, id: 't' } as Record<string, unknown>
    note.call(fresh, [{ type: 'url', url: 'https://example.com' }], ['alice', 'bob'], false, true)
    expect([...(fresh.sharedReads as Map<string, { k?: boolean }>).values()].some((g) => g.k)).toBe(true)
  })
})

describe('who may', () => {
  const ctxOf = (kind: ResolveCtx['chatKind'], o: { main?: boolean; hidden?: boolean; chatId?: string | null } = {}): ResolveCtx =>
    ({ db: db(), userId: 'bob', chatId: o.chatId === undefined ? 'c-x' : o.chatId, main: o.main ?? true, chatKind: kind, hiddenGroup: !!o.hidden, live: () => true })
  test('the rule: people and personal chats; a k answer, a project chat, locked, scheduled, guest, sub-agent and no chat refused', () => {
    expect(mayWriteChatVersion(ctxOf('people'))).toBe(true)
    expect(mayWriteChatVersion(ctxOf('personal'))).toBe(true)
    expect(mayWriteChatVersion(ctxOf('people', { hidden: true }))).toBe(PLACE_WORDS.hiddenVersion)
    expect(mayWriteChatVersion(ctxOf('project'))).toBe(PLACE_WORDS.projectReadOnly)
    for (const k of ['locked', 'scheduled', 'guest'] as const) expect(mayWriteChatVersion(ctxOf(k))).toBe(PLACE_WORDS.versionNotHere)
    expect(mayWriteChatVersion(ctxOf('people', { main: false }))).toBe(PLACE_WORDS.noChat)
    expect(mayWriteChatVersion(ctxOf('people', { chatId: null }))).toBe(PLACE_WORDS.noChat)
  })

  test('the k refusal is the caller\'s (putVersion does not know the turn): an answer with a k group writes no version', async () => {
    const { chat, file } = await sent('k.txt', 'K1')
    const files = new TurnFiles()
    const exec = { rt: { ctx: h.ctx, db: db() }, spec: { userId: 'bob', chatId: chat, clientKind: 'web' }, files, shared: { kind: 'people' }, hiddenFromLater: true, livePrincipal: () => ({}) } as unknown as TurnExec
    const p = chatPlaces(exec, files)
    expect(() => p.head(file, 'k.txt')).toThrow(PLACE_WORDS.hiddenVersion)
    await expect(p.version(file, { bytes: enc('K2') }, store().row(file)!.sha256, files)).rejects.toThrow(PLACE_WORDS.hiddenVersion)
    expect(versionsOf(chat, file)).toBe(1)
    // a sub-agent's view of the turn: not the main AI
    const sub = chatPlaces(exec, (files as unknown as { view(agent: string | null): TurnFiles }).view('agent-1'))
    expect(() => sub.head(file, 'k.txt')).toThrow(PLACE_WORDS.noChat)
  })

  test('a project chat: its chat files are read-only (owner, 2026-11-21); no card, nothing changed', async () => {
    const p = await h.api('alice').call(API.createProject, { body: { name: 'P4 AI versions', instructions: '', participants: [{ subjectType: 'group', subjectId: 'marketing' }] } })
    const pc = await h.api('alice').call(API.createChat, { body: { projectId: p.id } })
    await run('alice', pc.id, fake({ say: 'hi' }))
    // a chat file there (a project chat's uploads go to its folder; a chat_files row is put directly)
    const tmp = `${h.ctx.config.dataDir}/work/pc-${crypto.randomUUID()}`
    await Bun.write(tmp, 'P1')
    const att = await store().create('alice', pc.id, 'p.txt', tmp, new Bun.CryptoHasher('sha256').update('P1').digest('hex'))
    const r = await run('alice', pc.id, fake({ tool: 'read', args: { file_path: chatFilePath(att.id, 'p.txt') } }, { tool: 'edit', args: { file_path: chatFilePath(att.id, 'p.txt'), old_string: 'P1', new_string: 'P2' }, sayResult: true }))
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain(PLACE_WORDS.projectReadOnly)
    expect(versionsOf(pc.id, att.id)).toBe(1)
  })

  test('a sub-agent\'s write or edit of a chat file is refused; nothing changed', async () => {
    const { chat, file, path: p } = await sent('sub.txt', 'S1')
    const r = await run('bob', chat, fake({ agents: [{ id: 's1', type: 'general-purpose', description: 'change it', steps: [{ tool: 'read', args: { file_path: p } }, { tool: 'edit', args: { file_path: p, old_string: 'S1', new_string: 'S2' }, sayChildResult: true }] }] }))
    expect(r.content).not.toContain('saved as version')
    expect(versionsOf(chat, file)).toBe(1)
    expect(await fileText('alice', chat, file)).toBe('S1')
  })

  test('remote MCP (no chat turn): write and edit of a chat place are refused in plain words', async () => {
    const { chat, file, path: p } = await sent('mcp.txt', 'M1')
    const svc = h.ctx.files as FileService
    const ctx = { user: h.ctx.files.principal('bob'), turnId: null, files: new TurnFiles() }
    const w = await svc.call('write', { file_path: p, content: 'M2' }, ctx)
    const e = await svc.call('edit', { file_path: p, old_string: 'M1', new_string: 'M2' }, ctx)
    for (const o of [w, e]) { expect(o.isError).toBe(true); expect(o.text).toContain('only from inside its own Trina chat'); expect(o.text).not.toContain('main assistant') }
    expect(versionsOf(chat, file)).toBe(1)
  })

  test('a chain carried only by an answer hidden from erin stays hidden: her AI cannot read, list or change it', async () => {
    const { chat, file, path: p } = await sent('hid.txt', 'HIDDEN ONE')
    const ans = db().query("SELECT id FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").get(chat) as { id: string }
    const att = db().query("SELECT attachments FROM messages WHERE chat_id = ? AND role = 'user' AND attachments LIKE ?").get(chat, `%${file}%`) as { attachments: string }
    db().query('UPDATE messages SET attachments = ? WHERE id = ?').run(att.attachments, ans.id)
    db().query("UPDATE messages SET attachments = '[]' WHERE chat_id = ? AND role = 'user' AND attachments LIKE ?").run(chat, `%${file}%`)
    setAnswerReads(db(), chat, ans.id, [{ c: ['alice', 'bob'], s: [], x: 1 }])
    await store().putVersion('alice', chat, file, { bytes: enc('HIDDEN TWO') })
    const r = await run('erin', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'write', args: { file_path: p, content: 'ERIN' }, sayResult: true }))
    expect(r.content).not.toContain('HIDDEN')
    expect(r.content).toContain('No file')
    const v = await run('erin', chat, fake({ tool: 'read', args: { file_path: p, versions: true }, sayResult: true }))
    expect(v.content).not.toContain('version 2')
    expect(versionsOf(chat, file)).toBe(2)
  })
})

describe('limits', () => {
  test('the turn\'s write limits count a version; nothing written past them', async () => {
    const { chat, file, path: p } = await sent('lim.txt', 'L1')
    const cfg = h.ctx.engineConfig as { maxWriteBytesPerTurn: number }
    const was = cfg.maxWriteBytesPerTurn
    cfg.maxWriteBytesPerTurn = 3
    try {
      const r = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'write', args: { file_path: p, content: 'L2 is longer' }, sayResult: true }))
      expect(r.content).not.toContain('saved as version')
      expect(versionsOf(chat, file)).toBe(1)
    } finally { cfg.maxWriteBytesPerTurn = was }
  })

  test('the team\'s storage: a full disk saves nothing and says so', async () => {
    const { chat, file, path: p } = await sent('full.txt', 'F1')
    configureStorageGuard({ root: '/', statfs: () => ({ bsize: 4096, blocks: 20 * GiB / 4096, bfree: 0.1 * GiB / 4096, bavail: 0.1 * GiB / 4096 }), enforce: () => true })
    setLimitsPlatformForTests('linux')
    setPlanForTests({ storageGiB: 10 } as never)
    // this partial plan has no memory figures: on a real Linux (CI) the queue's memory admission would read
    // /proc/meminfo and divide by the plan's missing per-answer memory, so the answer would never start
    setAvailableMemoryForTests(null)
    try {
      const r = await run('bob', chat, readThenEdit(p, 'F1', 'F2'))
      expect(r.content).toContain('storage is full')
      expect(versionsOf(chat, file)).toBe(1)
    } finally { configureStorageGuard(null); setLimitsPlatformForTests(null); setPlanForTests(undefined); setAvailableMemoryForTests(undefined) }
  })
})

describe('edit_office on a chat file', () => {
  test('without output: a new version of the workbook (the cell changed, the rest as it was); no read: refused (a team file: b-shared-chat-edit-office.test.ts)', async () => {
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Quote')
    sheet.addRow(['Date', '2026-11-21'])
    sheet.addRow(['Total', 100])
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
    const chat = await sharedChat()
    const form = new FormData()
    form.set('chatId', chat)
    form.set('file', new File([bytes], 'quote.xlsx'))
    const up = (await (await h.req('alice', '/api/uploads', { method: 'POST', body: form })).json()) as Attachment
    await run('alice', chat, `the quote\n${fake({ say: 'ok' })}`, [up.id])
    const p = chatFilePath(up.id, 'quote.xlsx')
    const r = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit_office', args: { file_path: p, changes: [{ cell: { ref: 'B1', value: '2026-12-01' } }] }, sayResult: true }))
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('saved as version 2')
    expect(r.content).not.toContain('attached to your answer')
    const got = new Uint8Array(await (await h.req('erin', `/api/chats/${chat}/files/${up.id}`)).arrayBuffer())
    const read = XLSX.read(got, { type: 'array' })
    expect(read.Sheets['Quote']!['B1']!.v).toBe('2026-12-01')
    expect(read.Sheets['Quote']!['B2']!.v).toBe(100)
    expect(store().versions('erin', chat, up.id).map((v) => [v.version, !!v.ai])).toEqual([[1, false], [2, true]])
    // without a read of the newest version: refused, nothing changed
    const no = await run('bob', chat, fake({ tool: 'edit_office', args: { file_path: p, changes: [{ cell: { ref: 'B2', value: 5 } }] }, sayResult: true }))
    expect(no.content).toMatch(/read .* first|changed after you read it/)
    expect(versionsOf(chat, up.id)).toBe(2)
  })
})

describe('edit_office insert_picture with a chat file picture (QA TC-8173)', () => {
  const pandoc = which('pandoc')
  function png(w: number, h: number): Uint8Array {
    const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => [200, 20, 20]).flat()])))
    const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]) }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
  }
  async function send(chat: string, name: string, bytes: Uint8Array) {
    const form = new FormData()
    form.set('chatId', chat)
    form.set('file', new File([bytes as Uint8Array<ArrayBuffer>], name))
    return (await (await h.req('alice', '/api/uploads', { method: 'POST', body: form })).json()) as Attachment
  }
  ;(pandoc ? test : test.skip)('the seal sent in the chat goes onto the form sent in the chat: a new version with the picture, the text as it was', async () => {
    const r0 = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from('# Form\n\nSeller: Hong Gildong (seal)\n') })
    const chat = await sharedChat()
    const doc = await send(chat, 'form.docx', new Uint8Array(r0.stdout))
    const seal = await send(chat, 'seal.png', png(30, 30))
    await run('alice', chat, `the form and my seal\n${fake({ say: 'ok' })}`, [doc.id, seal.id])
    const p = chatFilePath(doc.id, 'form.docx')
    const r = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit_office', args: { file_path: p, changes: [{ insert_picture: { image: chatFilePath(seal.id, 'seal.png'), over: '(seal)', width_mm: 15 } }] }, sayResult: true }))
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('saved as version 2')
    expect(r.content).toContain('picture over "(seal)", behind the text (15 x 15 mm)')
    const got = new Uint8Array(await (await h.req('erin', `/api/chats/${chat}/files/${doc.id}`)).arrayBuffer())
    const z = readZip(got)
    expect(z.filter((e) => /^word\/media\/image\d+\.png$/.test(e.name)).length).toBe(1)
    expect(new TextDecoder().decode(z.find((e) => e.name === 'word/document.xml')!.data)).toMatch(/Seller: Hong Gildong <\/w:t><w:drawing>[\s\S]*<\/w:drawing><w:t xml:space="preserve">\(seal\)<\/w:t>/)
  })
})

describe('edit_pdf on a chat file (QA TC-7044)', () => {
  async function sentPdf(name: string, pages: number) {
    const chat = await sharedChat()
    const bytes = makePagedPdf(Array.from({ length: pages }, (_, i) => [`PAGE-${i + 1}`]))
    const form = new FormData()
    form.set('chatId', chat)
    form.set('file', new File([bytes as Uint8Array<ArrayBuffer>], name))
    const up = (await (await h.req('alice', '/api/uploads', { method: 'POST', body: form })).json()) as Attachment
    await run('alice', chat, `the quote\n${fake({ say: 'ok' })}`, [up.id])
    return { chat, file: up.id, path: chatFilePath(up.id, name) }
  }
  const pagesOf = async (user: string, chat: string, id: string, v?: number) =>
    (await PDFDocument.load(new Uint8Array(await (await h.req(user, `/api/chats/${chat}/files/${id}${v ? `?version=${v}` : ''}`)).arrayBuffer()))).getPageCount()

  test('without output: a new version of the same PDF (no "(2)" copy); the old one stays; read first', async () => {
    const { chat, file, path: p } = await sentPdf('견적서.pdf', 3)
    const no = await run('bob', chat, fake({ tool: 'edit_pdf', args: { file_path: p, operations: [{ remove_pages: '3' }] }, sayResult: true }))
    expect(no.content).toMatch(/read .* first/)
    expect(no.content).toContain('Nothing was saved by this call: "견적서.pdf" is still version 1')
    expect(versionsOf(chat, file)).toBe(1)
    const r = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit_pdf', args: { file_path: p, operations: [{ remove_pages: '3' }] }, sayResult: true }))
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('saved as version 2')
    expect(r.content).toContain('restore an earlier version from the file\'s Versions list')
    expect(r.content).not.toContain('attached to your answer')
    expect(await pagesOf('erin', chat, file)).toBe(2)
    expect(await pagesOf('erin', chat, file, 1)).toBe(3)
    expect(store().versions('erin', chat, file).map((v) => [v.version, !!v.ai])).toEqual([[1, false], [2, true]])
    // no second file in the chat
    expect(store().visibleTo('erin', chat).filter((v) => v.root.name.startsWith('견적서'))).toHaveLength(1)
  })

  test('an output that names the same chat file is the file itself (a version); another name is a new file', async () => {
    const { chat, file, path: p } = await sentPdf('quote.pdf', 2)
    const same = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit_pdf', args: { file_path: p, output: 'chat:files/quote.pdf', operations: [{ rotate_pages: { degrees: 90 } }] }, sayResult: true }))
    expect(same.content).toContain('saved as version 2')
    expect(store().visibleTo('erin', chat).map((v) => v.root.name).filter((n) => n.startsWith('quote'))).toEqual(['quote.pdf'])
    const other = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit_pdf', args: { file_path: p, output: 'chat:files/quote-page1.pdf', operations: [{ keep_pages: '1' }] }, sayResult: true }))
    expect(other.content).toContain('attached to your answer')
    expect(versionsOf(chat, file)).toBe(2)
    const made = store().visibleTo('erin', chat).find((v) => v.root.name === 'quote-page1.pdf')!
    expect(await pagesOf('erin', chat, made.id)).toBe(1)
  })

  test('a project chat: its chat files stay read-only; nothing changed', async () => {
    const pr = await h.api('alice').call(API.createProject, { body: { name: `PDF P4 ${crypto.randomUUID().slice(0, 6)}`, instructions: '', participants: [{ subjectType: 'group', subjectId: 'marketing' }] } })
    const pc = await h.api('alice').call(API.createChat, { body: { projectId: pr.id } })
    await run('alice', pc.id, fake({ say: 'hi' }))
    // a chat file there (a project chat's uploads go to its folder; a chat_files row is put directly)
    const bytes = makePagedPdf([['A'], ['B']])
    const tmp = `${h.ctx.config.dataDir}/work/pc-${crypto.randomUUID()}`
    await Bun.write(tmp, bytes)
    const up = await store().create('alice', pc.id, 'brief.pdf', tmp, new Bun.CryptoHasher('sha256').update(bytes).digest('hex'))
    const p = chatFilePath(up.id, 'brief.pdf')
    const r = await run('alice', pc.id, fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit_pdf', args: { file_path: p, operations: [{ remove_pages: '2' }] }, sayResult: true }))
    expect(r.content).toContain(PLACE_WORDS.projectReadOnly)
    expect(versionsOf(pc.id, up.id)).toBe(1)
  })
})

describe('make_file over a file of this chat (QA TC-7267)', () => {
  test('"make it again": output = the chat file\'s own path saves a new version (read first, the same format); a new name is a new file', async () => {
    const chat = await sharedChat()
    const first = await run('bob', chat, fake({ tool: 'make_file', args: { content: '# Quote\n\nTotal: 100', format: 'docx', output: 'chat:files/quote.docx' }, sayResult: true }))
    expect(first.content).toContain('attached to your answer')
    const v1 = store().visibleTo('erin', chat).find((v) => v.root.name === 'quote.docx')!
    const p = chatFilePath(v1.id, 'quote.docx')
    const again = (extra: object[] = []) => run('bob', chat, fake(...extra, { tool: 'make_file', args: { content: '# Quote\n\nTotal: 90', format: 'docx', output: p }, sayResult: true }))
    const unread = await again()
    expect(unread.content).toMatch(/read .* first/)
    expect(versionsOf(chat, v1.id)).toBe(1)
    const r = await again([{ tool: 'read', args: { file_path: p } }])
    expect(r.content).toContain('saved as a new version of that chat file, not as a new file')
    expect(r.content).not.toContain('attached to your answer')
    expect(versionsOf(chat, v1.id)).toBe(2)
    expect(store().visibleTo('erin', chat).filter((v) => v.root.name.startsWith('quote'))).toHaveLength(1)
    const pdf = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'make_file', args: { content: '# Quote', format: 'pptx', output: p.replace(/\.docx$/, '.pptx') }, sayResult: true }))
    expect(pdf.content).toContain('keeps its name and format')
    expect(versionsOf(chat, v1.id)).toBe(2)
  })
})

describe('the real state after a refused in-place change (QA TC-7039)', () => {
  test('a test edit saved version 2, a later call fails: the result says version 2 is the AI\'s own save of this answer; a read says which version it is', async () => {
    const { chat, file, path: p } = await sent('deck.md', 'Title\nSlide two\n')
    const r = await run('bob', chat, fake(
      { tool: 'read', args: { file_path: p } },
      { tool: 'edit', args: { file_path: p, old_string: 'Slide two', new_string: 'Slide two\n임시' } },
      // an Office edit of a text file: refused, nothing saved by it
      { tool: 'edit_office', args: { file_path: p, changes: [{ find: 'Title', replace: 'T' }] }, sayResult: true },
    ))
    expect(r.content).toContain('Nothing was saved by this call: "deck.md" is still version 2')
    expect(r.content).toContain('Version 2 is your own save from earlier in this answer')
    expect(versionsOf(chat, file)).toBe(2)
    // the next answer reads it: which version, saved by whom, and that version 1 is the original
    const next = await run('alice', chat, fake({ tool: 'read', args: { file_path: p }, sayResult: true }))
    expect(next.content).toContain('version 2 (the newest of 2 kept; saved by Trina for Bob')
    expect(next.content).toContain('version 1 is the original')
    // a refusal in a new answer: not the AI's own save of this answer
    const later = await run('alice', chat, fake({ tool: 'edit_office', args: { file_path: p, changes: [{ find: 'Title', replace: 'T' }] }, sayResult: true }))
    expect(later.content).toContain('Nothing was saved by this call: "deck.md" is still version 2')
    expect(later.content).toContain('the file was not changed')
  })
})

describe('edit_files and the old refusals', () => {
  test('edit_files changes each chat file it names (a version each), one file at a time', async () => {
    const { chat, file, path: p } = await sent('many.md', 'STATUS: draft\n')
    const up = await upload('alice', chat, 'many2.md', 'STATUS: draft too\n')
    await run('alice', chat, `one more\n${fake({ say: 'ok' })}`, [up.body.id])
    const q = chatFilePath(up.body.id, 'many2.md')
    const r = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'read', args: { file_path: q } }, { tool: 'edit_files', args: { file_paths: [p, q, 'chat:files/none.md'], old_string: 'draft', new_string: 'final' }, sayResult: true }))
    expect(r.content).toContain('2 of 3 files edited')
    expect(await fileText('erin', chat, file)).toBe('STATUS: final\n')
    expect(await fileText('erin', chat, up.body.id)).toBe('STATUS: final too\n')
  })

  test('chat:work/, chat:files/ itself, a name that is no chat file and room: keep the refusal', async () => {
    const { chat } = await sent('keep.txt', 'K')
    for (const c of [
      { tool: 'write', args: { file_path: 'chat:work/a.txt', content: 'X' }, says: 'box_shell' },
      { tool: 'write', args: { file_path: 'chat:files/', content: 'X' }, says: 'name one of them' },
      { tool: 'write', args: { file_path: 'chat:files/none.txt', content: 'X' }, says: 'No file' },
      { tool: 'edit', args: { file_path: 'room:files/a.txt', old_string: 'a', new_string: 'b' }, says: 'room files are not paths yet' },
    ]) {
      const r = await run('bob', chat, fake({ tool: c.tool, args: c.args, sayResult: true }))
      expect(r.cards).toHaveLength(0)
      expect(r.content).toContain(c.says)
    }
  })
})

describe('independent review (PR #252)', () => {
  test('a personal chat locked while the bytes are written: the save is refused, the bytes removed (the kind is read again at the insert)', async () => {
    const c = await h.api('bob').call(API.createChat, { body: {} })
    await run('bob', c.id, fake({ say: 'hi' }))
    const tmp = `${h.ctx.config.dataDir}/work/pl-${crypto.randomUUID()}`
    await Bun.write(tmp, 'L1')
    const att = await store().create('bob', c.id, 'mine.txt', tmp, new Bun.CryptoHasher('sha256').update('L1').digest('hex'))
    const files = new TurnFiles()
    const exec = { rt: getChatRuntime(h.ctx), spec: { userId: 'bob', chatId: c.id, clientKind: 'web' }, files, shared: null, hiddenFromLater: false, livePrincipal: () => ({}) } as unknown as TurnExec
    const p = chatPlaces(exec, files)
    const h1 = p.head(att.id, 'mine.txt')
    const before = fs.readdirSync(path.join(store().root(), c.id)).length
    const save = p.version(h1.id, { bytes: enc('L2') }, h1.sha256, files)
    db().query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(c.id)
    try {
      await expect(save).rejects.toThrow(PLACE_WORDS.versionNotHere)
    } finally { db().query('DELETE FROM safe_ops_chats WHERE chat_id = ?').run(c.id) }
    expect(versionsOf(c.id, att.id)).toBe(1)
    expect(fs.readdirSync(path.join(store().root(), c.id)).length).toBe(before)
    // unlocked again: the same save goes
    await p.version(h1.id, { bytes: enc('L2') }, h1.sha256, files)
    expect(versionsOf(c.id, att.id)).toBe(2)
  })

  test('QA TC-6778: the result of an AI save says "everyone in this chat" only in a chat shared with people', async () => {
    // a chat only bob sees (made private again: chat files stay) and one shared with people
    const c = await h.api('bob').call(API.createChat, { body: {} })
    await run('bob', c.id, fake({ say: 'hi' }))
    const tmp = `${h.ctx.config.dataDir}/work/pl-${crypto.randomUUID()}`
    await Bun.write(tmp, 'P1')
    const att = await store().create('bob', c.id, 'private.txt', tmp, new Bun.CryptoHasher('sha256').update('P1').digest('hex'))
    const files = new TurnFiles()
    const mine = { rt: getChatRuntime(h.ctx), spec: { userId: 'bob', chatId: c.id, clientKind: 'web' }, files, shared: null, hiddenFromLater: false, livePrincipal: () => ({}) } as unknown as TurnExec
    const p = chatPlaces(mine, files)
    const h1 = p.head(att.id, 'private.txt')
    const v = await p.version(h1.id, { bytes: enc('P2') }, h1.sha256, files)
    expect(v.everyone).toBe(false)
    expect(versionText(v, 'Changed')).toContain('The new version opens from the same file under its message.')
    expect(versionText(v, 'Changed')).not.toMatch(/everyone/i)

    const { chat, file } = await sent('people.txt', 'Q1')
    const f2 = new TurnFiles()
    const people = { rt: getChatRuntime(h.ctx), spec: { userId: 'bob', chatId: chat, clientKind: 'web' }, files: f2, shared: { kind: 'people' }, hiddenFromLater: false, livePrincipal: () => ({}) } as unknown as TurnExec
    const q = chatPlaces(people, f2)
    const h2 = q.head(file, 'people.txt')
    const w = await q.version(h2.id, { bytes: enc('Q2') }, h2.sha256, f2)
    expect(w.everyone).toBe(true)
    expect(versionText(w, 'Changed')).toContain('Everyone in this chat opens the new version')
  })

  test('QA TC-6778: the edit_office description promises no audience', () => {
    expect(EDIT_OFFICE_DESCRIPTION).not.toMatch(/everyone/i)
  })

  test('edit_files naming one chat file twice (by id and by name) edits it once', async () => {
    const { chat, file, path: p } = await sent('twice.md', 'release v1\n')
    const r = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit_files', args: { file_paths: [p, 'chat:files/twice.md'], old_string: 'v1', new_string: 'v1.1' }, sayResult: true }))
    expect(r.content).toContain('handled once')
    expect(await fileText('erin', chat, file)).toBe('release v1.1\n')
    expect(versionsOf(chat, file)).toBe(2)
  })

  test('edit_office is offered in a chat shared with people and in a project chat (its team files: S-028)', async () => {
    const chat = await sharedChat()
    const people = await run('bob', chat, fake({ echo: 'tools' }))
    expect(people.content.split(',')).toContain('edit_office')
    const pr = await h.api('alice').call(API.createProject, { body: { name: 'P4 review tools', instructions: '', participants: [{ subjectType: 'group', subjectId: 'marketing' }] } })
    const pc = await h.api('alice').call(API.createChat, { body: { projectId: pr.id } })
    const proj = await run('alice', pc.id, fake({ echo: 'tools' }))
    expect(proj.content.split(',')).toContain('make_file')
    expect(proj.content.split(',')).toContain('edit_office')
  })

  test('the shared chat prompt does not send edit_office output to chat:files/ (refused there: it changes only a chat file in place)', () => {
    const t = sharedSection({ project: null, audience: 3, asker: 'Alice' } as never, 'en', false)
    expect(t).toContain('Files you make for the people here go to this chat')
    expect(t).not.toMatch(/and edit_office, the PDF tools/)
    expect(t).toContain('edit_office it (Word, Excel, PowerPoint) or edit_pdf it (PDF) without output')
  })
})

describe('one version per answer (owner, 2026-11-21)', () => {
  test('several edits of one chat file in one answer leave one version; the next answer adds one', async () => {
    const { chat, file, path: p } = await sent('steps.md', 'S1 S2 S3\n')
    const edit = (o: string, n: string) => ({ tool: 'edit', args: { file_path: p, old_string: o, new_string: n } })
    const r = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, edit('S1', 'T1'), edit('S2', 'T2'), { ...edit('S3', 'T3'), sayResult: true }))
    expect(r.content).toContain('version 2')
    expect(await fileText('erin', chat, file)).toBe('T1 T2 T3\n')
    expect(store().versions('erin', chat, file).map((v) => [v.version, v.by, !!v.ai])).toEqual([[1, 'alice', false], [2, 'bob', true]])
    expect(store().chain(file)).toHaveLength(2)
    const next = await run('bob', chat, fake({ tool: 'read', args: { file_path: p } }, { ...edit('T1', 'U1'), sayResult: true }))
    expect(next.content).toContain('saved as version 3')
    expect(store().chain(file).map((x) => x.version ?? 1)).toEqual([1, 2, 3])
  })

  test('a person\'s save in between starts a new version; an editor opened on the replaced head saves beside; the old bytes go', async () => {
    const { chat, file } = await sent('mixed.txt', 'M1')
    const files = new TurnFiles()
    const exec = { rt: getChatRuntime(h.ctx), spec: { userId: 'bob', chatId: chat, clientKind: 'web' }, files, shared: { kind: 'people' }, hiddenFromLater: false, livePrincipal: () => ({}) } as unknown as TurnExec
    const p = chatPlaces(exec, files)
    const a = await p.version(file, { bytes: enc('AI one') }, store().row(file)!.sha256, files)
    expect(a).toMatchObject({ version: 2, beside: false })
    const first = store().headOf(file)!
    const firstAbs = store().open('bob', chat, file, false).abs
    // erin's editor was opened on the AI's first save
    const b = await p.version(file, { bytes: enc('AI two') }, a.sha256, files)
    expect(b).toMatchObject({ version: 2, beside: false })
    const second = store().headOf(file)!
    expect(second.id).not.toBe(first.id)
    expect(second).toMatchObject({ version: 2, replaces: file, origin: 'ai', sha256: b.sha256, size: 6 })
    expect(store().row(first.id)).toBeNull()
    expect(fs.existsSync(firstAbs)).toBe(false)
    expect(await fileText('erin', chat, file)).toBe('AI two')
    // erin saves on the head she opened (gone now): beside the AI's, nothing lost
    const e = await store().putVersion('erin', chat, file, { bytes: enc('ERIN') }, { expectHead: first.id })
    expect(e).toMatchObject({ beside: true, row: { version: 3 } })
    // the AI's next save in the same answer is over erin's head: a new version, never in her place
    const c = await p.version(file, { bytes: enc('AI three') }, e.row.sha256, files)
    expect(c).toMatchObject({ version: 4, beside: false })
    expect(store().chain(file).map((x) => [x.version ?? 1, x.user_id])).toEqual([[1, 'alice'], [2, 'bob'], [3, 'erin'], [4, 'bob']])
    // a new answer (its own TurnFiles) over the AI's head of an earlier one: a new version
    const files2 = new TurnFiles()
    const p2 = chatPlaces({ ...exec, files: files2 } as unknown as TurnExec, files2)
    const d = await p2.version(file, { bytes: enc('AI four') }, c.sha256, files2)
    expect(d.version).toBe(5)
    // a turn's write limits still count every save
    expect(files.bytesWritten).toBe('AI one'.length + 'AI two'.length + 'AI three'.length)
  })
})

describe('restore_chat_file (QA TC-r2u-10: "go back to Junho\'s version")', () => {
  test('bob\'s AI brings back version 1 as the newest version, by "Trina for bob"; nothing is lost; a project chat or a hidden file refuses', async () => {
    const { chat, file, path: p } = await sent('promo.txt', 'LOOK A\n')
    await run('erin', chat, readThenEdit(p, 'LOOK A', 'LOOK B'))
    expect(await fileText('alice', chat, file)).toBe('LOOK B\n')
    const r = await run('bob', chat, fake({ tool: 'restore_chat_file', args: { file: p, version: 1 }, sayResult: true }))
    expect(r.content).toContain('saved as version 3')
    expect(await fileText('alice', chat, file)).toBe('LOOK A\n')
    const vs = store().versions('alice', chat, file)
    expect(vs.map((v) => [v.version, v.by, !!v.ai])).toEqual([[1, 'alice', false], [2, 'erin', true], [3, 'bob', true]])
    // a version that is not there: nothing changes
    const no = await run('bob', chat, fake({ tool: 'restore_chat_file', args: { file: p, version: 9 }, sayResult: true }))
    expect(no.content).toContain('Nothing was restored')
    expect(versionsOf(chat, file)).toBe(3)
  })
})
