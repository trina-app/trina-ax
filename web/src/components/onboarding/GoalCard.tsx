// The 7-day team goal on Home for owners and admins (docs/DECISIONS.md "G — The 7-day team goal"; contract
// shared/src/api/onboarding-goal.ts): "7일 안에 3명이 같은 스킬 써 보기 · 2/3 · 5일 남음", the top skill and who ran it
// (never who has not), [팀원 초대] (the team invite link with that skill) and [초대 문구 복사]. Once reached it says so
// until dismissed. On a hosted team the owner checklist gives way to it while it shows; elsewhere both show.
// On phones the card has no frame of its own, only a line under it (fewer boxes; docs/DESIGN-SYSTEM.md).
import { CheckCircle2, UserPlus, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { TeamGoal, TeamLinkResponse } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { teamLinkMessage } from '../../lib/team-link'
import { goalProgressText, runnerNames } from '../../lib/teamGoal'
import { useT } from '../../i18n'
import { useMe, useMeStrict } from '../../store/session'
import { Button, CopyButton, IconButton, Modal } from '../ui'
import { InviteStep } from './InviteStep'

/** "달성했어요" dismissed in this browser, per team (its start) */
const doneKey = (startedAt: string) => `mycel.teamGoalDone.${startedAt}`
const readDone = (startedAt: string) => { try { return localStorage.getItem(doneKey(startedAt)) === '1' } catch { return false } }

/**
 * The top of Home for owners and admins: the goal card while it shows, and `checklist` (the owner's setup checklist,
 * null for an admin) unless the team is hosted and the card shows. The checklist does not wait for the goal: it shows
 * at once and gives way when the goal says so (a new hosted team, which has little to load); a failed load keeps it.
 */
export function GoalOrChecklist({ checklist }: { checklist: ReactNode }) {
  const me = useMeStrict()
  const [goal, setGoal] = useState<TeamGoal | null | undefined>(undefined)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    let live = true
    api.call(API.getTeamGoal).then((r) => live && setGoal(r.goal), () => live && setGoal(null))
    return () => { live = false }
  }, [me.user.id])
  const shown = goal && !(goal.state === 'reached' && (dismissed || readDone(goal.startedAt))) ? goal : null
  const dismiss = (g: TeamGoal) => {
    try { localStorage.setItem(doneKey(g.startedAt), '1') } catch { /* this tab only */ }
    setDismissed(true)
  }
  return (
    <>
      {shown && <GoalCard goal={shown} onDismiss={() => dismiss(shown)} />}
      {(!shown || me.server.deployment !== 'hosted') && checklist}
    </>
  )
}

/** The card itself, without loading the goal (tests render it as it is). `link`: the team invite link when known. */
export function GoalCard({ goal, onDismiss, link: given }: { goal: TeamGoal; onDismiss: () => void; link?: TeamLinkResponse | null }) {
  const t = useT()
  const me = useMe()
  const [inviting, setInviting] = useState(false)
  const [link, setLink] = useState<TeamLinkResponse | null>(given ?? null)
  const [linkTick, setLinkTick] = useState(0)
  useEffect(() => {
    if (given !== undefined || goal.state !== 'open') return
    let live = true
    api.call(API.getTeamLink).then((r) => live && setLink(r), () => {})
    return () => { live = false }
  }, [given, goal.state, linkTick])
  const skill = goal.skill
  const names = skill ? runnerNames(skill.people, skill.runners) : ''
  const frame = 'mb-6 border-b border-line pb-5 sm:mb-8 sm:rounded-2xl sm:border sm:bg-surface sm:p-4'

  if (goal.state === 'reached') {
    return (
      <section className={frame} aria-labelledby="team-goal-title" data-testid="team-goal" data-state="reached">
        <div className="flex items-start gap-2">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="team-goal-title" className="text-sm font-semibold">{t('goal.reachedTitle')}</h2>
            {skill && <p className="mt-1 text-sm text-muted">{t('goal.reachedBody', { count: skill.runners, skill: skill.name, names })}</p>}
          </div>
          <IconButton label={t('common.hide')} onClick={onDismiss} data-testid="team-goal-dismiss"><X size={15} aria-hidden /></IconButton>
        </div>
      </section>
    )
  }

  const count = skill?.runners ?? 0
  const filled = Math.min(count, goal.target)
  const progress = goalProgressText(t, count, goal.target)
  const open = link?.link && link.link.state === 'active' && link.link.url ? link.link : null
  // a link made or changed in the dialog: read it again for [초대 문구 복사]
  const closeInvite = () => { setInviting(false); setLinkTick((n) => n + 1) }
  const message = open ? teamLinkMessage(t, { name: me?.user.name ?? '', url: open.url!, skill: open.skill?.name ?? null }) : null
  return (
    <section className={frame} aria-labelledby="team-goal-title" data-testid="team-goal" data-state="open">
      <h2 id="team-goal-title" className="text-sm">
        <span className="font-semibold">{t('goal.title', { days: goal.days, target: goal.target })}</span>
        <span className="text-muted tabular-nums" data-testid="team-goal-progress"> · {progress} · {t('goal.daysLeft', { n: goal.daysLeft })}</span>
      </h2>
      <div className="mt-2 flex gap-1" role="img" aria-label={progress}>
        {Array.from({ length: goal.target }, (_, i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-full ${i < filled ? 'bg-accent' : 'bg-hover'}`} />
        ))}
      </div>
      <p className="mt-3 text-sm text-muted" data-testid="team-goal-skill">
        {skill ? t('goal.ranBy', { skill: skill.name, names }) : t('goal.none', { target: goal.target })}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => setInviting(true)} data-testid="team-goal-invite">
          <UserPlus size={14} aria-hidden /> {t('goal.invite')}
        </Button>
        {message && <CopyButton text={message} label={t('goal.copyInvite')} showLabel className="h-8 border border-line max-sm:min-h-9" />}
      </div>
      {inviting && (
        <Modal open onClose={closeInvite} title={t('goal.title', { days: goal.days, target: goal.target })} width={560}>
          <InviteStep onDone={closeInvite} skillPath={skill?.path ?? null} />
        </Modal>
      )}
    </section>
  )
}
