// Admin › Team settings › AI defaults: the "Default engine" list has only the engines that can be the team default
// (switched on, there on this installation, not Codex in beta), as the server decides (routes/admin.ts updateEngines);
// a saved default that is off since stays, marked off, instead of the screen quietly showing another (QA TC-182).
import { describe, expect, test } from 'bun:test'
import type { EngineId, EnginesResponse } from '@mycel/shared/api'
import { defaultEngineChoices } from '../../src/pages/admin/TeamAiSettings'

type Engine = EnginesResponse['engines'][number]
const engine = (id: EngineId, over: Partial<Engine> = {}): Engine => ({
  id, label: id, enabled: true, authMode: 'local-login', installed: true, version: '1', status: 'ok', detail: null, models: [], checkedAt: null, ...over,
})

describe('defaultEngineChoices', () => {
  test('engines switched off are not listed', () => {
    const list = [engine('claude-code'), engine('codex', { enabled: false }), engine('api', { enabled: false })]
    expect(defaultEngineChoices(list, 'claude-code')).toEqual([{ id: 'claude-code', off: false }])
  })
  test('all on: all listed, in order', () => {
    const list = [engine('claude-code'), engine('codex', { status: 'not_logged_in' }), engine('api')]
    expect(defaultEngineChoices(list, 'claude-code').map((c) => c.id)).toEqual(['claude-code', 'codex', 'api'])
  })
  test('the API engine without its settings and Codex turned off by the installation (not installed) are not listed', () => {
    const list = [engine('claude-code'), engine('codex', { installed: false, status: 'not_installed' }), engine('api', { installed: false, status: 'not_installed' })]
    expect(defaultEngineChoices(list, 'claude-code').map((c) => c.id)).toEqual(['claude-code'])
  })
  test('a check that failed or timed out (installed unknown) keeps the engine listed', () => {
    expect(defaultEngineChoices([engine('claude-code'), engine('codex', { installed: false, status: 'error' })], 'codex')).toEqual([{ id: 'claude-code', off: false }, { id: 'codex', off: false }])
  })
  test('Claude is listed while its program is missing (the server lets it be the default)', () => {
    expect(defaultEngineChoices([engine('claude-code', { installed: false, status: 'not_installed' })], 'claude-code')).toEqual([{ id: 'claude-code', off: false }])
  })
  test('Codex in beta is never offered as the default', () => {
    expect(defaultEngineChoices([engine('claude-code'), engine('codex', { beta: true })], 'claude-code').map((c) => c.id)).toEqual(['claude-code'])
  })
  test('a saved default that is off now stays, marked off; the others that are off do not', () => {
    const list = [engine('claude-code'), engine('codex', { installed: false, status: 'not_installed' }), engine('api', { enabled: false })]
    expect(defaultEngineChoices(list, 'codex')).toEqual([{ id: 'claude-code', off: false }, { id: 'codex', off: true }])
  })
})
