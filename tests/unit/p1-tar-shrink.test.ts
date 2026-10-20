// A file that shrinks while the backup reads it is zero-filled up to the size in its header. The fill used to be
// one allocation of everything that was missing (a 4 GB log truncated mid-backup = one 4 GB buffer); it now comes
// in pieces no bigger than the normal read size, and the archive still reads back with the size it announced.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { readTar, tarStream } from '../../server/src/system/tar'
import { WORK } from '../lib/env'

test('a file truncated during archiving is zero-filled in 1 MB pieces', async () => {
  const dir = path.join(WORK, 'p1-tar-shrink')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'growing.log')
  const SIZE = 9 * 1024 * 1024 + 123
  fs.writeFileSync(file, Buffer.alloc(SIZE, 0x61))

  const written: { size: number; changedWhileReading: boolean }[] = []
  const gen = tarStream([{ name: 'growing.log', type: 'file', source: file }], (w) => written.push(w))
  const pieces: Uint8Array[] = []
  let data = 0
  for await (const b of gen) {
    pieces.push(b)
    if (b.byteLength >= 1024 * 1024) data += b.byteLength
    // after the first data piece the file is cut to nothing
    if (data > 0 && fs.statSync(file).size > 0) fs.truncateSync(file, 0)
  }
  expect(Math.max(...pieces.map((p) => p.byteLength))).toBeLessThanOrEqual(1024 * 1024)
  expect(written).toEqual([expect.objectContaining({ size: SIZE, changedWhileReading: true })])

  // the archive is still well formed: one entry of the announced size, the part that was read, then zeros
  const seen: { name: string; size: number; head: number; tail: number }[] = []
  await readTar((async function* () { yield* pieces })(), async (e, body) => {
    const parts: Uint8Array[] = []
    for await (const c of body) parts.push(c)
    const all = Buffer.concat(parts)
    seen.push({ name: e.name, size: all.length, head: all[0]!, tail: all[all.length - 1]! })
  })
  expect(seen).toEqual([{ name: 'growing.log', size: SIZE, head: 0x61, tail: 0 }])
})
