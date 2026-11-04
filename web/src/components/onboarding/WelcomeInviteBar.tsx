// On the chat the welcome steps' first result ran in (pages/Welcome.tsx), once its answer is in: "결과가 마음에 드세요?
// 팀원도 같이 써 보게 해요 [초대하기]". The button opens the team invite (stream E's InviteStep) with that skill, so
// people who join land on its form. Closing the bar asks the soft "most teams start with one or two" first, as the
// invite step does. Only the owner sees it, and only until the invite is done or put off.
import { UserPlus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { showInviteBar } from '../../lib/welcome'
import { useT } from '../../i18n'
import { isOwner, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import type { WelcomeStepState } from '@mycel/shared/api'
import { Button, IconButton, Modal } from '../ui'
import { InviteStep, SkipDialog } from './InviteStep'

export function WelcomeInviteBar({ chatId, answered }: { chatId: string; answered: boolean }) {
  const t = useT()
  const owner = isOwner(useMe())
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    if (owner) void useWelcome.getState().load().catch(() => {})
  }, [owner])
  if (!owner || !loaded || !progress || !showInviteBar(progress, chatId)) return null

  const invite = () => {
    setAsking(false)
    setOpen(true)
    if (!progress.inviteShownAt) void useWelcome.getState().update({ inviteShown: true }).catch(() => {})
  }
  const finish = (state: WelcomeStepState) => {
    setOpen(false)
    setAsking(false)
    void useWelcome.getState().update({ step: { id: 'invite', state } }).then(
      (p) => { if (p.finishedAt) toast({ level: 'success', text: t('welcome.finished') }) },
      () => toast({ level: 'error', text: t('error.network') }),
    )
  }
  const skillPath = progress.pack?.skillPath ?? null
  return (
    <>
      {answered && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-subtle py-1.5 pr-1.5 pl-3 text-sm" data-testid="welcome-invite-bar">
          <UserPlus size={15} className="shrink-0 text-accent-text" aria-hidden />
          <span className="min-w-0 flex-[1_1_12rem] leading-6">{t('welcome.bar.text')}</span>
          <span className="flex items-center gap-1">
            <Button size="sm" variant="primary" onClick={invite} data-testid="welcome-invite-open">{t('welcome.bar.invite')}</Button>
            <IconButton label={t('welcome.bar.later')} onClick={() => setAsking(true)} data-testid="welcome-invite-close">
              <X size={15} />
            </IconButton>
          </span>
        </div>
      )}
      {open && (
        <Modal open onClose={() => setOpen(false)} width={560} title={t('teamLink.stepTitle')}>
          <InviteStep title={skillPath ? t('welcome.invite.title', { skill: t('welcome.skillName') }) : undefined} skillPath={skillPath} onDone={() => finish('done')} onSkip={() => finish('skipped')} />
        </Modal>
      )}
      {asking && <SkipDialog onInvite={invite} onLater={() => finish('skipped')} />}
    </>
  )
}

export default WelcomeInviteBar
