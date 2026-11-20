// Settings › Export (QA AP-038, docs/decisions/20261120-export-my-chats.md; server/src/system/my-export.ts): every member
// downloads a ZIP of the AI chats they made. Covered: only the person's own chats (never another person's chat, also not
// one shared with them, never a deleted one), Markdown + JSON per chat, attachments as links only while the person can
// read them, stored secrets hidden in names, headings and JSON, one export at a time per person, the download only for
// its maker and only for 24 hours, the audit row, the sweep. People (b-harness): alice and erin members, bob member,
// dana owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiError, MyExportResult, type Job, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { readZip } from '../../server/src/files/zip-write'
import { messageFiles, MY_EXPORT_KEEP_MS, myChatJson, myChatMarkdown, myExportEntries, myExportFile, sweepMyExports } from '../../server/src/system/my-export'
import { zipOut } from '../../server/src/system/zip-out'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'g-my-export', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'dana']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
async function newChat(user: string, text: string) {
  const c = await h.api(user).call(API.createChat, { body: {} })
  const started = await h.api(user).call(API.sendMessage, { params: { id: c.id }, body: { content: `${text}\n${fake({ say: `answer to ${text}` })}`, clientMessageId: cm(), attachmentIds: [] } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return c.id
}
async function share(user: string, chatId: string, to: string) {
  const subjects = [{ subjectType: 'user' as const, subjectId: to }]
  let r: PutChatAudienceResult = await h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects } })
  if (r.status === 'confirm') r = await h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, confirmKey: r.confirmKey } })
  expect(r.status).toBe('saved')
}
async function finished(user: string, jobId: string): Promise<Job> {
  const j = await waitFor(async () => { const x = await h.api(user).call(API.getJob, { params: { id: jobId } }); return x.status === 'queued' || x.status === 'running' ? null : x }, { timeoutMs: 20_000, intervalMs: 50 })
  if (!j) throw new Error('job did not finish')
  return j
}
async function exportOf(user: string) {
  const { jobId } = await h.api(user).call(API.startMyExport, {})
  const job = await finished(user, jobId)
  expect(job.status).toBe('done')
  const result = MyExportResult.parse(job.result)
  const res = await h.req(user, result.download)
  expect(res.status).toBe(200)
  const files = new Map(readZip(new Uint8Array(await res.arrayBuffer())).filter((e) => !e.name.endsWith('/')).map((e) => [e.name, Buffer.from(e.data).toString('utf8')]))
  return { jobId, result, res, files }
}

describe('the export of my own chats', () => {
  test("only alice's own chats: not bob's chat shared with her, not dana's, not a deleted one; Markdown + JSON per chat", async () => {
    const mine = await newChat('alice', 'ALICE-OWN budget plan')
    const gone = await newChat('alice', 'ALICE-DELETED draft')
    await h.api('alice').call(API.deleteChat, { params: { id: gone } })
    const bobs = await newChat('bob', 'BOB-SHARED notes')
    await share('bob', bobs, 'alice')
    // alice sees bob's chat (it is shared with her), but it is bob's
    expect((await h.api('alice').call(API.getChat, { params: { id: bobs } })).id).toBe(bobs)
    await newChat('dana', 'DANA-OWNER secret plan')

    const { result, res, files } = await exportOf('alice')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const all = [...files.entries()].map(([n, t]) => `${n}\n${t}`).join('\n')
    expect(all).toContain('ALICE-OWN budget plan')
    expect(all).toContain('answer to ALICE-OWN budget plan')
    for (const other of ['BOB-SHARED', 'DANA-OWNER', 'ALICE-DELETED', bobs, gone]) expect(all).not.toContain(other)
    const names = [...files.keys()].sort()
    expect(names.every((n) => n.startsWith('chats/'))).toBe(true)
    expect(names.filter((n) => n.endsWith('.md')).length).toBe(names.filter((n) => n.endsWith('.json')).length)
    expect(result.chats).toBe(names.filter((n) => n.endsWith('.md')).length)
    const json = JSON.parse([...files.entries()].find(([n, t]) => n.endsWith('.json') && t.includes(mine))![1]) as { id: string; url: string; messages: { role: string; text: string }[] }
    expect(json.id).toBe(mine)
    expect(json.url).toMatch(new RegExp(`/c/${mine}$`))
    expect(json.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    // the activity log: who took a copy, how many chats (never their titles)
    const row = db().query("SELECT actor_id, detail FROM audit_log WHERE action = 'export.mine' ORDER BY id DESC").get() as { actor_id: string; detail: string }
    expect(row.actor_id).toBe('alice')
    expect(JSON.parse(row.detail)).toMatchObject({ chats: result.chats })
  })

  test("bob's own export holds his chat, never alice's; nobody else downloads it (404, the owner too)", async () => {
    const { jobId, result, files } = await exportOf('bob')
    const all = [...files.values()].join('\n')
    expect(all).toContain('BOB-SHARED notes')
    expect(all).not.toContain('ALICE-OWN')
    for (const u of ['alice', 'dana']) expect((await h.req(u, result.download)).status).toBe(404)
    expect((await h.req(null, result.download)).status).toBe(401)
    // another person cannot read the job either
    expect((await errOf(h.api('alice').call(API.getJob, { params: { id: jobId } }))).status).toBe(404)
  })

  test('one export at a time per person (409 busy); the next export replaces the earlier ZIP', async () => {
    // hold the server's one export line, so alice's export waits in the queue
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const holder = h.ctx.services.jobs!.start({ kind: 'export', userId: null, run: () => held })
    const first = await h.api('alice').call(API.startMyExport, {})
    const again = await errOf(h.api('alice').call(API.startMyExport, {}))
    expect([again.status, again.body.code]).toEqual([409, 'busy'])
    // another person is not held back by alice's export
    const bobs = await h.api('bob').call(API.startMyExport, {})
    release()
    await finished('dana', holder).catch(() => null)
    const a = await finished('alice', first.jobId)
    expect(a.status).toBe('done')
    await finished('bob', bobs.jobId)
    // the earlier ZIP of alice is gone; the new one is there
    const dir = path.dirname(myExportFile(h.dataDir, 'alice', first.jobId))
    expect(fs.readdirSync(dir)).toEqual([`${first.jobId}.zip`])
    // and alice may export again now
    const next = await h.api('alice').call(API.startMyExport, {})
    expect((await finished('alice', next.jobId)).status).toBe('done')
  })

  test('kept 24 hours: an older file is not given out and the sweep deletes it', async () => {
    const { jobId, result } = await exportOf('alice')
    const file = myExportFile(h.dataDir, 'alice', jobId)
    const old = new Date(Date.now() - MY_EXPORT_KEEP_MS - 60_000)
    fs.utimesSync(file, old, old)
    expect((await h.req('alice', result.download)).status).toBe(404)
    expect(sweepMyExports(h.dataDir)).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('what goes in a chat file', () => {
  const base = 'https://team.example'
  const att = (o: Record<string, unknown>) => JSON.stringify([{ id: '0190f0b2-0000-7000-8000-000000000001', name: 'plan.pdf', path: '', size: 10, mime: 'application/pdf', kind: 'pdf', ...o }])

  test('attachments are links: a chat file always, an upload or team file only while the person can read it', () => {
    const readable = (rel: string) => rel === 'users/alice/.attachments/c1/plan.pdf'
    expect(messageFiles({ attachments: att({ source: 'chat' }) }, 'c1', base, readable)[0]!.url).toBe(`${base}/api/chats/c1/files/0190f0b2-0000-7000-8000-000000000001?download=1`)
    expect(messageFiles({ attachments: att({ path: 'users/alice/.attachments/c1/plan.pdf' }) }, 'c1', base, readable)[0]!.url).toBe(`${base}/api/files/download?path=users%2Falice%2F.attachments%2Fc1%2Fplan.pdf`)
    // a team file alice can no longer read: neither its name nor its path
    const lost = messageFiles({ attachments: att({ source: 'team', name: 'salaries.xlsx', path: 'groups/finance/salaries.xlsx' }) }, 'c1', base, readable)
    expect(lost).toEqual([{ name: '', size: 0, mime: '', url: null }])
    expect(messageFiles({ attachments: 'not json' }, 'c1', base, readable)).toEqual([])
  })

  test('a withheld answer is one line with no text and no files; the chat links back to the team', () => {
    const chat = { id: 'c1', title: 'Plan', created_at: '2026-11-20T01:00:00Z', updated_at: '2026-11-20T02:00:00Z', engine: 'claude', active_leaf_id: null }
    const msgs = [
      { id: 'm1', parent_id: null, role: 'user' as const, content: 'question', created_at: '2026-11-20T01:00:00Z', status: 'done', engine: null, model: null, attachments: att({ source: 'chat' }) },
      { id: 'm2', parent_id: 'm1', role: 'assistant' as const, content: 'HIDDEN-ANSWER', created_at: '2026-11-20T01:01:00Z', status: 'done', engine: 'claude', model: 'x', attachments: '[]' },
    ]
    const files = (m: { role: string; attachments?: string }) => m.role === 'user' ? messageFiles(m, 'c1', base) : []
    const md = myChatMarkdown(chat, msgs, base, 'en', (id) => id === 'm2', files)
    expect(md.split('\n').slice(0, 3)).toEqual(['# Plan', '', `<${base}/c/c1>`])
    expect(md).toContain(`- File: [plan.pdf](<${base}/api/chats/c1/files/0190f0b2-0000-7000-8000-000000000001?download=1>)`)
    expect(md).not.toContain('HIDDEN-ANSWER')
    const json = JSON.parse(myChatJson(chat, msgs, base, (id) => id === 'm2', files)) as { messages: Record<string, unknown>[] }
    expect(json.messages[1]).toEqual({ id: 'm2', role: 'assistant', at: '2026-11-20T01:01:00Z', withheld: true })
    expect(JSON.stringify(json)).not.toContain('HIDDEN-ANSWER')
  })

  test('a stored secret in a title is hidden in the file names, the heading and the JSON (QA SEC-16)', async () => {
    const id = crypto.randomUUID()
    db().query("INSERT INTO chats (id, user_id, title, engine) VALUES (?, 'erin', 'sk-QAFAKE-KEY-123 plan', 'claude')").run(id)
    const hide = (t: string) => t.replaceAll('sk-QAFAKE-KEY-123', '[hidden key]')
    const parts: Uint8Array[] = []
    for await (const p of zipOut(myExportEntries(db(), { ownerId: 'erin', base, hide }))) parts.push(p)
    const zip = readZip(new Uint8Array(Buffer.concat(parts)))
    const text = zip.map((e) => `${e.name}\n${Buffer.from(e.data).toString('utf8')}`).join('\n')
    expect(zip.map((e) => e.name).some((n) => n.includes('[hidden key] plan'))).toBe(true)
    expect(text).toContain('# [hidden key] plan')
    expect(text).not.toContain('sk-QAFAKE-KEY-123')
  })
})
