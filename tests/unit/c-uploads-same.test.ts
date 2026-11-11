// The same file uploaded again into the same place is kept, not stored as "name (2)" (QA TC-223): a retry whose first
// answer was lost after a network drop, or photos picked again. Another file of that name still gets "(2)", and
// onExists fail / replace are as before. Small uploads and upload sessions alike. Fixture (tests/lib/c-app.ts): alice =
// member (marketing).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { UPLOAD_CHUNK_SIZE } from '@mycel/shared/api'
import { jsonBody, makeCApp, sha256hex, type CApp } from '../lib/c-app'

setDefaultTimeout(30_000)

let A: CApp
beforeAll(async () => {
  A = await makeCApp('c-uploads-same')
  fs.mkdirSync(path.join(A.team, 'shared/photos'), { recursive: true })
})
afterAll(async () => { await A.close() })
const names = () => fs.readdirSync(path.join(A.team, 'shared/photos')).sort()
const up = (name: string, body: string, onExists = 'rename') => {
  const fd = new FormData()
  fd.set('folder', 'shared/photos')
  fd.set('name', name)
  fd.set('onExists', onExists)
  fd.set('file', new File([body], name))
  return A.json('/api/files/upload', { method: 'POST', body: fd, as: 'alice' })
}
const events = (p: string) => (A.ctx.db.query('SELECT COUNT(*) AS n FROM file_events WHERE path = ?').get(p) as { n: number }).n

describe('the same file again', () => {
  test('a small upload: kept and answered, no copy, no version, no event; another file of the name gets (2)', async () => {
    const first = await up('IMG_0001.jpg', 'photo one')
    expect(first.status).toBe(201)
    const before = events('shared/photos/IMG_0001.jpg')
    const again = await up('IMG_0001.jpg', 'photo one')
    expect(again.status).toBe(201)
    expect(again.body).toMatchObject({ path: 'shared/photos/IMG_0001.jpg', size: 9 })
    expect(names()).toEqual(['IMG_0001.jpg'])
    expect(events('shared/photos/IMG_0001.jpg')).toBe(before)
    expect((A.ctx.db.query("SELECT COUNT(*) AS n FROM file_versions WHERE path = 'shared/photos/IMG_0001.jpg'").get() as { n: number }).n).toBe(0)
    // other content under the name: a new name, as before
    expect((await up('IMG_0001.jpg', 'photo two')).body.path).toBe('shared/photos/IMG_0001 (2).jpg')
    // fail and replace are not changed
    expect((await up('IMG_0001.jpg', 'photo one', 'fail')).status).toBe(409)
    expect((await up('IMG_0001.jpg', 'photo one', 'replace')).status).toBe(201)
    expect((A.ctx.db.query("SELECT COUNT(*) AS n FROM file_versions WHERE path = 'shared/photos/IMG_0001.jpg'").get() as { n: number }).n).toBe(1)
  })

  test('a folder of that name: the file gets (2), as before', async () => {
    fs.mkdirSync(path.join(A.team, 'shared/photos/scan.pdf'))
    expect((await up('scan.pdf', 'x')).body.path).toBe('shared/photos/scan (2).pdf')
  })

  test('an upload session: the same file completed again is kept; the session answers with it', async () => {
    const data = new Uint8Array(UPLOAD_CHUNK_SIZE + 5).map((_, i) => i % 251)
    const target = { kind: 'path', path: 'shared/photos/video.mp4', onExists: 'rename' }
    const send = async () => {
      const s = await A.json('/api/upload-sessions', { ...jsonBody({ target, size: data.length, sha256: sha256hex(data) }), as: 'alice' })
      expect(s.status).toBe(201)
      for (const n of [0, 1]) await A.json(`/api/upload-sessions/${s.body.id}/chunks/${n}`, { method: 'PUT', body: data.slice(n * UPLOAD_CHUNK_SIZE, (n + 1) * UPLOAD_CHUNK_SIZE), headers: { 'content-type': 'application/octet-stream' }, as: 'alice' })
      return A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'alice' })
    }
    expect((await send()).body.entry.path).toBe('shared/photos/video.mp4')
    const again = await send()
    expect(again.status).toBe(200)
    expect(again.body.entry.path).toBe('shared/photos/video.mp4')
    expect(names().filter((n) => n.startsWith('video'))).toEqual(['video.mp4'])
  })
})
