// Admin › Home and Providers in plain words: an engine's untested version or failed lockdown test, and the server's
// internals (socket paths, sandbox, launcher, …), are for Admin › System › Diagnostics only (pages/admin/plain.ts).
import { expect, test } from 'bun:test'
import type { EngineStatus } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { engineVersionChecks, homeCheck, technicalEngineState } from '../../src/pages/admin/plain'

const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate('en', k, v)
const engine = (id: EngineStatus['id'], status: EngineStatus['status'], o: Partial<EngineStatus> = {}) =>
  ({ id, label: id === 'codex' ? 'Codex' : 'Claude Code', enabled: true, status, detail: null, ...o }) as EngineStatus

test('an untested version or a failed lockdown test is technical; signed out, not installed or an error is not', () => {
  expect(technicalEngineState('version_unsupported')).toBe(true)
  expect(technicalEngineState('lockdown_failed')).toBe(true)
  for (const s of ['ok', 'limited', 'not_installed', 'not_logged_in', 'error', 'unknown'] as const) expect(technicalEngineState(s)).toBe(false)
})

test('Home names an engine sign-in, the disk, backups and a failed update; never sockets, sandbox, launcher or relay', () => {
  for (const c of [{ id: 'engine.claude-code', group: 'engines' }, { id: 'disk', group: 'disk' }, { id: 'storage', group: 'disk' }, { id: 'backups', group: 'backups' }, { id: 'restore', group: 'backups' }, { id: 'update', group: 'update' }])
    expect(homeCheck(c)).toBe(true)
  for (const c of [{ id: 'sockets', group: 'engines' }, { id: 'credentials_key', group: 'engines' }, { id: 'model_proxy', group: 'engines' }, { id: 'sandbox', group: 'sandbox' }, { id: 'launcher', group: 'launcher' }, { id: 'relay', group: 'relay' }, { id: 'queue', group: 'queue' }, { id: 'time_machine', group: 'backups' }, { id: 'managed.plan', group: 'server' }, { id: 'release_signature', group: 'update' }])
    expect(homeCheck(c)).toBe(false)
})

test('Diagnostics gets one row per switched-on engine with an untested version or a failed lockdown test, with its detail', () => {
  const detail = 'This version has not been tested (pinned: 2.1.300; lockdown-tested: 2.1.300).'
  const rows = engineVersionChecks([
    engine('claude-code', 'version_unsupported', { detail }),
    engine('codex', 'lockdown_failed', { detail: 'The engine lockdown test failed for this version.' }),
    engine('codex', 'version_unsupported', { enabled: false }),
    engine('claude-code', 'ok'),
    engine('codex', 'not_logged_in'),
  ], t)
  expect(rows).toEqual([
    { id: 'engine-version.claude-code', group: 'engines', label: 'Claude Code: Untested version', status: 'warn', detail },
    { id: 'engine-version.codex', group: 'engines', label: 'Codex: Lockdown test failed', status: 'fail', detail: 'The engine lockdown test failed for this version.' },
  ])
})
