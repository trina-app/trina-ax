// The 7-day team goal on Home for owners and admins (docs/DECISIONS.md "G — The 7-day team goal" and "Y — Home shows
// one thing at a time"; contract shared/src/api/onboarding-goal.ts): the title "7일 안에 3명이 같은 스킬 써 보기 · 1/3 ·
// 5일 남음", ONE line of what to do next and ONE button. Someone joined and has not run the skill: "민지님이 들어왔지만
// '광고 문구'는 아직이에요." [다시 보내기] (copies a nudge with the skill form's link); one more person: "한 명만 더 쓰면
// 달성이에요."; nobody joined: "아직 아무도 안 들어왔어요." — those two with [초대 문구 복사] (the team link's message), or
// [팀원 초대] while no link works. Reached: "달성했어요 · 민지·지훈·Olga" until dismissed.
// On phones (below 768px) it is one slim line above the greeting, no frame and no rule: the title with the progress
// and the days left, which opens the next step and its button in place (never [다시 보내기] there: an orange button
// above the greeting); reached: "달성했어요 · names" and the way to hide it on one line. From 768px a card.
import clsx from 'clsx'
import { Check, CheckCircle2, ChevronDown, Copy, UserPlus, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { TeamGoal, TeamLinkResponse } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { teamLinkMessage } from '../../lib/team-link'
import { goalNext, goalNextText, goalProgressText, resendText, runnerNames, skillRunUrl } from '../../lib/teamGoal'
import { useLocale, useT } from '../../i18n'
import { useMe, useMeStrict } from '../../store/session'
import { Button, IconButton, Modal, useCopy, useMediaQuery } from '../ui'
import { InviteStep } from './InviteStep'

/** "달성했어요" dismissed in this browser, per team (its start) */
const doneKey = (startedAt: string) => `mycel.teamGoalDone.${startedAt}`
const readDone = (startedAt: string) => { try { return localStorage.getItem(doneKey(startedAt)) === '1' } catch { return false } }

/** The goal card on Home (owners and admins; Home decides when): loads the goal and shows nothing when there is none,
 * the load failed, or "달성했어요" was dismissed in this browser. */
export function HomeGoal() {
  const me = useMeStrict()
  const [goal, setGoal] = useState<TeamGoal | null>(null)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    let live = true
    api.call(API.getTeamGoal).then((r) => live && setGoal(r.goal), () => live && setGoal(null))
    return () => { live = false }
  }, [me.user.id])
  if (!goal || (goal.state === 'reached' && (dismissed || readDone(goal.startedAt)))) return null
  const dismiss = () => {
    try { localStorage.setItem(doneKey(goal.startedAt), '1') } catch { /* this tab only */ }
    setDismissed(true)
  }
  return <GoalCard goal={goal} onDismiss={dismiss} />
}

/** The card itself, without loading the goal (tests render it as it is). `link`: the team invite link when known
 * (undefined: the card reads it). */
export function GoalCard({ goal, onDismiss, link: given }: { goal: TeamGoal; onDismiss: () => void; link?: TeamLinkResponse | null }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const [inviting, setInviting] = useState(false)
  // undefined while it loads: the one button waits for it rather than change under the finger
  const [link, setLink] = useState<TeamLinkResponse | null | undefined>(given)
  const [linkTick, setLinkTick] = useState(0)
  const phone = useMediaQuery('(max-width: 767.98px)')
  const [shown, setShown] = useState(false)
  const nextId = useId()
  useEffect(() => {
    if (given !== undefined || goal.state !== 'open') return
    let live = true
    api.call(API.getTeamLink).then((r) => live && setLink(r), () => live && setLink(null))
    return () => { live = false }
  }, [given, goal.state, linkTick])
  const skill = goal.skill
  const frame = phone ? 'mb-2 text-center' : 'mb-8 rounded-2xl border border-line bg-surface p-4'

  if (goal.state === 'reached') {
    return (
      <section className={frame} aria-labelledby="team-goal-title" data-testid="team-goal" data-state="reached">
        <div className={clsx('flex items-center gap-2', phone && 'min-h-11 justify-center')}>
          <CheckCircle2 size={phone ? 16 : 18} className="shrink-0 text-ok" aria-hidden />
          <h2 id="team-goal-title" className={clsx('min-w-0', phone ? 'text-label' : 'flex-1 text-sm')}>
            <span className={phone ? 'font-medium' : 'font-semibold'}>{t('goal.reachedTitle')}</span>
            {skill && <span className="text-muted" data-testid="team-goal-names"> · {runnerNames(skill.people, skill.runners)}</span>}
          </h2>
          <IconButton label={t('common.hide')} onClick={onDismiss} className="touch-hit" data-testid="team-goal-dismiss"><X size={15} aria-hidden /></IconButton>
        </div>
      </section>
    )
  }

  const progress = goalProgressText(t, skill?.runners ?? 0, goal.target)
  const open = link?.link && link.link.state === 'active' && link.link.url ? link.link : null
  // the skill to name: the top one, else the one the team link carries (nobody ran one yet), else any team skill
  const linkName = open?.skill ? (open.skill.title ?? open.skill.name) : null
  const named = skill ? { path: skill.path, name: skill.name } : open?.skill && linkName ? { path: open.skill.path, name: linkName } : null
  const next = goalNext(goal)
  // a link made or changed in the dialog: read it again for [초대 문구 복사]
  const closeInvite = () => { setInviting(false); setLinkTick((n) => n + 1) }

  let action = null
  if (link !== undefined) {
    if (next.kind === 'waiting') {
      // the team's address as the team link has it (an office's public address), else this page's
      const base = open?.url ? new URL(open.url).origin : typeof location === 'undefined' ? '' : location.origin
      const text = resendText(t, locale, { first: next.first, more: next.more, skill: named?.name ?? null, url: skillRunUrl(base, named?.path ?? null) })
      action = <CopyAction text={text} label={t('goal.resend')} testId="team-goal-resend" />
    } else if (open) {
      const message = teamLinkMessage(t, { name: me?.user.name ?? '', team: me?.team.name ?? '', url: open.url!, skill: open.skill ? (open.skill.title ?? open.skill.name) : null })
      action = <CopyAction text={message} label={t('goal.copyInvite')} testId="team-goal-copy-invite" />
    } else {
      action = (
        <Button variant="primary" size="sm" onClick={() => setInviting(true)} data-testid="team-goal-invite">
          <UserPlus size={14} aria-hidden /> {t('goal.invite')}
        </Button>
      )
    }
  }
  const title = <span className={phone ? 'font-medium text-ink' : 'font-semibold'}>{t('goal.title', { days: goal.days, target: goal.target })}</span>
  const counts = <span className="text-muted tabular-nums" data-testid="team-goal-progress"> · {progress} · {t('goal.daysLeft', { n: goal.daysLeft })}</span>
  const nextLine = <p className={clsx('text-sm text-muted text-pretty', !phone && 'mt-1')} data-testid="team-goal-next" data-next={next.kind}>{goalNextText(t, locale, next, named?.name ?? null)}</p>
  return (
    <section className={frame} aria-labelledby="team-goal-title" data-testid="team-goal" data-state="open">
      {phone ? (
        <>
          {/* one line; a tap opens the next step (and its button, but never "다시 보내기": an orange button above the
              greeting) */}
          <h2 id="team-goal-title" className="text-label">
            {/* the chevron runs with the text, so it stays after the last word when a longer language wraps */}
            <button type="button" onClick={() => setShown((v) => !v)} aria-expanded={shown} aria-controls={nextId} className="min-h-11 max-w-full rounded-lg px-2 py-2.5 text-balance transition hover:bg-hover" data-testid="team-goal-toggle">
              {title}{counts}
              <ChevronDown size={15} className={clsx('ml-1.5 inline-block align-[-3px] text-faint transition', shown && 'rotate-180')} aria-hidden />
            </button>
          </h2>
          <div id={nextId} hidden={!shown} className="mb-3 px-2">
            {nextLine}
            {next.kind !== 'waiting' && action && <div className="mt-3">{action}</div>}
          </div>
        </>
      ) : (
        <>
          <h2 id="team-goal-title" className="text-sm">{title}{counts}</h2>
          {nextLine}
          <div className="mt-3 min-h-8">{action}</div>
        </>
      )}
      {inviting && (
        <Modal open onClose={closeInvite} title={t('goal.title', { days: goal.days, target: goal.target })} width={560}>
          <InviteStep onDone={closeInvite} skillPath={skill?.path ?? null} />
        </Modal>
      )}
    </section>
  )
}

/** The card's one button: copies `text`, and says so for a moment. */
function CopyAction({ text, label, testId }: { text: string; label: string; testId: string }) {
  const t = useT()
  const { copied, copy } = useCopy()
  return (
    <Button variant="primary" size="sm" onClick={() => void copy(text)} data-testid={testId}>
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? t('common.copied') : label}
    </Button>
  )
}
