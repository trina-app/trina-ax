// Shared project chats (docs/DECISIONS.md "Shared project chats"): roles x routes x states. Every route that takes a
// chat id answers each person as the design says, for a shared chat of the project on projects/falcon (alice made
// it and writes the folder; bob reads it through finance; carol is an admin, dana the owner; erin sees only its
// public/ folder, so she is not in its audience). States: as it is, in the trash, while safe operations (1A) are on,
// after bob lost the folder, and while the project's folder is in the trash (only admins and the owner see it then).
// A person outside the audience gets the same 404 as for a chat that does not exist, and no response carries the
// chat's canary to anyone who may not see it. An existing private chat shared later (POST /api/chats/:id/share,
// chat/share-chat.ts): only its creator may ask, the check names nobody and nothing she may not look at, nothing is
// shared without her yes on the confirm, and afterwards it follows the same rules (its earlier steps the words alone).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const CANARY = 'SEC-SHARED-CANARY-5521'
const PEOPLE = ['alice', 'bob', 'carol', 'dana', 'erin'] as const
type Who = (typeof PEOPLE)[number]

let h: Harness
const ws: Partial<Record<Who, TestSocket>> = {}
let projectId: string, otherProject: string
let chatId: string, questionId: string, answerId: string, turnId: string
beforeAll(async () => {
  h = await startHarness({ name: 'sec-shared-chats', askUserTimeoutMs: 2500, turnTimeoutMs: 60_000 })
  for (const u of PEOPLE) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  otherProject = (await h.api('alice').call(API.createProject, { body: { name: 'Other', scope: 'personal', participants: [], instructions: '' } })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  chatId = (await h.api('alice').call(API.createChat, { body: { projectId } })).id
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content: `${CANARY}\n${fake({ say: `answer ${CANARY}` })}`, clientMessageId: cm(), attachmentIds: [] } })
  questionId = r.userMessage!.id; answerId = r.assistantMessage.id; turnId = r.turnId
  await ws.alice!.next('message.done', (f) => f.data.messageId === answerId, 30_000)
})
afterAll(async () => { for (const s of Object.values(ws)) s?.close(); await h.close() })

const J = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' }, body: JSON.stringify(body) })
const PATCH = (body: unknown): RequestInit => ({ ...J(body), method: 'PATCH' })
/** one request as `who`: its status and body text */
async function hit(who: Who, p: string, init?: RequestInit): Promise<{ status: number; text: string }> {
  const r = await h.req(who, p, init as Parameters<Harness["req"]>[2])
  return { status: r.status, text: await r.text() }
}
/** wait until the chat has no turn, so the next send is not refused as busy */
const idle = () => waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 30_000 })

type Row = { route: string; run: (who: Who) => Promise<{ status: number; text: string }>; allow: Who[]; deny: Partial<Record<Who, number>> }
/** the reading routes: everyone in the audience, nobody else */
const reads = (): Row[] => [
  { route: 'GET /api/chats/:id', run: (w) => hit(w, `/api/chats/${chatId}`), allow: ['alice', 'bob', 'carol', 'dana'], deny: { erin: 404 } },
  { route: 'GET /api/chats/:id/messages', run: (w) => hit(w, `/api/chats/${chatId}/messages`), allow: ['alice', 'bob', 'carol', 'dana'], deny: { erin: 404 } },
  { route: 'GET /api/chats/:id/queue', run: (w) => hit(w, `/api/chats/${chatId}/queue`), allow: ['alice', 'bob', 'carol', 'dana'], deny: { erin: 404 } },
  { route: 'GET /api/chats/:id/requests', run: (w) => hit(w, `/api/chats/${chatId}/requests`), allow: ['alice', 'bob', 'carol', 'dana'], deny: { erin: 404 } },
  { route: 'GET /api/chats/:id/artifacts', run: (w) => hit(w, `/api/chats/${chatId}/artifacts`), allow: ['alice', 'bob', 'carol', 'dana'], deny: { erin: 404 } },
  { route: 'GET /api/chats/:id/messages/:messageId/sources', run: (w) => hit(w, `/api/chats/${chatId}/messages/${answerId}/sources`), allow: ['alice', 'bob', 'carol', 'dana'], deny: { erin: 404 } },
  { route: 'POST /api/chats/:id/seen', run: (w) => hit(w, `/api/chats/${chatId}/seen`, J({})), allow: ['alice', 'bob', 'carol', 'dana'], deny: { erin: 404 } },
  { route: 'GET /api/chats (list)', run: async (w) => { const r = await hit(w, `/api/chats?projectId=${projectId}`); return r.text.includes(chatId) ? r : { status: 404, text: r.text } }, allow: ['alice', 'bob', 'carol', 'dana'], deny: { erin: 404 } },
]
/** the writing routes, one person at a time */
const writes = (): Row[] => [
  { route: 'PATCH /api/chats/:id (title)', run: (w) => hit(w, `/api/chats/${chatId}`, PATCH({ title: `t-${w}` })), allow: ['alice'], deny: { bob: 403, carol: 403, dana: 403, erin: 404 } },
  { route: 'PATCH /api/chats/:id (projectId)', run: (w) => hit(w, `/api/chats/${chatId}`, PATCH({ projectId: otherProject })), allow: [], deny: { alice: 409, bob: 403, carol: 403, dana: 403, erin: 404 } },
  { route: 'POST /api/chats/:id/messages/:messageId/edit', run: (w) => hit(w, `/api/chats/${chatId}/messages/${questionId}/edit`, J({ content: 'x', clientMessageId: cm(), attachmentIds: [] })), allow: ['alice'], deny: { bob: 403, carol: 403, dana: 403, erin: 404 } },
  { route: 'POST /api/chats/:id/messages/:messageId/regenerate', run: (w) => hit(w, `/api/chats/${chatId}/messages/${answerId}/regenerate`, J({})), allow: ['alice'], deny: { bob: 403, carol: 403, dana: 403, erin: 404 } },
  // alice's own answer goes on to the room's checks (no such room: refused there); everyone else is stopped before
  { route: 'POST /api/chats/:id/messages/:messageId/share-to-room', run: (w) => hit(w, `/api/chats/${chatId}/messages/${answerId}/share-to-room`, J({ roomId: uuidv7(), note: '', clientMessageId: cm() })), allow: [], deny: { bob: 404, carol: 404, dana: 404, erin: 404 } },
  { route: 'POST /api/attachments/team-file', run: (w) => hit(w, '/api/attachments/team-file', J({ chatId, path: 'projects/falcon/plan.md' })), allow: ['alice', 'bob', 'carol', 'dana'], deny: { erin: 404 } },
  { route: 'POST /api/uploads (computer file)', run: (w) => { const f = new FormData(); f.set('chatId', chatId); f.set('file', new File(['x'], 'x.txt', { type: 'text/plain' })); return hit(w, '/api/uploads', { method: 'POST', headers: { [CSRF_HEADER]: '1' }, body: f }) }, allow: [], deny: { alice: 409, bob: 409, carol: 409, dana: 409, erin: 404 } },
  { route: 'POST /api/chats/:id/branch', run: (w) => hit(w, `/api/chats/${chatId}/branch`, J({ messageId: answerId })), allow: ['alice', 'bob', 'carol', 'dana'], deny: { erin: 404 } },
  { route: 'POST /api/chats/:id/stop (idle)', run: (w) => hit(w, `/api/chats/${chatId}/stop`, J({})), allow: ['alice', 'bob', 'carol', 'dana'], deny: { erin: 404 } },
  { route: 'DELETE /api/chats/:id', run: async (w) => { const r = await hit(w, `/api/chats/${chatId}`, { method: 'DELETE', headers: { [CSRF_HEADER]: '1' } }); if (r.status < 300) await hit('alice', `/api/chats/${chatId}/restore`, J({})); return r }, allow: ['alice', 'carol', 'dana'], deny: { bob: 403, erin: 404 } },
]

function judge(row: Row, who: Who, r: { status: number; text: string }) {
  if (row.allow.includes(who)) {
    expect({ route: row.route, who, ok: r.status < 300 }).toEqual({ route: row.route, who, ok: true })
  } else {
    const want = row.deny[who]
    expect({ route: row.route, who, status: r.status }).toEqual({ route: row.route, who, status: want ?? r.status })
    expect({ route: row.route, who, denied: r.status >= 400 }).toEqual({ route: row.route, who, denied: true })
  }
  // nobody outside the audience ever gets the chat's words
  if (who === 'erin') expect(r.text.includes(CANARY)).toBe(false)
}

describe('a shared chat as it is', () => {
  for (const row of reads()) test(row.route, async () => { for (const w of PEOPLE) judge(row, w, await row.run(w)) })
  for (const row of writes()) test(row.route, async () => { for (const w of PEOPLE) { await idle(); judge(row, w, await row.run(w)) } })

  test('POST /api/chats/:id/messages: everyone in the audience continues it, as themselves; erin gets 404', async () => {
    for (const w of PEOPLE) {
      await idle()
      const r = await hit(w, `/api/chats/${chatId}/messages`, J({ content: `from ${w}\n${fake({ say: `ok ${w}` })}`, clientMessageId: cm(), attachmentIds: [] }))
      if (w === 'erin') { expect(r.status).toBe(404); continue }
      expect({ w, status: r.status }).toEqual({ w, status: 202 })
      const t = JSON.parse(r.text) as { turnId: string }
      expect(h.ctx.db.query('SELECT user_id FROM turns WHERE id = ?').get(t.turnId)).toEqual({ user_id: w })
    }
    await idle()
  })

  test('while alice\'s turn runs: busy for the others (409 shared_chat_busy), stop and cards are hers', async () => {
    await idle()
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content: fake({ sleep: 3000 }, { say: 'slow' }), clientMessageId: cm(), attachmentIds: [] } })
    await waitFor(() => h.rt().activeTurnUser(chatId) === 'alice')
    for (const w of ['bob', 'carol', 'dana'] as const) {
      const s = await hit(w, `/api/chats/${chatId}/messages`, J({ content: 'x', clientMessageId: cm(), attachmentIds: [] }))
      expect({ w, status: s.status, reason: JSON.parse(s.text).error?.params?.reason }).toEqual({ w, status: 409, reason: 'shared_chat_busy' })
      expect((await hit(w, `/api/chats/${chatId}/stop`, J({}))).status).toBe(403)
      expect(JSON.parse((await hit(w, `/api/chats/${chatId}/requests`)).text).items).toEqual([])
    }
    expect((await hit('erin', `/api/chats/${chatId}/stop`, J({}))).status).toBe(404)
    expect((await hit('alice', `/api/chats/${chatId}/stop`, J({}))).status).toBe(200)
    await ws.alice!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
  })

  test("another person's turn id: answering its card is refused (404)", async () => {
    for (const w of ['bob', 'carol', 'dana', 'erin'] as const) {
      expect((await hit(w, `/api/turns/${turnId}/answer`, J({ kind: 'ask_user', requestId: uuidv7(), answer: 'share' }))).status).toBe(404)
    }
  })
})

describe('in the trash', () => {
  test('only its creator and those who may edit its project see it; nobody continues it', async () => {
    await idle()
    expect((await hit('alice', `/api/chats/${chatId}`, { method: 'DELETE', headers: { [CSRF_HEADER]: '1' } })).status).toBe(200)
    try {
      for (const w of PEOPLE) {
        const r = await hit(w, `/api/chats/${chatId}`)
        expect({ w, status: r.status }).toEqual({ w, status: w === 'alice' || w === 'carol' || w === 'dana' ? 200 : 404 })
        const s = await hit(w, `/api/chats/${chatId}/messages`, J({ content: 'x', clientMessageId: cm(), attachmentIds: [] }))
        expect({ w, status: s.status }).toEqual({ w, status: 404 })
      }
      expect((await hit('bob', `/api/chats/${chatId}/restore`, J({}))).status).toBe(404)
    } finally { expect((await hit('alice', `/api/chats/${chatId}/restore`, J({}))).status).toBe(200) }
  })
})

describe('while safe operations (1A) are on', () => {
  test('read-only for everyone in the audience (409 safe_ops); erin still 404', async () => {
    await idle()
    process.env.MYCEL_SAFE_OPS_1A = '1'
    try {
      for (const w of PEOPLE) {
        expect({ w, status: (await hit(w, `/api/chats/${chatId}`)).status }).toEqual({ w, status: w === 'erin' ? 404 : 200 })
        const s = await hit(w, `/api/chats/${chatId}/messages`, J({ content: 'x', clientMessageId: cm(), attachmentIds: [] }))
        expect({ w, status: s.status, reason: w === 'erin' ? undefined : JSON.parse(s.text).error?.params?.reason }).toEqual({ w, status: w === 'erin' ? 404 : 409, reason: w === 'erin' ? undefined : 'safe_ops' })
      }
      // and a new chat in the project is not shared
      const c = JSON.parse((await hit('alice', '/api/chats', J({ projectId }))).text)
      expect(c.shared).toBeUndefined()
      expect((await hit('bob', `/api/chats/${c.id}`)).status).toBe(404)
    } finally { delete process.env.MYCEL_SAFE_OPS_1A }
  })
})

describe('after bob lost the folder', () => {
  test('bob gets 404 on every route; the others are unchanged', async () => {
    await idle()
    h.ctx.db.query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'bob'").run()
    try {
      for (const row of reads()) {
        const r = await row.run('bob')
        expect({ route: row.route, status: r.status }).toEqual({ route: row.route, status: 404 })
        expect(r.text.includes(CANARY)).toBe(false)
      }
      expect((await hit('bob', `/api/chats/${chatId}/messages`, J({ content: 'x', clientMessageId: cm(), attachmentIds: [] }))).status).toBe(404)
      expect((await hit('alice', `/api/chats/${chatId}`)).status).toBe(200)
    } finally { h.ctx.db.query("INSERT INTO group_members VALUES ('finance','bob')").run() }
  })
})

describe("while the project's folder is in the trash", () => {
  test('only the owner and admins see it', async () => {
    await idle()
    h.ctx.db.query("UPDATE projects SET trashed_with = 'sec-trash' WHERE id = ?").run(projectId)
    try {
      for (const w of PEOPLE) {
        const r = await hit(w, `/api/chats/${chatId}`)
        expect({ w, status: r.status }).toEqual({ w, status: w === 'carol' || w === 'dana' ? 200 : 404 })
        if (r.status !== 200) expect(r.text.includes(CANARY)).toBe(false)
      }
    } finally { h.ctx.db.query('UPDATE projects SET trashed_with = NULL WHERE id = ?').run(projectId) }
  })
})

describe('realtime', () => {
  test("erin's socket never carries the shared chat; bob's never carries alice's live answer or cards", async () => {
    await idle()
    const at = { erin: ws.erin!.frames.length, bob: ws.bob!.frames.length }
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content: fake({ tool: 'read', args: { file_path: 'users/alice/todo.md' } }, { say: `live ${CANARY}` }), clientMessageId: cm(), attachmentIds: [] } })
    const card = await ws.alice!.next('turn.request', (f) => f.data.turnId === r.turnId, 15_000)
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'skip' } })
    await ws.alice!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    await Bun.sleep(300)
    const erin = JSON.stringify(ws.erin!.frames.slice(at.erin))
    expect(erin.includes(chatId)).toBe(false)
    const bob = ws.bob!.frames.slice(at.bob)
    expect(bob.some((f) => f.type === 'message.delta' || f.type === 'message.step' || f.type === 'turn.request' || f.type === 'message.done' || f.type === 'queue.position')).toBe(false)
    expect(bob.some((f) => f.type === 'chat.updated' && f.data.chatId === chatId)).toBe(true)
    expect(JSON.stringify(bob).includes('todo.md')).toBe(false)
  })
})

describe('an existing private chat shared later', () => {
  const NAMES = ['bob', 'carol', 'dana', 'erin', 'Bob', 'Carol', 'Dana', 'Erin']
  const PRIVATE = 'SEC-PRIVATE-CANARY-8812'
  test('POST /api/chats/:id/share on a shared chat: already shared for its audience, 404 for erin', async () => {
    await idle()
    for (const w of PEOPLE) {
      const r = await hit(w, `/api/chats/${chatId}/share`, J({}))
      expect({ w, status: r.status, reason: r.status === 409 ? JSON.parse(r.text).error?.params?.reason : undefined })
        .toEqual({ w, status: w === 'erin' ? 404 : 409, reason: w === 'erin' ? undefined : 'already_shared' })
      expect(r.text.includes(CANARY)).toBe(false)
    }
  })

  test('only its creator may ask; the check names nobody; nothing is shared without the key; then the audience sees it, erin never', async () => {
    // alice's private chat, moved into the project, that read her own folder
    const own = (await h.api('alice').call(API.createChat, { body: {} })).id
    await h.api('alice').call(API.updateChat, { params: { id: own }, body: { projectId } })
    const r = await h.api('alice').call(API.sendMessage, { params: { id: own }, body: { content: `${PRIVATE}\n${fake({ tool: 'read', args: { file_path: 'users/alice/todo.md' } }, { say: `done ${PRIVATE}` })}`, clientMessageId: cm(), attachmentIds: [] } })
    await ws.alice!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    await waitFor(() => !h.rt().activeTurn(own), { timeoutMs: 30_000 })
    // anyone but alice: the 404 of a chat that does not exist, also people who will see it once shared
    const missing = await hit('bob', `/api/chats/${uuidv7()}/share`, J({}))
    for (const w of ['bob', 'carol', 'dana', 'erin'] as const) {
      const x = await hit(w, `/api/chats/${own}/share`, J({}))
      expect({ w, status: x.status, code: JSON.parse(x.text).error?.code }).toEqual({ w, status: 404, code: JSON.parse(missing.text).error.code })
      expect(x.text.includes(PRIVATE)).toBe(false)
      expect((await hit(w, `/api/chats/${own}/messages`)).status).toBe(404)
    }
    // alice: a confirm that names her own folder and nobody
    const ask = await hit('alice', `/api/chats/${own}/share`, J({}))
    const c = JSON.parse(ask.text)
    expect(c).toMatchObject({ status: 'confirm', audience: 3, provenance: { people: 3, places: [{ kind: 'mine' }] } })
    expect(NAMES.filter((n) => ask.text.includes(n))).toEqual([])
    expect(ask.text.includes(PRIVATE)).toBe(false)
    expect(ask.text.includes('todo.md')).toBe(false)
    // a key of another chat, or a made-up one: asked again, nothing shared
    for (const key of ['x'.repeat(43), c.confirmKey.replace(/.$/, (ch: string) => (ch === 'A' ? 'B' : 'A'))]) {
      const again = JSON.parse((await hit('alice', `/api/chats/${own}/share`, J({ confirmKey: key }))).text)
      expect(again).toMatchObject({ status: 'confirm', reason: 'changed' })
      expect((await hit('bob', `/api/chats/${own}`)).status).toBe(404)
    }
    // bob cannot use alice's key
    expect((await hit('bob', `/api/chats/${own}/share`, J({ confirmKey: c.confirmKey }))).status).toBe(404)
    const at = { erin: ws.erin!.frames.length, bob: ws.bob!.frames.length }
    const done = JSON.parse((await hit('alice', `/api/chats/${own}/share`, J({ confirmKey: c.confirmKey }))).text)
    expect(done.status).toBe('shared')
    await Bun.sleep(300)
    // the audience sees it; the step that read her folder is the words alone for them; erin: 404, nothing on her socket
    for (const w of ['bob', 'carol', 'dana'] as const) {
      const msgs = await hit(w, `/api/chats/${own}/messages`)
      expect({ w, status: msgs.status }).toEqual({ w, status: 200 })
      expect(msgs.text.includes(PRIVATE)).toBe(true)
      // (alice's own message typed the path: the fake engine's directive)
      const answers = (JSON.parse(msgs.text).items as { role: string }[]).filter((m) => m.role === 'assistant')
      expect(JSON.stringify(answers).includes('users/alice')).toBe(false)
    }
    for (const p of [`/api/chats/${own}`, `/api/chats/${own}/messages`, `/api/chats?projectId=${projectId}`]) {
      const x = await hit('erin', p)
      expect(x.text.includes(PRIVATE)).toBe(false)
      expect(x.text.includes(own)).toBe(false)
    }
    expect(JSON.stringify(ws.erin!.frames.slice(at.erin)).includes(own)).toBe(false)
    expect(ws.bob!.frames.slice(at.bob).some((f) => f.type === 'chat.updated' && f.data.chatId === own)).toBe(true)
    // the audit row: counts, no names
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'chat.share' AND target = ?").get(own) as { detail: string }
    expect(JSON.parse(row.detail)).toEqual({ audience: 3, people: 3, unknown: false, memories: false, confirmed: true })
  })
})

describe('a later reader (docs/DECISIONS.md "People who see a shared chat later")', () => {
  test('no reading route, search or the AI of their turn carries an answer hidden from them', async () => {
    const LATER = 'Autumn Upgrade'
    // bob is out of the project while alice reads groups/marketing in a chat of it (alice, carol and dana read it: no
    // card), then joins again: he did not see the chat then, and cannot read the place
    h.ctx.db.query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'bob'").run()
    let later: string, hidden: string
    try {
      later = (await h.api('alice').call(API.createChat, { body: { projectId } })).id
      // (the words come from the file, never from the question, which everyone sees)
      const r = await h.api('alice').call(API.sendMessage, { params: { id: later }, body: { content: fake({ tool: 'artifact', args: { action: 'create', key: 'k', type: 'markdown', content: 'made' } }, { tool: 'read', args: { file_path: 'groups/marketing/campaign-brief.md' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
      hidden = r.assistantMessage.id
      await ws.alice!.next('message.done', (f) => f.data.messageId === hidden, 30_000)
      await waitFor(() => !h.rt().activeTurn(later), { timeoutMs: 30_000 })
    } finally { h.ctx.db.query("INSERT INTO group_members VALUES ('finance', 'bob')").run() }
    const routes = [`/api/chats/${later}`, `/api/chats/${later}/messages`, `/api/chats/${later}/artifacts`, `/api/chats/${later}/messages/${hidden}/sources`,
      `/api/chats?projectId=${projectId}&q=${encodeURIComponent('Autumn')}`, `/api/chats?q=${encodeURIComponent('Autumn')}`]
    for (const p of routes) {
      const b = await hit('bob', p)
      expect({ p, status: b.status }).toEqual({ p, status: 200 })
      expect({ p, leaks: b.text.includes(LATER) }).toEqual({ p, leaks: false })
      // carol saw the chat then: hers as it is
      if (p.endsWith('/messages')) expect((await hit('carol', p)).text.includes(LATER)).toBe(true)
    }
    expect(JSON.parse((await hit('bob', `/api/chats/${later}/messages`)).text).items.find((m: { id: string }) => m.id === hidden)).toMatchObject({ withheld: true, content: '', steps: [] })
    expect(JSON.parse((await hit('bob', `/api/chats/${later}/artifacts`)).text).items).toEqual([])
    expect(JSON.parse((await hit('carol', `/api/chats/${later}/artifacts`)).text).items.map((a: { key: string }) => a.key)).toEqual(['k'])
    // his own turn there: the engine gets a line in place of the answer, nothing of it
    const t = await h.api('bob').call(API.sendMessage, { params: { id: later }, body: { content: fake({ echo: 'system' }), clientMessageId: cm(), attachmentIds: [] } })
    const d = await ws.bob!.next('message.done', (f) => f.data.messageId === t.assistantMessage.id, 30_000)
    expect(d.data.message.content).not.toContain(LATER)
    expect(d.data.message.content).toContain('that the person asking you now cannot see')
  })
})
