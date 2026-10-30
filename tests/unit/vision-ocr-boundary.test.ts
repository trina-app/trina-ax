// Where OCR may run (docs/DECISIONS.md "AI sees images and PDF pages"):
// - Linux: nowhere. Not in read, chat attachments (read), drive_read, the grep / Office text cache or the semantic
//   index; tesseract is no longer installed, and an installed one is never used. Scanned PDFs and images are simply not
//   text-searchable there (like Claude Code's own Grep).
// - macOS: Apple Vision (mycel-ocr in OCR mode) only for the search index of scanned PDFs; photos stay out of the
//   index, and an AI read sees images and scanned pages as images (mycel-ocr runs there only to draw pages / read the
//   text layer, never to recognize text) unless the team turned image viewing off.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp } from '../lib/c-app'
import { makePng } from '../lib/images'
import { nativeBinDir, ocrBin, which } from '../../server/src/config'
import { extractText } from '../../server/src/files/extract'
import { visionTools } from '../../server/src/files/vision'
import { isolation } from '../../server/src/tools/isolate'

setDefaultTimeout(120_000)
const ROOT = path.resolve(import.meta.dir, '..', '..')
const FIX = path.join(ROOT, 'tests', 'fixtures', 'ocr')
const TOOLS = visionTools({ nativeBin: nativeBinDir(), pdftotext: which('pdftotext'), ocr: ocrBin(), which })
const canRead = !!TOOLS.normalizer && isolation() !== 'none' && !!(TOOLS.pdfkit || TOOLS.pdftoppm) && !!(TOOLS.pdftotext || TOOLS.pdfkit)

let A: CApp
beforeAll(async () => {
  A = await makeCApp('vision-ocr-boundary')
  A.ctx.db.query("UPDATE users SET locale = 'en'").run()
  for (const f of ['scan.pdf', 'mixed.pdf', 'page.png']) fs.copyFileSync(path.join(FIX, f), path.join(A.team, 'users/alice', f))
  fs.writeFileSync(path.join(A.team, 'users/alice/photo.png'), makePng(64, 64))
})
afterAll(async () => { await A.close() })

/** Every process the server starts while `f` runs (runIsolated, the office worker ...), as argv lists. */
async function spawned(f: () => Promise<unknown>): Promise<string[][]> {
  const calls: string[][] = []
  const real = Bun.spawn
  const spy = spyOn(Bun, 'spawn').mockImplementation(((cmd: any, opts: any) => {
    calls.push((Array.isArray(cmd) ? cmd : cmd?.cmd ?? []).map(String))
    return real(cmd, opts)
  }) as typeof Bun.spawn)
  try { await f() } finally { spy.mockRestore() }
  return calls
}
const base = (a: string) => a.split('/').pop() ?? a
const tesseract = (calls: string[][]) => calls.filter((c) => c.some((a) => base(a) === 'tesseract'))
/** mycel-ocr in recognition mode (the other modes draw pages, read text layers or decode HEIC) */
const recognition = (calls: string[][]) => calls.filter((c) => c.some((a) => base(a) === 'mycel-ocr') && !c.some((a) => ['--layer', '--page', '--jpeg'].includes(a)))

describe('the Linux installer and kit have no OCR', () => {
  test('deps.txt and install-linux.sh install no tesseract; the kit and native build have no Linux mycel-ocr', () => {
    expect(fs.readFileSync(path.join(ROOT, 'scripts/linux/deps.txt'), 'utf8')).not.toContain('tesseract')
    expect(fs.readFileSync(path.join(ROOT, 'scripts/install-linux.sh'), 'utf8')).not.toContain('tesseract')
    expect(fs.readFileSync(path.join(ROOT, 'native/build.sh'), 'utf8')).toMatch(/LINUX_CMDS="mycel-enroll mycel-sandbox mycel-ctl"/)
    expect(fs.existsSync(path.join(ROOT, 'native/cmd/mycel-ocr'))).toBe(false)
    expect(fs.readFileSync(path.join(ROOT, 'scripts/build-bundle.ts'), 'utf8')).toContain("LINUX_NATIVE = ['mycel-gate', 'mycel-bridge', 'mycel-safeops']")
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'versions.json'), 'utf8')).tesseract).toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'linux')('Linux: no OCR anywhere', () => {
  test('no OCR tool, even with tesseract on the machine', () => {
    expect(ocrBin()).toBeNull()
    expect(A.ctx.files.cfg.ocr).toBeNull()
    expect(A.ctx.engineConfig.ocr).toBeNull()
  })
  test.skipIf(!canRead)('read, attachments, drive_read, the grep cache and the semantic index never start tesseract or mycel-ocr', async () => {
    const turn = A.turn('alice', A.chat('alice'))
    const calls = await spawned(async () => {
      const ctx = A.toolCtx('alice', turn)
      for (const args of [{ file_path: 'users/alice/scan.pdf' }, { file_path: 'users/alice/mixed.pdf', offset: 1 }, { file_path: 'users/alice/page.png' }])
        expect((await A.ctx.files.call('read', args, ctx)).isError).toBeFalsy()
      // the grep / semantic text cache of a scanned PDF (uploads and changes queue the same update)
      await A.ctx.files.office.update('users/alice/scan.pdf')
      await A.ctx.files.office.update('users/alice/mixed.pdf')
      // drive_read converts with the same tools (tools/drive.ts)
      const e = A.ctx.engineConfig
      await extractText('document.pdf', fs.readFileSync(path.join(FIX, 'scan.pdf')), { pandoc: e.pandoc, pdftotext: e.pdftotext, ocr: e.ocr, quarantine: A.ctx.files.quarantine })
    })
    expect(tesseract(calls)).toEqual([])
    expect(calls.filter((c) => c.some((a) => base(a) === 'mycel-ocr'))).toEqual([])
    // the cached text of a scanned page is its (empty) text layer: not searchable
    expect(fs.readFileSync(A.ctx.files.office.cachePath('users/alice/scan.pdf'), 'utf8').replace(/\s/g, '')).toBe('')
    expect(fs.readFileSync(A.ctx.files.office.cachePath('users/alice/mixed.pdf'), 'utf8')).toContain('진료 예약 안내')
  })
})

describe.skipIf(process.platform !== 'darwin' || !ocrBin() || !canRead)('macOS: Apple Vision only for the search index of scanned PDFs', () => {
  test('the grep / semantic cache of a scanned PDF holds Apple Vision text; photos are not indexed', async () => {
    const calls = await spawned(() => A.ctx.files.office.update('users/alice/scan.pdf'))
    expect(recognition(calls)).toHaveLength(1)
    expect(fs.readFileSync(A.ctx.files.office.cachePath('users/alice/scan.pdf'), 'utf8').replace(/\s/g, '')).toContain('진료예약안내')
    // the team-files index admission skips images (isOffice): an upload of a photo queues nothing
    const { isOffice } = await import('../../server/src/files/extract')
    expect(isOffice('photo.png')).toBe(false)
  })
  test('an AI read of a scanned PDF or a photo shows the image and never recognizes text', async () => {
    const turn = A.turn('alice', A.chat('alice'))
    let out: any[] = []
    const calls = await spawned(async () => {
      const ctx = A.toolCtx('alice', turn)
      out = [await A.ctx.files.call('read', { file_path: 'users/alice/scan.pdf' }, ctx), await A.ctx.files.call('read', { file_path: 'users/alice/page.png' }, ctx)]
    })
    expect(recognition(calls)).toEqual([])
    for (const r of out) {
      expect(r.isError).toBeFalsy()
      expect(r.content.filter((c: any) => c.type === 'image')).toHaveLength(1)
      expect(r.text.replace(/\s/g, '')).not.toContain('진료예약안내')
    }
  })
  test('with image viewing off, a Mac read falls back to Apple Vision text', async () => {
    A.ctx.db.query("INSERT INTO settings (key, value) VALUES ('aiVision', 'false') ON CONFLICT(key) DO UPDATE SET value = 'false'").run()
    try {
      const ctx = A.toolCtx('alice', A.turn('alice', A.chat('alice')))
      const img = await A.ctx.files.call('read', { file_path: 'users/alice/page.png' }, ctx)
      expect(img.content).toBeUndefined()
      expect(img.text.replace(/\s/g, '')).toContain('진료예약안내')
      const pdf = await A.ctx.files.call('read', { file_path: 'users/alice/mixed.pdf' }, ctx)
      expect((pdf.content ?? []).filter((c: any) => c.type === 'image')).toEqual([])
      expect(pdf.text).toContain('Page 2 (scanned; recognized text):')
      expect(pdf.text.split('Page 2 (scanned')[1]!.replace(/\s/g, '')).toContain('진료예약안내')
    } finally { A.ctx.db.query("DELETE FROM settings WHERE key = 'aiVision'").run() }
  })
})
