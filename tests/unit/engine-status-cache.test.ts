// The engines' last check (admin/engines.ts EngineStatusCache, kept 10 minutes): a change of the team's AI connections
// drops it, also while a check runs (that check read the old connections and is not kept), so Admin › AI providers says
// "Connected" right after a sign-in instead of "Sign-in needed" for up to 10 minutes.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EngineStatusCache, type EngineEnv } from '../../server/src/admin/engines'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cache-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const claude = path.join(dir, 'claude')
fs.writeFileSync(claude, '#!/bin/sh\necho "2.1.305 (Claude Code)"\n', { mode: 0o755 })

// managed mode: the status follows the team's connections (none usable: not_logged_in; one: ok)
let usable = 0
let reads = 0
const env = (): EngineEnv => ({
  mode: 'prod', authMode: 'managed', claudeBin: claude, codexBin: '', dataDir: dir, secretsDir: dir, versionsFile: null, codexCatalogs: [],
  credentials: () => { reads++; return { total: usable, usable } },
})

describe('engine status cache', () => {
  test('kept until forgotten; forgotten: the next read checks again', async () => {
    usable = 0
    const c = new EngineStatusCache(env)
    expect((await c.get('claude-code', true, 'en')).status).toBe('not_logged_in')
    usable = 1
    expect((await c.get('claude-code', true, 'en')).status).toBe('not_logged_in') // the kept check
    c.forget('claude-code')
    expect(c.peek('claude-code')).toBeNull()
    expect((await c.get('claude-code', true, 'en')).status).toBe('ok')
  })

  test('a check that was running when the connections changed is not kept, and a read after the change does not wait for it', async () => {
    usable = 0; reads = 0
    const c = new EngineStatusCache(env)
    const before = c.get('claude-code', true, 'en') // started before the sign-in finished
    usable = 1
    c.forget('claude-code') // the sign-in finished while it ran
    const after = c.get('claude-code', true, 'en') // Admin › AI providers asks again
    // the one that was running answers for its own caller; it is not what the next read gets
    await before
    expect((await after).status).toBe('ok')
    expect(c.peek('claude-code')).toBe('ok')
    expect((await c.get('claude-code', true, 'en')).status).toBe('ok')
    expect(reads).toBe(2)
  })
})
