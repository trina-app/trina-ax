// Uploads never sit in memory whole (server/src/http/multipart.ts, the room target of an upload session).
// The fault this guards against (0.5.9): POST /api/rooms/:id/files read its body with Request.formData(). A body without
// Content-Length (Transfer-Encoding: chunked) passed Bun's request size limit, was held in memory whole and that memory
// was not given back: a few 100 MB uploads took a 3.8 GB team server down. Covered: the reader takes a body in any
// split of chunks, stops reading as soon as the limit is passed (counted on the way, not from a header), refuses a
// declared length over the limit before it reads a byte, and leaves no temp file behind after a refusal or a dropped
// connection; the room route refuses an endless body without a length; a file larger than one request goes through an
// upload session into the room (membership, the name and the 10 GB limit checked before any byte is sent).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, ROOM_FILE_MAX, UPLOAD_CHUNK_SIZE, SMALL_UPLOAD_MAX, uuidv7, type Room, type RoomFile, type RoomMessage, type UploadComplete, type UploadSession } from '@mycel/shared/api'
import { HttpError } from '../../server/src/http/errors'
import { MULTIPART_OVERHEAD_MAX, spoolMultipart } from '../../server/src/http/multipart'
import { startHarness, type Harness } from '../lib/b-harness'

setDefaultTimeout(120_000)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multipart-stream-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const left = () => fs.readdirSync(dir)

const BOUNDARY = '----test-boundary-7MA4YWxkTrZu0gW'
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
function form(parts: { name: string; filename?: string; data: Uint8Array | string }[]): Buffer {
  const out: Buffer[] = []
  for (const p of parts) {
    out.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"\r\nContent-Type: application/octet-stream` : ''}\r\n\r\n`))
    out.push(Buffer.from(p.data), Buffer.from('\r\n'))
  }
  out.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(out)
}
/** a request whose body arrives in the given pieces, with no Content-Length; `pulled` counts what the reader took */
function streamed(pieces: () => Generator<Uint8Array> | AsyncGenerator<Uint8Array>, headers: Record<string, string> = {}) {
  const it = pieces()
  const state = { pulled: 0, cancelled: false }
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      const { value, done } = await it.next()
      if (done) return c.close()
      state.pulled += value.byteLength
      c.enqueue(value)
    },
    cancel() { state.cancelled = true },
  }, { highWaterMark: 0 })
  const req = new Request('http://x/upload', { method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, ...headers }, duplex: 'half' } as RequestInit)
  return { req, state }
}
const split = (b: Buffer, size: number) => function* () { for (let i = 0; i < b.length; i += size) yield new Uint8Array(b.subarray(i, i + size)) }
const code = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return e instanceof HttpError ? e.code : `threw ${String(e)}` } }

describe('a multipart upload read as a stream', () => {
  test('fields and the file arrive whole, however the body is cut into chunks', async () => {
    // bytes that look like the delimiter's start are inside the file
    const data = Buffer.concat([crypto.randomBytes(5000), Buffer.from(`\r\n--${BOUNDARY.slice(0, 20)}`), crypto.randomBytes(3000), Buffer.from('\r\n--'), crypto.randomBytes(100), Buffer.from('\r')])
    const body = form([{ name: 'size', data: String(data.length) }, { name: 'file', filename: '보고서 "final".pdf'.replace(/"/g, '%22'), data }, { name: 'name', data: '한글 이름.pdf' }])
    for (const size of [1, 2, 3, 7, 61, 1024, body.length]) {
      const { req } = streamed(split(body, size))
      const r = await spoolMultipart(req, { maxBytes: 1024 * 1024, dir })
      expect(r.fields).toEqual({ size: String(data.length), name: '한글 이름.pdf' })
      expect(r.file).toMatchObject({ size: data.length, name: '보고서 %22final%22.pdf', sha256: sha(data) })
      expect(sha(fs.readFileSync(r.file!.path))).toBe(sha(data))
      expect(fs.statSync(r.file!.path).mode & 0o777).toBe(0o600)
      fs.rmSync(r.file!.path)
    }
    expect(left()).toEqual([])
  })

  test('an empty file and a body with no file part', async () => {
    const a = await spoolMultipart(streamed(split(form([{ name: 'file', filename: 'empty.txt', data: '' }]), 16)).req, { maxBytes: 100, dir })
    expect(a.file).toMatchObject({ size: 0, name: 'empty.txt', sha256: sha(new Uint8Array()) })
    fs.rmSync(a.file!.path)
    const b = await spoolMultipart(streamed(split(form([{ name: 'folder', data: 'shared' }]), 16)).req, { maxBytes: 100, dir })
    expect(b).toEqual({ fields: { folder: 'shared' }, file: null })
    // a repeated field: the last one counts; a preamble before the first delimiter is passed over
    const body = Buffer.concat([Buffer.from(`not a part, though it names --${BOUNDARY} in a line\r\n`), form([{ name: 'name', data: 'one' }, { name: 'name', data: 'two' }])])
    for (const size of [1, 5, 4096]) expect((await spoolMultipart(streamed(split(body, size)).req, { maxBytes: 100, dir })).fields).toEqual({ name: 'two' })
  })

  test('a body without a length that never ends: refused once the limit is passed, the rest is not read', async () => {
    const maxBytes = 4 * 1024 * 1024
    const chunk = new Uint8Array(256 * 1024).fill(7)
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="huge.bin"\r\n\r\n`)
    // 100 MB would follow: the reader must stop long before
    const { req, state } = streamed(function* () { yield new Uint8Array(head); for (let i = 0; i < 400; i++) yield chunk })
    expect(await code(spoolMultipart(req, { maxBytes, dir }))).toBe('payload_too_large')
    expect(state.pulled).toBeLessThanOrEqual(maxBytes + MULTIPART_OVERHEAD_MAX + chunk.byteLength)
    expect(state.cancelled).toBe(true)
    expect(left()).toEqual([])
  })

  test('a declared length over the limit: refused before a byte is read', async () => {
    const { req, state } = streamed(split(form([{ name: 'file', filename: 'a.bin', data: 'x' }]), 8), { 'content-length': String(10 * 1024 * 1024) })
    expect(await code(spoolMultipart(req, { maxBytes: 1024, dir }))).toBe('payload_too_large')
    expect(state.pulled).toBe(0)
    expect(left()).toEqual([])
  })

  test('text fields cannot be used to pass the limit', async () => {
    const { req } = streamed(split(form([{ name: 'note', data: 'n'.repeat(MULTIPART_OVERHEAD_MAX + 1) }, { name: 'file', filename: 'a.bin', data: 'x' }]), 4096))
    expect(await code(spoolMultipart(req, { maxBytes: 1024 * 1024, dir }))).toBe('payload_too_large')
    expect(left()).toEqual([])
  })

  test('a connection dropped on the way leaves no temp file', async () => {
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="cut.bin"\r\n\r\n`)
    const { req } = streamed(function* () { yield new Uint8Array(head); yield new Uint8Array(100_000); throw new Error('connection reset') })
    expect(await code(spoolMultipart(req, { maxBytes: 1024 * 1024, dir }))).toContain('threw')
    // and a body that ends before its last delimiter
    const cut = form([{ name: 'file', filename: 'cut.bin', data: crypto.randomBytes(5000) }]).subarray(0, 3000)
    expect(await code(spoolMultipart(streamed(split(cut, 512)).req, { maxBytes: 1024 * 1024, dir }))).toBe('bad_request')
    expect(left()).toEqual([])
  })

  test('not multipart, a second file, a file under another field: 400, nothing kept', async () => {
    const two = form([{ name: 'file', filename: 'a.bin', data: 'a' }, { name: 'file', filename: 'b.bin', data: 'b' }])
    expect(await code(spoolMultipart(streamed(split(two, 64)).req, { maxBytes: 1024, dir }))).toBe('bad_request')
    const other = form([{ name: 'avatar', filename: '../../etc/passwd', data: 'a' }])
    expect(await code(spoolMultipart(streamed(split(other, 64)).req, { maxBytes: 1024, dir }))).toBe('bad_request')
    expect(await code(spoolMultipart(new Request('http://x/', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), { maxBytes: 1024, dir }))).toBe('bad_request')
    expect(await code(spoolMultipart(streamed(split(Buffer.from('no delimiter here at all'), 5)).req, { maxBytes: 1024, dir }))).toBe('bad_request')
    expect(left()).toEqual([])
  })

  test('the temp file is named by the server, never by the part', async () => {
    const r = await spoolMultipart(streamed(split(form([{ name: 'file', filename: '../../../outside.txt', data: 'x' }]), 64)).req, { maxBytes: 1024, dir })
    expect(path.dirname(r.file!.path)).toBe(dir)
    expect(path.basename(r.file!.path)).toMatch(/^up-[0-9a-f]{24}$/)
    fs.rmSync(r.file!.path)
  })
})

describe('files sent in a room', () => {
  let h: Harness
  let room: string
  let dm: string
  beforeAll(async () => {
    h = await startHarness({ name: 'http-multipart-stream' })
    // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short
    const db = h.ctx.db
    db.exec('PRAGMA foreign_keys = OFF')
    for (const g of ['marketing', 'finance']) {
      const id = uuidv7()
      for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
        db.query(sql).run(id, g)
    }
    db.exec('PRAGMA foreign_keys = ON')
    room = ((await h.api('alice').call(API.listRooms)).items as Room[]).find((r) => r.kind === 'all')!.id
    dm = (await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'bob' } })).id
  })
  afterAll(async () => { await h.close() })
  const tmp = () => { try { return fs.readdirSync(path.join(h.ctx.config.dataDir, 'uploads', 'tmp')) } catch { return [] } }
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('one request: stored as sent, no temp file left', async () => {
    const data = crypto.randomBytes(300_000)
    const fd = new FormData()
    fd.set('size', String(data.length))
    fd.set('file', new File([data], '회의록.bin'))
    const r = await h.req('alice', `/api/rooms/${room}/files`, { method: 'POST', body: fd })
    expect(r.status).toBe(201)
    const f = (await r.json()) as RoomFile
    expect(f).toMatchObject({ name: '회의록.bin', size: data.length })
    const got = await h.req('alice', `/api/rooms/${room}/files/${f.id}`)
    expect(sha(new Uint8Array(await got.arrayBuffer()))).toBe(sha(data))
    expect(tmp()).toEqual([])
  })

  test('a body without a length, larger than one request may be: 413 while it streams, the server reads no more', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(1)
    const head = new TextEncoder().encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\n`)
    let sent = 0
    // 200 MB on offer, four times what one request may carry
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent === 0) { sent += head.length; return c.enqueue(head) }
        if (sent > 200 * 1024 * 1024) return c.close()
        sent += chunk.length
        c.enqueue(chunk)
      },
    })
    const r = await h.req('alice', `/api/rooms/${room}/files`, { method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, duplex: 'half', keepalive: false } as Parameters<Harness['req']>[2]).catch((e: unknown) => e)
    // the answer is 413; a client still writing when the server stops reading may see its connection closed instead
    if (r instanceof Response) {
      expect(r.status).toBe(413)
      // what was still on its way is not the next request: the answer ends the connection (this test's own connection is
      // not used again either: keepalive false)
      expect(r.headers.get('connection')).toBe('close')
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('payload_too_large')
    }
    // it answered long before the 200 MB were sent (reading the body whole first, the old fault, takes all of it)
    expect(sent).toBeLessThan(150 * 1024 * 1024)
    expect(tmp()).toEqual([])
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM room_files WHERE name = 'big.bin'").get() as { n: number }).n).toBe(0)
  })

  test('a larger file goes in pieces through an upload session and is sent like any upload', async () => {
    const data = crypto.randomBytes(UPLOAD_CHUNK_SIZE + 12_345)
    const r0 = await h.req('alice', '/api/upload-sessions', json({ target: { kind: 'room', roomId: dm, name: 'recording.mov' }, size: data.length, sha256: sha(data) }))
    const s = (await r0.json()) as UploadSession
    expect(s.chunkCount).toBe(2)
    for (let n = 0; n < s.chunkCount; n++) {
      const r = await h.req('alice', `/api/upload-sessions/${s.id}/chunks/${n}`, { method: 'PUT', body: data.subarray(n * s.chunkSize, (n + 1) * s.chunkSize) })
      expect(r.status).toBe(200)
    }
    const done = (await (await h.req('alice', `/api/upload-sessions/${s.id}/complete`, { method: 'POST' })).json()) as UploadComplete
    if (done.kind !== 'room') throw new Error(`unexpected result ${JSON.stringify(done)}`)
    expect(done.file).toMatchObject({ name: 'recording.mov', size: data.length })
    expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'uploads', `${s.id}.part`))).toBe(false)
    // mine only until it is sent
    expect((await h.req('bob', `/api/rooms/${dm}/files/${done.file.id}`)).status).toBe(404)
    const m = (await h.api('alice').call(API.sendRoomMessage, { params: { id: dm }, body: { body: '', clientMessageId: 'cm-' + crypto.randomUUID(), mentions: [], fileIds: [done.file.id] } })) as RoomMessage
    expect(m.files.map((f) => f.id)).toEqual([done.file.id])
    const got = await h.req('bob', `/api/rooms/${dm}/files/${done.file.id}`, { headers: { range: `bytes=${UPLOAD_CHUNK_SIZE}-` } })
    expect(got.status).toBe(206)
    expect(sha(new Uint8Array(await got.arrayBuffer()))).toBe(sha(data.subarray(UPLOAD_CHUNK_SIZE)))
  })

  test('refused before any byte is sent: over 10 GB (in plain words), a room I am not in, a name that is no file name', async () => {
    const start = (user: string, target: unknown, size: number) => h.req(user, '/api/upload-sessions', json({ target, size, sha256: 'a'.repeat(64) }))
    const big = await start('alice', { kind: 'room', roomId: dm, name: 'film.mov' }, ROOM_FILE_MAX + 1)
    expect(big.status).toBe(413)
    const err = ((await big.json()) as { error: { code: string; message: string; params?: { reason?: string } } }).error
    expect(err.code).toBe('payload_too_large')
    expect(err.message).toContain('10 GB')
    expect(err.params?.reason).toBe('room_file_too_large')
    expect((await start('alice', { kind: 'room', roomId: dm, name: 'film.mov' }, ROOM_FILE_MAX)).status).toBe(201)
    // carol is not in alice and bob's DM: the same answer as a room that does not exist
    expect((await start('carol', { kind: 'room', roomId: dm, name: 'film.mov' }, 100)).status).toBe(404)
    expect((await start('alice', { kind: 'room', roomId: dm, name: '../film.mov' }, 100)).status).toBe(400)
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM upload_sessions WHERE user_id = 'carol'").get()).toEqual({ n: 0 })
  })

  test('taken out of the room while the pieces went up: nothing is kept there', async () => {
    const group = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['bob', 'carol'] } })) as Room
    const data = crypto.randomBytes(2000)
    const s = (await (await h.req('bob', '/api/upload-sessions', json({ target: { kind: 'room', roomId: group.id, name: 'late.bin' }, size: data.length, sha256: sha(data) }))).json()) as UploadSession
    expect((await h.req('bob', `/api/upload-sessions/${s.id}/chunks/0`, { method: 'PUT', body: data })).status).toBe(200)
    await h.api('bob').call(API.leaveRoom, { params: { id: group.id } })
    expect((await h.req('bob', `/api/upload-sessions/${s.id}/complete`, { method: 'POST' })).status).toBe(404)
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM room_files WHERE name = 'late.bin'").get() as { n: number }).n).toBe(0)
    // it can never finish: the session and its part file are gone at once (not kept for a day)
    expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'uploads', `${s.id}.part`))).toBe(false)
    expect(h.ctx.db.query('SELECT 1 FROM upload_sessions WHERE id = ?').get(s.id)).toBeNull()
    // and no new one for a room I am no longer in
    expect((await h.req('bob', '/api/upload-sessions', json({ target: { kind: 'room', roomId: group.id, name: 'late.bin' }, size: data.length, sha256: sha(data) }))).status).toBe(404)
  })

  test('a finished upload whose chip is taken out before sending: cancelling the session removes the unsent file', async () => {
    const data = crypto.randomBytes(3000)
    const s = (await (await h.req('alice', '/api/upload-sessions', json({ target: { kind: 'room', roomId: dm, name: 'second-thoughts.bin' }, size: data.length, sha256: sha(data) }))).json()) as UploadSession
    await h.req('alice', `/api/upload-sessions/${s.id}/chunks/0`, { method: 'PUT', body: data })
    const done = (await (await h.req('alice', `/api/upload-sessions/${s.id}/complete`, { method: 'POST' })).json()) as UploadComplete
    if (done.kind !== 'room') throw new Error('unexpected result')
    expect((await h.req('alice', `/api/rooms/${dm}/files/${done.file.id}`)).status).toBe(200)
    expect((await h.req('alice', `/api/upload-sessions/${s.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await h.req('alice', `/api/rooms/${dm}/files/${done.file.id}`)).status).toBe(404)
    expect(h.ctx.db.query('SELECT 1 FROM room_files WHERE id = ?').get(done.file.id)).toBeNull()
  })

  test('a file named like a picture but larger than one request is kept as a plain file (never read whole for a preview)', async () => {
    // a sparse file of 50 MB + 1 with a PNG's first bytes, placed the way a finished upload session places it
    const p = path.join(h.ctx.config.dataDir, 'uploads', 'sparse-test.part')
    const fd = fs.openSync(p, 'w')
    fs.writeSync(fd, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
    fs.ftruncateSync(fd, SMALL_UPLOAD_MAX + 1)
    fs.closeSync(fd)
    const { roomFilesOf } = await import('../../server/src/rooms/files')
    const f = await roomFilesOf(h.ctx).create('alice', room, 'poster.png', p, 'b'.repeat(64))
    expect(f).toMatchObject({ name: 'poster.png', kind: 'other', thumb: false, size: SMALL_UPLOAD_MAX + 1 })
    expect(fs.existsSync(p)).toBe(false)
  })
})
