// The onboarding wizard's invite step (after the welcome steps' first result). Standalone: it shows the ready-made
// message with the team invite link and one "메시지 복사", or makes the link in one press; the link itself, its settings
// and "새 링크로 바꾸기" are folded under "링크 관리" (TeamLinkPanel `folded`). Skipping asks once, softly, whether to
// invite one or two people first, because a team skill is only a team's once others use it.
import { useState } from 'react'
import type { TeamLinkStarter } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { Button, Modal } from '../ui'
import { TeamLinkPanel } from './TeamLinkPanel'

export interface InviteStepProps {
  /** the person is done with this step (copied the link or the message, or just moves on) */
  onDone: () => void
  /** "later": shown only when given; asks once before it is called */
  onSkip?: () => void
  /** the skill the first result used: people who join land on its form (skills/…). Omitted: none. */
  skillPath?: string | null
  /** the lead's team files and what people who join get from them (needs `skillPath`): a new link carries it, and an
   * open link is changed to carry it (TeamLinkPanel) */
  starter?: TeamLinkStarter | null
  /** the heading in place of "팀원을 초대해요" (the welcome steps name the skill just used); null: none, the dialog
   * around it already names the step (one heading on a phone, not two) */
  title?: string | null
}

export function InviteStep({ onDone, onSkip, skillPath, starter, title }: InviteStepProps) {
  const t = useT()
  const [asking, setAsking] = useState(false)
  return (
    <div className="space-y-4" data-testid="invite-step">
      <div>
        {title !== null && <h2 className="mb-1 text-lg font-semibold">{title ?? t('teamLink.stepTitle')}</h2>}
        <p className="text-sm text-muted">{t('teamLink.stepDesc')}</p>
      </div>
      {/* folded: the message and "메시지 복사"; the link and its settings wait under "링크 관리" (no "링크 끄기" here) */}
      <TeamLinkPanel skillPicker={false} skillPath={skillPath} starter={starter} folded />
      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        {onSkip && (
          <Button variant="ghost" onClick={() => setAsking(true)} data-testid="invite-step-skip">
            {t('teamLink.later')}
          </Button>
        )}
        {/* not primary: the panel's own action (make the link, then copy the message) is the one primary here */}
        <Button onClick={onDone} data-testid="invite-step-done">
          {t('teamLink.stepDone')}
        </Button>
      </div>
      {asking && <SkipDialog onInvite={() => setAsking(false)} onLater={() => { setAsking(false); onSkip?.() }} />}
    </div>
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
