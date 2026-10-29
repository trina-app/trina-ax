import { afterAll, beforeAll, expect, test, spyOn } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp } from '../lib/c-app'
import { makeHandler } from '../../server/src/mcp/protocol'
import { confidentialChat, externalSearch } from '../../server/src/safe-ops/confidential'
import { normalizeImage } from '../../server/src/safe-ops/runner'
import { snapshot, recheck } from '../../server/src/safe-ops/source'
import { safeText } from '../../server/src/safe-ops/strings'
import * as XLSX from 'xlsx'
import { deckMismatch } from '../../server/src/tools/pptx-check'
let A: CApp
const jpeg = Buffer.from([255, 216, 255, 217]) // fake codec result; real decoding is covered by Go/Linux tests
beforeAll(async () => {
  A = await makeCApp('safe-ops')
  A.ctx.files.cfg.ocr = null
  fs.writeFileSync(path.join(A.team, 'users/alice/image.png'), 'synthetic')
  process.env.MYCEL_SAFE_OPS_1A = '1'
})
afterAll(async () => {
  delete process.env.MYCEL_SAFE_OPS_1A
  await A.close()
})
const call = (
  ctx: ReturnType<CApp['toolCtx']>,
  name = 'read',
  args: unknown = { file_path: 'users/alice/image.png' },
) =>
  makeHandler(
    A.ctx.files,
    A.ctx.db,
    ctx,
  )({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
for (const engine of ['claude-code', 'codex'])
  test(engine + ' receives a real MCP image block and retained provenance', async () => {
    const chat = A.chat('alice'),
      turn = A.turn('alice', chat)
    A.ctx.db.query('UPDATE turns SET engine=? WHERE id=?').run(engine, turn)
    const ctx = A.toolCtx('alice', turn),
      mock = spyOn(A.ctx.files, 'imagePreview').mockResolvedValue(jpeg)
    try {
      const r = await call(ctx)
      expect(r.result.isError).toBeUndefined()
      expect(r.result.content[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64') })
      expect(ctx.files.readPaths.has('users/alice/image.png')).toBe(true)
      expect(ctx.files.imageSources.get('users/alice/image.png')?.hash).toHaveLength(64)
      const wire = JSON.parse(JSON.stringify(r))
      expect(wire.beforeDelivery).toBeUndefined()
    } finally {
      mock.mockRestore()
    }
  })
test('revocation during conversion discards pixels and OCR', async () => {
  const turn = A.turn('alice', A.chat('alice')),
    ctx = A.toolCtx('alice', turn)
  const mock = spyOn(A.ctx.files, 'imagePreview').mockImplementation(async () => {
    A.ctx.db.query("UPDATE users SET status='disabled' WHERE id='alice'").run()
    return jpeg
  })
  try {
    const r = await call(ctx)
    expect(r.result.isError).toBe(true)
    expect(r.result.content.some((c: any) => c.type === 'image')).toBe(false)
  } finally {
    mock.mockRestore()
    A.ctx.db.query("UPDATE users SET status='active' WHERE id='alice'").run()
  }
})
test('source replacement between read and delivery is denied', () => {
  const ctx = A.toolCtx('alice'),
    s = snapshot(A.ctx.files, ctx, 'users/alice/image.png', 1024)
  fs.writeFileSync(path.join(A.team, s.path), 'replacement')
  expect(() => recheck(A.ctx.files, ctx, s)).toThrow()
})
test('cancellation refuses a result before disclosure', async () => {
  const turn = A.turn('alice', A.chat('alice')),
    ctx = A.toolCtx('alice', turn),
    abort = new AbortController()
  ctx.signal = abort.signal
  const mock = spyOn(A.ctx.files, 'imagePreview').mockImplementation(async () => {
    abort.abort()
    return jpeg
  })
  try {
    const r = await call(ctx)
    expect(r.result.isError).toBe(true)
    expect(r.result.content.some((c: any) => c.type === 'image')).toBe(false)
  } finally {
    mock.mockRestore()
  }
})
test('confidential conversations stay local after the feature is disabled', async () => {
  const chat = A.chat('alice'),
    turn = A.turn('alice', chat)
  expect(confidentialChat(A.ctx.db, chat)).toBe(true)
  delete process.env.MYCEL_SAFE_OPS_1A
  try {
    expect(confidentialChat(A.ctx.db, chat)).toBe(true)
    expect((await call(A.toolCtx('alice', turn), 'web_fetch', { url: 'https://example.invalid' })).result.isError).toBe(
      true,
    )
    expect(externalSearch({ input: [{ tools: [{ type: 'namespace', tools: [{ type: 'web_search' }] }] }] })).toBe(true)
  } finally {
    process.env.MYCEL_SAFE_OPS_1A = '1'
  }
})
test('unqualified converter fails closed; no direct-execution fallback', async () => {
  if (process.platform === 'linux') return
  await expect(normalizeImage('png', Buffer.from('synthetic'))).rejects.toThrow('unavailable')
})
test('safe presentation refuses uploaded templates before conversion or placement', async () => {
  const r = await call(A.toolCtx('alice'), 'make_file', {
    format: 'pptx',
    content: '## A',
    output: 'users/alice/no.pptx',
    template: 'skills/any.pptx',
  })
  expect(r.result.isError).toBe(true)
  expect(fs.existsSync(path.join(A.team, 'users/alice/no.pptx'))).toBe(false)
})
test('new strings are available in ko, en and id', () => {
  for (const locale of ['ko', 'en', 'id']) {
    A.ctx.db.query("UPDATE users SET locale=? WHERE id='alice'").run(locale)
    expect(safeText(A.ctx.db, 'alice', 'image').length).toBeGreaterThan(10)
  }
})
test('produced PowerPoint is checked in a child; the server never calls the ZIP parser', async () => {
  delete process.env.MYCEL_SAFE_OPS_1A
  const parser = spyOn(XLSX.CFB, 'read').mockImplementation(() => {
    throw new Error('privileged parser invoked')
  })
  try {
    const r = await call(A.toolCtx('alice'), 'make_file', {
      format: 'pptx',
      content: '## One\n\nBody',
      output: 'users/alice/isolated.pptx',
      expected_slides: 1,
    })
    expect(r.result.isError).toBeUndefined()
    expect(parser).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(A.team, 'users/alice/isolated.pptx'))).toBe(true)
  } finally {
    parser.mockRestore()
    process.env.MYCEL_SAFE_OPS_1A = '1'
  }
})
test('expected layouts reuse the slide-count mismatch gate', () => {
  const d = { slides: [{ title: 'A', notes: false, layout: 'Title and Content' }], notes: 0 }
  const shape = { level: 2 as const, metaTitle: false, sections: 0, textUnderSection: 0, rules: 0 }
  expect(deckMismatch(d, shape, { slides: 1, layouts: ['Title and Content'] })).toBeNull()
  expect(deckMismatch(d, shape, { layouts: ['Two Content'] })).toContain('nothing was saved')
})
