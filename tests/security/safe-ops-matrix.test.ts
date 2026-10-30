import { afterAll, beforeAll, expect, test, spyOn } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { makeHandler } from '../../server/src/mcp/protocol'
let A: CApp
beforeAll(async () => {
  A = await makeCApp('safe-ops-matrix')
  A.ctx.files.cfg.ocr = null
  process.env.MYCEL_SAFE_OPS_1A = '1'
  for (const p of ['shared/image.png', 'groups/finance/image.png', 'users/bob/image.png', 'projects/falcon/image.png'])
    fs.writeFileSync(path.join(A.team, p), 'synthetic')
})
afterAll(async () => {
  delete process.env.MYCEL_SAFE_OPS_1A
  await A.close()
})
const matrix: [Person, string, boolean][] = [
  ['alice', 'shared/image.png', true],
  ['alice', 'groups/finance/image.png', false],
  ['bob', 'groups/finance/image.png', true],
  ['carol', 'groups/finance/image.png', true],
  ['dana', 'groups/finance/image.png', true],
  ['alice', 'users/bob/image.png', false],
  ['carol', 'users/bob/image.png', false],
  ['dana', 'users/bob/image.png', false],
  ['bob', 'users/bob/image.png', true],
  ['alice', 'projects/falcon/image.png', true],
  ['erin', 'projects/falcon/image.png', false],
  ['alice', 'shared/missing.png', false],
]
for (const [who, source, allowed] of matrix)
  test('image matrix ' + who + ' ' + source, async () => {
    const turn = A.turn(who, A.chat(who)),
      ctx = A.toolCtx(who, turn)
    const codec = spyOn(A.ctx.files, 'modelImage').mockResolvedValue(Buffer.from([255, 216, 255, 217]))
    try {
      const r = await makeHandler(
        A.ctx.files,
        A.ctx.db,
        ctx,
      )({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { file_path: source } } })
      expect(!r.result.isError).toBe(allowed)
      expect(codec.mock.calls.length).toBe(allowed ? 1 : 0)
      expect(r.result.content.some((c: any) => c.type === 'image')).toBe(allowed)
    } finally {
      codec.mockRestore()
    }
  })
test('membership removal during image conversion prevents delivery', async () => {
  const turn = A.turn('bob', A.chat('bob')),
    ctx = A.toolCtx('bob', turn)
  const codec = spyOn(A.ctx.files, 'modelImage').mockImplementation(async () => {
    A.ctx.db.query("DELETE FROM group_members WHERE user_id='bob'").run()
    return Buffer.from([255, 216, 255, 217])
  })
  try {
    const r = await makeHandler(
      A.ctx.files,
      A.ctx.db,
      ctx,
    )({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read', arguments: { file_path: 'groups/finance/image.png' } },
    })
    expect(r.result.isError).toBe(true)
    expect(r.result.content.some((c: any) => c.type === 'image')).toBe(false)
  } finally {
    codec.mockRestore()
  }
})
