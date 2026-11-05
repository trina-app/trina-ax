// On the chat the welcome steps' first result ran in (pages/Welcome.tsx), once its answer is in, one slim bar with one
// button. With the lead's team files in that chat (docs/DECISIONS.md "S — The lead's way becomes a team skill"; the
// company card news of "N" always has them): "마음에 드시나요? 팀 스킬로 저장하면 다른 분들도 같은 방식으로 만들 수
// 있어요" [팀 스킬로 저장]; the skill card (SkillShareCard) drafts a team skill from that answer
// and its files, the lead shares it, and the invite step follows with that skill: people who join land on its form, or
// on a new chat with its title when it asks nothing. Its X puts the invite off. With the ad copy (no files, our own
// skill: making a team skill of it would only copy ours): "팀원도 이 스킬을 바로 써 볼 수 있어요" [팀원 초대], people land
// on its form, and closing the bar asks the soft "most teams start with one or two" first, as the invite step does.
// Only the owner sees it, and only until the invite is done or put off.
import { Sparkles, UserPlus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Message, SavedSkillDraft, WelcomeStepState } from '@mycel/shared/api'
import { resultStarter, showInviteBar } from '../../lib/welcome'
import { useT } from '../../i18n'
import { isOwner, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { Button, IconButton, Modal } from '../ui'
import { InviteStep, SkipDialog } from './InviteStep'
import { SkillShareCard } from './SkillShareCard'

type ChatMessage = Pick<Message, 'role' | 'content' | 'attachments'>

export function WelcomeInviteBar({ chatId, answered, messages = [] }: { chatId: string; answered: boolean; messages?: ChatMessage[] }) {
  const t = useT()
  const owner = isOwner(useMe())
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  // the skill card, then the invite with the skill it shared
  const [card, setCard] = useState(false)
  const [shared, setShared] = useState<SavedSkillDraft | null>(null)
  useEffect(() => {
    if (owner) void useWelcome.getState().load().catch(() => {})
  }, [owner])
  const found = useMemo(() => resultStarter(messages), [messages])
  if (!owner || !loaded || !progress || !showInviteBar(progress, chatId)) return null

  const invite = () => {
    setAsking(false)
    setOpen(true)
    if (!progress.inviteShownAt) void useWelcome.getState().update({ inviteShown: true }).catch(() => {})
  }
  const finish = (state: WelcomeStepState) => {
    setOpen(false)
    setAsking(false)
    setCard(false)
    void useWelcome.getState().update({ step: { id: 'invite', state } }).then(
      (p) => { if (p.finishedAt) toast({ level: 'success', text: t('welcome.finished') }) },
      () => toast({ level: 'error', text: t('error.network') }),
    )
  }
  // the lead's own files: their way of working becomes a team skill first ("S")
  if (found)
    return (
      <>
        {answered && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-subtle py-1.5 pr-1.5 pl-3 text-sm" data-testid="welcome-invite-bar" data-kind="skill-share">
            <Sparkles size={15} className="shrink-0 text-accent-text" aria-hidden />
            <span className="min-w-0 flex-[1_1_12rem] leading-6" data-testid="welcome-invite-text">{t('skillShare.bar')}</span>
            <span className="flex items-center gap-1">
              <Button size="sm" variant="primary" onClick={() => { setCard(true); if (!progress.inviteShownAt) void useWelcome.getState().update({ inviteShown: true }).catch(() => {}) }} data-testid="skill-share-open">{t('skillShare.make')}</Button>
              <IconButton label={t('welcome.bar.later')} onClick={() => finish('skipped')} data-testid="welcome-invite-close">
                <X size={15} />
              </IconButton>
            </span>
          </div>
        )}
        {card && (
          <Modal open onClose={() => setCard(false)} width={520} title={shared ? t('teamLink.stepTitle') : t('skillShare.cardTitle')}>
            {shared
              ? <InviteStep title={null} skillPath={shared.path} made onDone={() => finish('done')} onSkip={() => finish('skipped')} />
              : <SkillShareCard chatId={chatId} onShared={setShared} onLater={() => setCard(false)} />}
          </Modal>
        )}
      </>
    )
  // the ad copy (no files)
  const skillPath = progress.pack?.skillPath ?? null
  const text = t('welcome.bar.skill')
  const title = !skillPath ? t('teamLink.stepTitle') : t('welcome.invite.title', { skill: t('welcome.skillName') })
  return (
    <>
      {answered && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-subtle py-1.5 pr-1.5 pl-3 text-sm" data-testid="welcome-invite-bar" data-kind="skill">
          <UserPlus size={15} className="shrink-0 text-accent-text" aria-hidden />
          <span className="min-w-0 flex-[1_1_12rem] leading-6" data-testid="welcome-invite-text">{text}</span>
          <span className="flex items-center gap-1">
            <Button size="sm" variant="primary" onClick={invite} data-testid="welcome-invite-open">{t('welcome.bar.inviteTeam')}</Button>
            <IconButton label={t('welcome.bar.later')} onClick={() => setAsking(true)} data-testid="welcome-invite-close">
              <X size={15} />
            </IconButton>
          </span>
        </div>
      )}
      {open && (
        // the dialog's own title is the step's question: no second heading inside it
        <Modal open onClose={() => setOpen(false)} width={560} title={title}>
          <InviteStep title={null} skillPath={skillPath} onDone={() => finish('done')} onSkip={() => finish('skipped')} />
        </Modal>
      )}
      {asking && <SkipDialog onInvite={invite} onLater={() => finish('skipped')} />}
    </>
  )
}

export default WelcomeInviteBar
