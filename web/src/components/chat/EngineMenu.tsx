// The list of engines and their models a person who may pick the engine chooses from (composer picker, "retry with
// another model" after a failed answer). Only the engines the admin switched on are listed.
import type { EngineId } from '@mycel/shared/api'
import { useT } from '../../i18n'

// the AI's own name, the one people know (Claude, ChatGPT), not the engine's (Claude Code, Codex): Settings › AI
// accounts groups one's own accounts the same way (docs/DECISIONS.md "Plain words for members")
export const ENGINE_LABEL: Record<EngineId, string> = { 'claude-code': 'Claude', codex: 'ChatGPT', api: 'API' }

export interface EnginePick { engine: EngineId; model: string | null }

type EngineModels = Partial<Record<EngineId, { id: string; label: string }[]>>

/** Whether the composer shows its AI picker: with two or more engines switched on, or with one engine that has two or
 * more models (AI parity QA AP-032, 2026-11-20, as claude.ai lets you pick the model; supersedes the owner's 2026-11-12
 * "no picker with one engine", QA TC-182). One engine with one model (the API engine) has no picker: there is nothing
 * to pick. New chats without a pick use the person's own default (Settings › "AI for new chats") or else the team's
 * (Admin › Team settings › AI defaults). */
export function showsEnginePicker(engines: readonly EngineId[], models?: EngineModels): boolean {
  if (engines.length > 1) return true
  return engines.length === 1 && (models?.[engines[0]]?.length ?? 0) > 1
}

/** With one engine the picker lists only that engine's models (no engine row, no "Default model" row): the engine is
 * not a choice there (AP-032). Until the person picks a model, no row is ticked. */
export const onlyModels = (engines: readonly EngineId[]): boolean => engines.length === 1

export function EngineOptions({
  engines,
  models,
  current,
  onPick,
  modelsOnly = false,
}: {
  engines: EngineId[]
  models?: EngineModels
  current?: { engine: EngineId | undefined; model: string | null | undefined }
  onPick: (p: EnginePick) => void
  /** one engine in the composer's picker: its models only, without the engine's "Default model" row (onlyModels) */
  modelsOnly?: boolean
}) {
  const t = useT()
  if (modelsOnly) return (
    <>
      {engines.flatMap((id) => (models?.[id] ?? []).map((m) => (
        <li key={`${id}:${m.id}`}>
          <button
            type="button"
            role="option"
            aria-selected={current?.engine === id && current?.model === m.id}
            className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm hover:bg-hover"
            onClick={() => onPick({ engine: id, model: m.id })}
          >
            {m.label}
          </button>
        </li>
      )))}
    </>
  )
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
