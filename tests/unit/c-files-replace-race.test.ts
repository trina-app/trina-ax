// Two replace uploads of the same file at once (11-11 code audit, row 33): each version in History holds the bytes its
// sha256 names. Before, placeUpload hashed the current file, waited, then copied whatever was there by then (the other
// upload's bytes) under the first hash; restoring that version then did nothing ("already this content").
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { componentC } from '../../server/src/team-files/component'
import { writeTemp } from '../../server/src/team-files/place'
import { makeCApp, sha256hex, type CApp } from '../lib/c-app'

setDefaultTimeout(60_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-files-replace-race') })
afterAll(async () => { await A.close() })

const bytes = (s: string) => new TextEncoder().encode(s.repeat(50_000))

test('concurrent replaces: every version is stored under the sha256 of its own bytes, and each one restores', async () => {
  const files = componentC(A.ctx).files
  const rel = 'shared/budget.xlsx', abs = path.join(A.team, rel)
  const orig = bytes('original '), a = bytes('from alice '), b = bytes('from bob ')
  fs.writeFileSync(abs, orig)
  const tmp = path.join(A.data, 'up')
  const [ta, tb] = [await writeTemp(tmp, a), await writeTemp(tmp, b)]
  await Promise.all([
    files.placeUpload('alice', 'shared', 'budget.xlsx', ta, 'replace', sha256hex(a)),
    files.placeUpload('alice', 'shared', 'budget.xlsx', tb, 'replace', sha256hex(b)),
  ])
  const versions = A.ctx.db.query('SELECT id, version, sha256, storage_path FROM file_versions WHERE path = ? ORDER BY version').all(rel) as { id: string; version: number; sha256: string; storage_path: string }[]
  expect(versions).toHaveLength(2)
  for (const v of versions) expect(sha256hex(fs.readFileSync(path.join(A.team, ...v.storage_path.split('/'))))).toBe(v.sha256)
  // the two versions are the original and the upload that came first; restoring the middle one brings its bytes back
  expect(versions[0]!.sha256).toBe(sha256hex(orig))
  const middle = versions[1]!
  expect([sha256hex(a), sha256hex(b)]).toContain(middle.sha256)
  await files.restoreVersion('alice', rel, middle.id)
  expect(sha256hex(fs.readFileSync(abs))).toBe(middle.sha256)
})
