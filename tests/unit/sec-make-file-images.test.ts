// Security regression (round 1, ai-tools): make_file copied images from a narrower folder into a wider one without
// the "wider audience" card (design tab 7 "공용 폴더를 거친 유출"). A prompt-injected finance member's AI could call
// make_file with Markdown that only embeds ![x](groups/finance/secret-chart.png) and output shared/q.docx: the image
// was read with the person's own access and baked into a file everyone can read, while the pre-call check only knew
// the output and `source`, and the image never joined the chat's read scope. Now every embedded image (and the
// --reference-doc template) is a source of the new file: the server asks after the images are resolved and before
// anything is placed, and a call that has nobody to ask (no chat turn) is refused when it would widen.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { readScope } from '../../server/src/chat/read-scope'
import { TurnFiles } from '../../server/src/files/service'
import { makeHandler } from '../../server/src/mcp/protocol'
import { findConverters, missingConverter } from '../../server/src/tools/make-file'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
// a valid 1x1 grey PNG (typst decodes it), recognised byte for byte inside the output
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64')

let h: Harness
let bob: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'sec-make-file-images', askUserTimeoutMs: 5000, turnTimeoutMs: 60_000 })
  bob = await h.ws('bob', { windowId: 'win-sec-mf-bob' })
  await bob.next('hello')
  fs.writeFileSync(path.join(h.team, 'groups/finance/secret-chart.png'), PNG)
  fs.mkdirSync(path.join(h.team, 'users/bob'), { recursive: true })
  fs.writeFileSync(path.join(h.team, 'users/bob/private.png'), PNG)
  fs.writeFileSync(path.join(h.team, 'shared/public.png'), PNG)
})
afterAll(async () => { bob?.close(); await h?.close() })

/** One fake-engine turn; every server card is answered with `answer` (null = left unanswered until it times out). */
async function turn(content: string, answer: string | null) {
  const chat = await h.api('bob').call(API.createChat, { body: {} })
  const r = await h.api('bob').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const questions: string[] = []
  let stop = false
  const answering = (async () => {
    while (!stop) {
      const c = await bob.next('turn.request', (f) => f.data.turnId === r.turnId && !questions.includes(f.data.request.requestId), 1500).catch(() => null)
      if (!c) continue
      questions.push(c.data.request.requestId)
      if (answer) await h.api('bob').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer } })
    }
  })()
  const done = await bob.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 45_000)
  stop = true
  await answering
  const cards = bob.frames.filter((f) => f.type === 'turn.request' && f.data.turnId === r.turnId).map((f) => (f as Extract<typeof f, { type: 'turn.request' }>).data.request as { question: string; origin?: string })
  return { chatId: chat.id as string, turnId: r.turnId as string, content: done.data.message.content as string, cards }
}

const exists = (rel: string) => fs.existsSync(path.join(h.team, ...rel.split('/')))
/** the docx holds the PNG byte for byte */
function docxHasPng(rel: string): boolean {
  const out = fs.mkdtempSync(path.join(h.ctx.config.dataDir, 'unzip-'))
  Bun.spawnSync(['unzip', '-o', '-q', path.join(h.team, rel), '-d', out])
  const media = path.join(out, 'word', 'media')
  return (fs.existsSync(media) ? fs.readdirSync(media) : []).some((f) => fs.readFileSync(path.join(media, f)).equals(PNG))
}

describe('make_file: embedded images are sources of the new file', () => {
  test('only a finance image, output in shared/: a server card; declined = nothing written', async () => {
    const r = await turn(fake({ tool: 'make_file', args: { format: 'docx', content: '# Q update\n\n![chart](groups/finance/secret-chart.png)\n', output: 'shared/q-update.docx' }, sayResult: true }), 'skip')
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.origin).toBe('server')
    expect(r.cards[0]!.question).toContain('groups/finance/')
    expect(r.cards[0]!.question).toContain('shared/q-update.docx')
    expect(r.content).toContain('did not allow saving')
    expect(exists('shared/q-update.docx')).toBe(false)
    // the image joined the chat's read scope, so later saves in this chat take it into account
    expect(readScope(h.ctx.db, r.chatId)).toEqual([{ type: 'folder', id: 'f_groups_finance' }])
    const a = h.ctx.db.query("SELECT ok FROM tool_events WHERE turn_id = ? AND tool = 'make_file'").get(r.turnId) as { ok: number }
    expect(a.ok).toBe(0)
  })

  test('the PDF path is checked the same way', async () => {
    const r = await turn(fake({ tool: 'make_file', args: { format: 'pdf', content: '# Q\n\n![c](groups/finance/secret-chart.png)\n', output: 'shared/q-update.pdf' }, sayResult: true }), 'skip')
    expect(exists('shared/q-update.pdf')).toBe(false)
    if (!findConverters(null).typst) {
      // no typst on this machine (a Mac without `brew install typst`, a Linux test box without the release bundle): no
      // PDF can be made. The person is asked only about a file the server can make, so the call ends before the card,
      // with nothing written and advice that fits this platform. The card itself needs typst (macOS with Homebrew's
      // typst; the Linux bundle ships it: MYCEL_TYPST_BIN).
      expect(r.content).toContain(missingConverter('typst'))
      expect(r.cards.length).toBe(0)
      if (process.platform !== 'darwin') expect(r.content).not.toContain('brew')
      return
    }
    expect(r.content).toContain('did not allow saving')
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.question).toContain('groups/finance/')
  })

  test('a missing converter: Homebrew advice on a Mac only; a Linux server gets it with its bundle', () => {
    expect(missingConverter('typst', 'darwin')).toContain('brew install typst')
    for (const t of ['typst', 'pandoc'] as const) {
      expect(missingConverter(t, 'linux')).toContain(`${t} is not installed on the server`)
      expect(missingConverter(t, 'linux')).toContain('Linux server bundle')
      expect(missingConverter(t, 'linux')).not.toContain('brew')
    }
  })

  test('an image relative to the source file counts too', async () => {
    fs.writeFileSync(path.join(h.team, 'shared/outline.md'), '# Outline\n\n![c](../groups/finance/secret-chart.png)\n')
    const r = await turn(fake({ tool: 'make_file', args: { format: 'docx', source: 'shared/outline.md', output: 'shared/outline.docx' }, sayResult: true }), 'skip')
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.question).toContain('groups/finance/')
    expect(exists('shared/outline.docx')).toBe(false)
  })

  test('allowed by the person: saved with the image, one card', async () => {
    const r = await turn(fake({ tool: 'make_file', args: { format: 'docx', content: '# Q\n\n![chart](groups/finance/secret-chart.png)\n', output: 'shared/q-allowed.docx' }, sayResult: true }), 'save')
    expect(r.cards.length).toBe(1)
    expect(exists('shared/q-allowed.docx')).toBe(true)
    expect(docxHasPng('shared/q-allowed.docx')).toBe(true)
  })

  test('no card when nothing is narrower: a shared image into shared/, a finance image into finance', async () => {
    const a = await turn(fake({ tool: 'make_file', args: { format: 'docx', content: '# P\n\n![p](shared/public.png)\n', output: 'shared/p.docx' }, sayResult: true }), null)
    const b = await turn(fake({ tool: 'make_file', args: { format: 'docx', content: '# F\n\n![c](groups/finance/secret-chart.png)\n', output: 'groups/finance/f.docx' }, sayResult: true }), null)
    expect(a.cards.length + b.cards.length).toBe(0)
    expect(exists('shared/p.docx')).toBe(true)
    expect(exists('groups/finance/f.docx')).toBe(true)
  })

  test('a folder allowed for one source is asked again for a new narrower source (the personal image)', async () => {
    const r = await turn(fake(
      { tool: 'read', args: { file_path: 'groups/finance/budget.md' } },
      { tool: 'write', args: { file_path: 'shared/sum.md', content: 'summary' }, sayResult: true },
      { tool: 'make_file', args: { format: 'docx', content: '# Me\n\n![me](users/bob/private.png)\n', output: 'shared/me.docx' }, sayResult: true },
    ), 'save')
    expect(r.cards.length).toBe(2)
    expect(r.cards[0]!.question).toContain('groups/finance/')
    expect(r.cards[0]!.question).not.toContain('내 개인 폴더')
    expect(r.cards[1]!.question).toContain('내 개인 폴더') // bob's locale is Korean: "my personal folder"
    expect(exists('shared/me.docx')).toBe(true)
  })
})

describe('make_file outside a chat turn (nobody to ask): refused when it would widen', () => {
  let rpc = 0
  async function direct(turnId: string | null, args: unknown) {
    const handle = makeHandler(h.ctx.files, h.ctx.db, { user: h.ctx.files.principal('bob'), turnId, files: new TurnFiles() })
    const r = await handle({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name: 'make_file', arguments: args } })
    return { text: r.result.content[0].text as string, isError: !!r.result.isError }
  }

  test('a finance image into shared/ is refused and nothing is written, with or without a turn id', async () => {
    for (const [i, turnId] of [null, 'turn-without-tools'].entries()) {
      const out = `shared/direct-${i}.docx`
      const r = await direct(turnId, { format: 'docx', content: '# Q\n\n![chart](groups/finance/secret-chart.png)\n', output: out })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('more people')
      expect(exists(out)).toBe(false)
    }
  })

  test('a narrower --reference-doc template under skills/ is a source too', async () => {
    // skills/finance-tpl: finance only (narrower than shared/)
    const rel = 'skills/finance-tpl/brand.docx'
    fs.mkdirSync(path.join(h.team, 'skills/finance-tpl'), { recursive: true })
    fs.copyFileSync(path.join(h.team, 'groups/finance/board-memo.docx'), path.join(h.team, rel))
    h.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_skills_finance_tpl', 'skills/finance-tpl')").run()
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, 'f_skills_finance_tpl', 'group', 'finance', 'read')").run(crypto.randomUUID())
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, 'f_skills_finance_tpl', 'everyone', NULL, 'none')").run(crypto.randomUUID())
    const bad = await direct(null, { format: 'docx', content: '# Q\n', output: 'shared/tpl.docx', template: rel })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('more people')
    expect(exists('shared/tpl.docx')).toBe(false)
    const ok = await direct(null, { format: 'docx', content: '# Q\n', output: 'groups/finance/tpl.docx', template: rel })
    expect(ok.text).toContain('Saved')
  })

  test('nothing narrower: still works (shared image into shared/)', async () => {
    const r = await direct(null, { format: 'docx', content: '# P\n\n![p](shared/public.png)\n', output: 'shared/direct-ok.docx' })
    expect(r.isError).toBe(false)
    expect(exists('shared/direct-ok.docx')).toBe(true)
  })
})
