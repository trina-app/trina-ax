// Admin > AI engines, managed mode: a team connection that only waits for a limit to end is "limited" (set up, back
// by itself), not "not_logged_in"; a refused or expired one, or none at all, still is.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EngineStatus } from '@mycel/shared/api'
import { checkEngine, type EngineEnv } from '../../server/src/admin/engines'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-limited-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const claude = path.join(dir, 'claude')
fs.writeFileSync(claude, '#!/bin/sh\necho "2.1.305 (Claude Code)"\n', { mode: 0o755 })

const env = (credentials: EngineEnv['credentials']): EngineEnv => ({
  mode: 'prod', authMode: 'managed', claudeBin: claude, codexBin: '', dataDir: dir, secretsDir: dir, versionsFile: null, codexCatalogs: [], credentials,
})
const until = '2030-11-07T13:59:00.000Z'

describe('managed engine status with limited connections', () => {
  test('only limited connections: limited, with the end time, and the shared schema accepts it', async () => {
    const s = await checkEngine('claude-code', env(() => ({ total: 1, usable: 0, reasons: ['limited'], limitedUntil: until })), true, 'ko')
    expect(s).toMatchObject({ status: 'limited', limitedUntil: until, installed: true })
    expect(EngineStatus.safeParse(s).success).toBe(true)
  })
  test('a monthly limit (over_limit) is limited too; a disabled connection beside it does not change that', async () => {
    const s = await checkEngine('claude-code', env(() => ({ total: 2, usable: 0, reasons: ['over_limit', 'disabled'], limitedUntil: until })), true, 'en')
    expect(s.status).toBe('limited')
  })
  test('limited with no end date says so with null', async () => {
    const s = await checkEngine('claude-code', env(() => ({ total: 1, usable: 0, reasons: ['limited'] })), true, 'en')
    expect(s).toMatchObject({ status: 'limited', limitedUntil: null })
  })
  test('a refused, expired or signed-out connection beside a limited one is still not_logged_in', async () => {
    for (const bad of ['invalid', 'needs_reconnect', 'expired']) {
      const s = await checkEngine('claude-code', env(() => ({ total: 2, usable: 0, reasons: ['limited', bad], limitedUntil: until })), true, 'en')
      expect(s.status).toBe('not_logged_in')
    }
  })
  test('no connection at all, or none usable for another reason: not_logged_in; a usable one: ok', async () => {
    expect((await checkEngine('claude-code', env(() => ({ total: 0, usable: 0, reasons: [] })), true, 'en')).status).toBe('not_logged_in')
    expect((await checkEngine('claude-code', env(() => ({ total: 1, usable: 0, reasons: ['disabled'] })), true, 'en')).status).toBe('not_logged_in')
    expect((await checkEngine('claude-code', env(() => ({ total: 2, usable: 1, reasons: ['limited'], limitedUntil: until })), true, 'en')).status).toBe('ok')
  })
})
