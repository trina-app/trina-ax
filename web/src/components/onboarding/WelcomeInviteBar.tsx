// On the chat the welcome steps' first result ran in (pages/Welcome.tsx), once its answer is in, one slim bar for the
// owner with one button: "마음에 드시나요? 팀원도 같은 방식으로 바로 만들 수 있어요" [팀에 공유] (docs/DECISIONS.md "W2 —
// AI connection first"). It opens the invite (내 스킬 가져오기 came before it, docs/DECISIONS.md "K": with skills shared
// there the invite names them and its link opens the first of them); otherwise with the skill that made the result, as it is (lib/welcome.ts
// resultSkill: the run the server recorded, the path the 7-day goal counts), never a copy: people who join land on its
// form and their runs count with the owner's. The link is made in advance (InviteStep `prepare`: the message and one
// "메시지 복사" at once), an open link that leads elsewhere is changed to that skill (same address), and no files go
// with it: the pack's skills read the team's own folders (the intro deck: the newest company intro in the brand
// folder), and the link puts people in the team's group. Closing the bar asks the soft "most teams start with one or
// two" first, as the invite step does. Only the owner sees it, and only until the invite is done or put off. On a phone
// it is one frameless line with a text button, as the other suggestions there (ResultSuggestion).
// (Before, the bar drafted a team skill from the answer, "S": a near-copy of the pack's skill under another path, so a
// member's run of it never counted with the owner's. The skill card, components/onboarding/SkillShareCard.tsx, opens
// from the one suggestion under the lead's later answers instead: ResultSuggestion, docs/DECISIONS.md "W3".)
import clsx from 'clsx'
import { UserPlus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Message, WelcomeStepState } from '@mycel/shared/api'
import { resultSkill, showInviteBar } from '../../lib/welcome'
import { useT } from '../../i18n'
import { isOwner, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { Button, IconButton, Modal, useMediaQuery } from '../ui'
import { InviteStep, SkipDialog, sharedForInvite } from './InviteStep'

type ChatMessage = Pick<Message, 'role' | 'content' | 'receipt'>

export function WelcomeInviteBar({ chatId, answered, messages = [] }: { chatId: string; answered: boolean; messages?: ChatMessage[] }) {
  const t = useT()
  const owner = isOwner(useMe())
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const phone = useMediaQuery('(max-width: 767.98px)')
  useEffect(() => {
    if (owner) void useWelcome.getState().load().catch(() => {})
  }, [owner])
  // the skill the owner shared from 내 스킬 가져오기 first (docs/DECISIONS.md "K": the link opens it), else the deck's
  const skillPath = useMemo(() => progress?.shared?.landing ?? resultSkill(messages, progress), [messages, progress])
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
  return (
    <>
      {answered && (
        <div className={clsx('mb-2 flex items-center gap-2 text-sm', !phone && 'flex-wrap rounded-xl border border-line bg-subtle py-1.5 pr-1.5 pl-3')} data-testid="welcome-invite-bar" data-kind="share">
          <UserPlus size={15} className="shrink-0 text-accent-text" aria-hidden />
          {phone ? (
            <p className="min-w-0 flex-1 leading-6 text-muted">
              <span data-testid="welcome-invite-text">{t('welcome.share.bar')}</span>{' '}
              <button type="button" className="inline py-2 font-medium whitespace-nowrap text-accent-text underline-offset-2 hover:underline" onClick={invite} data-testid="welcome-invite-open">
                {t('welcome.share.button')}
              </button>
            </p>
          ) : (
            <span className="min-w-0 flex-[1_1_12rem] leading-6" data-testid="welcome-invite-text">{t('welcome.share.bar')}</span>
          )}
          <span className="flex items-center gap-1">
            {!phone && <Button size="sm" variant="primary" onClick={invite} data-testid="welcome-invite-open">{t('welcome.share.button')}</Button>}
            <IconButton label={t('welcome.bar.later')} onClick={() => setAsking(true)} data-testid="welcome-invite-close">
              <X size={15} />
            </IconButton>
          </span>
        </div>
      )}
      {open && (
        // the dialog's own title names the step: no second heading inside it
        <Modal open onClose={() => setOpen(false)} width={560} title={t('teamLink.stepTitle')}>
          <InviteStep title={null} skillPath={skillPath} retarget={!!skillPath} shared={sharedForInvite(progress)} prepare onDone={() => finish('done')} onSkip={() => finish('skipped')} />
        </Modal>
      )}
      {asking && <SkipDialog onInvite={invite} onLater={() => finish('skipped')} />}
    </>
  )
}

export default WelcomeInviteBar
