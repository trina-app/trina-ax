// The speech model ahead of first use (QA TC-4919, docs/decisions/20261118-speech-model-ahead.md): where speech is
// "this server" and whisper.cpp is there, the server downloads the model itself; a failed download waits longer each
// time; off when speech is not local, without whisper.cpp, or with MYCEL_SPEECH_PREFETCH=0. A local server stands in
// for the model's address.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { modelProgress, type TranscribeConfig } from '../../server/src/jobs/transcribe'
import { PREFETCH_RETRY_MS, startModelPrefetch, wantsModel } from '../../server/src/jobs/model-prefetch'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(30_000)

let A: CApp
let srv: ReturnType<typeof Bun.serve>
let fail = false
const BODY = 'a tiny model'
beforeAll(async () => {
  A = await makeCApp('model-prefetch')
  srv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return fail ? new Response('down', { status: 503 }) : new Response(BODY) } })
})
afterAll(async () => { srv?.stop(true); await A?.close() })

const cfg = (dir: string): TranscribeConfig => ({
  ...A.ctx.files.speech, whisperBin: '/usr/bin/true', modelDir: path.join(A.data, dir), sharedModelDir: null, baseUrl: `http://127.0.0.1:${(srv as { port: number }).port}/`,
  modelOverride: { file: 'tiny.bin', size: BODY.length, sha256: crypto.createHash('sha256').update(BODY).digest('hex') },
})

describe('the speech model ahead of first use', () => {
  test('only where speech is local and whisper.cpp is installed', () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'off' })
    expect(wantsModel(A.ctx.db, cfg('m0'))).toBe(false)
    updateTeamSettings(A.ctx.db, { speechProvider: 'local' })
    expect(wantsModel(A.ctx.db, cfg('m0'))).toBe(true)
    expect(wantsModel(A.ctx.db, { ...cfg('m0'), whisperBin: null })).toBe(false)
  })
  test('downloaded by the server itself, then ready; turned off by MYCEL_SPEECH_PREFETCH=0', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'local' })
    const off = startModelPrefetch({ db: A.ctx.db, cfg: cfg('m1'), env: { MYCEL_SPEECH_PREFETCH: '0' }, firstMs: 1e9, checkMs: 1e9 })
    expect(await off.tick()).toBe('skipped')
    off.stop()
    const p = startModelPrefetch({ db: A.ctx.db, cfg: cfg('m1'), env: {}, firstMs: 1e9, checkMs: 1e9 })
    try {
      expect(await p.tick()).toBe('downloaded')
      expect(fs.readFileSync(path.join(A.data, 'm1', 'tiny.bin'), 'utf8')).toBe(BODY)
      expect(await p.tick()).toBe('ready')
      expect(modelProgress()).toBeNull()
    } finally { p.stop() }
  })
  test('a failed download waits before the next try, longer each time', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'local' })
    let now = 1_000_000
    fail = true
    const p = startModelPrefetch({ db: A.ctx.db, cfg: cfg('m2'), env: {}, firstMs: 1e9, checkMs: 1e9, now: () => now })
    try {
      expect(await p.tick()).toBe('failed')
      expect(await p.tick()).toBe('waiting')
      now += PREFETCH_RETRY_MS + 1
      expect(await p.tick()).toBe('failed')
      now += PREFETCH_RETRY_MS + 1
      expect(await p.tick()).toBe('waiting') // the second pause is twice as long
      now += PREFETCH_RETRY_MS
      fail = false
      expect(await p.tick()).toBe('downloaded')
    } finally { fail = false; p.stop() }
  })
  test('speech off: nothing is downloaded', async () => {
    updateTeamSettings(A.ctx.db, { speechProvider: 'off' })
    const p = startModelPrefetch({ db: A.ctx.db, cfg: cfg('m3'), env: {}, firstMs: 1e9, checkMs: 1e9 })
    try {
      expect(await p.tick()).toBe('skipped')
      expect(fs.existsSync(path.join(A.data, 'm3', 'tiny.bin'))).toBe(false)
    } finally { p.stop() }
  })
})
