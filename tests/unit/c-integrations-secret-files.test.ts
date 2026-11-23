// QA TC-3041: the files the AI saves never hold the person's stored connection key. The answer and the steps said
// [hidden key] while make_file (docx, pdf, hwpx), write, edit, edit_hwp ({{key}} filled in) and artifact wrote the key
// itself, and the text cache and the owner export copied it. integrations/connections/hide-args.ts hides it in what
// these tools are given; what the person already had (their own file with the key in it) is not changed.
// QA TC-2981 (the rest): an encoded form of the key (base64) cut across the answer's text pieces showed in the live
// answer and the messages API while the turn waited on a card (redact.ts formCarryLength).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { hwpPluginOn } from '../lib/hwp-plugin'
import { employmentForm, hwpxParts } from '../lib/hwpx'
import { HIDDEN } from '../../server/src/integrations/connections/hide'
import { formCarryLength, RedactingText, redactorOf } from '../../server/src/integrations/connections/redact'
import { hideExcept, hideKeysInArgs, KEYS_HIDDEN_NOTE } from '../../server/src/integrations/connections/hide-args'
import { TurnFiles } from '../../server/src/files/service'

setDefaultTimeout(90_000)

const KEY = 'sk-RK1115-FAKE'
const B64 = Buffer.from(KEY).toString('base64')
const B64URL = Buffer.from(KEY).toString('base64url')
const PCT = [...Buffer.from(KEY)].map((b) => '%' + b.toString(16).padStart(2, '0')).join('')
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
// the fake engine's directive as JSON escapes, so the person's own words hold no schedule word or address (a schedule
// asked for in the person's own words, with only addresses they typed, is made without its card:
// docs/decisions/20261123-do-then-undo.md; this test is about the card)
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fakeQuiet = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
/** the key, or one of its encoded forms, or half of one (a form cut in two) */
const leaks = (text: string) => [KEY, B64.slice(0, 16), B64URL.slice(0, 16), KEY.slice(0, 8), KEY.slice(-8), B64.slice(0, 10), B64.slice(-10)].filter((k) => text.includes(k))

const r = redactorOf([KEY])

describe('the arguments a saving tool gets (hide-args.ts)', () => {
  const h = (name: string, args: unknown, current?: (p: string) => string | null) => hideKeysInArgs(name, args, r, current)

  test('write: the content and the file name; a form the file it overwrites already holds stays', () => {
    expect(h('write', { file_path: `users/alice/${KEY}.md`, content: `The key is ${KEY} (${B64})` })).toEqual({ args: { file_path: `users/alice/${HIDDEN}.md`, content: `The key is ${HIDDEN} (${HIDDEN})` }, hidden: true })
    const own = h('write', { file_path: 'users/alice/env.md', content: `KEY=${KEY}\nNEW=${B64}\n` }, () => `KEY=${KEY}\n`)
    expect(own.args).toEqual({ file_path: 'users/alice/env.md', content: `KEY=${KEY}\nNEW=${HIDDEN}\n` })
    // a file that cannot be read is no reason to keep the key
    expect((h('write', { file_path: 'a.md', content: KEY }, () => { throw new Error('gone') }).args as { content: string }).content).toBe(HIDDEN)
  })

  test('edit: old_string is left; new_string keeps only the forms old_string holds', () => {
    expect(h('edit', { file_path: 'a.md', old_string: 'TODO', new_string: `key ${KEY}` }).args).toEqual({ file_path: 'a.md', old_string: 'TODO', new_string: `key ${HIDDEN}` })
    expect(h('edit', { file_path: 'a.md', old_string: `KEY=${KEY} # old`, new_string: `KEY=${KEY} # new` })).toEqual({ args: { file_path: 'a.md', old_string: `KEY=${KEY} # old`, new_string: `KEY=${KEY} # new` }, hidden: false })
  })

  test('make_file: content and output; source and template (files it only reads) are left', () => {
    expect(h('make_file', { format: 'docx', content: `# Key\n\n${KEY}`, output: `users/alice/${KEY}.docx` }).args).toEqual({ format: 'docx', content: `# Key\n\n${HIDDEN}`, output: `users/alice/${HIDDEN}.docx` })
    expect(h('make_file', { format: 'pdf', source: `users/alice/${KEY}.md`, output: 'users/alice/a.pdf' })).toEqual({ args: { format: 'pdf', source: `users/alice/${KEY}.md`, output: 'users/alice/a.pdf' }, hidden: false })
  })

  test('edit_hwp: replacement, cell and row values and output; what it finds by (find, labels, file) is left', () => {
    const args = {
      file_path: `forms/${KEY}.hwpx`, output: `forms/filled-${KEY}.hwpx`,
      changes: [
        { find: '{{key}}', replace: KEY },
        { find: `old ${KEY}`, replace: `new ${KEY}` },
        { cell: { next_to: '성명' }, value: `이름 ${KEY}` },
        { add_rows: { table_with: '항목', rows: [[KEY, 'x'], ['y', B64]] } },
      ],
    }
    expect(h('edit_hwp', args).args).toEqual({
      file_path: `forms/${KEY}.hwpx`, output: `forms/filled-${HIDDEN}.hwpx`,
      changes: [
        { find: '{{key}}', replace: HIDDEN },
        { find: `old ${KEY}`, replace: `new ${KEY}` },
        { cell: { next_to: '성명' }, value: `이름 ${HIDDEN}` },
        { add_rows: { table_with: '항목', rows: [[HIDDEN, 'x'], ['y', HIDDEN]] } },
      ],
    })
  })

  test('artifact: content, title and key; an edit\'s old is left and its new keeps only what old holds', () => {
    expect(h('artifact', { action: 'create', key: `k-${KEY}`, type: 'markdown', title: `Key ${KEY}`, content: `The key is ${KEY}` }).args)
      .toEqual({ action: 'create', key: `k-${HIDDEN}`, type: 'markdown', title: `Key ${HIDDEN}`, content: `The key is ${HIDDEN}` })
    expect(h('artifact', { action: 'update', key: 'k', type: 'markdown', edits: [{ old: 'TBD', new: KEY }, { old: KEY, new: `${KEY}!` }] }).args)
      .toEqual({ action: 'update', key: 'k', type: 'markdown', edits: [{ old: 'TBD', new: HIDDEN }, { old: KEY, new: `${KEY}!` }] })
  })

  test('new names and the other saving tools; a tool that saves nothing, and a person with no stored key, are left alone', () => {
    expect(h('rename_file', { path: `a/${KEY}.md`, new_name: `${KEY}.md` }).args).toEqual({ path: `a/${KEY}.md`, new_name: `${HIDDEN}.md` })
    // rename_files (TC-4983): each new name and a pattern's replacement hidden; the paths and the pattern that find files kept
    expect(h('rename_files', { renames: [{ path: `a/${KEY}.md`, new_name: `${KEY}.md` }, { path: 'b.md', new_name: 'c.md' }] }).args)
      .toEqual({ renames: [{ path: `a/${KEY}.md`, new_name: `${HIDDEN}.md` }, { path: 'b.md', new_name: 'c.md' }] })
    expect(h('rename_files', { folder: `a/${KEY}`, find: KEY, replace: `new-${KEY}`, at: 'start' }).args).toEqual({ folder: `a/${KEY}`, find: KEY, replace: `new-${HIDDEN}`, at: 'start' })
    expect(h('move_files', { paths: [`a/${KEY}`], to_folder: `b/${KEY}` }).args).toEqual({ paths: [`a/${KEY}`], to_folder: `b/${HIDDEN}` })
    expect(h('copy_files', { paths: ['a'], to_folder: `b/${KEY}` }).args).toEqual({ paths: ['a'], to_folder: `b/${HIDDEN}` })
    expect(h('save_url', { url: 'https://x.example/a.png', save_as: `img/${KEY}.png` }).args).toEqual({ url: 'https://x.example/a.png', save_as: `img/${HIDDEN}.png` })
    expect(h('generate_video', { prompt: `A sign that reads ${KEY}` }).args).toEqual({ prompt: `A sign that reads ${HIDDEN}` })
    expect(h('promo_video', { title: KEY, sources: [`a/${KEY}.md`], hook: { label: KEY } }).args).toEqual({ title: HIDDEN, sources: [`a/${KEY}.md`], hook: { label: HIDDEN } })
    expect(h('intro_deck', { step: 'slide', slide: { title: KEY } }).args).toEqual({ step: 'slide', slide: { title: HIDDEN } })
    expect(h('read', { file_path: KEY })).toEqual({ args: { file_path: KEY }, hidden: false })
    expect(hideKeysInArgs('write', { file_path: 'a.md', content: KEY }, redactorOf([]))).toEqual({ args: { file_path: 'a.md', content: KEY }, hidden: false })
    expect(hideExcept(r, `${KEY} ${B64}`, `x ${B64}`)).toBe(`${HIDDEN} ${B64}`)
  })
})

describe('the live answer (redact.ts): an encoded form cut across pieces never shows', () => {
  const stream = (text: string, n: number) => {
    const s = new RedactingText(() => r)
    const out: string[] = []
    for (let i = 0; i < text.length; i += n) out.push(s.push(text.slice(i, i + n)))
    out.push(s.flush())
    return out
  }

  test('base64, URL-safe base64 and %-escaped forms, pieces of any size: hidden, and no piece holds part of one', () => {
    const text = `Your key in base64 is ${B64}, URL-safe ${B64URL}, escaped ${PCT}; 한글 ${B64} 끝. Basic ${Buffer.from(`user:${KEY}`).toString('base64')}.`
    for (const n of [1, 2, 3, 5, 7, 11, 13, 25, 200]) {
      const out = stream(text, n)
      const joined = out.join('')
      expect(leaks(joined), `pieces of ${n}`).toEqual([])
      expect(joined.split(HIDDEN).length - 1, `pieces of ${n}`).toBe(5)
      for (const piece of out) expect(leaks(piece), `pieces of ${n}`).toEqual([])
    }
  })

  test('only the end that could be part of a form waits: prose and Korean or Japanese text flow', () => {
    expect(formCarryLength('hello wor', [KEY])).toBe(3)
    expect(formCarryLength('끝났어요.', [KEY])).toBe(0)
    expect(formCarryLength('終わりました', [KEY])).toBe(0)
    expect(formCarryLength('x '.repeat(10) + 'a'.repeat(1000), [KEY])).toBe(KEY.length * 12) // at most the longest form
    expect(formCarryLength('anything', [])).toBe(0)
    const s = new RedactingText(() => r)
    expect(s.push('See: c2st')).toBe('See: ')
    expect(s.push('UksxMTE1LUZBS0U= done.')).toBe(`${HIDDEN} done.`)
  })
})

// ---------------- real turns ----------------
const GATE = path.join(import.meta.dir, '../../native/bin', `${process.platform}-${process.arch}`, 'mycel-gate')
const native = fs.existsSync(GATE)
let h: Harness
const published: { userId: string; ev: any }[] = []

describe.skipIf(!native)('a turn that saves the stored key in files (TC-3041)', () => {
  beforeAll(async () => {
    h = await startHarness({ name: 'c-integrations-secret-files', askUserTimeoutMs: 5000, stallTimeoutMs: 60_000 })
    hwpPluginOn(h.ctx)
    h.ctx.db.query("INSERT INTO settings (key, value) VALUES ('personalIntegrations', 'true') ON CONFLICT(key) DO UPDATE SET value='true'").run()
    const hub = h.rt().hub
    const publish = hub.publish.bind(hub)
    hub.publish = (userId, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); publish(userId, ev) }
    const c = await h.api('alice').call(API.createIntegration, { body: { kind: 'http', name: 'RK API', url: 'https://api.rk1115.invalid/v1', auth: 'bearer', secret: KEY, writePolicy: 'ask' } })
    expect(c.id).toBeTruthy()
  })
  afterAll(async () => { await h?.close() })

  const file = (rel: string) => path.join(h.team, ...rel.split('/'))
  /** a file's text: Office and Hangul files as the text of their parts, a PDF through pdftotext */
  function textOf(rel: string): string {
    const bytes = fs.readFileSync(file(rel))
    if (/\.(docx|hwpx|pptx|xlsx)$/.test(rel)) return [...hwpxParts(bytes).values()].join('\n')
    if (rel.endsWith('.pdf')) return new TextDecoder().decode(Bun.spawnSync([h.ctx.engineConfig.pdftotext || 'pdftotext', file(rel), '-']).stdout)
    return bytes.toString('utf8')
  }

  async function turn(content: string, answer = 'allow') {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const started = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const answered = new Set<string>()
    const approve = setInterval(() => {
      for (const p of published) {
        if (p.ev.type !== 'turn.request' || p.ev.data.turnId !== started.turnId || answered.has(p.ev.data.request.requestId)) continue
        answered.add(p.ev.data.request.requestId)
        void h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: p.ev.data.request.requestId, answer } }).catch(() => {})
      }
    }, 20)
    const id = started.assistantMessage.id
    const done = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === id), { timeoutMs: 60_000, what: 'message.done' }).finally(() => clearInterval(approve))
    return { chatId: chat.id, turnId: started.turnId, done: done!.ev.data.message }
  }

  test('make_file docx, pdf and hwpx, write, edit, edit_files, edit_hwp and artifact save [hidden key]; the text cache has no key', async () => {
    const dir = 'users/alice/rk'
    fs.mkdirSync(file(dir), { recursive: true })
    fs.writeFileSync(file(`${dir}/form.hwpx`), employmentForm())
    fs.writeFileSync(file(`${dir}/notes.md`), 'Status: TODO\n')
    fs.writeFileSync(file(`${dir}/notes2.md`), 'Status: TODO\n')
    const t = await turn([
      `Here is my key ${KEY}. Put it into documents.`,
      fake(
        { tool: 'make_file', args: { format: 'docx', content: `# Key\n\nThe key is ${KEY}\n\n| a | b |\n|---|---|\n| ${KEY} | x |`, output: `${dir}/key.docx` }, sayResult: true },
        { tool: 'make_file', args: { format: 'pdf', content: `# Key\n\nThe key is ${KEY}`, output: `${dir}/key.pdf` }, sayResult: true },
        { tool: 'make_file', args: { format: 'hwpx', content: `# 키\n\n키는 ${KEY} 입니다`, output: `${dir}/key.hwpx` }, sayResult: true },
        { tool: 'write', args: { file_path: `${dir}/key.md`, content: `The key is ${KEY}\nbase64 ${B64}\n` }, sayResult: true },
        { tool: 'read', args: { file_path: `${dir}/notes.md` } },
        { tool: 'edit', args: { file_path: `${dir}/notes.md`, old_string: 'TODO', new_string: `key ${KEY}` }, sayResult: true },
        { tool: 'read', args: { file_path: `${dir}/notes2.md` } },
        { tool: 'edit_files', args: { file_paths: [`${dir}/notes2.md`], old_string: 'TODO', new_string: `key ${KEY}` }, sayResult: true },
        { tool: 'read', args: { file_path: `${dir}/form.hwpx` } },
        { tool: 'edit_hwp', args: { file_path: `${dir}/form.hwpx`, changes: [{ find: '{{입사일}}', replace: KEY }, { cell: { next_to: '성명' }, value: KEY }], output: `${dir}/form-filled.hwpx` }, sayResult: true },
        { tool: 'artifact', args: { action: 'create', key: 'rk-key', type: 'markdown', title: `Key ${KEY}`, content: `The key is ${KEY}` }, sayResult: true },
        { tool: 'artifact', args: { action: 'update', key: 'rk-key', type: 'markdown', edits: [{ old: 'The key is', new: `Again ${KEY}, the key is` }] }, sayResult: true },
      ),
    ].join('\n'))
    // every call went through, and the AI was told what was saved
    const audit = h.ctx.db.query('SELECT tool, summary, ok FROM tool_events WHERE turn_id = ? ORDER BY rowid').all(t.turnId) as { tool: string; summary: string; ok: number }[]
    for (const a of audit) expect(a.ok, `${a.tool}: ${a.summary}`).toBe(1)
    expect(t.done.content.split(KEYS_HIDDEN_NOTE.slice(0, 40)).length - 1).toBe(9)
    for (const rel of ['key.docx', 'key.pdf', 'key.hwpx', 'key.md', 'notes.md', 'notes2.md', 'form-filled.hwpx']) {
      const text = textOf(`${dir}/${rel}`)
      expect(leaks(text), rel).toEqual([])
      expect(text, rel).toContain(HIDDEN)
    }
    expect(textOf(`${dir}/form.hwpx`)).toContain('{{입사일}}') // the form itself was not changed
    const arts = h.ctx.db.query("SELECT title, content FROM artifacts WHERE key = 'rk-key' ORDER BY version").all() as { title: string; content: string }[]
    expect(arts).toEqual([{ title: `Key ${HIDDEN}`, content: `The key is ${HIDDEN}` }, { title: `Key ${HIDDEN}`, content: `Again ${HIDDEN}, the key is ${HIDDEN}` }])
    // the search (and its text cache of Office, PDF and Hangul files) finds no key
    const ctx = { user: h.ctx.files.principal('alice'), turnId: null, files: new TurnFiles() }
    const found = await h.ctx.files.call('grep', { pattern: 'RK1115', path: dir, output_mode: 'files_with_matches' }, ctx)
    expect(found.text).not.toContain(`${dir}/`)
    const hidden = await h.ctx.files.call('grep', { pattern: 'hidden key', path: dir, output_mode: 'files_with_matches' }, ctx)
    for (const rel of ['key.docx', 'key.md', 'notes.md', 'form-filled.hwpx']) expect(hidden.text).toContain(`${dir}/${rel}`)
    expect(leaks(t.done.content + JSON.stringify(t.done.steps) + JSON.stringify(audit))).toEqual([])
  })

  test('the person\'s own file with the key in it: an AI edit or rewrite elsewhere in it leaves their key as it was', async () => {
    const rel = 'users/alice/rk/env.md'
    fs.writeFileSync(file(rel), `API_KEY=${KEY}\nMODE=test\n`)
    await turn(fake(
      { tool: 'read', args: { file_path: rel } },
      { tool: 'edit', args: { file_path: rel, old_string: 'MODE=test', new_string: 'MODE=live' } },
      { tool: 'read', args: { file_path: rel } },
      { tool: 'write', args: { file_path: rel, content: `API_KEY=${KEY}\nMODE=live\nCOPY=${B64}\n` } },
    ))
    expect(fs.readFileSync(file(rel), 'utf8')).toBe(`API_KEY=${KEY}\nMODE=live\nCOPY=${HIDDEN}\n`)
  })

  test('TC-2981: while the turn waits on the schedule card, the live answer and the messages API never show the base64 form', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const started = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake(
      { say: `Your key in base64 is ${B64} and URL-safe ${B64URL}; escaped ${PCT}.` },
    ) + '\n' + fakeQuiet(
      { tool: 'schedule_create', args: { title: 'Ping', prompt: 'Call the RK API and report', repeat: 'daily', time: '09:00' }, sayResult: true },
    ), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const id = started.assistantMessage.id
    const card = await waitFor(() => published.find((p) => p.ev.type === 'turn.request' && p.ev.data.turnId === started.turnId), { timeoutMs: 30_000, what: 'the schedule card' })
    const page = await h.api('alice').call(API.listMessages, { params: { id: chat.id }, query: {} })
    const live = page.items.find((m) => m.id === id)!
    expect(live.content).toContain('Your key in base64 is')
    const deltas = published.filter((p) => p.ev.type === 'message.delta' && p.ev.data.messageId === id).map((p) => p.ev.data.text as string)
    expect(deltas.length).toBeGreaterThan(1)
    for (const text of [live.content, ...deltas]) expect(leaks(text)).toEqual([])
    await h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: card!.ev.data.request.requestId, answer: 'deny' } }).catch(() => {})
    const done = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === id), { timeoutMs: 30_000, what: 'message.done' })
    expect(leaks(done!.ev.data.message.content)).toEqual([])
    expect(done!.ev.data.message.content).toContain(`base64 is ${HIDDEN} and URL-safe ${HIDDEN}; escaped ${HIDDEN}.`)
  })
})
