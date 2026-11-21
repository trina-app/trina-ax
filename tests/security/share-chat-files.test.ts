// The routes of a chat's shared files on a chat SHARED WITH PEOPLE (docs/decisions/20261121-share-chat-files.md; review
// L4): GET/POST /api/chats/:id/file-access and the copies (GET /api/chats/:id/files/:fileId). Alice's chat P made a
// file in her own folder and is shared with bob; erin was in it and was taken out; carol is in another of alice's
// chats (Q) only; gina is a guest; dana (the owner) is in neither. Only bob gets anything about P's file: the ask, then
// the copy. Everyone else gets P's 404 and leaves no request; P's path asked from Q is the generic 'no'.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, CSRF_HEADER, type Attachment } from '@mycel/shared/api'
import { addTestPerson, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const CANARY = 'SEC-SHARE-FILES-CANARY-4471'
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const user = (id: string): Sub => ({ subjectType: 'user', subjectId: id })

let h: Harness
const ws: Record<string, TestSocket> = {}
let P: string, Q: string, dir: string, file: string
beforeAll(async () => {
  h = await startHarness({ name: 'sec-share-chat-files', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  // gina: a guest (a copy of erin's account row, guest = 1)
  const erin = h.ctx.db.query("SELECT * FROM users WHERE id = 'erin'").get() as Record<string, unknown>
  const gina: Record<string, unknown> = { ...erin, id: 'gina', username: 'gina', name: 'Gina Guest', guest: 1 }
  for (const k of Object.keys(gina)) if (/email/.test(k) && typeof gina[k] === 'string') gina[k] = 'gina@guest.test'
  const cols = Object.keys(gina)
  h.ctx.db.query(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(cols.map((k) => gina[k]) as never[]))
  addTestPerson('gina', { id: 'gina', name: 'Gina Guest', role: 'member', locale: 'en' })
  ws.alice = await h.ws('alice'); await ws.alice.next('hello')
  const ask = async (chatId: string, content: string) => {
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm() } })
    await ws.alice!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  }
  const share = async (chatId: string, subjects: Sub[]) => {
    const p = await h.api('alice').call(API.previewChatAudience, { params: { id: chatId }, body: { subjects } })
    const r = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(p.previewKey ? { confirmKey: p.previewKey } : {}) } })
    expect(r.status).toBe('saved')
  }
  P = (await h.api('alice').call(API.createChat, { body: {} })).id
  dir = `users/alice/sec-quote-${crypto.randomUUID().slice(0, 6)}`
  file = `${dir}/quote.md`
  await ask(P, `make it\n${fake({ tool: 'write', args: { file_path: file, content: CANARY } }, { say: 'made' })}`)
  await share(P, [user('bob'), user('erin')])
  await share(P, [user('bob')])
  Q = (await h.api('alice').call(API.createChat, { body: {} })).id
  await ask(Q, `hello\n${fake({ say: 'hi' })}`)
  await share(Q, [user('carol')])
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const J = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' }, body: JSON.stringify(body) })
async function hit(who: string, p: string, init?: RequestInit) {
  const r = await h.req(who, p, init as Parameters<Harness['req']>[2])
  return { status: r.status, text: await r.text() }
}
const accessUrl = (chatId: string, p: string) => `/api/chats/${chatId}/file-access?path=${encodeURIComponent(p)}`
const asks = () => (h.ctx.db.query('SELECT COUNT(*) n FROM access_requests WHERE target_id LIKE ?').get(`${P}/%`) as { n: number }).n
const OUTSIDE = ['erin', 'carol', 'gina', 'dana'] as const

describe('file-access on a chat shared with people', () => {
  test('bob (in it) may ask; the removed member, a member of another chat, a guest and the owner get the chat\'s 404 and leave no ask', async () => {
    const bob = await hit('bob', accessUrl(P, file))
    expect(bob.status).toBe(200)
    expect(JSON.parse(bob.text)).toEqual({ status: 'ask', by: 'Alice Kim', name: 'quote.md' })
    for (const who of OUTSIDE) {
      const r = await hit(who, accessUrl(P, file))
      expect(`${who} ${r.status}`).toBe(`${who} 404`)
      expect(r.text).not.toContain('quote.md')
      expect(r.text).not.toContain(dir)
      const a = await hit(who, `/api/chats/${P}/file-access`, J({ path: file }))
      expect(`${who} ${a.status}`).toBe(`${who} 404`)
    }
    expect(asks()).toBe(0)
  })

  test('P\'s path asked from carol\'s own chat Q: the one generic no, and no ask', async () => {
    expect(JSON.parse((await hit('carol', accessUrl(Q, file))).text)).toEqual({ status: 'no' })
    expect((await hit('carol', `/api/chats/${Q}/file-access`, J({ path: file }))).status).toBe(404)
    expect((h.ctx.db.query('SELECT COUNT(*) n FROM access_requests WHERE target_id LIKE ?').get(`${Q}/%`) as { n: number }).n).toBe(0)
  })

  test('after the copy: bob opens it; nobody outside P does, by P or by Q', async () => {
    const aud = await h.api('alice').call(API.getChatAudience, { params: { id: P } })
    const r = await h.api('alice').call(API.putChatAudience, { params: { id: P }, body: { subjects: [user('bob')], withFiles: true, confirmKey: aud.madeFilesKey } })
    expect(r).toMatchObject({ status: 'saved', filesAdded: 1 })
    const row = h.ctx.db.query("SELECT attachments FROM messages WHERE chat_id = ? AND attachments LIKE '%shared-copy%'").get(P) as { attachments: string }
    const copy = (JSON.parse(row.attachments) as Attachment[]).find((a) => a.origin === 'shared-copy')!
    const bob = await hit('bob', `/api/chats/${P}/files/${copy.id}`)
    expect(bob.status).toBe(200)
    expect(bob.text).toBe(CANARY)
    for (const who of OUTSIDE) {
      for (const p of [`/api/chats/${P}/files/${copy.id}`, `/api/chats/${Q}/files/${copy.id}`, `/api/attachments/${copy.id}/thumbnail`]) {
        const x = await hit(who, p)
        expect(`${who} ${p} ${x.status}`).toBe(`${who} ${p} 404`)
        expect(x.text).not.toContain(CANARY)
      }
      expect((await hit(who, accessUrl(P, file))).status).toBe(404)
    }
  })
})
