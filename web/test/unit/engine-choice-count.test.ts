// The composer's engine picker shows only when there is something to choose (components/chat/EngineMenu.tsx
// engineChoiceCount, owner 2026-11-11): one engine with at most one model is one choice, so no "Default AI" picker.
import { expect, test } from 'bun:test'
import { engineChoiceCount } from '../../src/components/chat/EngineMenu'

test('one choice per engine, and one more per model beyond the first', () => {
  expect(engineChoiceCount([])).toBe(0)
  expect(engineChoiceCount(['claude-code'])).toBe(1)
  expect(engineChoiceCount(['api'], { api: [{ id: 'm', label: 'M' }] })).toBe(1)
  expect(engineChoiceCount(['claude-code'], { 'claude-code': [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] })).toBe(3)
  expect(engineChoiceCount(['claude-code', 'codex'])).toBe(2)
})
