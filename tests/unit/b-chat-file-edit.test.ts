// A chat's file edited in place from the web, with versions (server/src/chat/chat-file-edit.ts and the thin routes in
// routes/chats.ts over ChatFiles P4; plan docs/AGENTS/plan/20261121-1206-chat-file-edit-versions.md). Alice's chat made a
// file, she shared it with bob (and erin) with the file. Covered: the versions route and canEdit, a save by anyone who
// may open it (a new version, never an overwrite), `beside` when someone saved since, ?version=n, restore as a new head,
// each person in the chat told (message.attachments) except whom it is hidden from, a hidden root's 404 on every route,
// read-only refusals (not text, a chat no longer shared with people, safe operations), and a re-share of a changed
// original as a new version of the same chain (no second copy).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { chatFilePath } from '@mycel/shared/places'
import { API, type Attachment, type ChatFileSaved, type ChatFileVersions, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { chatFilesOf } from '../../server/src/chat/chat-files'
import { CHAT_FILE_SAVES_PER_MINUTE } from '../../server/src/chat/chat-file-edit'
import { setAnswerReads } from '../../server/src/chat/shared-answers'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-file-edit', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const bob: Sub = { subjectType: 'user', subjectId: 'bob' }
const erin: Sub = { subjectType: 'user', subjectId: 'erin' }
const put = (chatId: string, subjects: Sub[], o: { confirmKey?: string; withFiles?: boolean } = {}): Promise<PutChatAudienceResult> =>
  h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...o } })
const preview = (chatId: string, subjects: Sub[]) => h.api('alice').call(API.previewChatAudience, { params: { id: chatId }, body: { subjects } })
async function ask(user: string, chatId: string, content: string) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm() } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return started
}
let n = 0
async function sharedCopy(name: string, body: string, withWho: Sub[] = [bob]) {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  const dir = `users/alice/edit-${++n}-${crypto.randomUUID().slice(0, 6)}`
  const r = await ask('alice', c.id, `make it\n${fake({ tool: 'write', args: { file_path: `${dir}/${name}`, content: body } }, { say: 'made' })}`)
  const p = await preview(c.id, withWho)
  const s = await put(c.id, withWho, { confirmKey: p.previewKey, withFiles: true })
  expect(s.status).toBe('saved')
  const row = db().query('SELECT attachments FROM messages WHERE id = ?').get(r.assistantMessage.id) as { attachments: string }
  const copy = (JSON.parse(row.attachments) as Attachment[]).find((a) => a.origin === 'shared-copy')!
  return { chatId: c.id, answer: r.assistantMessage.id, rootId: copy.id, dir, path: `${dir}/${name}` }
}
const versions = (user: string, chatId: string, id: string) => h.req(user, `/api/chats/${chatId}/files/${id}/versions`)
const save = (user: string, chatId: string, id: string, content: string, baseVersion?: string) =>
  h.req(user, `/api/chats/${chatId}/files/${id}/content`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, ...(baseVersion ? { baseVersion } : {}) }) })
const restore = (user: string, chatId: string, id: string, v: number | string) => h.req(user, `/api/chats/${chatId}/files/${id}/versions/${v}/restore`, { method: 'POST' })
const read = (user: string, chatId: string, id: string, v?: number) => h.req(user, `/api/chats/${chatId}/files/${id}${v ? `?version=${v}` : ''}`)
const reason = async (r: Response) => ((await r.json()) as { error: { params?: { reason?: string } } }).error.params?.reason

describe('edit a chat file from the web', () => {
  test('anyone who may open it saves a new version; the others are told; ?version=n reads an earlier one', async () => {
    const c = await sharedCopy('notes.md', '# v1')
    const list = (await (await versions('bob', c.chatId, c.rootId)).json()) as ChatFileVersions
    expect(list.canEdit).toBe(true)
    expect(list.items.map((v) => v.version)).toEqual([1])
    expect((await versions('carol', c.chatId, c.rootId)).status).toBe(404)
    const before = ws.alice!.frames.length
    const r = await save('bob', c.chatId, c.rootId, '# v2 by bob', list.items[0]!.id)
    expect(r.status).toBe(200)
    const s = (await r.json()) as ChatFileSaved
    expect(s).toMatchObject({ beside: false, version: { version: 2, by: 'bob', byName: expect.any(String), head: true, name: 'notes.md' } })
    // alice's tile: the newest version, who changed it
    const f = await ws.alice!.next('message.attachments', (x) => x.data.chatId === c.chatId && ws.alice!.frames.indexOf(x) >= before)
    const tile = f.data.attachments.find((a) => a.id === c.rootId)!
    expect(tile.updated).toMatchObject({ by: 'bob', version: 2 })
    expect(JSON.stringify(f.data.attachments)).not.toContain('fromSha256')
    expect(await (await read('alice', c.chatId, c.rootId)).text()).toBe('# v2 by bob')
    expect(await (await read('alice', c.chatId, c.rootId, 1)).text()).toBe('# v1')
    expect((await read('alice', c.chatId, c.rootId, 9)).status).toBe(404)
    // saved from version 1 while version 2 is the head: both kept
    const late = (await (await save('alice', c.chatId, c.rootId, '# alice from v1', list.items[0]!.id)).json()) as ChatFileSaved
    expect(late).toMatchObject({ beside: true, version: { version: 3, by: 'alice' } })
    // the version saved in between is named, so the notice says whose it is and opens it (QA TC-6956)
    expect(late.besideOf).toMatchObject({ version: 2, by: 'bob', byName: expect.any(String) })
    expect(late.besideOf!.head).toBeUndefined()
    expect(late.pruned).toBeUndefined()
    // restore version 1: a new head with its bytes, nothing deleted
    const back = (await (await restore('bob', c.chatId, c.rootId, 1)).json()) as ChatFileSaved
    expect(back.version.version).toBe(4)
    expect(await (await read('bob', c.chatId, c.rootId)).text()).toBe('# v1')
    const after = (await (await versions('alice', c.chatId, c.rootId)).json()) as ChatFileVersions
    expect(after.items.map((v) => v.version)).toEqual([1, 2, 3, 4])
    expect(db().query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'chat.file_restore' AND target = ?").get(c.chatId)).toEqual({ n: 1 })
    expect((await restore('bob', c.chatId, c.rootId, 'x')).status).toBe(404)
    expect((await restore('bob', c.chatId, c.rootId, 99)).status).toBe(404)
  })

  test('a root hidden from someone: every route is the 404 of a missing file, and they are never told', async () => {
    const c = await sharedCopy('secret.md', 'only alice and bob', [bob, erin])
    setAnswerReads(db(), c.chatId, c.answer, [{ c: ['alice', 'bob'], s: [], x: 1 }])
    expect((await versions('erin', c.chatId, c.rootId)).status).toBe(404)
    expect((await save('erin', c.chatId, c.rootId, 'erin was here')).status).toBe(404)
    expect((await restore('erin', c.chatId, c.rootId, 1)).status).toBe(404)
    expect((await read('erin', c.chatId, c.rootId, 1)).status).toBe(404)
    const mark = ws.erin!.frames.length
    expect((await save('bob', c.chatId, c.rootId, 'still only them')).status).toBe(200)
    await ws.alice!.next('message.attachments', (x) => x.data.chatId === c.chatId)
    await Bun.sleep(200)
    expect(ws.erin!.frames.slice(mark).some((x) => x.type === 'message.attachments' && x.data.chatId === c.chatId)).toBe(false)
    expect(chatFilesOf(h.ctx).versions('erin', c.chatId, c.rootId)).toEqual([])
  })

  test('read-only: a name that is not text, a chat no longer shared with people, safe operations', async () => {
    const bin = await sharedCopy('data.bin', 'not text')
    expect(((await (await versions('bob', bin.chatId, bin.rootId)).json()) as ChatFileVersions).canEdit).toBe(false)
    const r = await save('bob', bin.chatId, bin.rootId, 'x')
    expect(r.status).toBe(409)
    expect(await reason(r)).toBe('chat_file_read_only')
    expect(await reason(await restore('bob', bin.chatId, bin.rootId, 1))).toBe('chat_file_read_only')

    const c = await sharedCopy('plan.md', 'v1')
    const prev = process.env.MYCEL_SAFE_OPS_1A
    process.env.MYCEL_SAFE_OPS_1A = '1'
    try {
      const s = await save('bob', c.chatId, c.rootId, 'x')
      expect(s.status).toBe(409)
      expect(await reason(s)).toBe('safe_ops')
    } finally { if (prev === undefined) delete process.env.MYCEL_SAFE_OPS_1A; else process.env.MYCEL_SAFE_OPS_1A = prev }
    // made alice's alone again (its files stay hers to see, as a project chat's: not a place to save)
    db().query('UPDATE chats SET people_shared_at = NULL WHERE id = ?').run(c.chatId)
    expect(((await (await versions('alice', c.chatId, c.rootId)).json()) as ChatFileVersions).canEdit).toBe(false)
    expect(await reason(await save('alice', c.chatId, c.rootId, 'x'))).toBe('chat_file_read_only')
    expect((await save('bob', c.chatId, c.rootId, 'x')).status).toBe(404)
  })
})

describe('the write itself (putVersion recheck, the AI\'s versions)', () => {
  test('the chat stops being shared with people while the bytes are written: refused, no version, no bytes left', async () => {
    const c = await sharedCopy('race.md', 'v1')
    const files = chatFilesOf(h.ctx) as unknown as { writeVersion: (...a: unknown[]) => Promise<string> }
    const orig = files.writeVersion
    const dir = path.join(chatFilesOf(h.ctx).root(), c.chatId)
    const before = fs.readdirSync(dir).length
    files.writeVersion = async function (this: unknown, ...a: unknown[]) {
      const sha = await orig.apply(this, a)
      // made alice's alone again between the checks and the insert
      db().query('UPDATE chats SET people_shared_at = NULL WHERE id = ?').run(c.chatId)
      return sha
    }
    try {
      const r = await save('alice', c.chatId, c.rootId, 'v2 written while it changed')
      expect(r.status).toBe(409)
      expect(await reason(r)).toBe('chat_file_read_only')
    } finally { files.writeVersion = orig }
    expect(chatFilesOf(h.ctx).chain(c.rootId)).toHaveLength(1)
    expect(fs.readdirSync(dir).length).toBe(before)
    expect(await (await read('alice', c.chatId, c.rootId)).text()).toBe('v1')
  })

  test('a version the AI saved reaches the open windows: alice\'s tile says "Trina for bob" at once', async () => {
    const c = await sharedCopy('agenda.md', '# agenda\n- budget\n')
    const p = chatFilePath(c.rootId, 'agenda.md')
    const mark = ws.alice!.frames.length
    await ask('bob', c.chatId, `add the launch\n${fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit', args: { file_path: p, old_string: '- budget', new_string: '- budget\n- launch' }, sayResult: true })}`)
    const f = await ws.alice!.next('message.attachments', (x) => x.data.chatId === c.chatId && ws.alice!.frames.indexOf(x) >= mark && !!x.data.attachments.find((a) => a.id === c.rootId)?.updated)
    expect(f.data.messageId).toBe(c.answer)
    expect(f.data.attachments.find((a) => a.id === c.rootId)!.updated).toMatchObject({ by: 'bob', version: 2, ai: true })
  })
})

describe('the save route\'s limits (S2 review L1, L3)', () => {
  test('a 5 MB text saves (the JSON limit is the edit limit\'s, not the default 1 MB)', async () => {
    const c = await sharedCopy('big.txt', 'small')
    const big = 'x'.repeat(5 * 1024 * 1024)
    const r = await save('alice', c.chatId, c.rootId, big)
    expect(r.status).toBe(200)
    expect(((await r.json()) as ChatFileSaved).version.size).toBe(big.length)
  })

  test('saves and restores are limited per person a minute (429 with retryAfter); someone it is hidden from still gets 404', async () => {
    const c = await sharedCopy('busy.md', 'v1', [bob, erin])
    let limited: Response | null = null
    for (let i = 0; i < CHAT_FILE_SAVES_PER_MINUTE + 1 && !limited; i++) {
      const r = i % 2 ? await save('erin', c.chatId, c.rootId, `v${i}`) : await restore('erin', c.chatId, c.rootId, 1)
      if (r.status === 429) limited = r
      else expect(r.status).toBe(200)
    }
    expect(limited).not.toBeNull()
    expect(((await limited!.json()) as { error: { retryAfter?: number } }).error.retryAfter).toBeGreaterThan(0)
    // bob is not limited by erin's
    expect((await save('bob', c.chatId, c.rootId, 'bob')).status).toBe(200)
  })
})

describe('the 20 versions kept (QA TC-6949)', () => {
  test('a restore at the cap says which version went to keep 20; below the cap nothing is pruned', async () => {
    const c = await sharedCopy('cap.md', 'v1')
    // 20 rows: the root and versions 2..20, saved directly (the route's per-minute limit is not what this is about)
    for (let i = 2; i <= 20; i++) await chatFilesOf(h.ctx).putVersion('alice', c.chatId, c.rootId, { bytes: new TextEncoder().encode(`v${i}`) })
    const list = (await (await versions('alice', c.chatId, c.rootId)).json()) as ChatFileVersions
    expect(list.items.map((v) => v.version)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    const back = (await (await restore('bob', c.chatId, c.rootId, 5)).json()) as ChatFileSaved
    expect(back.version.version).toBe(21)
    // the oldest after the first goes; the first stays
    expect(back.pruned).toEqual([2])
    const after = (await (await versions('alice', c.chatId, c.rootId)).json()) as ChatFileVersions
    expect(after.items.map((v) => v.version)).toEqual([1, ...Array.from({ length: 19 }, (_, i) => i + 3)])
    expect(await (await read('alice', c.chatId, c.rootId)).text()).toBe('v5')
  })
})

describe('re-share of a changed original', () => {
  test('becomes a new version of the existing chain, never a second copy', async () => {
    const c = await sharedCopy('quote.md', 'price 100')
    // made hers alone again, the chat changes the original in her own folder, then she shares it again with the files
    expect((await put(c.chatId, [])).status).toBe('saved')
    await ask('alice', c.chatId, `change it\n${fake({ tool: 'read', args: { file_path: c.path } }, { tool: 'edit', args: { file_path: c.path, old_string: 'price 100', new_string: 'price 120' } }, { say: 'changed' })}`)
    const p = await preview(c.chatId, [bob])
    const s = await put(c.chatId, [bob], { confirmKey: p.previewKey, withFiles: true })
    expect(s).toMatchObject({ status: 'saved', filesAdded: 1 })
    const copies = (db().query("SELECT attachments FROM messages WHERE chat_id = ? AND role = 'assistant'").all(c.chatId) as { attachments: string }[])
      .flatMap((m) => JSON.parse(m.attachments) as (Attachment & { fromSha256?: string })[]).filter((a) => a.origin === 'shared-copy')
    expect(copies).toHaveLength(1)
    expect(copies[0]!.id).toBe(c.rootId)
    const list = (await (await versions('bob', c.chatId, c.rootId)).json()) as ChatFileVersions
    expect(list.items.map((v) => [v.version, v.by])).toEqual([[1, 'alice'], [2, 'alice']])
    expect(await (await read('bob', c.chatId, c.rootId)).text()).toBe('price 120')
    // nothing left to offer: the stored copy names the new bytes
    const again = await h.api('alice').call(API.getChatAudience, { params: { id: c.chatId } })
    expect(again.madeFiles ?? []).toEqual([])
  })
})
