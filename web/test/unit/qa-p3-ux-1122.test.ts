// QA overnight C (2026-11-22) P3 findings, the parts that are plain rules:
// - TC-6922: a message opened from a link gets a neutral background that fades (index.css room-lit), still with reduced
//   motion; never an accent box (owner 2026-11-21).
// - TC-6923: a thread closed by a step back puts the room entry's ?m= away, the rest of the query kept.
// - TC-6924: the API engine's Display name follows the provider unless the admin chose one that names no provider.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { withoutTarget } from '../../src/lib/rooms'
import { API_PRESETS, presetLabel } from '../../src/pages/admin/apiEngineRules'
import { HIGHLIGHT_MS } from '../../src/components/rooms/RoomMessages'

describe('TC-6923: the room address after a thread closes', () => {
  test('?m= goes, the rest stays; nothing to put away: the same query', () => {
    expect(withoutTarget('?m=019a5f00-0000-7000-8000-000000000002')).toBe('')
    expect(withoutTarget('?m=abc&apps=add:slack')).toBe('?apps=add%3Aslack')
    expect(withoutTarget('?apps=1')).toBe('?apps=1')
    expect(withoutTarget('')).toBe('')
  })
})

describe('TC-6924: the Display name after the provider changes', () => {
  const model = (id: string) => API_PRESETS.find((p) => p.id === id)!.model
  test('a name that mentions the old provider goes (the QA case: "QA OpenRouter" after picking Ollama)', () => {
    expect(presetLabel('QA OpenRouter', { model: 'google/gemini-2.5-flash', from: 'openrouter', to: 'ollama' })).toBe('')
    expect(presetLabel('Claude via OpenRouter', { model: 'x', from: 'openrouter', to: 'anthropic' })).toBe('')
    expect(presetLabel('GPT-5 mini', { model: 'x', from: 'openai', to: 'gemini' })).toBe('')
  })
  test('the default (empty or the old model) and a provider\'s own name go too', () => {
    expect(presetLabel('', { model: model('openai'), from: 'openai', to: 'ollama' })).toBe('')
    expect(presetLabel(model('openai'), { model: model('openai'), from: 'openai', to: 'ollama' })).toBe('')
    for (const p of API_PRESETS) expect(presetLabel(p.label, { model: 'x', from: p.id, to: p.id === 'ollama' ? 'openai' : 'ollama' })).toBe('')
  })
  test('a name the admin chose that names no provider stays, and so does any name when the provider does not change', () => {
    expect(presetLabel('Office AI', { model: 'x', from: 'openrouter', to: 'ollama' })).toBe('Office AI')
    expect(presetLabel('Ollama box', { model: 'x', from: 'custom', to: 'ollama' })).toBe('Ollama box')
    expect(presetLabel('QA OpenRouter', { model: 'x', from: 'openrouter', to: 'openrouter' })).toBe('QA OpenRouter')
    // a word that only contains a provider's name is not one ("Googley" is not Google)
    // OpenRouter serves the others' models: a model family's name stays after picking it, a provider's name goes
    expect(presetLabel('Claude Sonnet', { model: 'x', from: 'anthropic', to: 'openrouter' })).toBe('Claude Sonnet')
    expect(presetLabel('Anthropic key', { model: 'x', from: 'anthropic', to: 'openrouter' })).toBe('')
    expect(presetLabel('Googley helper', { model: 'x', from: 'gemini', to: 'ollama' })).toBe('Googley helper')
  })
})

describe('TC-6922: the look of a message a link goes to', () => {
  const css = fs.readFileSync(path.join(import.meta.dir, '../../src/index.css'), 'utf8')
  test('a neutral background that fades over the mark\'s time, no accent; reduced motion: still, no animation', () => {
    const keyframes = css.match(/@keyframes room-lit \{[^\n]*\}/)?.[0] ?? ''
    expect(keyframes).toContain('var(--c-hover)')
    expect(keyframes).not.toContain('accent')
    expect(css).toContain(`[data-testid="room-message"][data-highlight] { animation: room-lit ${HIGHLIGHT_MS}ms ease-out; }`)
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('[data-testid="room-message"][data-highlight] { animation: none; background-color: var(--c-hover); }')
  })
})
