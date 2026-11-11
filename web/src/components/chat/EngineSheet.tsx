// The AI picker on a phone (below 768px): the choices of EngineOptions (EngineMenu.tsx) as MenuButton's bottom sheet,
// for the message box's picker (Composer.tsx) and "다른 모델로 다시 시도" under a failed answer (Messages.tsx). Computers
// keep the small list by the button.
import { ChevronDown } from 'lucide-react'
import type { EngineId } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { MenuButton, type MenuItem } from '../rooms/MenuButton'
import { ENGINE_LABEL, type EnginePick } from './EngineMenu'

/** The same choices as EngineOptions as a phone's menu rows (MenuButton): per engine its default model (the engine's name,
 * "기본 모델" after it), then its models, a little in; the chosen one ticked. A model named like another row gets its
 * engine's name after it (a row is known by its words). */
export function engineMenuItems(engines: readonly EngineId[], models: Partial<Record<EngineId, { id: string; label: string }[]>> | undefined, current: { engine: EngineId | undefined; model: string | null | undefined } | undefined, onPick: (p: EnginePick) => void, defaultModel: string): MenuItem[] {
  const seen = new Map<string, number>()
  for (const id of engines) for (const l of [ENGINE_LABEL[id], ...(models?.[id] ?? []).map((m) => m.label)]) seen.set(l, (seen.get(l) ?? 0) + 1)
  return engines.flatMap((id): MenuItem[] => [
    { label: ENGINE_LABEL[id], hint: defaultModel, checked: current?.engine === id && !current?.model, onSelect: () => onPick({ engine: id, model: null }) },
    ...(models?.[id] ?? []).map((m): MenuItem => ({
      label: (seen.get(m.label) ?? 0) > 1 ? `${m.label} · ${ENGINE_LABEL[id]}` : m.label,
      icon: <span aria-hidden className="w-4 shrink-0" />,
      checked: current?.engine === id && current?.model === m.id,
      onSelect: () => onPick({ engine: id, model: m.id }),
    })),
  ])
}

/** the button's look: the quiet picker under the message box, or a secondary button ("다른 모델로 다시 시도"), as on a computer */
// (over MenuButton's own: its rounded-md and colour give way, ! ; its padding to the px / py here)
const LOOK = {
  picker: 'touch-hit gap-1 rounded-lg! px-2 py-1.5 text-xs max-sm:px-2 max-sm:py-1.5',
  secondary: 'h-8 gap-1.5 rounded-lg! border border-field-border bg-surface px-2.5 text-label font-medium whitespace-nowrap text-ink! max-sm:min-h-9 max-sm:px-2.5 max-sm:py-0',
} as const

/** The picker on a phone (below 768px): MenuButton's sheet over a scrim, which a tap outside, Escape (and Back) close
 * and which never covers the message box while it is closed. The choices are EngineOptions' (engineMenuItems). `label`:
 * the button's words and name, as on a computer (the current choice, or what it does); `title`: the sheet's name and
 * the button's tooltip. Computers keep the small list by the button. */
export function EngineSheet({ engines, models, current, onPick, label, title, testId, look = 'picker' }: {
  engines: readonly EngineId[]
  models?: Partial<Record<EngineId, { id: string; label: string }[]>>
  current?: { engine: EngineId | undefined; model: string | null | undefined }
  onPick: (p: EnginePick) => void
  label: string
  title: string
  testId?: string
  look?: keyof typeof LOOK
}) {
  const t = useT()
  return (
    <MenuButton
      label={label}
      tip={title}
      heading={title}
      items={engineMenuItems(engines, models, current, onPick, t('composer.defaultModel'))}
      icon={<>{label} <ChevronDown size={13} aria-hidden /></>}
      muted={look === 'picker'}
      buttonClassName={LOOK[look]}
      testId={testId}
    />
  )
}
