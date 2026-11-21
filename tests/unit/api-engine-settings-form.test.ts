// The API engine form's small rules (web/src/pages/admin/Engines.tsx): an admin sees that a local (http) address is the
// owner's to set (QA TC-4825), and switching to Ollama from a provider with a key drops the old key in the same save
// (QA TC-4826; the server never sends a stored key to a new address).
import { expect, test } from 'bun:test'
import { API_PRESETS, apiSaveKey, ownerOnlyAddress } from '../../web/src/pages/admin/apiEngineRules'

const ollama = API_PRESETS.find((p) => p.id === 'ollama')!.baseUrl

test('an http address is the owner\'s to set; https ones are not', () => {
  expect(ownerOnlyAddress(ollama)).toBe(true)
  expect(ownerOnlyAddress(' http://10.0.0.5:8000/v1')).toBe(true)
  for (const p of API_PRESETS.filter((x) => x.id !== 'ollama')) expect(ownerOnlyAddress(p.baseUrl)).toBe(false)
})

test('the key a save sends', () => {
  const openrouter = 'https://openrouter.ai/api/v1'
  // a typed key goes as it is
  expect(apiSaveKey({ typed: ' sk-new ', savedBaseUrl: openrouter, baseUrl: ollama, hasKey: true })).toBe('sk-new')
  // to Ollama from a keyed provider, nothing typed: the old key goes
  expect(apiSaveKey({ typed: '', savedBaseUrl: openrouter, baseUrl: ollama, hasKey: true })).toBeNull()
  // Ollama saved again (model change): nothing to drop
  expect(apiSaveKey({ typed: '', savedBaseUrl: ollama, baseUrl: ollama, hasKey: false })).toBeUndefined()
  // another keyed provider, nothing typed: the key is kept (the server says to enter one for a new address)
  expect(apiSaveKey({ typed: '', savedBaseUrl: openrouter, baseUrl: 'https://api.openai.com/v1', hasKey: true })).toBeUndefined()
  expect(apiSaveKey({ typed: '', savedBaseUrl: openrouter, baseUrl: openrouter, hasKey: true })).toBeUndefined()
})
