// On the chat the welcome steps' first result ran in (pages/Welcome.tsx), once its answer is in, one slim bar with one
// button [팀원 초대]. With the lead's team files in that chat (docs/DECISIONS.md "M — One meeting note, everyone's own
// tasks"): "팀원도 이 회의록에서 각자 할 일을 바로 받아요", or, when the skill said the files were not meeting notes and
// gave a brief, "팀원도 이 자료에서 각자 필요한 것만 바로 봐요"; the invite then carries those files as its starter, so
// people who join land on a new chat with them and their own question. With the ad copy (no files): "팀원도 이 스킬을
// 바로 써 볼 수 있어요" and people land on its form. Closing the bar asks the soft "most teams start with one or two"
// first, as the invite step does. Only the owner sees it, and only until the invite is done or put off.
import { UserPlus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Message, TeamLinkStarter, WelcomeStepState } from '@mycel/shared/api'
import { resultStarter, showInviteBar } from '../../lib/welcome'
import { useT } from '../../i18n'
import { isOwner, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { Button, IconButton, Modal } from '../ui'
import { InviteStep, SkipDialog } from './InviteStep'

type ChatMessage = Pick<Message, 'role' | 'content' | 'attachments'>

export function WelcomeInviteBar({ chatId, answered, messages = [] }: { chatId: string; answered: boolean; messages?: ChatMessage[] }) {
  const t = useT()
  const owner = isOwner(useMe())
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
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
    void useWelcome.getState().update({ step: { id: 'invite', state } }).then(
      (p) => { if (p.finishedAt) toast({ level: 'success', text: t('welcome.finished') }) },
      () => toast({ level: 'error', text: t('error.network') }),
    )
  }
  // the team files: "할 일 정리" for their own tasks, or "핵심 정리" when the answer was a brief; else the ad copy
  const skillPath = found
    ? (found.kind === 'brief' ? (progress.general?.briefPath ?? progress.general?.tasksPath) : progress.general?.tasksPath) ?? null
    : (progress.pack?.skillPath ?? null)
  // a starter goes with a skill (the server needs one); the files are checked again when someone joins
  const starter: TeamLinkStarter | null = found && skillPath ? { kind: found.kind, files: found.files.slice(0, 20) } : null
  const text = found ? t(found.kind === 'brief' ? 'welcome.bar.brief' : 'welcome.bar.tasks') : t('welcome.bar.skill')
  const title = found || !skillPath ? t('teamLink.stepTitle') : t('welcome.invite.title', { skill: t('welcome.skillName') })
  return (
    <>
      {answered && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-subtle py-1.5 pr-1.5 pl-3 text-sm" data-testid="welcome-invite-bar" data-kind={found?.kind ?? 'skill'}>
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
          <InviteStep title={null} skillPath={skillPath} starter={starter} onDone={() => finish('done')} onSkip={() => finish('skipped')} />
        </Modal>
      )}
      {asking && <SkipDialog onInvite={invite} onLater={() => finish('skipped')} />}
    </>
  )
}

export default WelcomeInviteBar
