// Image blocks reach both engines through their real launch, the gate, the MCP bridge and the tools socket
// (deterministic fake Claude Code / Codex processes, the real image converters), with the 1A flag unset: the default
// path. Codex gets no structuredContent next to an image (openai/codex#10334 drops the image then).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness } from '../lib/b-harness'
import { makePng } from '../lib/images'
import { CCITT_SCAN, makePagesPdf } from '../lib/pdf'
import { nativeBinDir, ocrBin, which } from '../../server/src/config'
import { isolation } from '../../server/src/tools/isolate'
import { visionTools } from '../../server/src/files/vision'
import { confidentialChat } from '../../server/src/safe-ops/confidential'

setDefaultTimeout(60_000)
const TOOLS = visionTools({ nativeBin: nativeBinDir(), pdftotext: which('pdftotext'), ocr: ocrBin(), which })
const ready = !!TOOLS.normalizer && isolation() !== 'none' && !!(TOOLS.pdfkit || TOOLS.pdftoppm)

let h: Harness
beforeAll(async () => {
  delete process.env.MYCEL_SAFE_OPS_1A
  h = await startHarness({ name: 'vision-engines', turnTimeoutMs: 40_000 })
  fs.writeFileSync(path.join(h.team, 'users/alice/receipt.png'), makePng(320, 200))
  fs.writeFileSync(path.join(h.team, 'users/alice/scan.pdf'), makePagesPdf([{ lines: ['A text page with plenty of words on it.'] }, { image: CCITT_SCAN }]))
})
afterAll(async () => { await h?.close() })

for (const engine of ['claude-code', 'codex'] as const)
  test.skipIf(!ready)(`${engine}: images and scanned PDF pages arrive as MCP image blocks (real converters, no confidential lock)`, async () => {
    const socket = await h.ws('alice', { windowId: `vision-${engine}` })
    try {
      await socket.next('hello')
      const chat = await h.api('alice').call(API.createChat, { body: { engine } })
      const image = await ask(h, socket, 'alice', chat.id, '@fake ' + JSON.stringify({ tool: 'read', args: { file_path: 'users/alice/receipt.png' }, inspectImages: true, sayResult: true }), { ms: 40_000 })
      expect(image.done.status).toBe('done')
      const got = JSON.parse(image.done.content)
      expect(got.structured).toBe(false)
      expect(got.images).toHaveLength(1)
      expect(got.images[0].mimeType).toBe('image/jpeg')
      expect(got.images[0].magic.startsWith('ffd8ff')).toBe(true)
      const pdf = await ask(h, socket, 'alice', chat.id, '@fake ' + JSON.stringify({ tool: 'read', args: { file_path: 'users/alice/scan.pdf' }, inspectImages: true, sayResult: true }), { ms: 40_000 })
      const page = JSON.parse(pdf.done.content)
      expect(page.structured).toBe(false)
      expect(page.text).toContain('A text page with plenty of words')
      expect(page.text).toContain('--- Page 2 (no text layer: shown as an image) ---')
      expect(page.images.map((i: any) => i.mimeType)).toEqual(['image/jpeg'])
      // the default path leaves the conversation open: no confidential mark, web tools stay available
      expect(confidentialChat(h.ctx.db, chat.id)).toBe(false)
      expect(h.ctx.db.query("SELECT ok FROM tool_events WHERE tool='read' AND user_id='alice' ORDER BY rowid DESC LIMIT 2").all()).toEqual([{ ok: 1 }, { ok: 1 }])
    } finally { socket.close() }
  })
