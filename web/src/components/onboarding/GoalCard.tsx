// The 7-day team goal on Home for owners and admins (docs/DECISIONS.md "G — The 7-day team goal" and "Y — Home shows
// one thing at a time"; contract shared/src/api/onboarding-goal.ts): the title names the skill, "7일 안에 3명이 '광고
// 문구' 써 보기 · 1/3 · 5일 남음" ("같은 스킬" while there is none; a skill without a title by its folder name as words,
// shared skillLabel), ONE line of what to do next and ONE button. Someone joined and has not run a team skill: "민지님이
// 들어왔어요. '광고 문구'는 아직 써 보기 전이에요." [다시 보내기] (copies a nudge with the skill form's link; never
// "들어왔지만": the goal's skill may have changed after they joined, docs/DECISIONS.md "W5"); one more person: "한 명만 더
// 쓰면 달성이에요."; nobody joined, from the third day: "아직 아무도 안 들어왔어요." — those two with [초대 문구 복사] (the
// team link's message), or [팀원 초대] while no link works (while the owner's welcome steps are unfinished it goes to
// their invite step, INVITE_STEP_STATE, never a second invite dialog). Reached: "달성했어요 · 민지·지훈·Olga" until dismissed.
// On phones (below 768px) it is one quiet 44px row under the message box (Home places it there), no frame and no rule,
// like the folders row: the title with the progress and the days left, which opens the next step and its button in
// place (never [다시 보내기] on phones); reached: "달성했어요 · names" and the way to hide it. From 768px a card.
import clsx from 'clsx'
import { Check, CheckCircle2, ChevronDown, Copy, Target, UserPlus, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GENERAL_DECK_SKILL, skillLabel, type TeamGoal, type TeamLinkResponse } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { teamLinkMessage } from '../../lib/team-link'
import { goalNext, goalNextText, goalProgressText, resendText, runnerNames, skillQuote, skillRunUrl } from '../../lib/teamGoal'
import { showResume } from '../../lib/welcome'
import { useLocale, useT } from '../../i18n'
import { useMe, useMeStrict } from '../../store/session'
import { useWelcome } from '../../store/welcome'
import { Button, IconButton, Modal, useCopy, useMediaQuery } from '../ui'
import { InviteStep } from './InviteStep'

/** The router state of the [팀원 초대] that goes to the welcome steps while they are unfinished: /welcome opens on its
 * invite step (pages/Welcome.tsx reads it), not where the steps would resume. */
export const INVITE_STEP_STATE = { step: 'invite' } as const

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
  const navigate = useNavigate()
  // the owner's welcome steps, unfinished (Home's top loads them): their invite step is the one way to invite meanwhile
  const welcome = useWelcome((s) => s.progress)
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
  const frame = phone ? undefined : 'mb-8 rounded-2xl border border-line bg-surface p-4'

  if (goal.state === 'reached') {
    return (
      <section className={frame} aria-labelledby="team-goal-title" data-testid="team-goal" data-state="reached">
        <div className={clsx('flex items-center', phone ? 'min-h-11 gap-2.5 pl-3' : 'gap-2')}>
          <CheckCircle2 size={phone ? 16 : 18} className="shrink-0 text-ok" aria-hidden />
          <h2 id="team-goal-title" className="min-w-0 flex-1 text-sm">
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
  // the skill to name: the top one, else the one the team link carries (nobody ran one yet), else any team skill; a
  // skill without a title by its folder name as words (never 'quote-maker'). A link that still opens the intro deck is
  // no stand-in: the deck is the owner's own onboarding run, never the team's goal skill (docs/DECISIONS.md "DS3")
  const linkName = open?.skill?.name ? skillLabel({ name: open.skill.name, title: open.skill.title }) : null
  const deckLink = !!open?.skill && (open.skill.path === GENERAL_DECK_SKILL || open.skill.path === welcome?.general?.introDeckPath)
  const named = skill ? { path: skill.path, name: skill.name } : open?.skill && linkName && !deckLink ? { path: open.skill.path, name: linkName } : null
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
      const message = teamLinkMessage(t, { name: me?.user.name ?? '', team: me?.team.name ?? '', url: open.url!, skill: linkName, ownAi: open.memberAi === 'connect_own' })
      action = <CopyAction text={message} label={t('goal.copyInvite')} testId="team-goal-copy-invite" />
    } else {
      // setup unfinished: the welcome steps' own invite step, not a second invite dialog
      const invite = showResume(welcome, !phone) ? () => navigate('/welcome', { state: INVITE_STEP_STATE }) : () => setInviting(true)
      action = (
        <Button variant="primary" size="sm" onClick={invite} data-testid="team-goal-invite">
          <UserPlus size={14} aria-hidden /> {t('goal.invite')}
        </Button>
      )
    }
  }
  // the skill by name when there is one ("7일 안에 3명이 '견적 만들기' 써 보기"), else "같은 스킬"
  const titleText = named ? t('goal.titleSkill', { days: goal.days, target: goal.target, skill: skillQuote(locale, named.name) }) : t('goal.title', { days: goal.days, target: goal.target })
  const title = <span className={phone ? 'font-medium text-ink' : 'font-semibold'}>{titleText}</span>
  // phones: the counts as the row's second line, so a wrap never leaves "남음" alone
  const counts = phone
    ? <span className="block text-xs text-muted tabular-nums" data-testid="team-goal-progress">{progress} · {t('goal.daysLeft', { n: goal.daysLeft })}</span>
    : <span className="text-muted tabular-nums" data-testid="team-goal-progress"> · {progress} · {t('goal.daysLeft', { n: goal.daysLeft })}</span>
  const nextLine = <p className={clsx('text-sm text-muted text-pretty', !phone && 'mt-1')} data-testid="team-goal-next" data-next={next.kind}>{goalNextText(t, locale, next, named?.name ?? null)}</p>
  return (
    <section className={frame} aria-labelledby="team-goal-title" data-testid="team-goal" data-state="open">
      {phone ? (
        <>
          {/* one row; a tap opens the next step under it (and its button, but never "다시 보내기" on phones) */}
          <h2 id="team-goal-title" className="text-sm">
            <button type="button" onClick={() => setShown((v) => !v)} aria-expanded={shown} aria-controls={nextId} className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition hover:bg-hover" data-testid="team-goal-toggle">
              <Target size={16} className="shrink-0 text-faint" aria-hidden />
              <span className="min-w-0 flex-1 text-pretty">{title}{counts}</span>
              <ChevronDown size={16} className={clsx('shrink-0 text-faint transition', shown && 'rotate-180')} aria-hidden />
            </button>
          </h2>
          {/* in line with the title's text (12px padding, the 16px icon and its 10px gap) */}
          <div id={nextId} hidden={!shown} className="pr-3 pb-2 pl-[38px]">
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
        <Modal open onClose={closeInvite} title={titleText} width={560}>
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
