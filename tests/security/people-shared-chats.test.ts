// A chat outside projects shared with chosen people and groups (docs/DECISIONS.md "Chats shared with people and groups",
// plan S9): roles x routes. Alice shares her chat with bob by name and with her group marketing (erin); carol is an
// admin and dana the owner, neither in it. Every route that takes a chat id answers each person as the design says; a
// person outside it gets the same 404 as for a chat that does not exist (admins and the owner too), no response carries
// the chat's canary to anyone outside it, chat.updated reaches only the people in it, and someone taken out loses it at
// once (their windows told by its id alone).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { waitFor } from '../lib/wait'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const CANARY = 'SEC-PEOPLE-CANARY-7731'
const PEOPLE = ['alice', 'bob', 'carol', 'dana', 'erin'] as const
type Who = (typeof PEOPLE)[number]
const IN: Who[] = ['alice', 'bob', 'erin']
const OUT: Who[] = ['carol', 'dana']

let h: Harness
const ws: Partial<Record<Who, TestSocket>> = {}
let chatId: string, questionId: string, answerId: string
let clock = Date.now()
const SUBJECTS = [{ subjectType: 'user' as const, subjectId: 'bob' }, { subjectType: 'group' as const, subjectId: 'marketing' }]
beforeAll(async () => {
  h = await startHarness({ name: 'sec-people-chats', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  for (const u of PEOPLE) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content: `${CANARY}\n${fake({ say: `answer ${CANARY}` })}`, clientMessageId: cm(), attachmentIds: [] } })
  questionId = r.userMessage!.id; answerId = r.assistantMessage.id
  await ws.alice!.next('message.done', (f) => f.data.messageId === answerId, 30_000)
  let s = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects: SUBJECTS } })
  if (s.status === 'confirm') s = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects: SUBJECTS, confirmKey: s.confirmKey } })
  expect(s.status).toBe('saved')
})
afterAll(async () => { for (const s of Object.values(ws)) s?.close(); await h.close() })

const J = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' }, body: JSON.stringify(body) })
async function hit(who: Who, p: string, init?: RequestInit): Promise<{ status: number; text: string }> {
  const r = await h.req(who, p, init as Parameters<Harness['req']>[2])
  return { status: r.status, text: await r.text() }
}
const idle = () => waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 30_000 })

type Row = { route: string; run: (who: Who) => Promise<{ status: number; text: string }>; allow: Who[]; deny: Partial<Record<Who, number>> }
const out404 = { carol: 404, dana: 404 }
const reads = (): Row[] => [
  { route: 'GET /api/chats/:id', run: (w) => hit(w, `/api/chats/${chatId}`), allow: IN, deny: out404 },
  { route: 'GET /api/chats/:id/messages', run: (w) => hit(w, `/api/chats/${chatId}/messages`), allow: IN, deny: out404 },
  { route: 'GET /api/chats/:id/queue', run: (w) => hit(w, `/api/chats/${chatId}/queue`), allow: IN, deny: out404 },
  { route: 'GET /api/chats/:id/requests', run: (w) => hit(w, `/api/chats/${chatId}/requests`), allow: IN, deny: out404 },
  { route: 'GET /api/chats/:id/artifacts', run: (w) => hit(w, `/api/chats/${chatId}/artifacts`), allow: IN, deny: out404 },
  { route: 'GET /api/chats/:id/messages/:messageId/sources', run: (w) => hit(w, `/api/chats/${chatId}/messages/${answerId}/sources`), allow: IN, deny: out404 },
  { route: 'GET /api/chats/:id/audience', run: (w) => hit(w, `/api/chats/${chatId}/audience`), allow: IN, deny: out404 },
  { route: 'POST /api/chats/:id/seen', run: (w) => hit(w, `/api/chats/${chatId}/seen`, J({})), allow: IN, deny: out404 },
  { route: 'GET /api/chats (list)', run: async (w) => { const r = await hit(w, '/api/chats'); return r.text.includes(chatId) ? r : { status: 404, text: r.text } }, allow: IN, deny: out404 },
  { route: 'GET /api/chats/groups', run: async (w) => { const r = await hit(w, '/api/chats/groups'); return r.text.includes(chatId) ? r : { status: 404, text: r.text } }, allow: IN, deny: out404 },
  { route: 'GET /api/chats?q=', run: async (w) => { const r = await hit(w, `/api/chats?q=${CANARY}`); return r.text.includes(chatId) ? r : { status: 404, text: r.text } }, allow: IN, deny: out404 },
]
const writes = (): Row[] => [
  { route: 'PATCH /api/chats/:id (title)', run: (w) => hit(w, `/api/chats/${chatId}`, J({ title: `t-${w}` }, 'PATCH')), allow: ['alice'], deny: { bob: 403, erin: 403, ...out404 } },
  { route: 'PATCH /api/chats/:id (projectId)', run: async (w) => {
    const p = (await h.api('alice').call(API.createProject, { body: { name: `P-${w}-${Math.random().toString(36).slice(2, 6)}`, scope: 'personal', participants: [], instructions: '' } })).id
    return hit(w, `/api/chats/${chatId}`, J({ projectId: p }, 'PATCH'))
  }, allow: [], deny: { alice: 409, bob: 403, erin: 403, ...out404 } },
  { route: 'PUT /api/chats/:id/audience', run: (w) => hit(w, `/api/chats/${chatId}/audience`, J({ subjects: SUBJECTS }, 'PUT')), allow: ['alice'], deny: { bob: 403, erin: 403, ...out404 } },
  { route: 'POST /api/chats/:id/share (project)', run: (w) => hit(w, `/api/chats/${chatId}/share`, J({})), allow: [], deny: { alice: 409, bob: 404, erin: 404, ...out404 } },
  { route: 'POST /api/chats/:id/hide', run: async (w) => { const r = await hit(w, `/api/chats/${chatId}/hide`, J({})); if (r.status < 300) await hit(w, `/api/chats/${chatId}/hide`, { method: 'DELETE', headers: { [CSRF_HEADER]: '1' } }); return r }, allow: ['bob', 'erin'], deny: { alice: 400, ...out404 } },
  { route: 'POST /api/chats/:id/messages/:messageId/edit', run: (w) => hit(w, `/api/chats/${chatId}/messages/${questionId}/edit`, J({ content: 'x', clientMessageId: cm(), attachmentIds: [] })), allow: ['alice'], deny: { bob: 403, erin: 403, ...out404 } },
  { route: 'POST /api/chats/:id/messages/:messageId/share-to-room', run: (w) => hit(w, `/api/chats/${chatId}/messages/${answerId}/share-to-room`, J({ roomId: uuidv7(), note: '', clientMessageId: cm() })), allow: [], deny: { bob: 404, erin: 404, ...out404 } },
  { route: 'POST /api/attachments/team-file', run: (w) => hit(w, '/api/attachments/team-file', J({ chatId, path: 'shared/glossary.md' })), allow: IN, deny: out404 },
  // a file from the computer is not taken in a people-shared chat yet (no chat-scoped store): refused for everyone
  { route: 'POST /api/uploads (computer file)', run: (w) => { const f = new FormData(); f.set('chatId', chatId); f.set('file', new File(['x'], 'x.txt', { type: 'text/plain' })); return hit(w, '/api/uploads', { method: 'POST', headers: { [CSRF_HEADER]: '1' }, body: f }) }, allow: [], deny: out404 },
  { route: 'POST /api/chats/:id/branch', run: (w) => hit(w, `/api/chats/${chatId}/branch`, J({ messageId: answerId })), allow: IN, deny: out404 },
  { route: 'POST /api/chats/:id/stop (idle)', run: (w) => hit(w, `/api/chats/${chatId}/stop`, J({})), allow: IN, deny: out404 },
  { route: 'POST /api/sharing/widening-answers (chat)', run: (w) => hit(w, '/api/sharing/widening-answers', J({ target: { kind: 'chat', chatId }, add: [{ subjectType: 'user', subjectId: 'carol' }] })), allow: ['alice'], deny: { bob: 403, erin: 403, ...out404 } },
  { route: 'DELETE /api/chats/:id', run: async (w) => { const r = await hit(w, `/api/chats/${chatId}`, { method: 'DELETE', headers: { [CSRF_HEADER]: '1' } }); if (r.status < 300) await hit('alice', `/api/chats/${chatId}/restore`, J({})); return r }, allow: ['alice'], deny: { bob: 403, erin: 403, ...out404 } },
]

function judge(row: Row, who: Who, r: { status: number; text: string }) {
  if (row.allow.includes(who)) expect({ route: row.route, who, ok: r.status < 300 }).toEqual({ route: row.route, who, ok: true })
  else {
    const want = row.deny[who]
    expect({ route: row.route, who, status: r.status }).toEqual({ route: row.route, who, status: want ?? r.status })
    expect({ route: row.route, who, denied: r.status >= 400 }).toEqual({ route: row.route, who, denied: true })
  }
  if (OUT.includes(who)) expect({ route: row.route, who, leaks: r.text.includes(CANARY) }).toEqual({ route: row.route, who, leaks: false })
}

describe('a people-shared chat as it is', () => {
  for (const row of reads()) test(row.route, async () => { for (const w of PEOPLE) judge(row, w, await row.run(w)) })
  for (const row of writes()) test(row.route, async () => { for (const w of PEOPLE) { await idle(); judge(row, w, await row.run(w)) } })

  test('POST /api/chats/:id/messages: everyone in it continues it, as themselves; outsiders 404', async () => {
    for (const w of PEOPLE) {
      await idle()
      const r = await hit(w, `/api/chats/${chatId}/messages`, J({ content: `from ${w}\n${fake({ say: `ok ${w}` })}`, clientMessageId: cm(), attachmentIds: [] }))
      if (OUT.includes(w)) { expect({ w, status: r.status }).toEqual({ w, status: 404 }); expect(r.text.includes(CANARY)).toBe(false); continue }
      expect({ w, status: r.status }).toEqual({ w, status: 202 })
      expect(h.ctx.db.query('SELECT user_id FROM turns WHERE id = ?').get((JSON.parse(r.text) as { turnId: string }).turnId)).toEqual({ user_id: w })
    }
    await idle()
  })

  test('chat.updated reaches only the people in it', async () => {
    for (const w of OUT) ws[w]!.frames.length = 0
    await hit('alice', `/api/chats/${chatId}`, J({ title: `renamed ${CANARY}` }, 'PATCH'))
    await ws.bob!.next('chat.updated', (f) => f.data.chatId === chatId, 10_000)
    await ws.erin!.next('chat.updated', (f) => f.data.chatId === chatId, 10_000)
    for (const w of OUT) expect(ws[w]!.frames.some((f) => JSON.stringify(f).includes(chatId))).toBe(false)
  })
})

describe('someone taken out', () => {
  test('bob removed: 404 everywhere, his windows told by id alone; the share check names nobody', async () => {
    await idle()
    const r = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects: [SUBJECTS[1]!] } })
    expect(r.status).toBe('saved')
    const f = await ws.bob!.next('chat.updated', (x) => x.data.chatId === chatId && x.data.change === 'deleted', 10_000)
    expect(f.data.chat).toBeNull()
    for (const row of reads()) {
      const res = await row.run('bob')
      expect({ route: row.route, status: res.status }).toEqual({ route: row.route, status: 404 })
      expect(res.text.includes(CANARY)).toBe(false)
    }
    // adding him back asks nothing about others' names
    const back = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects: SUBJECTS } })
    expect(JSON.stringify(back)).not.toMatch(/Bob Lee|Erin Yoo|Carol|Dana/)
  })
})
