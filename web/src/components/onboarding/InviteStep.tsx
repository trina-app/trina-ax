// The onboarding wizard's invite step (after the welcome steps' first result). Standalone: it shows the ready-made
// message with the team invite link and one "메시지 복사", or makes the link in one press; the link itself, its settings
// and "새 링크로 바꾸기" are folded under "링크 관리" (TeamLinkPanel `folded`). For the owner walking the welcome steps
// (`prepare`) the link is made as the step opens, so the message is there at once (docs/DECISIONS.md "W2"). Skipping
// asks once, softly, whether to invite one or two people first, because a team skill is only a team's once others use it.
// A team with no skills and no documents yet gets one quiet line above the message (docs/DECISIONS.md "W6.3"): "지금
// 초대하면 팀원이 볼 게 없어요 · 스킬 넣기 · 팀 파일 넣기"; it never blocks, and it is gone while "이 사람이 팀장이에요" is
// ticked (the lead is the one who will set up).
import clsx from 'clsx'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { WelcomeProgress } from '@mycel/shared/api'
import { t as tNow, useT } from '../../i18n'
import { isAdmin, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { Button, Modal } from '../ui'
import { TeamLinkPanel } from './TeamLinkPanel'
import { quietLink } from './SkillShareReview'
import { useTeamPrepared } from './TeamPrepared'
import { LeadInvite } from '../handover/LeadInvite'

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
  /** "later": shown only when given; asks once before it is called */
  onSkip?: () => void
  /** the skill the first result used: people who join land on its form (skills/…). Omitted: none. */
  skillPath?: string | null
  /** `skillPath` is a team skill the lead just made from their own work (docs/DECISIONS.md "S"): an open link is changed
   * to lead there, and the message says the skill was made for the team */
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
   * again); absent: they go to 팀 스킬 and 파일 */
  steps?: EmptyTeamSteps
}

export function InviteStep({ onDone, onSkip, skillPath, made, retarget, prepare, title, shared, steps }: InviteStepProps) {
  const t = useT()
  const [asking, setAsking] = useState(false)
  return (
    <div className="space-y-4" data-testid="invite-step">
      <div>
        {title !== null && <h2 className="mb-1 text-lg font-semibold">{title ?? t('teamLink.stepTitle')}</h2>}
        <p className="text-sm text-muted">{t('teamLink.stepDesc')}</p>
      </div>
      {/* folded: the message and "메시지 복사"; the link and its settings wait under "링크 관리" (no "링크 끄기" here).
          The welcome steps (prepare): the owner may tick "이 사람이 팀장이에요" above it, and the one-person lead link's
          message takes its place (components/handover/LeadInvite.tsx, docs/DECISIONS.md "W6") */}
      <LeadInvite enabled={!!prepare}>
        <EmptyTeamLine steps={steps} />
        <TeamLinkPanel skillPicker={false} skillPath={skillPath} made={made} retarget={retarget} prepare={prepare} shared={shared} folded />
      </LeadInvite>
      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        {onSkip && (
          <Button variant="ghost" onClick={() => setAsking(true)} data-testid="invite-step-skip">
            {t('teamLink.later')}
          </Button>
        )}
        {/* not primary: the panel's own action (copy the message, or make the link first) is the one primary here */}
        <Button onClick={onDone} data-testid="invite-step-done">
          {t('teamLink.stepDone')}
        </Button>
      </div>
      {asking && <SkipDialog onInvite={() => setAsking(false)} onLater={() => { setAsking(false); onSkip?.() }} />}
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
        : <Link to="/skills" className={link} data-testid="invite-empty-skills">{t('home.prepared.addSkills')}</Link>}
      <span aria-hidden> · </span>
      {steps
        ? <button type="button" className={link} onClick={steps.files} data-testid="invite-empty-files">{t('home.prepared.addFiles')}</button>
        : <Link to="/files" className={link} data-testid="invite-empty-files">{t('home.prepared.addFiles')}</Link>}
    </p>
  )
}

/** "Most teams start with one or two": [초대하기] goes back to the link, [나중에] skips. */
export function SkipDialog({ onInvite, onLater }: { onInvite: () => void; onLater: () => void }) {
  const t = useT()
  return (
    <Modal
      open
      onClose={onInvite}
      title={t('teamLink.skipTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onLater} data-testid="invite-step-later">
            {t('teamLink.later')}
          </Button>
          <Button variant="primary" onClick={onInvite} data-testid="invite-step-invite">
            {t('teamLink.invite')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">{t('teamLink.skipBody')}</p>
    </Modal>
  )
}

export default InviteStep
