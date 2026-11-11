// The list of engines and their models a person who may pick the engine chooses from (composer picker, "retry with
// another model" after a failed answer). Only the engines the admin switched on are listed.
import type { EngineId } from '@mycel/shared/api'
import { useT } from '../../i18n'

// the AI's own name, the one people know (Claude, ChatGPT), not the engine's (Claude Code, Codex): Settings › AI
// accounts groups one's own accounts the same way (docs/DECISIONS.md "Plain words for members")
export const ENGINE_LABEL: Record<EngineId, string> = { 'claude-code': 'Claude', codex: 'ChatGPT', api: 'API' }

export interface EnginePick { engine: EngineId; model: string | null }

/** How many different choices the picker would offer: one per engine, and one more per model beyond the first (an
 * engine with a single model, such as the API one, is one choice: its default model is that model). With one choice
 * there is nothing to pick, so the composer shows no picker (owner 2026-11-11). */
export function engineChoiceCount(engines: readonly EngineId[], models?: Partial<Record<EngineId, readonly unknown[]>>): number {
  return engines.reduce((n, id) => {
    const m = models?.[id]?.length ?? 0
    return n + (m > 1 ? 1 + m : 1)
  }, 0)
}

export function EngineOptions({
  engines,
  models,
  current,
  onPick,
}: {
  engines: EngineId[]
  models?: Partial<Record<EngineId, { id: string; label: string }[]>>
  current?: { engine: EngineId | undefined; model: string | null | undefined }
  onPick: (p: EnginePick) => void
}) {
  const t = useT()
  return (
    <>
      {engines.map((id) => (
        <li key={id}>
          <button
            type="button"
            role="option"
            aria-selected={current?.engine === id && !current?.model}
            className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm hover:bg-hover"
            onClick={() => onPick({ engine: id, model: null })}
          >
            {ENGINE_LABEL[id]} <span className="text-xs text-faint">{t('composer.defaultModel')}</span>
          </button>
          {models?.[id]?.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={current?.engine === id && current?.model === m.id}
              className="flex w-full items-center rounded-lg py-1.5 pr-2.5 pl-6 text-left text-sm text-muted hover:bg-hover"
              onClick={() => onPick({ engine: id, model: m.id })}
            >
              {m.label}
            </button>
          ))}
        </li>
      ))}
    </>
  )
}
