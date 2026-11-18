// make_file's "Limits: 30 slides, 20 images, 100,000 characters" applies only with safe operations on
// (MYCEL_SAFE_OPS_1A, safe-ops/presentation.ts), so the AI is told it only then (QA TC-4902): without them a 40-slide
// deck is one make_file call, not a refusal or a split.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('make-file-safe-ops-limits') })
afterAll(async () => { delete process.env.MYCEL_SAFE_OPS_1A; await A.close() })

let rpcId = 0
async function makeFileDescription(): Promise<string> {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', A.turn('alice', A.chat('alice'))))
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' })
  const mf = (r.result.tools as { name: string; description: string }[]).find((t) => t.name === 'make_file')!
  // the chat turns' entry says the same
  expect(A.ctx.services.turnTools!.find((t) => t.name === 'make_file')!.description).toBe(mf.description)
  return mf.description
}

test('safe operations off (the default): no slide, image or character limit in make_file\'s description', async () => {
  delete process.env.MYCEL_SAFE_OPS_1A
  const d = await makeFileDescription()
  expect(d).toContain('pptx: ')
  expect(d).not.toContain('30 slides')
  expect(d).not.toContain('100,000 text characters')
  expect(d).not.toContain('Safe operations')
  expect(d).not.toContain('expected_layouts checks')
})

test('safe operations on: the limits are there', async () => {
  process.env.MYCEL_SAFE_OPS_1A = '1'
  try {
    const d = await makeFileDescription()
    expect(d).toContain('Safe operations are on: PPTX uses only the bundled reference')
    expect(d).toContain('Limits: 30 slides, 20 PNG/JPEG/WebP/HEIC images, 100,000 text characters.')
  } finally { delete process.env.MYCEL_SAFE_OPS_1A }
})
