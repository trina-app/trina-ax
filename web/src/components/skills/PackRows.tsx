// The kept skills a person can put in the team (docs/DECISIONS.md "W6"; FLOW-v6 §2.1, §4.2): the catalog (GET
// /api/onboarding/packs, owners and admins), its rows (checkbox · title · one line · 예시, the example viewer behind
// 예시) and the install of what was checked (POST /api/onboarding/packs/:id/install, one call per pack with the names).
// Each row keeps its one line on phones too (what the skill makes is how a person chooses). Used by the owner's skills step (components/onboarding/SkillsStep.tsx) and by the Team skills page's fold
// (components/AvailableSkills.tsx). Nothing here installs without a press, and nothing tells anyone that a skill is new:
// a skill shipped later is one more row.
import clsx from 'clsx'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { PackCatalog, PackCatalogSkill, SkillPackId } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { skillsChanged } from '../../store/live'
import { quietLink } from '../onboarding/SkillShareReview'
import { ErrorNote } from '../ui'
import { SkillExampleViewer } from './SkillExampleViewer'

/** The catalog, read again when the team skills change (a row the team now has leaves the missing ones). `enabled`
 * false: not read (a member). */
export function usePackCatalog(enabled = true): { catalog: PackCatalog | null; failed: boolean; reload: () => void } {
  const [catalog, setCatalog] = useState<PackCatalog | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let live = true, generation = 0
    const load = () => {
      const g = ++generation
      api.call(API.listSkillPacks).then(
        (c) => { if (live && g === generation) { setCatalog(c); setFailed(false) } },
        () => { if (live && g === generation) setFailed(true) },
      )
    }
    load()
    const off = skillsChanged.on(load)
    return () => { live = false; off() }
  }, [enabled, attempt])
  return { catalog, failed, reload: () => { setFailed(false); setAttempt((n) => n + 1) } }
}

/** What one press put in: by skill name. `taken`: another team skill has the name; `blocked`: the folder rules (or a
 * file there) kept it out; `failed`: the request did not go through (`error`, safe to send again). */
export interface PackInstallOutcome { went: string[]; taken: string[]; blocked: string[]; failed: string[]; error: unknown }
export const outcomeEmpty = (): PackInstallOutcome => ({ went: [], taken: [], blocked: [], failed: [], error: null })

/** Install `items` (kept skills), one request per pack in the catalog's order: a pack that fails still lets the other in. */
export async function installPacks(items: readonly Pick<PackCatalogSkill, 'pack' | 'name'>[]): Promise<PackInstallOutcome> {
  const out = outcomeEmpty()
  const byPack = new Map<SkillPackId, string[]>()
  for (const s of items) byPack.set(s.pack, [...(byPack.get(s.pack) ?? []), s.name])
  for (const [id, names] of byPack) {
    try {
      const r = await api.call(API.installSkillPack, { params: { id }, body: { skills: names } })
      for (const s of r.skills) {
        if (s.status !== 'blocked') out.went.push(s.name)
        else if (s.sameNameAs) out.taken.push(s.name)
        else out.blocked.push(s.name)
      }
    } catch (e) {
      out.failed.push(...names)
      out.error ??= e
    }
  }
  if (out.went.length) skillsChanged.emit()
  return out
}

/** The notes under the rows after a press: the names already taken, the folder rules, a request that did not go. */
export function PackNotes({ outcome, onRetry }: { outcome: PackInstallOutcome | null; onRetry?: () => void }) {
  const t = useT()
  const locale = useLocale()
  if (!outcome) return null
  return (
    <>
      {outcome.taken.length > 0 && <p className="text-label text-muted" role="status" data-testid="skill-pack-taken">{t('skillPack.taken', { n: outcome.taken.length })}</p>}
      {outcome.blocked.length > 0 && <p className="text-label text-muted" role="status" data-testid="skill-pack-blocked">{t('skillPack.blockedRules')}</p>}
      {outcome.failed.length > 0 && <div data-testid="skill-pack-failed"><ErrorNote onRetry={onRetry}>{errorText(outcome.error, locale, t('error.network'))}</ErrorNote></div>}
    </>
  )
}

export interface PackRowsProps {
  items: readonly PackCatalogSkill[]
  checked: ReadonlySet<string>
  onToggle: (name: string, on: boolean) => void
  /** after a press: what went in (a check mark), what did not (why) */
  outcome?: PackInstallOutcome | null
  disabled?: boolean
  className?: string
}

/** The rows: checkbox · title · one line · 예시. 예시 opens that row's example; closing it returns to the row. */
export function PackRows({ items, checked, onToggle, outcome, disabled, className }: PackRowsProps) {
  const t = useT()
  const ids = useId()
  const [viewing, setViewing] = useState<string | null>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const shown = viewing === null ? null : items.find((s) => s.name === viewing) ?? null
  return (
    <>
      <ul className={clsx('divide-y divide-line', className)} data-testid="skill-pack-rows">
        {items.map((s) => {
          const id = `${ids}-${s.name}`
          const went = outcome?.went.includes(s.name)
          const why = outcome?.taken.includes(s.name) ? t('skillPack.takenOne') : outcome?.blocked.includes(s.name) ? t('skillPack.blockedOne') : null
          return (
            <li key={s.name} className="flex items-start gap-3 py-2.5" data-testid="skill-pack-row" data-name={s.name} data-state={went ? 'in' : why ? 'out' : undefined}>
              {went ? (
                <CircleCheck size={18} className="mt-px shrink-0 text-ok" aria-hidden />
              ) : (
                <input
                  id={id}
                  type="checkbox"
                  checked={checked.has(s.name)}
                  onChange={(e) => onToggle(s.name, e.target.checked)}
                  disabled={disabled}
                  className="touch-hit mt-0.5 size-4.5 shrink-0 accent-[var(--c-accent)] dark:[color-scheme:dark]"
                  data-testid="skill-pack-check"
                />
              )}
              <label htmlFor={went ? undefined : id} className={clsx('min-w-0 flex-1', !went && 'cursor-pointer')}>
                <span className="block text-sm font-medium break-words text-ink" data-testid="skill-pack-title">{s.title}</span>
                {went ? <span className="mt-0.5 block text-label text-muted">{t('skillPack.inNow')}</span>
                  : why ? <span className="mt-0.5 flex items-center gap-1 text-label text-muted"><CircleAlert size={13} className="shrink-0 text-faint" aria-hidden />{why}</span>
                  : s.description && <span className="mt-0.5 block text-label text-muted" data-testid="skill-pack-line">{s.description}</span>}
              </label>
              <button
                ref={(el) => { if (el) buttons.current.set(s.name, el); else buttons.current.delete(s.name) }}
                type="button"
                className={clsx(quietLink, 'touch-hit mt-px shrink-0 text-label')}
                aria-haspopup="dialog"
                aria-label={t('skillPack.exampleNamed', { title: s.title })}
                onClick={() => setViewing(s.name)}
                data-testid="skill-pack-example"
              >
                {t('skillPack.example')}
              </button>
            </li>
          )
        })}
      </ul>
      {shown && <SkillExampleViewer skill={shown} onClose={() => setViewing(null)} returnTo={buttons.current.get(shown.name) ?? null} />}
    </>
  )
}
