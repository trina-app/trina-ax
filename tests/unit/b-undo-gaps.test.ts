// Gaps found in the review of #426 (docs/decisions/20261123-do-then-undo.md):
// 1. 취소 on a share takes back only what that share added, by the server's record (files/share-take-back.ts): access a
//    person had before the share survives.
// 2. "share this folder" when the files are only in the chat: a folder of the person's own is made with copies of them
//    and shared; its 취소 deletes it. Unclear recipient: nothing is made, the old answer.
// 3. The create tier respects an admin's "ask" on a team connection (connections/tools.ts createTierOk).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Attachment, type Step } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { fileSharesOf } from '../../server/src/files/shares'
import { takeBackShares } from '../../server/src/files/share-take-back'
import { undoShares } from '../../server/src/files/share-undo'
import { createTierOk } from '../../server/src/integrations/connections/tools'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')

let h: Harness
let sock: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-undo-gaps', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  sock = await h.ws('alice', { windowId: 'win-undo-gaps' })
  await sock.next('hello')
})
afterAll(async () => { sock?.close(); await h?.close() })
const put = (rel: string, body = rel) => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id })
const canOpen = (who: string, owner: string, rel: string) => fileSharesOf(h.ctx).view(owner, rel).people.some((p) => p.subjectId === who)

async function turn(content: string, chatId?: string, attachmentIds: string[] = []) {
  const id = chatId ?? (await h.api('alice').call(API.createChat, { body: {} })).id
  const r = await h.api('alice').call(API.sendMessage, { params: { id }, body: { content, clientMessageId: cm(), attachmentIds } })
  const done = await sock.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  const msgs = (await h.api('alice').call(API.listMessages, { params: { id }, query: {} })).items
  return { chatId: id, content: done.data.message.content as string, steps: (msgs.find((x) => x.id === r.assistantMessage.id)!.steps ?? []) as Step[] }
}
async function upload(chatId: string, name: string, content: string) {
  const form = new FormData()
  form.set('chatId', chatId)
  form.set('file', new File([content], name))
  const res = await h.req('alice', '/api/uploads', { method: 'POST', body: form })
  expect(res.status).toBe(201)
  return (await res.json()) as Attachment
}
const cards = (turnStart: number) => sock.frames.slice(turnStart).filter((f) => f.type === 'turn.request').length

describe('취소 takes back only what the share added', () => {
  test('a person who could open A before keeps A; the B this share gave them goes', async () => {
    put('users/alice/gap-a.txt', 'A'); put('users/alice/gap-b.txt', 'B')
    // Bob could open A already (the Share dialog)
    fileSharesOf(h.ctx).change('alice', 'users/alice/gap-a.txt', [user('bob')], [], 'en', 'dialog')
    const f0 = sock.frames.length
    const r = await turn(`share gap-a.txt and gap-b.txt with Bob Lee\n${fake({ tool: 'share_with_person', args: { paths: ['users/alice/gap-a.txt', 'users/alice/gap-b.txt'], people: ['Bob Lee'] }, sayResult: true })}`)
    expect(cards(f0)).toBe(0)
    const shared = r.steps.find((s) => s.tool === 'share_with_person')!.shared!
    expect(shared.outcome).toBe('done')
    expect(shared.takeBack?.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(canOpen('bob', 'alice', 'users/alice/gap-a.txt')).toBe(true)
    expect(canOpen('bob', 'alice', 'users/alice/gap-b.txt')).toBe(true)
    // someone else's press, and the removal undo endpoint, never take it
    expect(() => takeBackShares(h.ctx, 'bob', shared.takeBack!.id, 'en')).toThrow()
    expect(() => undoShares(h.ctx, 'alice', shared.takeBack!.id, 'en')).toThrow()
    const res = await h.api('alice').call(API.takeBackFileShares, { body: { id: shared.takeBack!.id } })
    expect(res).toEqual({ removed: 1, skipped: 0 })
    // the earlier access survives; the newly added one is gone
    expect(canOpen('bob', 'alice', 'users/alice/gap-a.txt')).toBe(true)
    expect(canOpen('bob', 'alice', 'users/alice/gap-b.txt')).toBe(false)
    // once only
    expect(() => takeBackShares(h.ctx, 'alice', shared.takeBack!.id, 'en')).toThrow()
  })

  test('both new: both go', async () => {
    put('users/alice/gap-c.txt', 'C'); put('users/alice/gap-d.txt', 'D')
    const r = await turn(`share gap-c.txt and gap-d.txt with Bob Lee\n${fake({ tool: 'share_with_person', args: { paths: ['users/alice/gap-c.txt', 'users/alice/gap-d.txt'], people: ['Bob Lee'] }, sayResult: true })}`)
    const shared = r.steps.find((s) => s.tool === 'share_with_person')!.shared!
    expect(takeBackShares(h.ctx, 'alice', shared.takeBack!.id, 'en')).toEqual({ removed: 2, skipped: 0 })
    expect(canOpen('bob', 'alice', 'users/alice/gap-c.txt')).toBe(false)
    expect(canOpen('bob', 'alice', 'users/alice/gap-d.txt')).toBe(false)
  })
})

describe('"share this folder" with the files only in the chat', () => {
  const folders = () => fs.readdirSync(path.join(h.ctx.files.fx.root, 'users', 'alice'), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort()

  test('makes a folder of the person\'s own with copies, shares it, and 취소 deletes it', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    const a = await upload(c.id, 'quote.txt', 'the quote')
    const before = folders()
    const f0 = sock.frames.length
    const r = await turn(`share this folder with Bob Lee\n${fake({ tool: 'share_folder', args: { add: ['Bob Lee'] }, sayResult: true })}`, c.id, [a.id])
    expect(cards(f0)).toBe(0)
    const shared = r.steps.find((s) => s.tool === 'share_folder')!.shared!
    expect(shared.outcome).toBe('done')
    expect(shared.madeFolder).toBe(true)
    expect(shared.takeBack?.id).toBeTruthy()
    const made = folders().filter((x) => !before.includes(x))
    expect(made.length).toBe(1)
    const rel = `users/alice/${made[0]}`
    expect(fs.readFileSync(path.join(h.ctx.files.fx.root, 'users', 'alice', made[0]!, 'quote.txt'), 'utf8')).toBe('the quote')
    expect(canOpen('bob', 'alice', rel)).toBe(true)
    expect(shared.files[0]!.name).toBe(made[0]!)
    const res = takeBackShares(h.ctx, 'alice', shared.takeBack!.id, 'en')
    expect(res.removed).toBe(1)
    expect(folders()).toEqual(before)
    // the original attachment is untouched
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, ...a.path!.split('/')))).toBe(true)
  })

  test('a recipient the message does not name: nothing is made, the old answer', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    const a = await upload(c.id, 'memo.txt', 'memo')
    const before = folders()
    const r = await turn(`share this folder with him\n${fake({ tool: 'share_folder', args: { add: ['Bob Lee'] }, sayResult: true })}`, c.id, [a.id])
    expect(r.content).toContain('did not say which folder')
    expect(folders()).toEqual(before)
    expect(r.steps.find((s) => s.tool === 'share_folder')?.shared?.outcome).not.toBe('done')
  })
})

describe('the create tier and the admin\'s "ask"', () => {
  test('a team connection set to ask asks for a create too; allow and a person\'s own keep the tier', () => {
    expect(createTierOk({ scope: 'team', write_policy: 'ask' })).toBe(false)
    expect(createTierOk({ scope: 'team', write_policy: 'deny' })).toBe(false)
    expect(createTierOk({ scope: 'team', write_policy: 'allow' })).toBe(true)
    expect(createTierOk({ scope: 'personal', write_policy: 'ask' })).toBe(true)
  })
})
