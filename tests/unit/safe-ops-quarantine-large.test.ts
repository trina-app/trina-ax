// A quarantined (download-only) artifact is found by content, also when a team file has its size and is larger than
// 32 MiB. Before, Quarantine.hasFile read at most 32 MiB, so authorize() failed every read of such a file with "file is
// too large" (video-read plan review): a large video with exactly the size of a quarantined deck could not be read.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { sha256Regular } from '../../server/src/files/store'
import { makeCApp, type CApp } from '../lib/c-app'

let A: CApp
const SIZE = 33 * 1024 ** 2
let file: string
beforeAll(async () => {
  A = await makeCApp('safe-ops-quarantine-large')
  A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run()
  file = path.join(A.team, 'users/alice/big.txt')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(SIZE, 'a'))
})
afterAll(async () => { await A.close() })
const add = (hash: string) => A.ctx.db.query('INSERT OR IGNORE INTO safe_ops_artifacts(hash,size,kind) VALUES(?,?,?)').run(hash, SIZE, 'pptx')

test('over 32 MiB with the size of another quarantined artifact: not quarantined, and the read works', async () => {
  add('0'.repeat(64))
  expect(A.ctx.files.quarantine.hasFile(file)).toBe(false)
  const out = await A.ctx.files.call('read', { file_path: 'users/alice/big.txt', limit: 1 }, A.toolCtx('alice'))
  expect(out.isError).toBeUndefined()
  expect(out.text).toContain('aaaa')
})
test('the same bytes quarantined: found (streamed hash), and the read is refused as download-only', async () => {
  const h = sha256Regular(file)
  expect(h).toBe(new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex'))
  add(h)
  expect(A.ctx.files.quarantine.hasFile(file)).toBe(true)
  const out = await A.ctx.files.call('read', { file_path: 'users/alice/big.txt', limit: 1 }, A.toolCtx('alice'))
  expect(out.isError).toBe(true)
  expect(out.text).toContain('download-only')
})
test('the streamed hash refuses links like readRegular', () => {
  const l = path.join(A.team, 'users/alice/big-link.txt')
  fs.symlinkSync(file, l)
  expect(() => sha256Regular(l)).toThrow('symbolic links')
})
