// The onboarding wizard's invite step (after the welcome steps' first result). Standalone: it shows the ready-made
// message with the team invite link and one "메시지 복사", or makes the link in one press; the link box with its QR code,
// its settings and "새 링크로 바꾸기" are folded under "링크 관리" (TeamLinkPanel `folded`). For the owner walking the
// welcome steps (`prepare`) the link is made as the step opens, so the message is there at once (docs/DECISIONS.md "W2").
// Once the message (or the link) was copied or sent, "다 했어요" is the step's primary: the one thing left to press.
// "나중에" just skips, with no question first (docs/decisions/20261123-ask-registry-findings.md, decision 13).
// A team with no skills and no documents yet gets one quiet line above the message (docs/DECISIONS.md "W6.3"): "지금
// 초대하면 팀원이 볼 게 없어요 · 스킬 넣기 · 팀 파일 넣기"; it never blocks. No "이 사람이 팀장이에요" here: one link
// invites many people, so the owner hands the role over after people join (Admin › Members, a person's "…").
// Under the message, one quiet line for someone from outside the team: "Invite a guest" (GuestInviteFlow: the one group
// chat or project first, then the guest form); not where the dialog around it has a Guest choice (`guestLine` false).
import clsx from 'clsx'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { teamFolderPath } from '../../lib/newChat'
import type { WelcomeProgress } from '@mycel/shared/api'
import { t as tNow, useT } from '../../i18n'
import { SKILL_CATALOG } from '../../lib/nav'
import { canShareText, SHARE_PHONE_QUERY } from '../../lib/share'
import { isAdmin, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { Button, useMediaQuery } from '../ui'
import { TeamLinkPanel } from './TeamLinkPanel'
import { quietLink } from './SkillShareReview'
import { useTeamPrepared } from './TeamPrepared'
import { GuestInviteFlow } from '../GuestInviteChoice'

/** The skills the owner shared from 내 스킬 가져오기 (docs/DECISIONS.md "SK"): the one the link opens, which "바꾸기"
 * changes among them. The message names that one only (docs/DECISIONS.md "W5"). */
export interface InviteShared { landing: string; options: { path: string; title: string }[]; onLanding: (path: string) => void }

/** The invite's shared skills from the welcome progress; null when nothing was shared, or when the skill the server
 * points at (`landingSkill`) is none of them (the shared one was deleted: no 바꾸기 among gone skills). */
export function sharedForInvite(progress: WelcomeProgress | null): InviteShared | null {
  const sh = progress?.shared
  const landing = progress?.landingSkill !== undefined ? progress.landingSkill : sh?.landing
  if (!sh?.skills.length || !landing || !sh.skills.some((x) => x.path === landing)) return null
  return {
    landing, options: sh.skills,
    onLanding: (path) => void useWelcome.getState().update({ landing: path }).catch(() => toast({ level: 'error', text: tNow('error.network') })),
  }
}

export interface InviteStepProps {
  /** the person is done with this step (copied the link or the message, or just moves on) */
  onDone: () => void
  /** "later": shown only when given; it skips at once */
  onSkip?: () => void
  /** the skill the first result used: people who join land on its form (skills/…). Omitted: none. */
  skillPath?: string | null
  /** `skillPath` is a team skill the lead just made from their own work (docs/DECISIONS.md "S"): an open link is changed
   * to lead there (the message is the standard one: "I set up '{skill}' for us") */
  made?: boolean
  /** `skillPath` is the skill that made the welcome steps' first result, shared as it is: an open link that leads
   * elsewhere is changed to lead there, keeping its address */
  retarget?: boolean
  /** the owner walking the welcome steps: with no link that could let anyone in, one is made as the step opens (the
   * message and its copy button at once); never a link that still works replaced. Ignored for anyone but an owner. */
  prepare?: boolean
  /** the heading in place of "팀원을 초대해요" (the welcome steps name the skill just used); null: none, the dialog
   * around it already names the step (one heading on a phone, not two) */
  title?: string | null
  /** the skills shared from 내 스킬 가져오기 (`skillPath` is the landing one): the message names that one, and one line
   * says it opens first, with 바꾸기 */
  shared?: InviteShared | null
  /** the welcome steps: the empty-team line's links open 내 스킬 and 팀 파일 there (the next step after each is this one
   * again); absent: they go to 팀 스킬 (the ready-made skills unfolded) and 파일 */
  steps?: EmptyTeamSteps
  /** false: no "Someone from outside the team? Invite a guest" line (the dialog around it has a Guest choice already:
   * TeamMenu.tsx InvitePeople) */
  guestLine?: boolean
}

export function InviteStep({ onDone, onSkip, skillPath, made, retarget, prepare, title, shared, steps, guestLine = true }: InviteStepProps) {
  const t = useT()
  // copied or sent: "다 했어요" takes over as the primary (the panel's copy button was the one before)
  const [sent, setSent] = useState(false)
  // "Invite a guest" (docs/DECISIONS.md "Guests from Invite people"): the place first, then the guest form
  const [guest, setGuest] = useState(false)
  const phone = useMediaQuery(SHARE_PHONE_QUERY)
  // a phone with a share sheet sends the message from there (TeamLinkPanel's primary), so the line says send, not paste
  const sharing = phone && canShareText()
  return (
    <div className="space-y-4" data-testid="invite-step">
      <div>
        {title !== null && <h2 className="mb-1 text-display font-semibold">{title ?? t('teamLink.stepTitle')}</h2>}
        <p className="text-sm text-muted">{t(sharing ? 'teamLink.stepDescShare' : 'teamLink.stepDesc')}</p>
      </div>
      {/* folded: the message and "메시지 복사"; the link and its settings wait under "링크 관리" (no "링크 끄기" here) */}
      <EmptyTeamLine steps={steps} />
      <TeamLinkPanel skillPicker={false} skillPath={skillPath} made={made} retarget={retarget} prepare={prepare} shared={shared} folded onSent={() => setSent(true)} />
      {guestLine && (
        <p className="text-label text-muted" data-testid="invite-step-guest">
          {t('teamLink.guestLine')}{' '}
          <button type="button" className={clsx(quietLink, 'touch-hit')} onClick={() => setGuest(true)} data-testid="invite-step-guest-open">{t('guest.invite.row')}</button>
        </p>
      )}
      {guest && <GuestInviteFlow onClose={() => setGuest(false)} />}
      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        {onSkip && (
          <Button variant="ghost" onClick={onSkip} data-testid="invite-step-skip">
            {t('teamLink.later')}
          </Button>
        )}
        {/* not primary until something was copied or sent: before that the panel's own action (copy the message, or make
            the link first) is the one primary here */}
        <Button variant={sent ? 'primary' : 'secondary'} onClick={onDone} data-testid="invite-step-done" data-sent={sent || undefined}>
          {t('teamLink.stepDone')}
        </Button>
      </div>
    </div>
  )
}

export interface EmptyTeamSteps { skills: () => void; files: () => void }

/** "지금 초대하면 팀원이 볼 게 없어요 · 스킬 넣기 · 팀 파일 넣기", for owners and admins while the team has no skill and no
 * document (GET /api/skills/examples as them: the same count members see, the brand folder left out). Nothing while
 * that is unknown or the read fails: the line only ever informs. */
export function EmptyTeamLine({ steps }: { steps?: EmptyTeamSteps }) {
  const t = useT()
  const admin = isAdmin(useMe())
  const { data } = useTeamPrepared(admin)
  // a count that stopped (`more`) before it found a document is no empty team
  if (!admin || !data || data.skills.length > 0 || (data.teamFolder?.files ?? 0) > 0 || data.teamFolder?.more) return null
  const link = clsx(quietLink, 'touch-hit')
  return (
    <p className="text-label text-muted" role="note" data-testid="invite-empty-team">
      {t('home.prepared.inviteEmpty')}
      <span aria-hidden> · </span>
      {steps
        ? <button type="button" className={link} onClick={steps.skills} data-testid="invite-empty-skills">{t('home.prepared.addSkills')}</button>
        : <Link to={SKILL_CATALOG} className={link} data-testid="invite-empty-skills">{t('home.prepared.addSkills')}</Link>}
      <span aria-hidden> · </span>
      {steps
        ? <button type="button" className={link} onClick={steps.files} data-testid="invite-empty-files">{t('home.prepared.addFiles')}</button>
        : <Link to={teamFolderPath()} className={link} data-testid="invite-empty-files">{t('home.prepared.addFiles')}</Link>}
    </p>
  )
}

export default InviteStep
