// Versions of a chat's files (server/src/chat/chat-files.ts putVersion, visibleTo, versions, restore; migration 432;
// plan docs/AGENTS/plan/20261121-0646-chat-file-versions.md, P4 of 20261121-0615-chat-places-as-paths.md review fix 2
// and 7). Alice's chat makes a file, she shares it with bob (and later erin) with the file, and versions are written on
// the copy. Covered: the chain resolves root → head everywhere (the route by the root's id and a version's, find by name,
// the chip, visibleTo, the AI's chat_file), a hidden root keeps its versions hidden (route, list, name, versions, write),
// the sweep never deletes a version (and an unsent root takes its chain), the uploader's exemption is the root's alone,
// pruning keeps the root and the head, the size cap, the turn's write limits and the storage check, restore makes a new
// head, and from / fromSha256 never reach a client.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Attachment, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { CHAT_FILE_MAX, CHAT_FILE_VERSIONS_KEPT, chatFilesOf, UNSENT_CHAT_FILE_MS } from '../../server/src/chat/chat-files'
import { chatFilesAsHeads, copyForViewer } from '../../server/src/chat/store'
import { HttpError } from '../../server/src/http/errors'
import { MIGRATIONS_DIR, SCHEMA_READER_LEVEL, SchemaTooNewError, migrate, openDb, readMigrations } from '../../server/src/db'
import { setAnswerReads } from '../../server/src/chat/shared-answers'
import { roomsOf } from '../../server/src/rooms/service'
import { configureStorageGuard } from '../../server/src/system/storage'
import { setLimitsPlatformForTests, setPlanForTests } from '../../server/src/system/limits'
import { ToolError } from '../../server/src/policy/errors'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const enc = (s: string) => new TextEncoder().encode(s)

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-file-versions', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 10_000)
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const files = () => chatFilesOf(h.ctx)
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const bob: Sub = { subjectType: 'user', subjectId: 'bob' }
const erin: Sub = { subjectType: 'user', subjectId: 'erin' }
const put = (chatId: string, subjects: Sub[], o: { confirmKey?: string; withFiles?: boolean } = {}): Promise<PutChatAudienceResult> =>
  h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...o } })
const preview = (chatId: string, subjects: Sub[]) => h.api('alice').call(API.previewChatAudience, { params: { id: chatId }, body: { subjects } })
async function ask(user: string, chatId: string, content: string) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm() } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return { started, done: done.data.message }
}
let n = 0
/** alice's chat whose first answer made `name` in her folder, shared with `with` and the file: the chat, the answer, the
 * chain's root (the copy the answer carries) */
async function sharedCopy(name: string, body: string, withWho: Sub[] = [bob]) {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  const dir = `users/alice/versions-${++n}-${crypto.randomUUID().slice(0, 6)}`
  const r = await ask('alice', c.id, `make it\n${fake({ tool: 'write', args: { file_path: `${dir}/${name}`, content: body } }, { say: 'made' })}`)
  const p = await preview(c.id, withWho)
  const s = await put(c.id, withWho, { confirmKey: p.previewKey, withFiles: true })
  expect(s.status).toBe('saved')
  const root = (db().query("SELECT attachments FROM messages WHERE id = ?").get(r.started.assistantMessage.id) as { attachments: string })
  const copy = (JSON.parse(root.attachments) as Attachment[]).find((a) => a.origin === 'shared-copy')!
  return { chatId: c.id, answer: r.started.assistantMessage.id, rootId: copy.id, dir }
}
const fileReq = (user: string, chatId: string, id: string) => h.req(user, `/api/chats/${chatId}/files/${id}`)
const chip = async (user: string, chatId: string, answer: string) =>
  ((await (await h.req(user, `/api/chats/${chatId}/messages`)).json()).items.find((m: { id: string }) => m.id === answer).attachments as (Attachment & Record<string, unknown>)[]).find((a) => a.source === 'chat')
const hideFromOthers = (chatId: string, answer: string) => setAnswerReads(db(), chatId, answer, [{ c: ['alice', 'bob'], s: [], x: 1 }])
/** an upload of `user`'s in the chat, not sent in a message */
async function unsent(user: string, chatId: string, name: string, body: string) {
  const src = path.join(h.ctx.config.dataDir, 'work', `up-${crypto.randomUUID()}`)
  fs.mkdirSync(path.dirname(src), { recursive: true })
  fs.writeFileSync(src, body)
  const sha = new Bun.CryptoHasher('sha256').update(body).digest('hex')
  return files().create(user, chatId, name, src, sha)
}

describe('a chain resolves root → head', () => {
  test('a version: the root\'s id and the version\'s open the newest, the chip shows it with who changed it, find and visibleTo give the head', async () => {
    const c = await sharedCopy('quote.md', 'v1 text')
    const r = await files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('v2 text, longer') })
    expect(r.beside).toBe(false)
    expect(r.replaced.id).toBe(c.rootId)
    expect(r.row).toMatchObject({ root_id: c.rootId, replaces: c.rootId, version: 2, name: 'quote.md', user_id: 'bob', origin: null })
    for (const u of ['alice', 'bob']) {
      expect(await (await fileReq(u, c.chatId, c.rootId)).text()).toBe('v2 text, longer')
      expect(await (await fileReq(u, c.chatId, r.row.id)).text()).toBe('v2 text, longer')
    }
    expect((await fileReq('carol', c.chatId, r.row.id)).status).toBe(404)
    // the AI's edit: origin 'ai', a third version
    const ai = await files().putVersion('alice', c.chatId, r.row.id, { bytes: enc('v3 by the AI') }, { origin: 'ai', expectHead: r.row.id })
    expect(ai.row).toMatchObject({ version: 3, replaces: r.row.id, origin: 'ai' })
    // the chip keeps the chain's id, with the head's size and who changed it
    const a = await chip('bob', c.chatId, c.answer)
    expect(a).toMatchObject({ id: c.rootId, name: 'quote.md', size: 'v3 by the AI'.length, updated: { by: 'alice', version: 3, ai: true } })
    expect(typeof a!.updated!.byName).toBe('string')
    expect(a!.updated!.at).toBe(ai.row.created_at)
    // one entry per chain, its head; by name, by the root's id, by a version's id
    const seen = files().visibleTo('bob', c.chatId)
    expect(seen.map((v) => [v.id, v.head.id, v.versions])).toEqual([[c.rootId, ai.row.id, 3]])
    expect(files().find('bob', c.chatId, 'quote.md', true)?.head.id).toBe(ai.row.id)
    expect(files().find('bob', c.chatId, r.row.id)?.id).toBe(c.rootId)
    expect(files().find('bob', c.chatId, 'quote.md')).toBeNull()
    // sent: a version counts as its root does
    expect(files().sent(r.row)).toBe(true)
    // bob's AI reads the chain by the root's file_id: the newest bytes
    const read = await ask('bob', c.chatId, fake({ tool: 'chat_file', args: { file: c.rootId }, sayResult: true }))
    expect(read.done.content).toContain('v3 by the AI')
    expect(read.done.content).toContain(`file_id=${c.rootId}`)
    // a head that changed since the caller read it: the save is a version beside it, nothing lost
    const late = await files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('bob, late') }, { expectHead: r.row.id })
    expect(late.beside).toBe(true)
    expect(late.replaced.id).toBe(ai.row.id)
    expect(files().versions('bob', c.chatId, c.rootId).map((v) => v.version)).toEqual([1, 2, 3, 4])
  })

  test('restore: version n\'s bytes become a new head; versions and version n read the chain', async () => {
    const c = await sharedCopy('plan.md', 'first')
    await files().putVersion('alice', c.chatId, c.rootId, { bytes: enc('second') })
    const back = await files().restore('bob', c.chatId, c.rootId, 1)
    expect(back.row).toMatchObject({ version: 3, user_id: 'bob' })
    expect(await (await fileReq('alice', c.chatId, c.rootId)).text()).toBe('first')
    expect(fs.readFileSync(files().openVersion('bob', c.chatId, c.rootId, 2).abs, 'utf8')).toBe('second')
    const vs = files().versions('alice', c.chatId, c.rootId)
    expect(vs.map((v) => [v.version, v.by, !!v.head])).toEqual([[1, 'alice', false], [2, 'alice', false], [3, 'bob', true]])
    expect(() => files().openVersion('alice', c.chatId, c.rootId, 9)).toThrow()
    expect(db().query("SELECT 1 AS ok FROM audit_log WHERE action = 'chat.file_restore' AND target = ?").get(c.chatId)).toEqual({ ok: 1 })
  })
})

describe('who sees a chain', () => {
  test('a hidden root keeps its versions hidden: the route, the list, the name, versions, a write', async () => {
    const c = await sharedCopy('secret.md', 'alice and bob only', [bob, erin])
    const v = await files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('still only them') })
    hideFromOthers(c.chatId, c.answer)
    for (const id of [c.rootId, v.row.id]) {
      expect((await fileReq('bob', c.chatId, id)).status).toBe(200)
      expect((await fileReq('erin', c.chatId, id)).status).toBe(404)
    }
    expect(files().visibleTo('erin', c.chatId)).toEqual([])
    expect(files().find('erin', c.chatId, 'secret.md', true)).toBeNull()
    expect(files().find('erin', c.chatId, v.row.id)).toBeNull()
    expect(files().versions('erin', c.chatId, c.rootId)).toEqual([])
    expect(() => files().openVersion('erin', c.chatId, c.rootId, 1)).toThrow()
    await expect(files().putVersion('erin', c.chatId, c.rootId, { bytes: enc('erin was here') })).rejects.toThrow()
    await expect(files().restore('erin', c.chatId, c.rootId, 1)).rejects.toThrow()
    expect(files().versions('bob', c.chatId, c.rootId)).toHaveLength(2)
    // erin's AI finds nothing by the name either
    const r = await ask('erin', c.chatId, fake({ tool: 'chat_file', args: { file: 'secret.md' }, sayResult: true }))
    expect(r.done.content).not.toContain('still only them')
    expect(r.done.content).not.toContain('alice and bob only')
  })

  test('name lookup does not leak: someone else\'s unsent upload, and a version\'s writer is never the uploader', async () => {
    const c = await sharedCopy('shown.md', 'shown')
    const up = await unsent('alice', c.chatId, 'draft-name.md', 'alice draft')
    const v = await files().putVersion('alice', c.chatId, up.id, { bytes: enc('alice draft 2') })
    // her own unsent upload: hers, and its versions
    expect(files().find('alice', c.chatId, 'draft-name.md', true)?.head.id).toBe(v.row.id)
    expect((await fileReq('alice', c.chatId, up.id)).status).toBe(200)
    // bob: no name, no id, no list entry, no write
    expect(files().visibleTo('bob', c.chatId).map((x) => x.root.name)).toEqual(['shown.md'])
    expect(files().find('bob', c.chatId, 'draft-name.md', true)).toBeNull()
    for (const id of [up.id, v.row.id]) expect((await fileReq('bob', c.chatId, id)).status).toBe(404)
    await expect(files().putVersion('bob', c.chatId, up.id, { bytes: enc('x') })).rejects.toThrow()
    // a version row that names bob as its writer gives him nothing: the exemption is the root's uploader's alone
    db().query('UPDATE chat_files SET user_id = ? WHERE id = ?').run('bob', v.row.id)
    expect((await fileReq('bob', c.chatId, v.row.id)).status).toBe(404)
    expect(files().find('bob', c.chatId, v.row.id)).toBeNull()
    // a version id is never sent by a message (ownByIds: roots only)
    expect([...files().ownByIds('bob', c.chatId, [v.row.id]).keys()]).toEqual([])
    expect([...files().ownByIds('alice', c.chatId, [up.id]).keys()]).toEqual([up.id])
  })
})

describe('the sweep and pruning', () => {
  test('the sweep never deletes a version of a sent root; an unsent root a day old takes its chain', async () => {
    const c = await sharedCopy('kept.md', 'kept')
    const v = await files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('kept 2') })
    const up = await unsent('bob', c.chatId, 'never-sent.md', 'x')
    const uv = await files().putVersion('bob', c.chatId, up.id, { bytes: enc('x2') })
    const old = new Date(Date.now() - UNSENT_CHAT_FILE_MS - 60_000).toISOString()
    db().query('UPDATE chat_files SET created_at = ? WHERE chat_id = ?').run(old, c.chatId)
    files().sweep()
    expect(files().row(v.row.id)).not.toBeNull()
    expect(files().row(c.rootId)).not.toBeNull()
    expect(await (await fileReq('bob', c.chatId, c.rootId)).text()).toBe('kept 2')
    expect(files().row(up.id)).toBeNull()
    expect(files().row(uv.row.id)).toBeNull()
    // the bytes went with the rows (the sweep does not set them aside as orphans later)
    const dir = path.join(files().root(), c.chatId)
    expect(fs.readdirSync(dir).filter((f) => f.startsWith(up.id) || f.startsWith(uv.row.id))).toEqual([])
    expect(fs.readdirSync(dir)).toContain(v.row.id)
  })

  test(`pruning keeps ${CHAT_FILE_VERSIONS_KEPT} rows: the root and the newest, never the head`, async () => {
    const c = await sharedCopy('many.md', 'v1')
    let last = ''
    for (let i = 2; i <= CHAT_FILE_VERSIONS_KEPT + 5; i++) last = (await files().putVersion('alice', c.chatId, c.rootId, { bytes: enc(`v${i}`) })).row.id
    const chain = files().chain(c.rootId)
    expect(chain).toHaveLength(CHAT_FILE_VERSIONS_KEPT)
    expect(chain[0]!.id).toBe(c.rootId)
    expect(chain[chain.length - 1]!.id).toBe(last)
    expect(chain.map((r) => r.version ?? 1)).toEqual([1, ...Array.from({ length: CHAT_FILE_VERSIONS_KEPT - 1 }, (_, i) => i + 7)])
    expect(await (await fileReq('bob', c.chatId, c.rootId)).text()).toBe(`v${CHAT_FILE_VERSIONS_KEPT + 5}`)
    // the version numbers stay: version 10 is still v10
    expect(fs.readFileSync(files().openVersion('bob', c.chatId, c.rootId, 10).abs, 'utf8')).toBe('v10')
    expect(() => files().openVersion('bob', c.chatId, c.rootId, 3)).toThrow()
    // the rows go with the chat
    files().removeChat(c.chatId)
    expect(files().chain(c.rootId)).toEqual([])
  })
})

describe('limits', () => {
  test('the size cap (a person\'s 50 MB), the turn\'s write limits, the team\'s storage: nothing written', async () => {
    const c = await sharedCopy('limits.md', 'v1')
    const rows = () => files().chain(c.rootId).length
    const big = { fd: -1, st: { size: CHAT_FILE_MAX + 1 } }
    await expect(files().putVersion('bob', c.chatId, c.rootId, big)).rejects.toMatchObject({ code: 'payload_too_large' })
    const max = h.ctx.engineConfig.maxWriteBytesPerTurn
    const turn = { bytesWritten: max - 2, filesWritten: new Set<string>() }
    await expect(files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('too much') }, { origin: 'ai', turn })).rejects.toBeInstanceOf(ToolError)
    const full = { bytesWritten: 0, filesWritten: new Set(Array.from({ length: h.ctx.engineConfig.maxFilesWrittenPerTurn }, (_, i) => `x/${i}`)) }
    await expect(files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('one more') }, { origin: 'ai', turn: full })).rejects.toBeInstanceOf(ToolError)
    // a turn's write counts once per chain
    const ok = { bytesWritten: 0, filesWritten: new Set<string>() }
    await files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('fits') }, { origin: 'ai', turn: ok })
    expect(ok).toEqual({ bytesWritten: 4, filesWritten: new Set([`chat:files/${c.rootId}`]) })
    // the team's disk near full (the plan's guard on Linux)
    const GiB = 1024 ** 3
    configureStorageGuard({ root: '/', statfs: () => ({ bsize: 4096, blocks: 20 * GiB / 4096, bfree: 0.1 * GiB / 4096, bavail: 0.1 * GiB / 4096 }), enforce: () => true })
    setLimitsPlatformForTests('linux')
    setPlanForTests(null)
    try {
      await expect(files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('no room') })).rejects.toMatchObject({ code: 'storage_full' })
    } finally { configureStorageGuard(null); setLimitsPlatformForTests(null); setPlanForTests(undefined) }
    expect(rows()).toBe(2)
    expect(await (await fileReq('bob', c.chatId, c.rootId)).text()).toBe('fits')
  })

  test('a checked descriptor is streamed; one that is shorter than it said is refused and nothing is kept', async () => {
    const c = await sharedCopy('fd.md', 'v1')
    const src = path.join(h.ctx.config.dataDir, 'work', `fd-${crypto.randomUUID()}`)
    fs.writeFileSync(src, 'from a descriptor')
    const fd = fs.openSync(src, 'r')
    try {
      const r = await files().putVersion('alice', c.chatId, c.rootId, { fd, st: fs.fstatSync(fd) })
      expect(r.row.sha256).toBe(new Bun.CryptoHasher('sha256').update('from a descriptor').digest('hex'))
      await expect(files().putVersion('alice', c.chatId, c.rootId, { fd, st: { size: 999 } })).rejects.toThrow()
    } finally { fs.closeSync(fd) }
    expect(files().chain(c.rootId)).toHaveLength(2)
    expect(await (await fileReq('bob', c.chatId, c.rootId)).text()).toBe('from a descriptor')
  })
})

describe('from and fromSha256 stay on the server', () => {
  test('copyForViewer strips them from every attachment, versions included; the chip and versions carry neither', async () => {
    const stored = { id: '01900000-0000-7000-8000-000000000001', name: 'x.md', path: '', size: 1, mime: 'text/markdown', kind: 'other' as const, source: 'chat' as const, from: 'users/alice/x.md', fromSha256: 'a'.repeat(64) }
    expect(copyForViewer({ ...stored, origin: 'ai' }, true)).not.toHaveProperty('from')
    expect(copyForViewer({ ...stored, origin: 'ai' }, true)).not.toHaveProperty('fromSha256')
    expect(copyForViewer(stored, true)).not.toHaveProperty('from')
    expect(copyForViewer({ ...stored, origin: 'shared-copy' }, true)).toMatchObject({ from: 'users/alice/x.md' })
    expect(copyForViewer({ ...stored, origin: 'shared-copy' }, true)).not.toHaveProperty('fromSha256')
    expect(copyForViewer({ ...stored, origin: 'shared-copy' }, false)).not.toHaveProperty('from')
    const c = await sharedCopy('copy.md', 'v1')
    await files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('v2') }, { origin: 'ai' })
    const bobs = await chip('bob', c.chatId, c.answer)
    expect(bobs).not.toHaveProperty('from')
    expect(bobs).not.toHaveProperty('fromSha256')
    expect(JSON.stringify(bobs)).not.toContain(c.dir)
    const alices = await chip('alice', c.chatId, c.answer)
    expect(alices!.from).toBe(`${c.dir}/copy.md`)
    expect(alices).not.toHaveProperty('fromSha256')
    for (const v of files().versions('bob', c.chatId, c.rootId)) {
      expect(Object.keys(v).sort()).toEqual(expect.arrayContaining(['by', 'byName', 'createdAt', 'id', 'mime', 'name', 'size', 'version']))
      for (const k of ['from', 'fromSha256', 'sha256', 'path', 'abs']) expect(v).not.toHaveProperty(k)
    }
  })
})

// independent review of #217 (2026-11-21)
describe('review: what a version write re-checks', () => {
  test('an older build cannot open the database: it would read a version as an upload never sent and sweep it', () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.name === '432_b_chat_file_versions.sql')!
    expect(m.minCompatibleReader).toBe(9)
    expect(SCHEMA_READER_LEVEL).toBeGreaterThanOrEqual(9)
    expect(() => migrate(openDb(':memory:'), { readerLevel: 8 })).toThrow(SchemaTooNewError)
  })

  test('access lost while the bytes are written: nothing is kept', async () => {
    const c = await sharedCopy('late-loss.md', 'v1', [bob, erin])
    const p = files().putVersion('erin', c.chatId, c.rootId, { bytes: enc('erin, after she lost it') })
    // synchronously after the call started (its first await): the answer is now hidden from erin
    hideFromOthers(c.chatId, c.answer)
    await expect(p).rejects.toThrow()
    expect(files().chain(c.rootId)).toHaveLength(1)
    expect(fs.readdirSync(path.join(files().root(), c.chatId)).filter((f) => !f.startsWith(c.rootId))).toEqual([])
  })

  test('a chat in the trash, or read-only under safe operations: no version', async () => {
    const c = await sharedCopy('readonly.md', 'v1')
    process.env.MYCEL_SAFE_OPS_1A = '1'
    try {
      await expect(files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('x') })).rejects.toMatchObject({ code: 'conflict' })
      await expect(files().restore('bob', c.chatId, c.rootId, 1)).rejects.toMatchObject({ code: 'conflict' })
    } finally { delete process.env.MYCEL_SAFE_OPS_1A }
    db().query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), c.chatId)
    try {
      await expect(files().putVersion('alice', c.chatId, c.rootId, { bytes: enc('x') })).rejects.toMatchObject({ code: 'not_found' })
    } finally { db().query('UPDATE chats SET deleted_at = NULL WHERE id = ?').run(c.chatId) }
    expect(files().chain(c.rootId)).toHaveLength(1)
  })

  test('two writes of one turn at once count against its limit together; a failed write gives its share back', async () => {
    const c = await sharedCopy('turn-race.md', 'v1')
    const max = h.ctx.engineConfig.maxWriteBytesPerTurn
    const half = enc('six b.')
    const turn = { bytesWritten: max - 10, filesWritten: new Set<string>() }
    const both = await Promise.allSettled([
      files().putVersion('bob', c.chatId, c.rootId, { bytes: half }, { origin: 'ai', turn }),
      files().putVersion('bob', c.chatId, c.rootId, { bytes: half }, { origin: 'ai', turn }),
    ])
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(turn.bytesWritten).toBe(max - 10 + half.byteLength)
    const t2 = { bytesWritten: 0, filesWritten: new Set<string>() }
    await expect(files().putVersion('erin', c.chatId, c.rootId, { bytes: enc('x') }, { origin: 'ai', turn: t2 })).rejects.toThrow()
    expect(t2).toEqual({ bytesWritten: 0, filesWritten: new Set() })
  })

  test('a person\'s save on a full disk is the HTTP storage_full, not the AI\'s words', async () => {
    const c = await sharedCopy('full.md', 'v1')
    const GiB = 1024 ** 3
    configureStorageGuard({ root: '/', statfs: () => ({ bsize: 4096, blocks: 20 * GiB / 4096, bfree: 0.1 * GiB / 4096, bavail: 0.1 * GiB / 4096 }), enforce: () => true })
    setLimitsPlatformForTests('linux')
    setPlanForTests(null)
    try {
      const e = await files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('no room') }).catch((x) => x)
      expect(e).toBeInstanceOf(HttpError)
      expect(e.code).toBe('storage_full')
      expect(await files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('no room') }, { origin: 'ai' }).catch((x) => x)).toBeInstanceOf(ToolError)
    } finally { configureStorageGuard(null); setLimitsPlatformForTests(null); setPlanForTests(undefined) }
  })

  test('a person may restore a version the AI wrote that is over a person\'s 50 MB', async () => {
    const c = await sharedCopy('big.bin', 'v1')
    const src = path.join(h.ctx.config.dataDir, 'work', `big-${crypto.randomUUID()}`)
    fs.writeFileSync(src, '')
    fs.truncateSync(src, CHAT_FILE_MAX + 1)
    const fd = fs.openSync(src, 'r')
    try { await files().putVersion('alice', c.chatId, c.rootId, { fd, st: fs.fstatSync(fd) }, { origin: 'ai' }) } finally { fs.closeSync(fd); fs.rmSync(src, { force: true }) }
    await files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('small again') })
    const back = await files().restore('bob', c.chatId, c.rootId, 2)
    expect(back.row).toMatchObject({ version: 4, size: CHAT_FILE_MAX + 1, user_id: 'bob' })
    // a person's own new bytes stay at 50 MB
    await expect(files().putVersion('bob', c.chatId, c.rootId, { fd: -1, st: { size: CHAT_FILE_MAX + 1 } })).rejects.toMatchObject({ code: 'payload_too_large' })
  })

  test('the chip\'s newest version is looked up in the message\'s own chat only', async () => {
    const c = await sharedCopy('elsewhere.md', 'v1')
    await files().putVersion('bob', c.chatId, c.rootId, { bytes: enc('v2') })
    const att: Attachment = { id: c.rootId, name: 'elsewhere.md', path: '', size: 2, mime: 'text/markdown', kind: 'text', source: 'chat' }
    expect(chatFilesAsHeads(db(), c.chatId, [att])[0]).toHaveProperty('updated')
    expect(chatFilesAsHeads(db(), crypto.randomUUID(), [att])[0]).toEqual(att)
  })
})
