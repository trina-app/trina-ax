// The AI repeats a stored connection key in its own words (QA INT-13 / B-W5-4): the person's message has the key, the
// service echoes it (hidden by hide.ts), and the answer says "the string you sent (<key>) matched the stored key". The
// key must not reach the streamed answer (also when it is cut across text pieces), the saved answer, the steps, the
// audit lines (tool_events), the chat title (placeholder and AI-named; B-W5-1) or the chat list and search.
// server/src/integrations/connections/redact.ts; the person's own message is kept as typed.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { FakeServices } from '../lib/fake-services'
import { HIDDEN } from '../../server/src/integrations/connections/hide'
import { carryLength, hideKeysInStoredMemories, MEMORY_SCAN_KEY, RedactingText, redactorFor, redactorOf } from '../../server/src/integrations/connections/redact'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { placeholderTitle } from '../../server/src/chat/title'
import { memoriesCsv, runExport } from '../../server/src/system/export'
import { readFileChunks, zstdDecompress } from '../../server/src/system/streams'
import { extractTar } from '../../server/src/system/tar'

setDefaultTimeout(60_000)

// the QA key: words and digits only, so the secret-shape detector (shared/src/secrets.ts) does not see it
const KEY = ['QA', 'FAKE', 'KEY', '0000', 'NOT', 'REAL'].join('-')
const TEAM_KEY = 'team-CANARY-9a8b7c6d5e'
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
/** the key whole, or its first or last 8 characters (a key cut in two) */
const leaks = (text: string, keys = [KEY, TEAM_KEY]) => keys.filter((k) => text.includes(k) || text.includes(k.slice(0, 8)) || text.includes(k.slice(-8)))

describe('the stream redactor (redact.ts)', () => {
  const r = redactorOf([KEY])
  /** the text cut into pieces of n characters, through the stream: what comes out, and each piece let out */
  const stream = (text: string, n: number, red = r) => {
    const s = new RedactingText(() => red)
    const out: string[] = []
    for (let i = 0; i < text.length; i += n) out.push(s.push(text.slice(i, i + n)))
    out.push(s.flush())
    return out
  }

  test('a key cut across pieces of any size is hidden; nothing of it is let out before it is whole', () => {
    const text = `The string you sent (${KEY}) matched the stored key, so it was hidden. Again: ${KEY}.`
    for (const n of [1, 2, 3, 5, 7, 11, 25, 200]) {
      const out = stream(text, n)
      expect(out.join(''), `pieces of ${n}`).toBe(`The string you sent (${HIDDEN}) matched the stored key, so it was hidden. Again: ${HIDDEN}.`)
      for (const piece of out) expect(leaks(piece), `pieces of ${n}`).toEqual([])
    }
  })

  test('ordinary text and parts of the key pass unchanged, and without stored keys nothing is held back', () => {
    const text = 'QA FAKE KEY 0000 is not the key; QA-FAKE-KEY-000 neither. 한글도 그대로.'
    expect(stream(text, 3).join('')).toBe(text)
    const none = redactorOf([])
    expect(none.res).toEqual([])
    const pieces = stream(`${KEY} as typed`, 4, none)
    expect(pieces.slice(0, -1).join('')).toBe(`${KEY} as typed`) // every piece let out at once
    expect(pieces.at(-1)).toBe('')
  })

  test('carry-over: only the end that could start a key waits', () => {
    expect(carryLength('hello QA-FA', [KEY])).toBe(5)
    expect(carryLength('hello world', [KEY])).toBe(0)
    expect(carryLength(KEY, [KEY])).toBe(0) // a whole key is hidden, not held
    const s = new RedactingText(() => r)
    expect(s.push('see QA-FA')).toBe('see ')
    expect(s.held).toBe('QA-FA')
    // not the key after all; the word at the end still waits: it could start an encoded form (formCarryLength)
    expect(s.push('X- and')).toBe('QA-FAX- ')
    expect(s.flush()).toBe('and')
  })

  test('placeholder title: a stored key is cut out like a secret-looking one; a line left with one word is skipped', () => {
    const known = r.hide
    expect(placeholderTitle(`${KEY} 이게 무슨 뜻이야?`, [], known)).toBe('이게 무슨 뜻이야?')
    expect(placeholderTitle(`${KEY}\nWhat does this mean?`, [], known)).toBe('What does this mean?')
    expect(placeholderTitle(`key ${KEY}`, [], known)).toBe('')
    // without the stored key the QA string is a named test key (shared/src/secrets.ts, QA B-W47-3): also cut out
    expect(placeholderTitle(`${KEY} 이게 무슨 뜻이야?`)).toBe('이게 무슨 뜻이야?')
    expect(placeholderTitle('Plan the trip to Bali', [], known)).toBe('Plan the trip to Bali')
  })
})

// ---------------- real turns ----------------
// through the real launcher and gate (bun run build:native); without the native binaries these turns cannot start
const GATE = path.join(import.meta.dir, '../../native/bin', `${process.platform}-${process.arch}`, 'mycel-gate')
let h: Harness, svc: FakeServices
/** every event the server published to a person (what their apps get over the socket) */
const published: { userId: string; ev: any }[] = []

const native = fs.existsSync(GATE)

describe('a turn that repeats the stored key', () => {
  beforeAll(async () => {
    h = await startHarness({ name: 'c-integrations-secret-echo', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
    h.ctx.db.query("INSERT INTO settings (key, value) VALUES ('personalIntegrations', 'true') ON CONFLICT(key) DO UPDATE SET value='true'").run()
    const hub = h.rt().hub
    const publish = hub.publish.bind(hub)
    hub.publish = (userId, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); publish(userId, ev) }
    svc = new FakeServices()
    integrationsOf(h.ctx, { net: svc.net() })
    // a personal connection asks before every change ("run without asking" is for team connections): turn() answers the card
    const qa = await h.api('alice').call(API.createIntegration, { body: { kind: 'http', name: 'QA API', url: `${svc.base}/echo`, auth: 'bearer', secret: KEY, writePolicy: 'ask' } })
    expect(qa.status).toBe('connected')
  })
  afterAll(async () => { svc?.stop(); await h?.close() })

  /** one turn in a new chat; every text the server let out or saved for it */
  async function turn(content: string, answer = 'allow') {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const started = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const id = started.assistantMessage.id
    // the person allows each change on the server's card
    const answered = new Set<string>()
    const approve = setInterval(() => {
      for (const p of published) {
        if (p.ev.type !== 'turn.request' || p.ev.data.turnId !== started.turnId || answered.has(p.ev.data.request.requestId)) continue
        answered.add(p.ev.data.request.requestId)
        void h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: p.ev.data.request.requestId, answer } }).catch(() => {})
      }
    }, 20)
    const doneEv = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === id), { timeoutMs: 40_000, what: 'message.done' }).finally(() => clearInterval(approve))
    expect(doneEv).toBeTruthy()
    const r = { started, done: doneEv!.ev.data.message }
    const deltas = published.filter((p) => p.userId === 'alice' && p.ev.type === 'message.delta' && p.ev.data.messageId === id).map((p) => p.ev.data as { offset: number; text: string })
    const stored = h.ctx.db.query('SELECT content, steps FROM messages WHERE id = ?').get(id) as { content: string; steps: string }
    const events = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool <> '(connect)'").all(r.started.turnId) as { summary: string }[]
    const title = (h.ctx.db.query('SELECT title FROM chats WHERE id = ?').get(chat.id) as { title: string }).title
    return { chatId: chat.id, done: r.done, deltas, stored, events, title }
  }

  test.skipIf(!native)('INT-13: the service echoes the key, the answer quotes it across pieces: hidden in the stream, the saved answer, steps and audit', async () => {
    const t = await turn([
      `${KEY} 이게 무슨 뜻이야?`,
      fake(
        { tool: 'api_request', args: { connection: 'my_qaapi', method: 'POST', path: '/headers', body: { title: KEY, body: 'x', userId: 1 } }, sayResult: true },
        { say: `\nThe string you sent (${KEY}) matched the key stored for this connection, so it was hidden.` },
        { saySplit: ` 한글 ${KEY} 끝` },
        { tool: 'api_request', args: { connection: 'my_qaapi', method: 'GET', path: `/x/${KEY}` } },
        { say: `Bearer ${KEY}` },
      ),
    ].join('\n'))
    // the stream: each piece, and joined in place, is the saved answer
    expect(t.deltas.length).toBeGreaterThan(5)
    for (const d of t.deltas) expect(leaks(d.text)).toEqual([])
    let joined = ''
    for (const d of t.deltas) { expect(d.offset).toBe(joined.length); joined += d.text }
    expect(joined).toBe(t.done.content)
    expect(t.stored.content).toBe(t.done.content)
    expect(t.done.content).toContain(`The string you sent (${HIDDEN}) matched`)
    expect(t.done.content).toContain(`한글 ${HIDDEN} 끝`)
    expect(t.done.content.endsWith(`Bearer ${HIDDEN}`)).toBe(true)
    expect(t.done.content).toContain(`\\"title\\":\\"${HIDDEN}\\"`) // the echoed body, hidden by hide.ts
    for (const [where, text] of Object.entries({ answer: t.done.content, steps: JSON.stringify(t.done.steps), stored: JSON.stringify(t.stored), audit: JSON.stringify(t.events), title: t.title })) {
      expect(leaks(text), where).toEqual([])
    }
    expect(t.events).toHaveLength(2)
    // the placeholder title skips the key; the chat list and search never show it
    expect(t.title).toBe('이게 무슨 뜻이야?')
    const listed = await h.api('alice').call(API.listChats, { query: {} })
    const found = await h.api('alice').call(API.listChats, { query: { q: 'QA-FAKE' } })
    expect(found.items.map((c) => c.id)).toContain(t.chatId) // found by the person's own message, as QA allows
    expect(leaks(JSON.stringify(listed) + JSON.stringify(found))).toEqual([])
    // the person's own message is kept as typed (the AI's history needs it)
    const mine = h.ctx.db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'user'").get(t.chatId) as { content: string }
    expect(mine.content).toContain(KEY)
  })

  test.skipIf(!native)('a team connection key the person may use is hidden too; set_title with the key is refused', async () => {
    const team = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'http', name: 'Team API', url: `${svc.base}/echo`, auth: 'bearer', secret: TEAM_KEY, access: { everyone: true, groups: [], users: [] } } })
    expect(team.id).toBeTruthy()
    expect(redactorFor(h.ctx, 'alice').hide(`a ${TEAM_KEY} b ${KEY}`)).toBe(`a ${HIDDEN} b ${HIDDEN}`)
    expect(redactorFor(h.ctx, 'bob').hide(`a ${KEY}`)).toBe(`a ${KEY}`) // alice's own key is not bob's secret
    const t = await turn([
      'Name this chat please',
      fake({ tool: 'set_title', args: { title: `About ${TEAM_KEY}` }, sayResult: true }, { say: `team key: ${TEAM_KEY}.` }),
    ].join('\n'))
    expect(t.done.content).toContain('Not set: the title looks like it contains a key')
    expect(t.done.content).toContain(`team key: ${HIDDEN}.`)
    expect(t.title).toBe('Name this chat please')
    for (const text of [t.done.content, JSON.stringify(t.done.steps), JSON.stringify(t.events), ...t.deltas.map((d) => d.text)]) expect(leaks(text)).toEqual([])
  })

  test.skipIf(!native)('an ordinary answer is let out unchanged', async () => {
    const text = 'Here is the plan: QA FAKE KEY is fine, 0000 too. 한국어 답변도 그대로입니다.'
    const t = await turn(fake({ say: text }))
    expect(t.done.content).toBe(text)
    expect(t.deltas.map((d) => d.text).join('')).toBe(text)
  })

  // QA AP-033 (docs/decisions/20261120-ap033-thinking-text.md): the AI's thinking text is kept on its "Thinking" step,
  // saved with the message (so a reload shows it), with the stored key hidden in the whole text (the key comes cut across
  // thinking deltas). It never goes into the answer, and an empty thinking block adds no text.
  test.skipIf(!native)('AP-033: the thinking text is kept on its step, the key hidden, also after a reload', async () => {
    const first = `The person asks about ${KEY}. Check the connection first.`
    const t = await turn(fake({ think: first }, { say: 'Done.' }, { think: '  ' }, { say: 'Bye.' }))
    expect(t.done.content).toBe('Done.\n\nBye.') // two text blocks: two paragraphs, no thinking text
    const thinking = (steps: { kind: string; detail?: string; status: string }[]) => steps.filter((s) => s.kind === 'thinking')
    const live = thinking(t.done.steps)
    expect(live).toHaveLength(2)
    expect(live[0]!.detail).toBe(`The person asks about ${HIDDEN}. Check the connection first.`)
    expect(live[0]!.status).toBe('ok')
    expect(live[1]!.detail).toBeUndefined()
    // saved with the message: the chat's page after a reload has the same text
    const page = await h.api('alice').call(API.listMessages, { params: { id: t.chatId } })
    const answer = page.items.find((m) => m.id === t.done.id)!
    const reloaded = thinking(answer.steps)
    expect(reloaded.map((s) => s.detail)).toEqual(live.map((s) => s.detail))
    // the key is nowhere in the answer: not in the stored steps, the reloaded answer, or any step event the person's apps
    // got (the person's own message keeps it as typed)
    const stepEvents = published.filter((p) => p.ev.type === 'message.step' && p.ev.data.messageId === t.done.id)
    expect(stepEvents.length).toBeGreaterThan(0)
    expect(leaks(t.stored.steps + JSON.stringify(stepEvents) + JSON.stringify(answer))).toEqual([])
  })

  // QA TC-2981: the step said "Remembered: My key is [hidden key]", the saved memory held the key (Settings › Memory,
  // the export's memories.csv). Since auto memory (docs/decisions/20261122-auto-memory.md) a memory that held a stored
  // key is not kept at all: the step says so, with the key hidden, and nothing is saved
  test.skipIf(!native)('remember: a memory that holds a stored key is not kept; the step has the key hidden', async () => {
    const before = (h.ctx.db.query("SELECT count(*) n FROM memories WHERE user_id = 'alice'").get() as { n: number }).n
    const t = await turn(['remember my key please', fake({ tool: 'remember', args: { text: `My key is ${KEY}` }, sayResult: true }, { say: 'Done.' })].join('\n'))
    const step = t.done.steps.find((s: { tool: string }) => s.tool === 'remember')
    expect(step.label).toBe(`Not remembered: My key is ${HIDDEN}`)
    expect((h.ctx.db.query("SELECT count(*) n FROM memories WHERE user_id = 'alice'").get() as { n: number }).n).toBe(before)
    const listed = await h.api('alice').call(API.listMemories, {})
    const rows = h.ctx.db.query("SELECT id, text, created_at, source_chat_id FROM memories WHERE user_id = 'alice'").all() as Parameters<typeof memoriesCsv>[0]
    expect(leaks(memoriesCsv(rows) + JSON.stringify(listed) + JSON.stringify(t.done.steps))).toEqual([])
  })

  test.skipIf(!native)('schedule_create: the card and the saved task have the key hidden in the title and the prompt', async () => {
    const args = { title: `Check ${KEY}`, prompt: `Every morning call QA API with the key ${KEY} and save the answer in my folder.`, repeat: 'daily', time: '07:00' }
    const t = await turn(fake({ tool: 'schedule_create', args, sayResult: true }), 'create')
    const card = published.find((p) => p.ev.type === 'turn.request' && JSON.stringify(p.ev.data.request).includes('Every morning call QA API'))
    expect(card).toBeTruthy()
    expect(leaks(JSON.stringify(card!.ev))).toEqual([])
    const row = h.ctx.db.query("SELECT title, prompt FROM schedules WHERE user_id = 'alice' AND prompt LIKE 'Every morning call QA API%'").get() as { title: string; prompt: string }
    expect(row).toEqual({ title: `Check ${HIDDEN}`, prompt: `Every morning call QA API with the key ${HIDDEN} and save the answer in my folder.` })
    expect(leaks(t.done.content + JSON.stringify(t.done.steps))).toEqual([])
  })

  test('once at start: memories the AI saved with a stored key get it hidden; memories the person typed stay', () => {
    const db = h.ctx.db
    const at = new Date().toISOString()
    db.query("INSERT INTO memories (id, user_id, text, source_chat_id, source, created_turn_id, created_at) VALUES ('m-old-ai', 'alice', ?, NULL, 'ai', 'turn-old', ?)").run(`My key is ${KEY}`, at)
    db.query("INSERT INTO memories (id, user_id, text, source_chat_id, source, created_turn_id, created_at) VALUES ('m-old-typed', 'alice', ?, NULL, 'user', NULL, ?)").run(`typed ${KEY}`, at)
    db.query("INSERT INTO memories (id, user_id, text, source_chat_id, source, created_turn_id, created_at) VALUES ('m-old-bob', 'bob', ?, NULL, 'ai', 'turn-bob', ?)").run(`not bob's key ${KEY}`, at)
    db.query('DELETE FROM settings WHERE key = ?').run(MEMORY_SCAN_KEY)
    expect(hideKeysInStoredMemories(h.ctx)).toBe(1)
    const text = (id: string) => (db.query('SELECT text FROM memories WHERE id = ?').get(id) as { text: string }).text
    expect(text('m-old-ai')).toBe(`My key is ${HIDDEN}`)
    expect(text('m-old-typed')).toBe(`typed ${KEY}`)
    expect(text('m-old-bob')).toBe(`not bob's key ${KEY}`) // alice's key is not bob's secret
    // once: a later row is left to the remember tool
    db.query("UPDATE memories SET text = ? WHERE id = 'm-old-ai'").run(`again ${KEY}`)
    expect(hideKeysInStoredMemories(h.ctx)).toBe(0)
    db.query("DELETE FROM memories WHERE id IN ('m-old-ai', 'm-old-typed', 'm-old-bob')").run()
  })

  test('the start-up clean-up is not marked done while a stored key cannot be read; it runs again at the next start', () => {
    const db = h.ctx.db
    const at = new Date().toISOString()
    const own = db.query("SELECT id FROM integrations WHERE scope = 'personal' AND owner_user_id = 'alice' AND secret_enc IS NOT NULL LIMIT 1").get() as { id: string }
    // a second connection of alice's whose stored secret cannot be opened (a damaged row, a changed server key)
    db.run('CREATE TEMP TABLE broken AS SELECT * FROM integrations WHERE id = ?', [own.id])
    db.run("UPDATE broken SET id = 'int-broken', name = 'Broken API', slug = 'brokenapi', secret_enc = 'not-a-sealed-secret'")
    db.run('INSERT INTO integrations SELECT * FROM broken')
    db.run('DROP TABLE broken')
    try {
      db.query("INSERT INTO memories (id, user_id, text, source_chat_id, source, created_turn_id, created_at) VALUES ('m-scan-1', 'alice', ?, NULL, 'ai', 'turn-old', ?)").run(`My key is ${KEY}`, at)
      db.query('DELETE FROM settings WHERE key = ?').run(MEMORY_SCAN_KEY)
      // the keys that can be read are hidden now; the mark waits
      expect(hideKeysInStoredMemories(h.ctx)).toBe(1)
      expect((db.query("SELECT text FROM memories WHERE id = 'm-scan-1'").get() as { text: string }).text).toBe(`My key is ${HIDDEN}`)
      expect(db.query('SELECT value FROM settings WHERE key = ?').get(MEMORY_SCAN_KEY)).toBeNull()
      // the next start reads every key: it runs again and is marked done
      db.run("DELETE FROM integrations WHERE id = 'int-broken'")
      db.query("UPDATE memories SET text = ? WHERE id = 'm-scan-1'").run(`again ${KEY}`)
      expect(hideKeysInStoredMemories(h.ctx)).toBe(1)
      expect((db.query("SELECT text FROM memories WHERE id = 'm-scan-1'").get() as { text: string }).text).toBe(`again ${HIDDEN}`)
      expect(db.query('SELECT value FROM settings WHERE key = ?').get(MEMORY_SCAN_KEY)).toEqual({ value: '1' })
    } finally {
      db.run("DELETE FROM integrations WHERE id = 'int-broken'")
      db.run("DELETE FROM memories WHERE id = 'm-scan-1'")
    }
  })

  test('a title that holds the key (made before the key was saved, or a rename) is hidden in the list, search, one chat and chat.updated', async () => {
    const api = h.api('alice')
    const old = await api.call(API.createChat, { body: {} })
    h.ctx.db.query('UPDATE chats SET title = ? WHERE id = ?').run(`${KEY} 이게 무슨 뜻이야?`, old.id)
    const renamed = await api.call(API.createChat, { body: {} })
    const patched = await api.call(API.updateChat, { params: { id: renamed.id }, body: { title: `Key ${KEY}` } })
    expect(patched.title).toBe(`Key ${HIDDEN}`)
    const listed = await api.call(API.listChats, { query: {} })
    const found = await api.call(API.listChats, { query: { q: 'QA-FAKE' } })
    expect(found.items.map((c) => c.id)).toContain(old.id) // the old raw title is still found, shown hidden
    // a rename is saved hidden: the database never gets the key from it
    expect((h.ctx.db.query('SELECT title FROM chats WHERE id = ?').get(renamed.id) as { title: string }).title).toBe(`Key ${HIDDEN}`)
    const created = await api.call(API.createChat, { body: { title: `${KEY} plan` } })
    expect(created.title).toBe(`${HIDDEN} plan`)
    expect((h.ctx.db.query('SELECT title FROM chats WHERE id = ?').get(created.id) as { title: string }).title).toBe(`${HIDDEN} plan`)
    expect(listed.items.find((c) => c.id === old.id)!.title).toBe(`${HIDDEN} 이게 무슨 뜻이야?`)
    const one = await api.call(API.getChat, { params: { id: old.id } })
    const updates = published.filter((p) => p.ev.type === 'chat.updated' && p.ev.data.chatId === renamed.id)
    expect(updates.length).toBeGreaterThan(0)
    expect(leaks(JSON.stringify([listed, found, one, patched, created, updates]))).toEqual([])
    // the export (QA SEC-16): the file name and the heading of the chat whose old title holds the key
    const r = await runExport(h.ctx.db, h.ctx.config.teamRoot, { ownerId: 'alice', what: ['chats'], hide: redactorFor(h.ctx, 'alice').hide })
    const out = fs.mkdtempSync(path.join(h.ctx.config.teamRoot, '..', 'export-out-'))
    await extractTar(zstdDecompress(readFileChunks(path.join(h.ctx.config.teamRoot, r.path))), out)
    const root = path.join(out, fs.readdirSync(out)[0]!)
    const names = fs.readdirSync(path.join(root, 'chats'))
    expect(names.some((n) => n.includes('이게 무슨 뜻이야'))).toBe(true)
    expect(leaks(names.join('\n'))).toEqual([])
    for (const n of names) expect(leaks(fs.readFileSync(path.join(root, 'chats', n), 'utf8').split('\n')[0]!), n).toEqual([])
  })
})
