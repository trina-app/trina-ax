// The composer's engine picker shows only when there is something to choose (components/chat/EngineMenu.tsx
// engineChoiceCount, owner 2026-11-11): one engine without models (or the API engine with its one model) is one choice, so no "Default AI" picker.
import { expect, test } from 'bun:test'
import { engineChoiceCount } from '../../src/components/chat/EngineMenu'

test('per engine its default and each model; the API engine\'s one model is its default', () => {
  expect(engineChoiceCount([])).toBe(0)
  expect(engineChoiceCount(['claude-code'])).toBe(1)
  expect(engineChoiceCount(['api'], { api: [{ id: 'm', label: 'M' }] })).toBe(1)
  expect(engineChoiceCount(['claude-code'], { 'claude-code': [{ id: 'opus', label: 'Opus' }] })).toBe(2)
  expect(engineChoiceCount(['claude-code'], { 'claude-code': [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] })).toBe(3)
  expect(engineChoiceCount(['claude-code', 'codex'])).toBe(2)
})
