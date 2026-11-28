// The API engine form's presets and small rules, without React (tests/unit/api-engine-settings-form.test.ts).

/** Presets of the API engine's address (any OpenAI-compatible Chat Completions API works with "custom"). */
/** `keys`: where that provider's API keys are made (QA TC-2312, the same kind of link as Add account's and Voice input's);
 * Ollama runs on the server's own computer and needs none; its option says so in the person's words (Engines.tsx). */
export const API_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', keys: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Claude API (Anthropic)', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', keys: 'https://platform.claude.com/settings/keys' },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keys: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.4-mini', keys: 'https://openrouter.ai/keys' },
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', keys: null },
] as const

/** Words that name a provider in a display name ("QA OpenRouter", "Claude via API") */
const PRESET_NAMES: Record<string, readonly string[]> = {
  // the provider's own word first: OpenRouter serves the others' models, so only that one counts after picking it
  openai: ['openai', 'gpt', 'chatgpt'],
  anthropic: ['anthropic', 'claude'],
  gemini: ['google', 'gemini'],
  openrouter: ['openrouter'],
  ollama: ['ollama'],
}

/** The Display name after the provider changes from `from` to `to` (QA TC-6924): emptied (the server then names the
 * engine after its model, and the field shows the new model as its placeholder) when it was the default (empty or the
 * old model), a provider's own name, or a name that mentions another provider ("QA OpenRouter" after picking Ollama).
 * A name the admin chose that names no provider ("Office AI") is kept. */
export function presetLabel(current: string, o: { model: string; from: string; to: string }): string {
  const typed = current.trim()
  if (!typed || o.from === o.to) return current
  const lower = typed.toLowerCase()
  const stale = typed === o.model.trim() || API_PRESETS.some((p) => p.label.toLowerCase() === lower)
    || Object.entries(PRESET_NAMES).some(([id, words]) => id !== o.to && (o.to === 'openrouter' ? words.slice(0, 1) : words).some((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(lower)))
  return stale ? '' : current
}

/** The body of a save. No new key typed and a new address whose provider needs no key (Ollama): the old key goes
 * (QA TC-4826; the server never sends a stored key to a new address, and a newcomer would not guess "Remove key"). */
export function apiSaveKey(o: { typed: string; savedBaseUrl: string | null; baseUrl: string; hasKey: boolean }): string | null | undefined {
  if (o.typed.trim()) return o.typed.trim()
  const p = API_PRESETS.find((x) => x.baseUrl === o.baseUrl.trim())
  if (o.hasKey && p && p.keys === null && (o.savedBaseUrl ?? '') !== o.baseUrl.trim()) return null
  return undefined
}

/** Only the owner sets an http address (one on this computer or the local network: the server refuses an admin's,
 * routes/admin.ts); an admin sees why up front (QA TC-4825) */
export const ownerOnlyAddress = (baseUrl: string) => /^http:\/\//i.test(baseUrl.trim())
