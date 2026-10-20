// An upload session whose part file is gone (a DB restore brings back session rows of a later state, someone cleaned
// <data>/uploads): every chunk answered 500 "internal error" (ENOENT from open). The web client retried, gave up, and on
// the next try resumed the same session (GET still found it), so that file could not be uploaded for 24 hours. Now the
// session ends and the chunk is answered 410 gone; the next try finds no session and starts a new one.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { UPLOAD_CHUNK_SIZE } from '@mycel/shared/api'
import { jsonBody, makeCApp, sha256hex, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('p1-upload-missing-part') })
afterAll(async () => { await A.close() })

test('a chunk for a session without its part file: 410, and the session is gone', async () => {
  const data = new Uint8Array(UPLOAD_CHUNK_SIZE + 5).fill(7)
  const s = await A.json('/api/upload-sessions', { ...jsonBody({ target: { kind: 'path', path: 'shared/x.bin' }, size: data.length, sha256: sha256hex(data) }), as: 'alice' })
  expect(s.status).toBe(201)
  fs.rmSync(path.join(A.data, 'uploads', `${s.body.id}.part`))
  const r = await A.json(`/api/upload-sessions/${s.body.id}/chunks/0`, { method: 'PUT', body: data.subarray(0, UPLOAD_CHUNK_SIZE), headers: { 'content-type': 'application/octet-stream' }, as: 'alice' })
  expect(r.status).toBe(410)
  expect((await A.json(`/api/upload-sessions/${s.body.id}`, { as: 'alice' })).status).toBe(404)
})
