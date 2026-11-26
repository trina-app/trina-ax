// A team file linked in a shared chat that does not open for me (QA after #651: the side panel said only "can't be
// found, or you don't have access", with nothing to do). GET /api/chats/:id/file-access answers view / viewAsked /
// open for any team file linked in a message of the shared chat that I see, by someone who can read it now (the room
// link's rules, server/src/files/linked-file-ask.ts), and the POST is an ordinary file access request. Every other case
// stays the one generic 'no' (a path nobody linked, a file the linker cannot read either, a private chat), and someone
// who cannot see the chat gets its 404. The fixture team: alice and erin in marketing, bob in finance, carol admin.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { fileSharesOf } from '../../server/src/files/shares'
import { roomsOf } from '../../server/src/rooms/service'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-file-ask', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 10_000)
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const put = (rel: string, body: string) => { const abs = path.join(h.team, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }
const link = (rel: string) => `[${rel.slice(rel.lastIndexOf('/') + 1)}](/files/view?path=${encodeURIComponent(rel)})`
async function say(user: string, chatId: string, content: string) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm() } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
}
const access = async (user: string, chatId: string, p: string) => {
  const res = await h.req(user, `/api/chats/${chatId}/file-access?path=${encodeURIComponent(p)}`)
  return { status: res.status, body: res.status === 200 ? await res.json() : null }
}
const askFor = async (user: string, chatId: string, p: string) => {
  const res = await h.req(user, `/api/chats/${chatId}/file-access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const requests = (user: string) => (db().query("SELECT COUNT(*) n FROM file_access_requests WHERE requester_id = ? AND state = 'pending'").get(user) as { n: number }).n
async function sharedWithBob() {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  await say('alice', c.id, `hello\n${fake({ say: 'hi' })}`)
  const subjects = [{ subjectType: 'user' as const, subjectId: 'bob' }]
  const p = await h.api('alice').call(API.previewChatAudience, { params: { id: c.id }, body: { subjects } })
  expect((await h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects, ...(p.previewKey ? { confirmKey: p.previewKey } : {}) } })).status).toBe('saved')
  return c.id
}

describe('a linked team file in a shared chat', () => {
  test('root cause: alice\'s answer links her own older file; bob may ask to view it, by her name; the ask is a file request', async () => {
    const chatId = await sharedWithBob()
    const rel = `users/alice/reports-${crypto.randomUUID().slice(0, 6)}/weekly.md`
    put(rel, '# weekly')
    await say('alice', chatId, `show the report\n${fake({ say: `Here it is: ${link(rel)}` })}`)
    expect(await access('bob', chatId, rel)).toEqual({ status: 200, body: { status: 'view', by: 'Alice Kim' } })
    const before = requests('bob')
    const sent = await askFor('bob', chatId, rel)
    expect(sent.status).toBe(200)
    expect(sent.body.status).toBe('sent')
    expect(requests('bob')).toBe(before + 1)
    // asked: its date, and a second ask stores nothing new
    const asked = await access('bob', chatId, rel)
    expect(asked.body).toMatchObject({ status: 'viewAsked', by: 'Alice Kim' })
    expect((await askFor('bob', chatId, rel)).body.status).toBe('already')
    expect(requests('bob')).toBe(before + 1)
    // alice lets him view it: it opens by its own link
    fileSharesOf(h.ctx).change('alice', rel, [{ subjectType: 'user', subjectId: 'bob' }], [], 'en')
    const open = await access('bob', chatId, rel)
    expect(open.body.status).toBe('open')
    expect(typeof open.body.link).toBe('string')
  })

  test('the creator may ask too: bob\'s own message links his own file', async () => {
    const chatId = await sharedWithBob()
    const rel = `users/bob/notes-${crypto.randomUUID().slice(0, 6)}.md`
    put(rel, '# bob notes')
    await say('bob', chatId, `see ${link(rel)}\n${fake({ say: 'ok' })}`)
    expect(await access('alice', chatId, rel)).toEqual({ status: 200, body: { status: 'view', by: 'Bob Lee' } })
  })

  test('the one generic no: a path nobody linked, a file the linker cannot read either, a private chat; outsiders the chat\'s 404', async () => {
    const chatId = await sharedWithBob()
    const unlinked = `users/alice/private-${crypto.randomUUID().slice(0, 6)}.md`
    put(unlinked, 'salary')
    const erins = `users/erin/secret-${crypto.randomUUID().slice(0, 6)}.md`
    put(erins, 'erin only')
    await say('alice', chatId, `links\n${fake({ say: `Missing: ${link('users/alice/none.md')} and ${link(erins)}` })}`)
    const no = { status: 200, body: { status: 'no' } }
    for (const p of [unlinked, erins, 'users/alice/none.md', `users/alice/../erin/${erins.split('/').pop()}`]) expect(await access('bob', chatId, p)).toEqual(no)
    expect((await askFor('bob', chatId, unlinked)).status).toBe(404)
    expect((await access('carol', chatId, unlinked)).status).toBe(404)
    // a chat only alice sees: nothing to ask in it
    const own = (await h.api('alice').call(API.createChat, { body: {} })).id
    const rel = `users/alice/own-${crypto.randomUUID().slice(0, 6)}.md`
    put(rel, 'own')
    await say('alice', own, `x\n${fake({ say: link(rel) })}`)
    expect((await access('bob', own, rel)).status).toBe(404)
  })
})
