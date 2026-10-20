// Cross-user probe (security review): everything one member creates — chat, messages, open card, artifact, memory,
// project on a personal folder, upload session, attachment — is tried by another member through every endpoint that
// takes its id. Nothing may leak (404 / 403, never the data) and nothing may change.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, CSRF_HEADER } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(40_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let alice: TestSocket
const ids: Record<string, string> = {}

beforeAll(async () => {
  h = await startHarness({ name: 'p0-cross-user', askUserTimeoutMs: 20_000, turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-x-alice' })
  await alice.next('hello')
  const a = h.api('alice')
  const proj = await a.call(API.createProject, { body: { name: 'Mine', folderPath: 'users/alice', instructions: 'SECRET-INSTRUCTION-11' } })
  ids.project = proj.id
  const chat = await a.call(API.createChat, { body: { projectId: proj.id, title: 'SECRET-TITLE-22' } })
  ids.chat = chat.id
  const r = await a.call(API.sendMessage, { params: { id: chat.id }, body: { clientMessageId: cm(), attachmentIds: [], content: fake(
    { tool: 'artifact', args: { action: 'create', key: 'k', type: 'html', content: '<p>SECRET-ARTIFACT-33</p>' } },
    { tool: 'remember', args: { text: 'SECRET-MEMORY-44' } },
    { tool: 'ask_user', args: { question: 'SECRET-QUESTION-55?' } },
  ) } })
  ids.turn = r.turnId
  ids.userMessage = r.userMessage.id
  ids.assistant = r.assistantMessage.id
  const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId)
  ids.request = card.data.request.requestId
  ids.artifact = (h.ctx.db.query('SELECT id FROM artifacts WHERE chat_id = ? LIMIT 1').get(chat.id) as { id: string }).id
  const mem = h.ctx.db.query("SELECT id FROM memories WHERE user_id = 'alice' LIMIT 1").get() as { id: string }
  ids.memory = mem.id
  const sess = await a.call(API.createUploadSession, { body: { target: { kind: 'path', path: 'users/alice/big.bin', onExists: 'rename' }, size: 10, sha256: 'a'.repeat(64) } })
  ids.upload = sess.id
})
afterAll(async () => { alice?.close(); await h?.close() })

const send = (user: string, method: string, p: string, body?: unknown) =>
  h.req(user, p, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' } } : { headers: { [CSRF_HEADER]: '1' } }) })

describe("bob tries alice's things", () => {
  test('every id-taking endpoint refuses and shows nothing', async () => {
    const tries: [string, string, unknown?][] = [
      ['GET', `/api/chats/${ids.chat}`],
      ['PATCH', `/api/chats/${ids.chat}`, { title: 'pwned' }],
      ['GET', `/api/chats/${ids.chat}/messages`],
      ['GET', `/api/chats/${ids.chat}/artifacts`],
      ['GET', `/api/chats/${ids.chat}/requests`],
      ['POST', `/api/chats/${ids.chat}/messages`, { content: 'hi', clientMessageId: cm(), attachmentIds: [] }],
      ['POST', `/api/chats/${ids.chat}/messages/${ids.userMessage}/edit`, { content: 'x', clientMessageId: cm() }],
      ['POST', `/api/chats/${ids.chat}/messages/${ids.assistant}/regenerate`, { clientMessageId: cm() }],
      ['POST', `/api/chats/${ids.chat}/branch`, { leafId: ids.userMessage }],
      ['POST', `/api/chats/${ids.chat}/stop`, {}],
      ['POST', `/api/chats/${ids.chat}/restore`, {}],
      ['POST', `/api/turns/${ids.turn}/answer`, { kind: 'ask_user', requestId: ids.request, answer: 'from bob' }],
      ['GET', `/api/artifacts/${ids.artifact}`],
      ['DELETE', `/api/memories/${ids.memory}`],
      ['GET', `/api/projects/${ids.project}`],
      ['PATCH', `/api/projects/${ids.project}`, { instructions: 'pwned' }],
      ['DELETE', `/api/projects/${ids.project}`],
      ['GET', `/api/upload-sessions/${ids.upload}`],
      ['PUT', `/api/upload-sessions/${ids.upload}/chunks/0`],
      ['POST', `/api/upload-sessions/${ids.upload}/complete`, {}],
      ['DELETE', `/api/upload-sessions/${ids.upload}`],
      ['DELETE', `/api/chats/${ids.chat}`],
    ]
    const leaks: string[] = []
    for (const [m, p, b] of tries) {
      const res = await send('bob', m, p, b)
      const text = await res.text()
      if (res.status < 400 || /SECRET-/.test(text)) leaks.push(`${m} ${p} -> ${res.status} ${text.slice(0, 200)}`)
    }
    expect(leaks).toEqual([])
  })

  test("bob's lists never include alice's things", async () => {
    for (const p of ['/api/chats', '/api/projects', '/api/memories', '/api/search?q=SECRET']) {
      const res = await send('bob', 'GET', p)
      expect(await res.text(), p).not.toContain('SECRET-')
    }
  })

  test('API responses, downloads included, may not be embedded by another site (sibling team addresses are same-site)', async () => {
    for (const p of ['/api/chats', `/api/chats/${ids.chat}`, '/api/files/download?path=users%2Falice%2Ftodo.md&disposition=inline', '/api/nope']) {
      const res = await h.req('alice', p)
      await res.arrayBuffer()
      expect(res.headers.get('cross-origin-resource-policy'), p).toBe('same-origin')
      expect(res.headers.get('x-content-type-options'), p).toBe('nosniff')
    }
  })

  test("alice's things are unchanged and her card still waits for her", async () => {
    const chat = await h.api('alice').call(API.getChat, { params: { id: ids.chat } })
    expect(chat.title).toBe('SECRET-TITLE-22')
    const proj = await h.api('alice').call(API.getProject, { params: { id: ids.project } })
    expect(proj.instructions).toBe('SECRET-INSTRUCTION-11')
    expect(h.ctx.db.query('SELECT 1 FROM memories WHERE id = ?').get(ids.memory)).toBeTruthy()
    const open = await h.api('alice').call(API.listTurnRequests, { params: { id: ids.chat } })
    expect(JSON.stringify(open)).toContain(ids.request)
    await h.api('alice').call(API.answerTurn, { params: { id: ids.turn }, body: { kind: 'ask_user', requestId: ids.request, answer: 'from alice' } })
    const done = await alice.next('message.done', (f) => f.data.messageId === ids.assistant, 30_000)
    expect(done.data.message.status).toBe('done')
  })
})
