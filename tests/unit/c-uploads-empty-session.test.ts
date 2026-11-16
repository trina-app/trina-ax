// An upload session that has not received a chunk lives an hour (server/src/uploads/sessions.ts SESSION_EMPTY_TTL_MS):
// nothing of it could be resumed, and until it goes it holds its whole size of the team's disk room and one of the
// person's ten sessions (a tab closed as a 10 GB upload started). The first chunk gives it the usual 24 hours, so a
// started upload still resumes the next morning.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { UploadSession } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { componentC } from '../../server/src/team-files/component'
import { SESSION_EMPTY_TTL_MS, SESSION_TTL_MS } from '../../server/src/uploads/sessions'

setDefaultTimeout(60_000)
let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'c-uploads-empty-session' }) })
afterAll(async () => { await h.close() })

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const start = async (data: Uint8Array, name: string) =>
  (await (await h.req('alice', '/api/upload-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { kind: 'path', path: `users/alice/${name}`, onExists: 'rename' }, size: data.length, sha256: sha(data) }) })).json()) as UploadSession
const left = (s: UploadSession) => Date.parse(s.expiresAt) - Date.now()
const part = (id: string) => path.join(h.ctx.config.dataDir, 'uploads', `${id}.part`)
const near = (ms: number, want: number) => Math.abs(ms - want) < 60_000

describe('an upload session with no chunk yet', () => {
  test('lives an hour; its first chunk gives it 24 hours', async () => {
    const data = crypto.randomBytes(5000)
    const s = await start(data, 'a.bin')
    expect(near(left(s), SESSION_EMPTY_TTL_MS)).toBe(true)
    expect((await h.req('alice', `/api/upload-sessions/${s.id}/chunks/0`, { method: 'PUT', body: data })).status).toBe(200)
    const now = (await (await h.req('alice', `/api/upload-sessions/${s.id}`)).json()) as UploadSession
    expect(near(left(now), SESSION_TTL_MS)).toBe(true)
    expect((await h.req('alice', `/api/upload-sessions/${s.id}/complete`, { method: 'POST' })).status).toBe(200)
  })

  test('after its hour it is gone with its disk room, and says so in plain words; a started one stays', async () => {
    const data = crypto.randomBytes(5000)
    const empty = await start(data, 'never-started.bin')
    const started = await start(data.subarray(0, 4000), 'started.bin')
    await h.req('alice', `/api/upload-sessions/${started.id}/chunks/0`, { method: 'PUT', body: data.subarray(0, 4000) })
    expect(fs.existsSync(part(empty.id))).toBe(true)
    // 61 minutes later
    const later = Date.now() + SESSION_EMPTY_TTL_MS + 60_000
    expect(componentC(h.ctx).uploads.sweep(later)).toBe(1)
    expect(fs.existsSync(part(empty.id))).toBe(false)
    expect(fs.existsSync(part(started.id))).toBe(true)
    expect((await h.req('alice', `/api/upload-sessions/${started.id}`)).status).toBe(200)
    // a chunk that comes for a session whose hour passed before the sweep ran
    const late = await start(data, 'late.bin')
    h.ctx.db.query('UPDATE upload_sessions SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), late.id)
    const r = await h.req('alice', `/api/upload-sessions/${late.id}/chunks/0`, { method: 'PUT', body: data, headers: { 'accept-language': 'en' } })
    expect(r.status).toBe(410)
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/did not start within an hour/)
    expect(fs.existsSync(part(late.id))).toBe(false)
  })
})
