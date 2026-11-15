// The API engine form's Model field follows the provider (QA TC-2440): picking Claude API after OpenAI showed "gpt-4.1",
// because the field kept any value it already had. Now a provider's own default replaces an empty field or another
// provider's default; a model the person typed themselves is kept.
import { describe, expect, test } from 'bun:test'
import { API_PRESETS, presetModel } from '../../src/pages/admin/Engines'

const model = (id: string) => API_PRESETS.find((p) => p.id === id)!.model

describe('API engine: the model after a provider is picked', () => {
  test('every provider has its own default model, and the Claude one is a Claude model', () => {
    const models = API_PRESETS.map((p): string => p.model)
    expect(new Set(models).size).toBe(models.length)
    expect(model('anthropic')).toBe('claude-sonnet-5-5')
    for (const p of API_PRESETS) if (p.id !== 'anthropic') expect(p.model).not.toMatch(/^claude-/)
  })
  test('an empty field gets the provider\'s default', () => {
    for (const p of API_PRESETS) expect(presetModel('', p.id)).toBe(p.model)
    expect(presetModel('  ', 'gemini')).toBe(model('gemini'))
  })
  test('another provider\'s default is replaced: OpenAI then Claude API shows a Claude model', () => {
    expect(presetModel(model('openai'), 'anthropic')).toBe('claude-sonnet-5-5')
    for (const from of API_PRESETS) for (const to of API_PRESETS) expect(presetModel(from.model, to.id)).toBe(to.model)
  })
  test('the old OpenAI default saved by an earlier version is not kept either', () => {
    expect(presetModel('gpt-4.1', 'anthropic')).toBe('claude-sonnet-5-5')
    expect(presetModel('openai/gpt-4.1', 'gemini')).toBe(model('gemini'))
  })
  test('a model typed by the person is kept', () => {
    expect(presetModel('gpt-5.5', 'anthropic')).toBe('gpt-5.5')
    expect(presetModel('llama3.3:70b', 'ollama')).toBe('llama3.3:70b')
  })
  test('Custom (no provider) leaves the field alone', () => {
    expect(presetModel(model('openai'), 'custom')).toBe(model('openai'))
  })
})
