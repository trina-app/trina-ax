// The onboarding wizard's invite step (wave 2 strings it after 팀 유형 → 회사 소개 → 첫 결과). Standalone: it shows the
// team invite link and the ready-made message, or makes the link in one press. Skipping asks once, softly, whether to
// invite one or two people first, because a team skill is only a team's once others use it.
import { useState } from 'react'
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
}

export function InviteStep({ onDone, onSkip, skillPath }: InviteStepProps) {
  const t = useT()
  const [asking, setAsking] = useState(false)
  return (
    <div className="space-y-4" data-testid="invite-step">
      <div>
        <h2 className="text-lg font-semibold">{t('teamLink.stepTitle')}</h2>
        <p className="mt-1 text-sm text-muted">{t('teamLink.stepDesc')}</p>
      </div>
      <TeamLinkPanel skillPicker={false} skillPath={skillPath} />
      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        {onSkip && (
          <Button variant="ghost" onClick={() => setAsking(true)} data-testid="invite-step-skip">
            {t('teamLink.later')}
          </Button>
        )}
        <Button variant="primary" onClick={onDone} data-testid="invite-step-done">
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
