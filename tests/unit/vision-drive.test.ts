// drive_read without OCR (docs/DECISIONS.md "AI sees images and PDF pages"): Drive photos reach the model as image
// blocks through the same switch, engine check, budget and converter as a team-folder read; Drive PDFs give their
// text layer only, with a note when pages have none.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { makeCApp, type CApp } from '../lib/c-app'
import { makePng } from '../lib/images'
import { CCITT_SCAN, makePagesPdf } from '../lib/pdf'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { registerDriveTools } from '../../server/src/tools/drive'
import { toolRegistry } from '../../server/src/tools/registry'
import { FakeGoogleDrive, DRIVE_CONFIG } from '../lib/fake-google-drive'

let a: CApp, fake: FakeGoogleDrive, i = 0
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
beforeEach(async () => {
  a = await makeCApp('vision-drive-' + ++i); fake = new FakeGoogleDrive()
  a.ctx.db.query("UPDATE users SET locale = 'en'").run()
  const svc = googleDriveOf(a.ctx, { config: DRIVE_CONFIG, fetch: fake.fetch })
  a.ctx.db.query("INSERT INTO sessions(id,user_id,token_hash,client,created_at,last_seen_at,expires_at) VALUES('drive-session','alice','drive-session-hash','web',?,?,?)").run(new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString())
  const f = svc.authorize('alice', 'drive-session'); await svc.callback(fake.authorize(f.authorizationUrl), { userId: 'alice', sessionId: 'drive-session' }); svc.complete('alice', 'drive-session', f.flowId)
  registerDriveTools(a.ctx, toolRegistry(a.ctx.files))
  fake.blobs.set('photo', { owner: 'alice', name: 'receipt', mime: 'image/png', bytes: makePng(32, 24) })
  fake.blobs.set('scan', { owner: 'alice', name: 'scan.pdf', mime: 'application/pdf', bytes: makePagesPdf([{ lines: ['A page with a real text layer and enough words.'] }, { image: CCITT_SCAN }]) })
})
afterEach(async () => { await a?.close() })
const read = (fileId: string, engine = 'claude-code') => {
  const turn = a.turn('alice', a.chat('alice'))
  a.ctx.db.query('UPDATE turns SET engine = ? WHERE id = ?').run(engine, turn)
  const ctx = a.toolCtx('alice', turn)
  return { ctx, result: toolRegistry(a.ctx.files).call('drive_read', { fileId }, ctx) }
}

test('a Drive photo is an image block next to the JSON text (never inside it), counted in the turn budget', async () => {
  const codec = spyOn(a.ctx.files, 'modelImage').mockResolvedValue(jpeg)
  try {
    const c = read('photo'), r = await c.result
    expect(r.isError).not.toBe(true)
    expect(r.images).toEqual([{ type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64') }])
    expect(r.text).toContain('The image is shown below.')
    expect(r.text).not.toContain(jpeg.toString('base64'))
    expect(r.structured).not.toHaveProperty('image')
    expect(c.ctx.files.imageCount).toBe(1)
    expect(codec.mock.calls[0]![0]).toBe('image.png')
  } finally { codec.mockRestore() }
})

test('no pixels for the API engine or with the switch off; no OCR either way on Linux', async () => {
  const codec = spyOn(a.ctx.files, 'modelImage').mockResolvedValue(jpeg)
  try {
    const api = await read('photo', 'api').result
    expect(api.images).toBeUndefined()
    expect(api.text).toContain('reads text only')
    a.ctx.db.query("INSERT INTO settings (key, value) VALUES ('aiVision', 'false')").run()
    const ocr = a.ctx.files.cfg.ocr
    a.ctx.files.cfg.ocr = null
    try {
      const off = await read('photo').result
      expect(off.images).toBeUndefined()
      expect(off.text).toContain('does not send images to the AI')
    } finally { a.ctx.files.cfg.ocr = ocr }
    expect(codec).not.toHaveBeenCalled()
  } finally { codec.mockRestore() }
})

test('a scanned Drive PDF gives its text layer and a note, and is never recognized (OCR)', async () => {
  if (!a.ctx.engineConfig.pdftotext && !a.ctx.engineConfig.ocr) return
  const real = Bun.spawn
  const calls: string[][] = []
  const spy = spyOn(Bun, 'spawn').mockImplementation(((cmd: any, o: any) => { calls.push((Array.isArray(cmd) ? cmd : []).map(String)); return real(cmd, o) }) as typeof Bun.spawn)
  let r: Awaited<ReturnType<typeof read>['result']>
  try { r = await read('scan').result } finally { spy.mockRestore() }
  expect(r.isError).not.toBe(true)
  expect(r.text).toContain('A page with a real text layer')
  expect(r.structured).toMatchObject({ note: expect.stringContaining('no text layer') })
  // OCR mode of mycel-ocr is the one without --layer / --page / --jpeg; tesseract is never run
  const ocr = calls.filter((c) => c.some((x) => x.endsWith('/mycel-ocr')) && !c.some((x) => ['--layer', '--page', '--jpeg'].includes(x)))
  expect(ocr).toEqual([])
  expect(calls.filter((c) => c.some((x) => x.endsWith('/tesseract')))).toEqual([])
})
