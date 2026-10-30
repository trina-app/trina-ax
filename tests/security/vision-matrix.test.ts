// Permission matrix of the default image / PDF-page path (no 1A flag): read access decides, per person, whether any
// pixels are converted or delivered; hidden, missing, linked and hard-linked files look the same and convert nothing.
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { makePng } from '../lib/images'
import { CCITT_SCAN, makePagesPdf } from '../lib/pdf'
import { makeHandler } from '../../server/src/mcp/protocol'

let A: CApp
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const IMAGES = ['shared/photo.png', 'groups/finance/receipt.jpg', 'groups/marketing/salaries/badge.png', 'users/bob/scan.heic', 'projects/falcon/chart.webp', 'projects/falcon/public/logo.gif']
const PDFS = ['shared/scan.pdf', 'groups/finance/statement.pdf', 'users/bob/contract.pdf', 'projects/atlas/plan.pdf']
beforeAll(async () => {
  delete process.env.MYCEL_SAFE_OPS_1A
  A = await makeCApp('vision-matrix')
  A.ctx.db.query("UPDATE users SET locale = 'en'").run()
  for (const p of IMAGES) { fs.mkdirSync(path.dirname(path.join(A.team, p)), { recursive: true }); fs.writeFileSync(path.join(A.team, p), makePng(8, 8)) }
  for (const p of PDFS) { fs.mkdirSync(path.dirname(path.join(A.team, p)), { recursive: true }); fs.writeFileSync(path.join(A.team, p), makePagesPdf([{ image: CCITT_SCAN }])) }
  fs.symlinkSync(path.join(A.team, 'groups/finance/receipt.jpg'), path.join(A.team, 'users/alice/link.jpg'))
  // a hard link makes both names unreadable (nlink > 1): its own source file, so statement.pdf stays readable
  fs.writeFileSync(path.join(A.team, 'groups/finance/linked.pdf'), makePagesPdf([{ image: CCITT_SCAN }]))
  fs.linkSync(path.join(A.team, 'groups/finance/linked.pdf'), path.join(A.team, 'users/alice/hard.pdf'))
})
afterAll(async () => { await A.close() })

// [person, path, allowed]: the fixture's rules (tests/lib/fixtures.ts seed)
const matrix: [Person, string, boolean][] = [
  ['alice', 'shared/photo.png', true], ['erin', 'shared/photo.png', true],
  ['alice', 'groups/finance/receipt.jpg', false], ['bob', 'groups/finance/receipt.jpg', true], ['carol', 'groups/finance/receipt.jpg', true],
  ['alice', 'groups/marketing/salaries/badge.png', false], ['erin', 'groups/marketing/salaries/badge.png', false], ['carol', 'groups/marketing/salaries/badge.png', true],
  ['bob', 'users/bob/scan.heic', true], ['alice', 'users/bob/scan.heic', false], ['carol', 'users/bob/scan.heic', false], ['dana', 'users/bob/scan.heic', false],
  ['alice', 'projects/falcon/chart.webp', true], ['bob', 'projects/falcon/chart.webp', true], ['erin', 'projects/falcon/chart.webp', false],
  ['erin', 'projects/falcon/public/logo.gif', true],
  ['alice', 'shared/scan.pdf', true], ['alice', 'groups/finance/statement.pdf', false], ['bob', 'groups/finance/statement.pdf', true],
  ['dana', 'users/bob/contract.pdf', false], ['bob', 'users/bob/contract.pdf', true], ['alice', 'projects/atlas/plan.pdf', false], ['bob', 'projects/atlas/plan.pdf', true],
  // never: links, hard links, case tricks, hidden system folders, missing files
  ['alice', 'users/alice/link.jpg', false], ['alice', 'users/alice/hard.pdf', false], ['alice', 'Groups/finance/receipt.jpg', false],
  ['alice', 'users/ALICE/../bob/scan.heic', false], ['carol', '.system/history/x.png', false], ['alice', 'shared/missing.png', false],
]

for (const [who, file, allowed] of matrix)
  test(`vision matrix ${who} ${file} -> ${allowed ? 'image' : 'denied, nothing converted'}`, async () => {
    const ctx = A.toolCtx(who, A.turn(who, A.chat(who)))
    const image = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(jpeg)
    const page = spyOn(A.ctx.files, 'pdfPageImage').mockResolvedValue(jpeg)
    try {
      const args = file.endsWith('.pdf') ? { file_path: file, pages: '1' } : { file_path: file }
      const r = await makeHandler(A.ctx.files, A.ctx.db, ctx)({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: args } })
      const imgs = (r.result.content as any[]).filter((c) => c.type === 'image')
      expect(!r.result.isError).toBe(allowed)
      expect(imgs.length).toBe(allowed ? 1 : 0)
      expect(image.mock.calls.length + page.mock.calls.length).toBe(allowed ? 1 : 0)
      expect(ctx.files.readPaths.size).toBe(allowed ? 1 : 0)
      if (!allowed) {
        const text = (r.result.content as any[]).map((c) => c.text ?? '').join(' ')
        // hidden and missing look alike (the uniform policy answer), links and hard links are refused as such
        expect(text).toMatch(/^Access denied: (not found or no access|symbolic links are not followed|hard-linked files are refused|'\.\.' is not allowed)/)
      }
    } finally { image.mockRestore(); page.mockRestore() }
  })

test('the team switch is admin-only: members cannot turn image viewing on or off', async () => {
  for (const who of ['alice', 'bob', 'erin'] as const) {
    const r = await A.json('/api/admin/settings', { as: who, method: 'PATCH', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1' }, body: JSON.stringify({ aiVision: false }) })
    expect(r.status).toBe(403)
  }
  expect((await A.json('/api/admin/settings', { as: 'dana' })).body.aiVision).toBe(true)
})
