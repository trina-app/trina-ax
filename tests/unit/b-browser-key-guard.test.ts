// The key guard of the desktop app's browser, end to end (docs/decisions/20261124-browser-key-guard.md): a fake desktop
// window shows a fake API key page with canary keys of many shapes; the AI reads it every way it can. No canary (nor
// the middle of one) reaches the model input (the fake engine says each tool result back as it got it), tool_events,
// the audit log, the server log, any table of the database or any file under the data and team folders. Screenshots
// and scripts on that page are refused before the window runs them; the AI is told to hand over, in the chat's
// language. Ordinary pages come through unchanged.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { createLogger } from '../../server/src/log'
import { CANARIES, keyPageOutline, middleOf } from '../lib/page-key-canaries'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const DESK = 'win-desk-keys1'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex').toString('base64')
const VALUES = Object.values(CANARIES).map((c) => c.value)

const NORMAL_PAGE = [
  'https://shop.example.test/orders — Orders',
  '- heading "주문 내역" level=1 [ref_1]',
  '- paragraph "Order 123e4567-e89b-12d3-a456-426614174000 shipped on 2026-11-24. Input tokens: 12,345." [ref_2]',
  '- link "commit 3f2a9c1" [ref_3] href="/org/repo/commit/3f2a9c1e5b4d7a8c9e0f1a2b3c4d5e6f7a8b9c0d"',
  '- button "Create new secret key" [ref_4]',
].join('\n')

let h: Harness
let desk: TestSocket
const lines: string[] = []
/** what the fake window's page is now */
let page: 'key' | 'normal' = 'normal'
beforeAll(async () => {
  h = await startHarness({ name: 'b-browser-key-guard', askUserTimeoutMs: 5000, log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) })
  desk = await h.ws('alice', { windowId: DESK, client: 'desktop' })
  await desk.next('hello')
})
afterAll(async () => { desk?.close(); await h.close() })

/** the plain text of the key page (get_page_text), a JSON body (read_network_requests), console lines */
const keyText = () => Object.entries(CANARIES).map(([name, c]) => `${name}\n${c.label ?? 'API key'}\n${c.value}`).join('\n\n')
const keyJson = () => JSON.stringify({ data: Object.values(CANARIES).map((c, i) => ({ id: `key_${i}`, secret: c.value })) })

/** the desktop app: answers each browser.call that comes from now on from the page it shows; a batch that clicks
 * "Create key" opens the key page */
function serve(sock: TestSocket) {
  const from = sock.frames.length
  const done = new Set<string>()
  const seen: { tool: string; args: Record<string, unknown> }[] = []
  const timer = setInterval(() => {
    for (const f of sock.frames.slice(from)) {
      if (f.type !== 'browser.call' || done.has(f.data.call.callId)) continue
      const c = f.data.call
      done.add(c.callId)
      seen.push({ tool: c.tool, args: c.args })
      sock.send({ type: 'browser.ack', callId: c.callId })
      const text = (t: string, image = false) => ({ callId: c.callId, ok: true, content: [{ type: 'text', text: t }, ...(image ? [{ type: 'image', mime: 'image/png', data: PNG }] : [])] })
      let r
      if (c.tool === 'read_page') r = text(page === 'key' ? keyPageOutline() : NORMAL_PAGE)
      else if (c.tool === 'get_page_text') r = text(page === 'key' ? `https://console.example.test/settings/keys — API keys\n\n${keyText()}` : 'Orders\nOrder 123e4567-e89b-12d3-a456-426614174000 shipped.')
      else if (c.tool === 'find') r = text(page === 'key' ? keyPageOutline().split('\n').filter((l) => l.includes('textbox')).map((l) => `${l.trim()} at (640, 300)`).join('\n') : '- button "Create new secret key" [ref_4] at (640, 300)')
      else if (c.tool === 'read_network_requests') r = text(page === 'key' ? keyJson() : '[]')
      else if (c.tool === 'read_console_messages') r = text(page === 'key' ? Object.values(CANARIES).map((x) => `[log] created key ${x.value}`).join('\n') : 'No console messages.')
      else if (c.tool === 'javascript_tool') r = text(page === 'key' ? JSON.stringify(VALUES) : '"ok"')
      else if (c.tool === 'computer') r = text('Screenshot · viewport 1280x800', c.args.action === 'screenshot' || c.args.action === 'zoom')
      else if (c.tool === 'browser_batch') { page = 'key'; r = text('[1/2] computer:\nleft click on "Create new secret key"\n[2/2] computer:\nScreenshot · viewport 1280x800', true) }
      else r = text(`${c.tool} done`)
      sock.send({ type: 'browser.result', result: r })
    }
  }, 20)
  return { seen, stop: () => clearInterval(timer) }
}

const ask = async (...ds: unknown[]) => {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  const r = await h.api('alice', { window: DESK, client: 'desktop' }).call(API.sendMessage, { params: { id: chat.id }, body: { content: fake(...ds), clientMessageId: cm(), attachmentIds: [] } })
  const d = await desk.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 40_000)
  return { turnId: r.turnId, chatId: chat.id, content: d.data.message.content as string }
}

/** every value of every row of every table, as text */
function databaseText(): string {
  const out: string[] = []
  const tables = h.ctx.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  for (const { name } of tables) {
    for (const row of h.ctx.db.query(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
      for (const v of Object.values(row)) out.push(v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v))
    }
  }
  return out.join('\n')
}

/** the files under a folder that hold one of the values (as text or in base64), and the folders that could not be
 * read (a folder the server keeps closed) */
function filesHolding(root: string, values: readonly string[]): { hits: string[]; closed: string[] } {
  const hits: string[] = []
  const closed: string[] = []
  const forms = values.flatMap((v) => [v, middleOf(v), Buffer.from(v).toString('base64').slice(4, 24)])
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { closed.push(path.relative(root, dir)); return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.isFile()) continue
      let text: string
      try { if (fs.statSync(p).size > 50_000_000) continue; text = fs.readFileSync(p).toString('latin1') } catch { closed.push(path.relative(root, p)); continue }
      if (forms.some((x) => text.includes(x))) hits.push(path.relative(root, p))
    }
  }
  walk(root)
  return { hits, closed }
}

const leaks = (text: string) => VALUES.filter((v) => text.includes(v) || text.includes(middleOf(v)))

describe('browser key guard (canary)', () => {
  test('a key page read every way: no canary reaches the model, the records, the log or the disk; screenshots and scripts are refused', async () => {
    page = 'key'
    const w = serve(desk)
    try {
      const steps = [
        { tool: 'read_page', args: {}, sayResult: true },
        { tool: 'get_page_text', args: {}, sayResult: true },
        { tool: 'find', args: { query: 'API key' }, sayResult: true },
        { tool: 'read_network_requests', args: {}, sayResult: true },
        { tool: 'read_console_messages', args: {}, sayResult: true },
        { tool: 'computer', args: { action: 'screenshot', save_to_disk: true }, inspectImages: true, sayResult: true },
        { tool: 'computer', args: { action: 'zoom', region: [0, 0, 400, 200] }, inspectImages: true, sayResult: true },
        { tool: 'javascript_tool', args: { action: 'javascript_exec', text: 'document.querySelector("input").value' }, sayResult: true },
        { tool: 'browser_batch', args: { actions: [{ name: 'read_page', input: {} }, { name: 'computer', input: { action: 'screenshot' } }] }, inspectImages: true, sayResult: true },
      ]
      const said = await ask(...steps.flatMap((s) => [s, { say: '\n=====\n' }]))
      const parts = said.content.split('\n=====\n')
      // what the model got, step by step (the fake engine says each tool result back exactly as it got it)
      expect(leaks(said.content)).toEqual([])
      expect(parts[0]).toContain('[hidden key]')
      expect(parts[0]).toContain('This page shows a key, token or other secret.')
      expect(parts[0]).toContain('"Please take it from here. Copy the key and paste it into the connection card."')
      for (const i of [1, 2, 3, 4]) expect(parts[i]).toContain('[hidden key]')
      // the screenshot, the zoom, the script and the batch: refused before the window ran them, no picture for the model
      for (const i of [5, 6, 8]) {
        expect(JSON.parse(parts[i]!)).toMatchObject({ images: [] })
        expect(JSON.parse(parts[i]!).text).toContain('Not run: the page shows a key')
      }
      expect(parts[7]).toContain('Not run: the page shows a key')
      expect(w.seen.map((s) => s.tool).filter((t) => t === 'computer' || t === 'javascript_tool' || t === 'browser_batch')).toEqual([])
      // nothing shared to the chat: no screenshot saved
      expect(fs.existsSync(path.join(h.team, 'users/alice/.attachments', said.chatId))).toBe(false)

      // the records: tool_events (the audit line), audit_log, every table, the server log, every file
      const events = h.ctx.db.query('SELECT tool, summary FROM tool_events WHERE turn_id = ? ORDER BY id').all(said.turnId) as { tool: string; summary: string }[]
      expect(leaks(JSON.stringify(events))).toEqual([])
      expect(events.find((e) => e.tool === 'read_page')!.summary).toMatch(/^read_page -> ok \(key screen: \d+ key-like values hidden, pictures left out, handed over\)$/)
      expect(events.find((e) => e.tool === 'computer')!.summary).toBe('computer -> refused: the page shows a key (handed over)')
      expect(leaks(JSON.stringify(h.ctx.db.query('SELECT * FROM audit_log').all()))).toEqual([])
      expect(leaks(databaseText())).toEqual([])
      expect(leaks(lines.join('\n'))).toEqual([])
      for (const root of [h.dataDir, h.team]) {
        const scan = filesHolding(root, VALUES)
        expect(scan.hits).toEqual([])
        // the person's own folders are read (a closed folder is one the server keeps from everyone)
        expect(scan.closed.filter((p) => p === '' || p.startsWith('users/alice'))).toEqual([])
      }
    } finally { w.stop(); page = 'normal' }
  })

  test('a batch that opens the key screen and photographs it: the picture never reaches the model', async () => {
    page = 'normal'
    const w = serve(desk)
    try {
      const said = await ask({ tool: 'browser_batch', args: { actions: [{ name: 'computer', input: { action: 'left_click', ref: 'ref_4' } }, { name: 'computer', input: { action: 'screenshot' } }] }, inspectImages: true, sayResult: true })
      const got = JSON.parse(said.content)
      expect(got.images).toEqual([])
      expect(got.text).toContain('The page showed a key, token or other secret after this call, so its screenshots and output were left out.')
      expect(w.seen.map((s) => s.tool)).toEqual(['read_page', 'browser_batch', 'read_page'])
      expect(leaks(said.content + JSON.stringify(h.ctx.db.query("SELECT summary FROM tool_events WHERE tool = 'browser_batch'").all()))).toEqual([])
    } finally { w.stop(); page = 'normal' }
  })

  test('in a Korean chat the AI is given the Korean hand-over sentence', async () => {
    page = 'key'
    h.ctx.db.query("UPDATE users SET locale = 'ko' WHERE id = 'alice'").run()
    const w = serve(desk)
    try {
      const said = await ask({ tool: 'read_page', args: {}, sayResult: true })
      expect(said.content).toContain('"여기서부터는 직접 해 주세요. 키를 복사해서 연결 카드에 붙여 넣으면 돼요."')
      expect(leaks(said.content)).toEqual([])
    } finally {
      w.stop()
      page = 'normal'
      h.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run()
    }
  })

  test('an ordinary page comes through unchanged, and its screenshot is taken (checked first)', async () => {
    page = 'normal'
    const w = serve(desk)
    try {
      const said = await ask({ tool: 'read_page', args: {}, sayResult: true }, { say: '\n=====\n' }, { tool: 'computer', args: { action: 'screenshot' }, inspectImages: true, sayResult: true })
      const [read, shot] = said.content.split('\n=====\n')
      expect(read).toBe(NORMAL_PAGE)
      expect(JSON.parse(shot!).images).toEqual([{ mimeType: 'image/png', magic: '89504e470d0a1a0a' }])
      expect(w.seen.map((s) => s.tool)).toEqual(['read_page', 'read_page', 'computer'])
      const events = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool IN ('read_page', 'computer') ORDER BY id").all(said.turnId) as { summary: string }[]
      expect(events.map((e) => e.summary)).toEqual(['read_page -> ok', 'computer -> ok'])
    } finally { w.stop() }
  })

  test('the desktop rules tell the AI to stop at the key screen and leave the key to the person', async () => {
    const said = await ask({ echo: 'system' })
    expect(said.content).toContain('- Connecting a service: you may open its sign-up or API key page and guide the steps, but stop at the screen that shows the key')
    expect(said.content).toContain('never read, copy, type or say a key')
  })
})
