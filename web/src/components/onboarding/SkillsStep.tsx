// The skills step, the owner's welcome step (docs/DECISIONS.md "W6 — Onboarding v6: skills catalog and 내 스킬", "W7 —
// Onboarding: no own skills in the setup"; FLOW-v6 §2; pages/Welcome.tsx renders the eyebrow, the progress bar and the
// focus; this is the heading and what is under it). Only the skills Trina prepared: the kept skills the team does not
// have yet (components/skills/PackRows.tsx: GET /api/onboarding/packs), each with 예시 (the viewer). 회사 소개서, 카드뉴스
// and 홍보 영상 come checked when a company profile is saved (all three are made from it), 자연스러운 글 never; no AI
// decides, and the checks never move while the step is up. Nothing is checked on a revisit of a done step. With every
// kept skill in the team already, one line says so and the primary goes on. Own skills (a .claude or .codex folder,
// Claude Code or Codex) are not brought here: office workers rarely have them, and the hidden folder confused them
// (owner, 2026-11-11). They go in from Team skills › Bring my skills (components/skills/BringSkillsSheet.tsx).
// The one primary names what goes in, up to three ("회사 소개서·카드뉴스·홍보 영상 넣기"; from four on "팀에 넣기 · n개"),
// and hides when nothing is checked (나중에 하기 takes its style). On press: one install per pack (POST
// …/packs/:id/install; the server runs the brand action first on the owner's press and records the step too). All in:
// a toast and the next step. When anything failed the step stays: what went in is marked, the rest says why (a name
// taken, folder rules, a request that failed, with 다시 for only those), and once nothing is left to send the primary
// reads 다음. 나중에 하기 installs nothing. A phone: the same rows with their lines.
import { type ReactNode, useState } from 'react'
import type { PackCatalogSkill } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { namedProduct } from '../../lib/tabs'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { installPacks, outcomeEmpty, PackNotes, PackRows, usePackCatalog, type PackInstallOutcome } from '../skills/PackRows'
import { Button, ErrorNote, Skeleton, useMediaQuery } from '../ui'

/** The primary names what it puts in while it covers at most this many skills. */
const NAMED_MAX = 3

/** The kept skills checked when the step first shows them: the visual ones when a company profile is saved, none on a
 * revisit of a done step. */
export function preChecked(rows: readonly Pick<PackCatalogSkill, 'name' | 'visual'>[], o: { profile: boolean; done: boolean }): Set<string> {
  return new Set(o.done || !o.profile ? [] : rows.filter((r) => r.visual).map((r) => r.name))
}

/** The primary's words (null: nothing to put in): up to NAMED_MAX skills each is named; more: "팀에 넣기 · n개". */
export function primaryLabel(t: ReturnType<typeof useT>, kept: readonly string[]): string | null {
  if (!kept.length) return null
  if (kept.length > NAMED_MAX) return t('welcome.skills.putN', { n: kept.length })
  return t('welcome.skills.put', { names: kept.join('·') })
}

export interface SkillsStepProps {
  /** the primary once there is nothing to put in (e.g. "다음: 팀 파일 가져오기") */
  nextLabel: string
  /** on to the next step, the step done */
  onNext: () => void
  /** 나중에 하기, or 다음 after a press that put nothing in */
  onSkip: () => void
  busy?: boolean
  /** one note under the heading (the parent's: e.g. the brand files not placed) */
  note?: ReactNode
}

export function SkillsStep({ nextLabel, onNext, onSkip, busy, note }: SkillsStepProps) {
  const t = useT()
  const phone = useMediaQuery('(max-width: 767.98px)')
  // the step is done (the steps' progress, loaded by pages/Welcome.tsx): a revisit checks nothing
  const done = useWelcome((s) => s.progress?.steps.skills === 'done')

  // the rows are the ones missing when the step first gets them, and stay (checks never move)
  const { catalog, failed: catalogFailed, reload } = usePackCatalog()
  const [rows, setRows] = useState<PackCatalogSkill[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  if (catalog && rows === null) {
    const missing = catalog.skills.filter((s) => !s.inTeam)
    setRows(missing)
    setChecked(preChecked(missing, { profile: catalog.profile, done }))
  }
  const [outcome, setOutcome] = useState<PackInstallOutcome | null>(null)
  const [pressing, setPressing] = useState(false)

  const keptChecked = (rows ?? []).filter((r) => checked.has(r.name) && !outcome?.went.includes(r.name))
  // what failed on the press before: sent again by 다시 or the primary
  const keptFailed = (rows ?? []).filter((r) => outcome?.failed.includes(r.name))
  const label = primaryLabel(t, keptChecked.map((r) => r.title))
  // every kept skill is in the team already: nothing to choose, the step reads as done
  const allIn = rows !== null && rows.length === 0
  const anythingIn = !!outcome?.went.length || done || allIn

  /** a press or 다시: what went in is marked, the rest says why; on with a toast only when nothing failed */
  const put = async (items: PackCatalogSkill[]) => {
    const r = items.length ? await installPacks(items) : outcomeEmpty()
    // a retry keeps what the press before it said about the others (a name taken stays said, a failure not retried stays)
    const tried = new Set(items.map((s) => s.name))
    const failedBefore = (outcome?.failed ?? []).filter((n) => !tried.has(n))
    const all: PackInstallOutcome = {
      went: [...(outcome?.went ?? []), ...r.went], taken: [...(outcome?.taken ?? []), ...r.taken], blocked: [...(outcome?.blocked ?? []), ...r.blocked],
      failed: [...failedBefore, ...r.failed], error: r.failed.length ? r.error : failedBefore.length ? outcome?.error ?? null : null,
    }
    setOutcome(all)
    setChecked((x) => { const next = new Set(x); for (const s of items) next.delete(s.name); return next })
    if (!all.failed.length && !all.taken.length && !all.blocked.length) {
      if (all.went.length > 0) toast({ level: 'success', text: t('welcome.skills.installed', { n: all.went.length }) })
      onNext()
    }
  }
  const run = (items: PackCatalogSkill[]) => {
    if (pressing || busy) return
    setPressing(true)
    void put(items).finally(() => setPressing(false))
  }
  // a press is also the retry of what failed before
  const press = () => run([...keptChecked, ...keptFailed.filter((r) => !keptChecked.includes(r))])
  const retry = () => { if (keptFailed.length) run(keptFailed) }

  let body: ReactNode
  if (catalogFailed && !rows) body = <div data-testid="skill-packs-failed"><ErrorNote onRetry={reload}>{t('skillPack.loadFailed')}</ErrorNote></div>
  else if (!rows) body = <Skeleton lines={3} />
  else if (allIn) body = <p className="text-sm text-muted" data-testid="skill-packs-all-in">{t('welcome.skills.allIn', namedProduct(t))}</p>
  else body = (
    <section className="space-y-1" aria-labelledby="skills-packs-title" data-testid="skill-packs">
      <h3 id="skills-packs-title" className="text-sm font-semibold text-ink">{t('skills.catalog.title', namedProduct(t))}</h3>
      <PackRows
        items={rows}
        checked={checked}
        onToggle={(name, on) => setChecked((x) => { const next = new Set(x); if (on) next.add(name); else next.delete(name); return next })}
        outcome={outcome}
        disabled={pressing || busy}
      />
      <div className="space-y-2 pt-1">
        <PackNotes outcome={outcome} onRetry={pressing ? undefined : retry} />
      </div>
    </section>
  )

  // after a press, on a revisit of a done step, or with every kept skill in: 다음
  const showNext = !label && (anythingIn || outcome !== null)
  const wide = phone ? 'w-full' : undefined
  const primary = label ? (
    <Button variant="primary" busy={pressing} disabled={busy} className={wide} onClick={press} data-testid="skills-primary" data-state="put">{label}</Button>
  ) : showNext ? (
    <Button variant="primary" disabled={busy || pressing} className={wide} onClick={anythingIn ? onNext : onSkip} data-testid="skills-primary" data-state="next">{nextLabel}</Button>
  ) : null

  return (
    <div className="space-y-6" data-testid="skills-step">
      <div className="space-y-2">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-ink">{t('welcome.skills.title')}</h2>
          <p className="text-sm text-balance text-muted">{t('welcome.skills.desc')}</p>
        </div>
        {note}
      </div>
      {body}
      <div className={phone ? 'space-y-2' : 'flex items-center justify-between gap-3'}>
        {primary ?? <span />}
        {!done && !allIn && (
          <Button variant={primary ? 'ghost' : 'primary'} className={wide} onClick={onSkip} disabled={busy || pressing} data-testid="skills-later">{t('welcome.later')}</Button>
        )}
      </div>
    </div>
  )
}
