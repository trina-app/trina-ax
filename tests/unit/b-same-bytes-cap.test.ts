// The "same bytes as its last event" check (chat/shared-actions.ts sameBytesAsEvent) runs synchronously inside a read
// card's check: it hashes in pieces and only files up to HASH_MAX (review of batch 3, #381: 64 MB read whole held the
// server). A larger file is not hashed: false, so the card asks.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HASH_MAX, sameBytesAsEvent } from '../../server/src/chat/shared-actions'
import { sha256 } from '../../server/src/files/store'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'same-bytes-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('sameBytesAsEvent', () => {
  test('the recorded hash: true; another hash or none: false', () => {
    const b = Buffer.alloc(5 * 1024 * 1024 + 7, 7)
    fs.mkdirSync(path.join(root, 'users', 'alice'), { recursive: true })
    fs.writeFileSync(path.join(root, 'users', 'alice', 'a.bin'), b)
    expect(sameBytesAsEvent(root, 'users/alice/a.bin', sha256(b))).toBe(true)
    expect(sameBytesAsEvent(root, 'users/alice/a.bin', sha256('other'))).toBe(false)
    expect(sameBytesAsEvent(root, 'users/alice/a.bin', null)).toBe(false)
  })

  test('a file over the cap is not hashed: false (the card asks)', () => {
    expect(HASH_MAX).toBeLessThanOrEqual(8 * 1024 * 1024)
    const b = Buffer.alloc(HASH_MAX + 1, 1)
    fs.writeFileSync(path.join(root, 'big.bin'), b)
    expect(sameBytesAsEvent(root, 'big.bin', sha256(b))).toBe(false)
  })

  test('a link is never followed: false', () => {
    const b = Buffer.from('x')
    fs.writeFileSync(path.join(root, 'real.txt'), b)
    fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'))
    expect(sameBytesAsEvent(root, 'link.txt', sha256(b))).toBe(false)
  })
})
