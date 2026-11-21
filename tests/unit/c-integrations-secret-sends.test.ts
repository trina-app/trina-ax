// QA tracking TC-3081: what the AI sends to a connected service never holds the person's stored connection key. The
// card showed the arguments with the key hidden, but the call sent the key itself: the person approved one thing and
// the service got another. integrations/connections/hide-args.ts hideAllArgs runs before the cards and the call (the
// turn's hook, chat/tools.ts hideKeys); the connection's own sign-in (headers) keeps working.
// Also a point of the #971 review: write keeps a key form only when the file it really overwrites (the hidden path) holds it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { HIDDEN } from '../../server/src/integrations/connections/hide'
import { redactorOf } from '../../server/src/integrations/connections/redact'
import { hideAllArgs, hideKeysInArgs, KeyRefusal, KEYS_SENT_HIDDEN_NOTE } from '../../server/src/integrations/connections/hide-args'
import { integrationsOf } from '../../server/src/integrations/connections/service'

setDefaultTimeout(90_000)

const KEY = 'sk-RK1115-FAKE'
const B64 = Buffer.from(KEY).toString('base64')
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
/** the key, one of its encoded forms, or half of one */
const leaks = (text: string) => [KEY, B64, KEY.slice(0, 8), KEY.slice(-8), B64.slice(0, 10), B64.slice(-10)].filter((k) => text.includes(k))
const r = redactorOf([KEY])

describe('the arguments of a call to a connected service (hide-args.ts hideAllArgs)', () => {
  test('every value and field name, at any depth, in any form; the note says it was sent hidden', () => {
    const args = { title: `Key ${KEY}`, body: { text: `b64 ${B64}`, [`x-${KEY}`]: 1, list: [KEY, 2, true, null] }, path: `/x?k=${encodeURIComponent(KEY)}` }
    expect(hideAllArgs(args, r)).toEqual({
      args: { title: `Key ${HIDDEN}`, body: { text: `b64 ${HIDDEN}`, [`x-${HIDDEN}`]: 1, list: [HIDDEN, 2, true, null] }, path: `/x?k=${HIDDEN}` },
      hidden: true, note: KEYS_SENT_HIDDEN_NOTE,
    })
    // call_tool's arguments as a JSON text stay JSON
    const out = hideAllArgs({ name: 'my_tasks__create_task', arguments: JSON.stringify({ title: KEY }) }, r).args as { arguments: string }
    expect(JSON.parse(out.arguments)).toEqual({ title: HIDDEN })
  })

  test('nothing to hide: the same arguments back; a person with no stored key: nothing changes', () => {
    const args = { title: 'Quarterly plan', n: 3 }
    expect(hideAllArgs(args, r)).toEqual({ args, hidden: false })
    expect(hideAllArgs(args, r).args).toBe(args)
    expect(hideAllArgs({ title: KEY }, redactorOf([]))).toEqual({ args: { title: KEY }, hidden: false })
  })

  test('base64 data (an attachment) that holds the key is not sent with a hole in it: refused', () => {
    const file = Buffer.from(`notes\nKEY=${KEY}\n${'x'.repeat(80)}`).toString('base64')
    expect(() => hideAllArgs({ to: 'a@acme.test', attachments: [{ filename: 'env.txt', content: file }] }, r)).toThrow(KeyRefusal)
    // the same data without the key goes as it is; long words with spaces are words, not data
    const clean = Buffer.from('x'.repeat(120)).toString('base64')
    expect(hideAllArgs({ attachments: [{ content: clean }] }, r).hidden).toBe(false)
    expect(hideAllArgs({ text: `please put ${KEY} in the notes field of the new page, for me. Thanks a lot!` }, r).hidden).toBe(true)
  })

  test('base64 wrapped across lines at any width, with the key across a wrap: refused, never sent unchanged', () => {
    const wrap = (b: string, w: number, eol = '\n') => b.match(new RegExp(`.{1,${w}}`, 'g'))!.join(eol)
    for (const lead of ['', 'a', 'ab', 'notes\n', 'x'.repeat(13)]) {
      const file = Buffer.from(`${lead}KEY=${KEY}\n${'y'.repeat(90)}`).toString('base64')
      for (const w of [16, 20, 24, 28, 64, 76]) {
        for (const eol of ['\n', '\r\n']) {
          expect(() => hideAllArgs({ attachments: [{ content: wrap(file, w, eol) }] }, r), `lead ${lead.length}, width ${w}`).toThrow(KeyRefusal)
        }
      }
    }
    // a wrapped file without the key goes as it is
    const clean = Buffer.from('z'.repeat(200)).toString('base64')
    expect(hideAllArgs({ attachments: [{ content: wrap(clean, 76) }] }, r).hidden).toBe(false)
  })

  test('a key cut by a space or a line break in ordinary text is refused, not sent', () => {
    expect(() => hideAllArgs({ text: `the key is ${KEY.slice(0, 6)} ${KEY.slice(6)}.` }, r)).toThrow(KeyRefusal)
    expect(() => hideAllArgs({ text: `the key is ${KEY.slice(0, 6)}\n${KEY.slice(6)}.` }, r)).toThrow(KeyRefusal)
    expect(() => hideAllArgs({ text: `b64: ${B64.slice(0, 9)}\n${B64.slice(9)}` }, r)).toThrow(KeyRefusal)
  })

  test('a whole copy hidden does not let a split copy of the key in the same text go out', () => {
    expect(() => hideAllArgs({ text: `${KEY} and again ${KEY.slice(0, 7)}\n${KEY.slice(7)}` }, r)).toThrow(KeyRefusal)
    expect(() => hideAllArgs({ text: `${KEY}, then ${KEY.slice(0, 5)} ${KEY.slice(5)}.` }, r)).toThrow(KeyRefusal)
    expect(() => hideAllArgs({ text: `base64 ${B64}\nwrapped ${B64.slice(0, 12)}\n${B64.slice(12)}` }, r)).toThrow(KeyRefusal)
    // several whole copies with spaces and lines between them: hidden, sent
    expect(hideAllArgs({ text: `${KEY}\n${KEY} ${B64}` }, r).args).toEqual({ text: `${HIDDEN}\n${HIDDEN} ${HIDDEN}` })
  })

  test('write looks up the file it overwrites at the path it really writes (the hidden one)', () => {
    const asked: string[] = []
    const out = hideKeysInArgs('write', { file_path: `notes/${KEY}.md`, content: `KEY=${KEY}` }, r, (p) => { asked.push(p); return p === `notes/${HIDDEN}.md` ? `KEY=${KEY}` : null })
    expect(asked).toEqual([`notes/${HIDDEN}.md`])
    expect(out.args).toEqual({ file_path: `notes/${HIDDEN}.md`, content: `KEY=${KEY}` })
  })
})

// ---------------- real turns ----------------
// through the real launcher and gate (bun run build:native); without the native binaries these turns cannot start
const GATE = path.join(import.meta.dir, '../../native/bin', `${process.platform}-${process.arch}`, 'mycel-gate')
const native = fs.existsSync(GATE)
let h: Harness, svc: FakeServices
const published: { userId: string; ev: any }[] = []

describe('a turn that puts the stored key into a call to a connected service', () => {
  beforeAll(async () => {
    h = await startHarness({ name: 'c-integrations-secret-sends', askUserTimeoutMs: 5000, stallTimeoutMs: 60_000 })
    h.ctx.db.query("INSERT INTO settings (key, value) VALUES ('personalIntegrations', 'true') ON CONFLICT(key) DO UPDATE SET value='true'").run()
    const hub = h.rt().hub
    const publish = hub.publish.bind(hub)
    hub.publish = (userId, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); publish(userId, ev) }
    svc = new FakeServices()
    integrationsOf(h.ctx, { net: svc.net() })
    // the key the AI repeats: alice's HTTP API connection; the MCP connection signs in with its own key (a header)
    const api = await h.api('alice').call(API.createIntegration, { body: { kind: 'http', name: 'QA API', url: `${svc.base}/echo`, auth: 'bearer', secret: KEY, writePolicy: 'ask' } })
    expect(api.status).toBe('connected')
    const tasks = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Tasks', url: `${svc.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY, writePolicy: 'ask' } })
    expect(tasks.status).toBe('connected')
  })
  afterAll(async () => { svc?.stop(); await h?.close() })

  /** one turn in a new chat, the person allowing each card; the cards shown and the answer */
  async function turn(content: string) {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const started = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const id = started.assistantMessage.id
    const answered = new Set<string>()
    const cards: any[] = []
    const approve = setInterval(() => {
      for (const p of published) {
        if (p.ev.type !== 'turn.request' || p.ev.data.turnId !== started.turnId || answered.has(p.ev.data.request.requestId)) continue
        answered.add(p.ev.data.request.requestId)
        cards.push(p.ev.data.request)
        void h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: p.ev.data.request.requestId, answer: 'allow' } }).catch(() => {})
      }
    }, 20)
    const doneEv = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === id), { timeoutMs: 40_000, what: 'message.done' }).finally(() => clearInterval(approve))
    return { done: doneEv!.ev.data.message, cards }
  }

  test.skipIf(!native)('an MCP tool: the card shows [hidden key] and the service gets exactly that; its own sign-in still works', async () => {
    const before = svc.calls.length
    const t = await turn(fake(
      { tool: 'my_tasks__create_task', args: { title: `Rotate ${KEY}`, notes: `base64 ${B64}` }, sayResult: true },
      { say: 'Done.' },
    ))
    const sent = svc.calls.slice(before).filter((c) => c.name === 'create_task')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.args).toEqual({ title: `Rotate ${HIDDEN}`, notes: `base64 ${HIDDEN}` })
    expect(sent[0]!.auth).toBe(`Bearer ${MCP_KEY}`) // the connection's own key, in the header, untouched
    expect(t.cards).toHaveLength(1)
    const card = JSON.stringify(t.cards[0])
    expect(card).toContain(`Rotate ${HIDDEN}`)
    expect(leaks(card)).toEqual([])
    expect(t.done.content).toContain(`created task "Rotate ${HIDDEN}"`)
    expect(leaks(t.done.content + JSON.stringify(t.done.steps))).toEqual([])
  })

  test.skipIf(!native)('api_request: the body and query the service gets have [hidden key]; the stored key signs the call in', async () => {
    const before = svc.seen.length
    const t = await turn(fake(
      { tool: 'api_request', args: { connection: 'my_qaapi', method: 'POST', path: '/headers', query: { note: KEY }, body: { title: KEY, b64: B64 } }, sayResult: true },
      { say: 'Done.' },
    ))
    const req = svc.seen.slice(before).find((s) => s.path.startsWith('/echo/headers'))!
    expect(req).toBeTruthy()
    expect(JSON.parse(req.body)).toEqual({ title: HIDDEN, b64: HIDDEN })
    expect(new URL(req.path, 'https://x.test').searchParams.get('note')).toBe(HIDDEN)
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`) // the connection's own sign-in: the stored key, as before
    expect(t.cards).toHaveLength(1)
    expect(leaks(JSON.stringify(t.cards[0]))).toEqual([])
    expect(JSON.stringify(t.cards[0])).toContain(HIDDEN)
  })

  test.skipIf(!native)('an attachment whose data holds the key is not sent at all', async () => {
    const before = svc.calls.length
    const file = Buffer.from(`KEY=${KEY}\n${'x'.repeat(80)}`).toString('base64')
    const t = await turn(fake(
      { tool: 'my_tasks__create_task', args: { title: 'with file', attachments: [{ filename: 'env.txt', content: file }] }, sayResult: true },
    ))
    expect(svc.calls.slice(before).filter((c) => c.name === 'create_task')).toHaveLength(0)
    expect(t.cards).toHaveLength(0)
    expect(t.done.content).toContain('Nothing was sent')
  })

  test.skipIf(!native)('a stored key that cannot be read now: nothing is sent unchecked', async () => {
    const db = h.ctx.db
    const own = db.query("SELECT id FROM integrations WHERE scope = 'personal' AND owner_user_id = 'alice' AND secret_enc IS NOT NULL LIMIT 1").get() as { id: string }
    // a connection of alice's whose stored secret cannot be opened (a damaged row, a changed server key)
    db.run('CREATE TEMP TABLE broken AS SELECT * FROM integrations WHERE id = ?', [own.id])
    db.run("UPDATE broken SET id = 'int-broken', name = 'Broken API', slug = 'brokenapi', secret_enc = 'not-a-sealed-secret'")
    db.run('INSERT INTO integrations SELECT * FROM broken')
    db.run('DROP TABLE broken')
    try {
      const before = svc.calls.length
      const t = await turn(fake({ tool: 'my_tasks__create_task', args: { title: `Rotate ${KEY}` }, sayResult: true }))
      expect(svc.calls.slice(before).filter((c) => c.name === 'create_task')).toHaveLength(0)
      expect(t.cards).toHaveLength(0)
      expect(t.done.content).toContain('could not be read just now')
      const audit = db.query("SELECT summary FROM tool_events WHERE tool = 'my_tasks__create_task' ORDER BY id DESC LIMIT 1").get() as { summary: string }
      expect(audit.summary).toBe('my_tasks__create_task -> not sent (stored keys could not be read)')
    } finally {
      db.run("DELETE FROM integrations WHERE id = 'int-broken'")
    }
  })
})
