// Admin > Providers, managed mode: a team connection that only waits for a limit to end is "limited" (set up, back
// by itself), not "not_logged_in"; a refused or expired one, or none at all, still is.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EngineStatus } from '@mycel/shared/api'
import { checkEngine, type EngineEnv } from '../../server/src/admin/engines'
import { onlyWaitingForLimit } from '../../server/src/credentials/resolve'
import { checkEngines } from '../../server/src/system/engines'

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
  test('every account only switched off: the line says so and to switch one on, not refused / expired / limit (TC-3043)', async () => {
    const off = await checkEngine('claude-code', env(() => ({ total: 2, usable: 0, reasons: ['disabled', 'disabled'] })), true, 'en')
    expect(off).toMatchObject({ status: 'not_logged_in', detail: "This engine's AI accounts are all switched off. Switch one on below with ⋯ › Switch on." })
    const ko = await checkEngine('claude-code', env(() => ({ total: 1, usable: 0, reasons: ['disabled'] })), true, 'ko')
    expect(ko.detail).toBe("이 엔진의 AI 계정이 모두 꺼져 있어요. 아래 계정의 ⋯ 메뉴에서 '켜기'를 눌러 주세요.")
    // one switched off and one refused: the refused one is the problem, so the reasons line stays
    const mixed = await checkEngine('claude-code', env(() => ({ total: 2, usable: 0, reasons: ['disabled', 'invalid'] })), true, 'en')
    expect(mixed.detail).toContain('refused, expired or at their limit')
    // none at all: the no-account line
    const none = await checkEngine('claude-code', env(() => ({ total: 0, usable: 0, reasons: [] })), true, 'en')
    expect(none.detail).toContain('no AI account yet')
  })
})

// QA on WSL2 (2026-11-27): `mycel-ctl status` said engine.claude-code fail while the team's Claude subscription only
// waited for its usage limit to end. The diagnostics (system/engines.ts) took "limited" only when every connection
// was limited, Admin > Providers (above) when one is and none is refused: one rule now (credentials/resolve.ts).
describe('the diagnostics read limited connections with the same rule as Admin > Providers', () => {
  const managed = (reasons: string[]) => checkEngines({
    authMode: 'managed', roleAccount: true, claudeBin: claude, codexBin: null, secretsDir: dir,
    managed: { 'claude-code': { total: reasons.length, usable: 0, expiring: 0, reasons }, codex: { total: 0, usable: 0, expiring: 0, reasons: [] } },
  }).then((r) => r.find((e) => e.engine === 'claude-code')!.reason)
  test('limited, also beside one switched off, not allowed here or with sharing off: credential_limited (warn)', async () => {
    for (const r of [['limited'], ['over_limit'], ['limited', 'disabled'], ['over_limit', 'kind_off'], ['limited', 'sharing_off']])
      expect(`${r}: ${await managed(r)}`).toBe(`${r}: credential_limited`)
  })
  test('a refused, expired or signed-out one beside it, or nothing waiting for a limit: credential_unusable (fail)', async () => {
    for (const r of [['limited', 'invalid'], ['limited', 'needs_reconnect'], ['over_limit', 'expired'], ['disabled'], ['no_credit']])
      expect(`${r}: ${await managed(r)}`).toBe(`${r}: credential_unusable`)
    expect(await managed([])).toBe('credential_none')
  })
  test('both screens call the one rule', () => {
    const src = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../../server/src', f), 'utf8')
    for (const f of ['system/engines.ts', 'admin/engines.ts']) expect(`${f}: ${src(f).includes('onlyWaitingForLimit(')}`).toBe(`${f}: true`)
    expect(onlyWaitingForLimit(['limited', 'disabled'])).toBe(true)
    expect(onlyWaitingForLimit(['limited', 'invalid'])).toBe(false)
  })
})
