// Component C: chunked upload sessions (8 MB chunks, resumable, sha256-checked) and chat attachments.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { UPLOAD_CHUNK_SIZE, uuidv7 } from '@mycel/shared/api'
import { componentC } from '../../server/src/team-files/component'
import { imageSize } from '../../server/src/uploads/image'
import { MAX_OPEN_SESSIONS } from '../../server/src/uploads/sessions'
import { jsonBody, makeCApp, sha256hex, type CApp } from '../lib/c-app'
import { which } from '../../server/src/config'

// the app setup (database, migrations, team folder, server) takes seconds on a busy machine: room for it and the cases
setDefaultTimeout(30_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-uploads') })
afterAll(async () => { await A.close() })

const MB = 1024 * 1024
const blob = (n: number, seed = 1) => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x & 255 } return b }
const put = (id: string, n: number, data: Uint8Array, as: 'alice' | 'bob' = 'alice') => A.json(`/api/upload-sessions/${id}/chunks/${n}`, { method: 'PUT', body: new Uint8Array(data), headers: { 'content-type': 'application/octet-stream' }, as })
const create = (target: unknown, data: Uint8Array, as: 'alice' | 'bob' = 'alice') => A.json('/api/upload-sessions', { ...jsonBody({ target, size: data.length, sha256: sha256hex(data) }), as })
const chunk = (d: Uint8Array, n: number) => d.subarray(n * UPLOAD_CHUNK_SIZE, (n + 1) * UPLOAD_CHUNK_SIZE)

describe('upload sessions', () => {
  test('out-of-order chunks, resume from GET, re-sent chunk is a no-op, complete places the file', async () => {
    const data = blob(2 * UPLOAD_CHUNK_SIZE + 12345)
    expect((await create({ kind: 'path', path: 'shared/big/video.bin' }, data)).status).toBe(404) // the folder must exist
    fs.mkdirSync(path.join(A.team, 'shared/big'), { recursive: true })
    const s = await create({ kind: 'path', path: 'shared/big/video.bin' }, data)
    expect(s.status).toBe(201)
    expect(s.body).toMatchObject({ chunkSize: UPLOAD_CHUNK_SIZE, chunkCount: 3, received: [] })
    expect((await put(s.body.id, 2, chunk(data, 2))).body.received).toEqual([2])
    expect((await put(s.body.id, 0, chunk(data, 0))).body.received).toEqual([0, 2])
    // "disconnect": the client asks what arrived and sends the rest
    const g = await A.json(`/api/upload-sessions/${s.body.id}`, { as: 'alice' })
    expect(g.body.received).toEqual([0, 2])
    expect((await A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'alice' })).status).toBe(409) // chunk 1 missing
    expect((await put(s.body.id, 1, chunk(data, 1))).body.received).toEqual([0, 1, 2])
    expect((await put(s.body.id, 1, chunk(data, 1))).body.received).toEqual([0, 1, 2])
    const done = await A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'alice' })
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ kind: 'path', entry: { path: 'shared/big/video.bin', size: data.length } })
    expect(sha256hex(fs.readFileSync(path.join(A.team, 'shared/big/video.bin')))).toBe(sha256hex(data))
    // a retried complete answers the same; the part file is gone
    expect((await A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'alice' })).body).toEqual(done.body)
    expect(fs.existsSync(path.join(A.data, 'uploads', `${s.body.id}.part`))).toBe(false)
  })
  test('unfinished sessions are limited per person until cancelled: a cancel frees the slot and the part file', async () => {
    const data = blob(UPLOAD_CHUNK_SIZE + 1, 3)
    const ids: string[] = []
    for (let i = 0; i < MAX_OPEN_SESSIONS; i++) {
      const s = await create({ kind: 'path', path: `shared/limit-${i}.bin` }, data, 'bob')
      expect(s.status).toBe(201)
      ids.push(s.body.id)
    }
    expect((await create({ kind: 'path', path: 'shared/limit-x.bin' }, data, 'bob')).status).toBe(429)
    expect((await A.json(`/api/upload-sessions/${ids[0]}`, { method: 'DELETE', as: 'bob' })).status).toBe(204)
    expect(fs.existsSync(path.join(A.data, 'uploads', `${ids[0]}.part`))).toBe(false)
    const again = await create({ kind: 'path', path: 'shared/limit-x.bin' }, data, 'bob')
    expect(again.status).toBe(201)
    for (const id of [...ids.slice(1), again.body.id]) await A.json(`/api/upload-sessions/${id}`, { method: 'DELETE', as: 'bob' })
  })
  test('in-order upload is hashed on the way; wrong chunk sizes and numbers are refused', async () => {
    const data = blob(UPLOAD_CHUNK_SIZE + 10, 7)
    const s = await create({ kind: 'path', path: 'shared/inorder.bin' }, data)
    expect((await put(s.body.id, 0, chunk(data, 0).subarray(0, 100))).status).toBe(400) // short chunk
    expect((await put(s.body.id, 1, new Uint8Array(11))).status).toBe(400) // last chunk must be exactly 10
    expect((await put(s.body.id, 2, new Uint8Array(1))).status).toBe(400) // no chunk 2
    await put(s.body.id, 0, chunk(data, 0))
    await put(s.body.id, 1, chunk(data, 1))
    const t0 = performance.now()
    expect((await A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'alice' })).status).toBe(200)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
  test('a chunk larger than 8 MB is cut off (413)', async () => {
    const data = blob(UPLOAD_CHUNK_SIZE * 2)
    const s = await create({ kind: 'path', path: 'shared/toolarge.bin' }, data)
    expect((await put(s.body.id, 0, new Uint8Array(UPLOAD_CHUNK_SIZE + 1))).status).toBe(413)
  })
  test('checksum mismatch: complete refuses and the client must send everything again', async () => {
    const data = blob(1000, 3)
    const s = await A.json('/api/upload-sessions', { ...jsonBody({ target: { kind: 'path', path: 'shared/bad.bin' }, size: 1000, sha256: '0'.repeat(64) }), as: 'alice' })
    await put(s.body.id, 0, data)
    const r = await A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'alice' })
    expect(r.status).toBe(409)
    expect(r.body.error.fields.sha256).toBe(sha256hex(data))
    expect((await A.json(`/api/upload-sessions/${s.body.id}`, { as: 'alice' })).body.received).toEqual([])
    expect(fs.existsSync(path.join(A.team, 'shared/bad.bin'))).toBe(false)
  })
  test('targets are checked at create and again at complete; other people\'s sessions are invisible', async () => {
    const data = blob(10)
    expect((await create({ kind: 'path', path: 'groups/finance/x.bin' }, data)).status).toBe(404)
    expect((await create({ kind: 'path', path: 'skills/x.bin' }, data)).status).toBe(403)
    expect((await create({ kind: 'path', path: 'shared/glossary.md', onExists: 'fail' }, data)).status).toBe(409)
    const s = await create({ kind: 'path', path: 'shared/later.bin', onExists: 'fail' }, data)
    expect((await put(s.body.id, 0, data, 'bob')).status).toBe(404)
    expect((await A.json(`/api/upload-sessions/${s.body.id}`, { as: 'bob' })).status).toBe(404)
    await put(s.body.id, 0, data)
    fs.writeFileSync(path.join(A.team, 'shared/later.bin'), 'someone was faster')
    expect((await A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'alice' })).status).toBe(409)
    expect(fs.readFileSync(path.join(A.team, 'shared/later.bin'), 'utf8')).toBe('someone was faster')
  })
  test('cancel, expiry (410) and the sweep', async () => {
    const data = blob(10)
    const s = await create({ kind: 'path', path: 'shared/c.bin' }, data)
    expect((await A.req(`/api/upload-sessions/${s.body.id}`, { method: 'DELETE', as: 'alice' })).status).toBe(204)
    expect((await A.json(`/api/upload-sessions/${s.body.id}`, { as: 'alice' })).status).toBe(404)
    const e = await create({ kind: 'path', path: 'shared/e.bin' }, data)
    A.ctx.db.query('UPDATE upload_sessions SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), e.body.id)
    expect((await put(e.body.id, 0, data)).status).toBe(410)
    const f = await create({ kind: 'path', path: 'shared/f.bin' }, data)
    fs.writeFileSync(path.join(A.data, 'uploads', 'orphan.part'), 'x')
    const n = componentC(A.ctx).uploads.sweep(Date.now() + 25 * 3600_000)
    expect(n).toBeGreaterThanOrEqual(2)
    expect(fs.existsSync(path.join(A.data, 'uploads', `${f.body.id}.part`))).toBe(false)
    expect(fs.existsSync(path.join(A.data, 'uploads', 'orphan.part'))).toBe(false)
  })
  test('too many open sessions per person', async () => {
    const data = blob(1)
    const ids: string[] = []
    let last = 0
    for (let i = 0; i < 12; i++) { const r = await create({ kind: 'path', path: `shared/many-${i}.bin` }, data, 'bob'); last = r.status; if (r.status === 201) ids.push(r.body.id) }
    expect(last).toBe(429)
    for (const id of ids) await A.req(`/api/upload-sessions/${id}`, { method: 'DELETE', as: 'bob' })
  })
  test('a large upload never sits in memory', async () => {
    const size = 6 * UPLOAD_CHUNK_SIZE
    const one = blob(UPLOAD_CHUNK_SIZE, 11)
    const all = new Bun.CryptoHasher('sha256')
    for (let i = 0; i < 6; i++) all.update(one)
    const s = await A.json('/api/upload-sessions', { ...jsonBody({ target: { kind: 'path', path: 'shared/48mb.bin' }, size, sha256: all.digest('hex') }), as: 'alice' })
    Bun.gc(true)
    const before = process.memoryUsage().rss
    for (let i = 0; i < 6; i++) expect((await put(s.body.id, i, one)).status).toBe(200)
    expect((await A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'alice' })).status).toBe(200)
    expect(process.memoryUsage().rss - before).toBeLessThan(120 * MB)
    expect(fs.statSync(path.join(A.team, 'shared/48mb.bin')).size).toBe(size)
  })
})

describe('attachments', () => {
  const png = () => {
    // 2x3 PNG made by hand (IHDR is enough for the size parser; ffmpeg gets a real one below)
    const b = new Uint8Array(33)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3])
    return b
  }
  test('image sizes from headers', () => {
    expect(imageSize(png())).toEqual({ width: 2, height: 3 })
    expect(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0]))).toEqual({ width: 10, height: 20 })
    expect(imageSize(new Uint8Array(10))).toBeNull()
  })
  test('upload into an own chat, stored in users/<me>/.attachments/<chat>/; others cannot attach or see it', async () => {
    const chat = A.chat('alice')
    const fd = new FormData()
    fd.set('chatId', chat)
    fd.set('file', new File(['col1,col2\n1,2\n'], '분기 매출.csv'))
    const r = await A.json('/api/uploads', { method: 'POST', body: fd, as: 'alice' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ name: '분기 매출.csv', path: `users/alice/.attachments/${chat}/분기 매출.csv`, kind: 'spreadsheet', size: 14 })
    expect(fs.readFileSync(path.join(A.team, r.body.path), 'utf8')).toContain('col1')
    // same name again -> renamed
    const fd2 = new FormData(); fd2.set('chatId', chat); fd2.set('file', new File(['x'], '분기 매출.csv'))
    expect((await A.json('/api/uploads', { method: 'POST', body: fd2, as: 'alice' })).body.name).toBe('분기 매출 (2).csv')
    // bob can't attach to alice's chat; admins can't read alice's attachments
    const fd3 = new FormData(); fd3.set('chatId', chat); fd3.set('file', new File(['x'], 'x.txt'))
    expect((await A.json('/api/uploads', { method: 'POST', body: fd3, as: 'bob' })).status).toBe(404)
    expect((await A.req('/api/files/download?path=' + encodeURIComponent(r.body.path), { as: 'carol' })).status).toBe(404)
    // B looks attachments up by id when the message is sent
    const C = componentC(A.ctx)
    expect(C.attachments.byIds('alice', chat, [uuidv7(), r.body.id]).map((x) => x.id)).toEqual([r.body.id])
    expect(C.attachments.byIds('bob', chat, [r.body.id])).toEqual([])
  })
  test('image attachment: size, thumbnail (ffmpeg) or the small original', async () => {
    const chat = A.chat('alice')
    const work = path.join(A.data, 'imgsrc')
    fs.mkdirSync(work, { recursive: true })
    const ff = which('ffmpeg')
    let bytes: Uint8Array<ArrayBuffer>
    if (ff) {
      Bun.spawnSync([ff, '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=800x600:rate=1', '-frames:v', '1', path.join(work, 'a.png')])
      bytes = new Uint8Array(fs.readFileSync(path.join(work, 'a.png')))
    } else bytes = png()
    const fd = new FormData(); fd.set('chatId', chat); fd.set('file', new File([bytes], 'shot.png'))
    const r = await A.json('/api/uploads', { method: 'POST', body: fd, as: 'alice' })
    expect(r.body.kind).toBe('image')
    if (ff) expect(r.body).toMatchObject({ width: 800, height: 600 })
    const t = await A.req(`/api/uploads/${r.body.id}/thumbnail`, { as: 'alice' })
    expect(t.status).toBe(200)
    const tb = new Uint8Array(await t.arrayBuffer())
    if (ff) {
      expect(t.headers.get('content-type')).toBe('image/jpeg')
      expect(imageSize(tb)).toEqual({ width: 320, height: 240 })
    }
    expect((await A.req(`/api/uploads/${r.body.id}/thumbnail`, { as: 'bob' })).status).toBe(404)
  })
  test('attachment through an upload session', async () => {
    const chat = A.chat('bob')
    const data = blob(3000, 5)
    const s = await create({ kind: 'attachment', chatId: chat, name: 'scan.pdf' }, data, 'bob')
    expect(s.status).toBe(201)
    await put(s.body.id, 0, data, 'bob')
    const r = await A.json(`/api/upload-sessions/${s.body.id}/complete`, { method: 'POST', as: 'bob' })
    expect(r.body).toMatchObject({ kind: 'attachment', attachment: { name: 'scan.pdf', kind: 'pdf', path: `users/bob/.attachments/${chat}/scan.pdf` } })
    expect((await create({ kind: 'attachment', chatId: chat, name: 'x.pdf' }, data, 'alice')).status).toBe(404)
  })
})
