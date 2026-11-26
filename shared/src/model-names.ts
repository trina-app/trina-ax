// The names people read for an AI model id (Settings › Usage, Admin › Usage, the composer's picker when the engine
// lists a dated id): "claude-opus-5-5-20261101" is "Claude Opus", "claude-haiku-4-5" "Claude Haiku". Codex and other
// ids keep their own name (the Codex catalog already gives display names). The admin CSV keeps the real id.

const CLAUDE_FAMILY: Record<string, string> = { opus: 'Claude Opus', sonnet: 'Claude Sonnet', haiku: 'Claude Haiku', fable: 'Claude Fable' }

/** "Claude Opus" for opus / claude-opus-* / anthropic/claude-opus-* / us.anthropic.claude-opus-*; GPT ids in their
 * usual spelling ("gpt-5.5-codex" → "GPT-5.5 Codex"); anything else as it is. */
export function modelDisplayName(id: string): string {
  const raw = id.trim()
  if (!raw) return raw
  const base = raw.toLowerCase().replace(/\[1m\]$/, '').split('/').pop()!.replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
  if (CLAUDE_FAMILY[base]) return CLAUDE_FAMILY[base]
  const m = /^claude-(?:(\d+(?:[-.]\d+)?)-)?(opus|sonnet|haiku|fable)\b/.exec(base)
  if (m) return CLAUDE_FAMILY[m[2]!]!
  const g = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(base)
  if (g) return `GPT-${g[1]}${g[2] ? ' ' + g[2].split('-').map((w) => w ? w[0]!.toUpperCase() + w.slice(1) : w).join(' ') : ''}`
  return raw
}

/**
 * The same with the version the id names, where one id per row matters (Admin › Usage by model and its filter keep the
 * real ids apart): "claude-opus-4-5-20251101" → "Claude Opus 4.5", "claude-3-5-sonnet-20241022" → "Claude Sonnet 3.5".
 * An alias ("opus") or an id without a version keeps the plain name.
 */
export function modelVersionName(id: string): string {
  const name = modelDisplayName(id)
  const base = id.trim().toLowerCase().replace(/\[1m\]$/, '').split('/').pop()!.replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
  const after = /^claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d{1,2}))?(?![\d])/.exec(base)
  const before = /^claude-(\d+)(?:[-.](\d{1,2}))?-(?:opus|sonnet|haiku|fable)\b/.exec(base)
  const v = after ?? before
  return v ? `${name} ${v[1]}${v[2] !== undefined ? '.' + v[2] : ''}` : name
}

/** The family of a Claude model id (for the plain hint under it), or null for any other model. */
export function claudeFamily(id: string): 'opus' | 'sonnet' | 'haiku' | null {
  const base = id.toLowerCase().split('/').pop()!.replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
  const m = /^(?:claude-(?:\d+(?:[-.]\d+)?-)?)?(opus|sonnet|haiku)\b/.exec(base)
  return (m?.[1] as 'opus' | 'sonnet' | 'haiku' | undefined) ?? null
}
