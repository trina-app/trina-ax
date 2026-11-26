// The list of engines and their models a person who may pick the engine chooses from (composer picker, "retry with
// another model" after a failed answer). Only the engines the admin switched on are listed.
import clsx from 'clsx'
import { claudeFamily } from '@mycel/shared'
import type { Effort, EngineId } from '@mycel/shared/api'
import { useT, type MessageKey } from '../../i18n'

// the AI's own name, the one people know (Claude, ChatGPT), not the engine's (Claude Code, Codex): Settings › AI
// accounts groups one's own accounts the same way (docs/DECISIONS.md "Plain words for members")
export const ENGINE_LABEL: Record<EngineId, string> = { 'claude-code': 'Claude', codex: 'ChatGPT', api: 'API' }

export interface EnginePick { engine: EngineId; model: string | null }

/** 빠르게 · 보통 · 꼼꼼하게 (docs/decisions/20261126-model-effort-choice.md): the server sends Claude Code --effort low /
 * nothing / high, Codex model_reasoning_effort low / medium / high */
export const EFFORTS: readonly Effort[] = ['quick', 'normal', 'thorough']
export const EFFORT_KEY: Record<Effort, MessageKey> = { quick: 'composer.effort.quick', normal: 'composer.effort.normal', thorough: 'composer.effort.thorough' }

/** One plain line under a Claude model: what it is for, in the words of how the person's connection is paid (a
 * subscription's limits, an API key's cost). Other models (Codex, the API engine) have none. */
export function modelHintKey(id: string, billing: 'limit' | 'cost' | undefined): MessageKey | null {
  const f = claudeFamily(id)
  if (!f) return null
  return `composer.modelHint.${f}.${billing === 'cost' ? 'cost' : 'limit'}` as MessageKey
}

/** The depth row under the models: three choices on one line, the chosen one ticked (aria). `role`: options in the
 * computer's listbox, radio items in a phone's menu sheet. */
export function EffortRow({ value, onPick, itemRole = 'option' }: { value: Effort; onPick: (e: Effort) => void; itemRole?: 'option' | 'menuitemradio' }) {
  const t = useT()
  const label = t('composer.effort')
  return (
    <div role="group" aria-label={label} className="mt-1 border-t border-line px-2.5 pt-2 pb-1 max-md:px-3" data-testid="effort-row">
      <p aria-hidden className="pb-1.5 text-xs text-muted">{label}</p>
      <div className="grid grid-cols-3 gap-1">
        {EFFORTS.map((e) => {
          const on = e === value
          return (
            <button
              key={e}
              type="button"
              role={itemRole}
              {...(itemRole === 'option' ? { 'aria-selected': on } : { 'aria-checked': on })}
              onClick={() => onPick(e)}
              className={clsx('min-w-0 truncate rounded-lg border px-2 py-1.5 text-xs max-md:min-h-11', on ? 'border-accent bg-accent-soft font-medium text-accent-text' : 'border-line text-ink hover:bg-hover')}
              data-testid={`effort-${e}`}
            >
              {t(EFFORT_KEY[e])}
            </button>
          )
        })}
      </div>
    </div>
  )
}

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
  billing,
}: {
  engines: EngineId[]
  models?: EngineModels
  current?: { engine: EngineId | undefined; model: string | null | undefined }
  onPick: (p: EnginePick) => void
  /** one engine in the composer's picker: its models only, without the engine's "Default model" row (onlyModels) */
  modelsOnly?: boolean
  /** how the person's connection of each engine is paid: a plain hint line under each Claude model (modelHintKey) */
  billing?: Partial<Record<EngineId, 'limit' | 'cost'>>
}) {
  const t = useT()
  const hint = (id: EngineId, m: string) => {
    if (!billing) return null
    const k = modelHintKey(m, billing[id])
    return k ? <span className="block text-xs text-faint">{t(k)}</span> : null
  }
  if (modelsOnly) return (
    <>
      {engines.flatMap((id) => (models?.[id] ?? []).map((m) => (
        <li key={`${id}:${m.id}`}>
          <button
            type="button"
            role="option"
            aria-selected={current?.engine === id && current?.model === m.id}
            className="flex w-full flex-col items-start rounded-lg px-2.5 py-2 text-left text-sm hover:bg-hover"
            onClick={() => onPick({ engine: id, model: m.id })}
          >
            {m.label}
            {hint(id, m.id)}
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
              className="flex w-full flex-col items-start rounded-lg py-1.5 pr-2.5 pl-6 text-left text-sm text-muted hover:bg-hover"
              onClick={() => onPick({ engine: id, model: m.id })}
            >
              {m.label}
              {hint(id, m.id)}
            </button>
          ))}
        </li>
      ))}
    </>
  )
}
