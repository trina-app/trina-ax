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
    // named for its one file, never for the sentence the chat's title may be
    expect(made[0]).toBe('quote')
    const res = takeBackShares(h.ctx, 'alice', shared.takeBack!.id, 'en')
    expect(res.removed).toBe(1)
    expect(folders()).toEqual(before)
    // the original attachment is untouched
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, ...a.path!.split('/')))).toBe(true)
  })

  test('취소 when the folder stays (a file saved there since): only the share\'s own grant goes, a person added by hand keeps it', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    const a = await upload(c.id, 'plan.txt', 'the plan')
    const before = folders()
    const r = await turn(`share this folder with Bob Lee\n${fake({ tool: 'share_folder', args: { add: ['Bob Lee'] }, sayResult: true })}`, c.id, [a.id])
    const shared = r.steps.find((s) => s.tool === 'share_folder')!.shared!
    expect(shared.madeFolder).toBe(true)
    const made = folders().filter((x) => !before.includes(x))
    const rel = `users/alice/${made[0]}`
    // since: a file of her own saved there, and Carol added by hand (the Share dialog)
    put(`${rel}/mine.txt`, 'kept')
    fileSharesOf(h.ctx).put('alice', rel, [user('carol')], [], 'en', 'dialog')
    expect(takeBackShares(h.ctx, 'alice', shared.takeBack!.id, 'en').removed).toBe(1)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, ...rel.split('/'), 'mine.txt'))).toBe(true)
    expect(canOpen('bob', 'alice', rel)).toBe(false)
    expect(canOpen('carol', 'alice', rel)).toBe(true)
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

// QA b5 F5: in a chat shared with Bob the AI made the quote as chat:files/견적서.docx; "이 폴더 팀원들한테 공유해줘" then
// asked which folder twice. The files the person's latest answer that made any carries, in a chat that holds only their
// work, are in the chat alone, as an attachment is: the same folder of copies, the same Undo
describe('"share this folder" with a file the AI made in the chat (chat:files)', () => {
  const folders = () => fs.readdirSync(path.join(h.ctx.files.fx.root, 'users', 'alice'), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort()
  async function sharedWithBob() {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    await turn(`hello\n${fake({ say: 'hi' })}`, c.id)
    const subjects = [user('bob')]
    let r = await h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects } }) as { status?: string; confirmKey?: string }
    if (r.status === 'confirm') r = await h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects, confirmKey: r.confirmKey! } }) as never
    return c.id
  }
  const makeQuote = (c: string, name: string) => turn(`견적서 만들어줘\n${fake({ tool: 'make_file', args: { format: 'docx', content: '# 견적서\n\nA형 1,200,000원 x 3\n', output: `chat:files/${name}` }, sayResult: true })}`, c)
  const share = (c: string) => turn(`이 폴더 Bob Lee한테 공유해줘\n${fake({ tool: 'share_folder', args: { add: ['Bob Lee'] }, sayResult: true })}`, c)

  test('makes a folder with a copy of what the answer made and shares it with no card; 취소 deletes it; an unsent upload stays out', async () => {
    const c = await sharedWithBob()
    await makeQuote(c, 'quote-f5.docx')
    // an upload alice did not send: never in the folder
    await upload(c, 'draft-not-sent.txt', 'draft')
    const before = folders()
    const f0 = sock.frames.length
    const r = await share(c)
    expect(cards(f0)).toBe(0)
    const shared = r.steps.find((s) => s.tool === 'share_folder')!.shared!
    expect(shared.outcome).toBe('done')
    expect(shared.madeFolder).toBe(true)
    const made = folders().filter((x) => !before.includes(x))
    expect(made.length).toBe(1)
    expect(fs.readdirSync(path.join(h.ctx.files.fx.root, 'users', 'alice', made[0]!))).toEqual(['quote-f5.docx'])
    expect(canOpen('bob', 'alice', `users/alice/${made[0]}`)).toBe(true)
    expect(takeBackShares(h.ctx, 'alice', shared.takeBack!.id, 'en').removed).toBe(1)
    expect(folders()).toEqual(before)
  })
  test('nothing is made where someone else wrote in the chat, or the chat took in someone else\'s words before', async () => {
    const c = await sharedWithBob()
    await makeQuote(c, 'memo-f5.docx')
    await h.api('bob').call(API.sendMessage, { params: { id: c }, body: { content: `a note from bob\n${fake({ say: 'ok' })}`, clientMessageId: cm(), attachmentIds: [] } })
    await Bun.sleep(2500)
    const before = folders()
    const r = await share(c)
    expect(r.content).toContain('did not say which folder')
    expect(folders()).toEqual(before)
    const d = await sharedWithBob()
    await makeQuote(d, 'memo2-f5.docx')
    h.ctx.db.query('UPDATE chats SET others_words = 1 WHERE id = ?').run(d)
    const r2 = await share(d)
    expect(r2.content).toContain('did not say which folder')
    expect(folders()).toEqual(before)
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
