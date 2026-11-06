// One suggestion under a result, above the message box (docs/DECISIONS.md "X — Lean onboarding"): at most one line,
// chosen by state, never two at once.
//   - the lead's first result: the welcome invite bar (WelcomeInviteBar, which shares the skill that made it), nothing else;
//   - else what the server says for the newest answer (server/src/onboarding/suggestions.ts): the same person ran the
//     same team skill for the 2nd time → "매주 이 시간에 자동으로 받을까요?" [예약하기], which asks the AI in this chat to
//     schedule the same request every week at this time (the AI's schedule card is how tasks are made: the person sees
//     the title, the time and the whole request and confirms there); a long report-like answer → [PPT로 만들기], which
//     sends "이 내용을 PPT로 만들어 줘"; an owner's or admin's answer that used team files and ran no team skill, when S's
//     rules let it become one → "이 방식대로 팀 스킬로 만들까요?" [팀 스킬로 만들기], which opens the skill card
//     (SkillShareCard: the draft, then [팀에 공유] and the invite with that skill; docs/DECISIONS.md "S", "W3": the card
//     had no entry since the first result shares the pack's own skill).
// Closing one (X) closes it for good for this person (stored on the server). Acting on one hides it under that answer.
// From 768px it is a slim box with a primary button; on a phone one frameless line over the message box, its action a
// text button at the end of the sentence (a box and a big button there sat on top of the message box).
// The promo video from the intro deck (`deck-video`, docs/DECISIONS.md "D2") is not built yet: the server never sends it
// while DECK_VIDEO_SUGGESTION is off, and this line shows nothing for it.
import clsx from 'clsx'
import { CalendarClock, Presentation, Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SavedSkillDraft, ResultSuggestion as Suggestion } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { showInviteBar } from '../../lib/welcome'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { isOwner, useMe } from '../../store/session'
import type { ViewMessage } from '../../store/thread'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { Button, IconButton, Modal, useMediaQuery } from '../ui'
import { InviteStep } from './InviteStep'
import { SkillShareCard } from './SkillShareCard'
import { WelcomeInviteBar } from './WelcomeInviteBar'

/** Each suggestion's line and button (`deck-video` has none yet: it is never shown). */
const WORDS = {
  schedule: { text: 'resultTip.schedule.text', act: 'resultTip.schedule.act' },
  'team-skill': { text: 'resultTip.teamSkill.text', act: 'resultTip.teamSkill.act' },
  ppt: { text: 'resultTip.ppt.text', act: 'resultTip.ppt.act' },
} as const satisfies Record<Exclude<Suggestion['kind'], 'deck-video'>, { text: MessageKey; act: MessageKey }>

/** "매주 수요일 오후 2:30에 …": the weekday and time of now, in the person's language. */
export function weeklyAt(now: Date, locale: string): { day: string; time: string } {
  return {
    day: new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now),
    time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(now),
  }
}

export function ResultSuggestion({ chatId, messages, busy, onSend }: { chatId: string; messages: ViewMessage[]; busy: boolean; onSend: (text: string) => void }) {
  const t = useT()
  const locale = useLocale()
  const owner = isOwner(useMe())
  const phone = useMediaQuery('(max-width: 767.98px)')
  const welcomeLoaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  const last = messages.at(-1)
  const answered = !busy && last?.role === 'assistant' && last.status === 'done' && !last.local
  // the owner's first-result chat has the invite bar; until the steps' progress is known, nothing else is asked
  const inviteHere = owner && (!welcomeLoaded || (!!progress && showInviteBar(progress, chatId)))
  const [got, setGot] = useState<{ messageId: string; suggestion: Suggestion | null } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  // the skill card of "팀 스킬로 만들기" (the answer it was opened under), then the invite with the skill it shared
  const [card, setCard] = useState<string | null>(null)
  const [shared, setShared] = useState<SavedSkillDraft | null>(null)
  const lastId = answered ? last!.id : null
  useEffect(() => {
    if (!lastId || inviteHere) return
    let live = true
    api.call(API.getResultSuggestion, { query: { chatId, messageId: lastId } }).then(
      (r) => live && setGot({ messageId: lastId, suggestion: r.suggestion }),
      () => live && setGot({ messageId: lastId, suggestion: null }),
    )
    return () => { live = false }
  }, [chatId, lastId, inviteHere])

  const closeCard = () => { setCard(null); setShared(null) }
  const cardDialog = card && (
    <Modal open onClose={closeCard} width={520} title={shared ? t('teamLink.stepTitle') : t('resultTip.teamSkill.act')}>
      {shared
        ? <InviteStep title={null} skillPath={shared.path} made onDone={closeCard} />
        : <SkillShareCard chatId={chatId} answerId={card} onShared={setShared} onLater={closeCard} />}
    </Modal>
  )
  const bar = <><WelcomeInviteBar chatId={chatId} answered={answered} messages={messages} />{cardDialog}</>
  if (inviteHere || !lastId || got?.messageId !== lastId || !got.suggestion || done === lastId || got.suggestion.kind === 'deck-video') return bar
  const s = got.suggestion
  const act = () => {
    setDone(lastId)
    if (s.kind === 'team-skill') return setCard(lastId)
    if (s.kind === 'ppt') return onSend(t('resultTip.ppt.message'))
    // the request that made this answer, as the person sent it ("/ad-copy" and the form's lines)
    const request = messages.find((m) => m.id === last!.parentId)?.content.trim() || `/${s.skill.name}`
    onSend(t('resultTip.schedule.message', { ...weeklyAt(new Date(), locale), request }))
  }
  const close = () => {
    setDone(lastId)
    api.call(API.dismissSuggestion, { body: { key: s.key } }).catch(() => toast({ level: 'error', text: t('error.network') }))
  }
  const Icon = s.kind === 'ppt' ? Presentation : s.kind === 'team-skill' ? Sparkles : CalendarClock
  const words = WORDS[s.kind]
  return (
    <>
      {bar}
      <div className={clsx('mb-2 flex items-center gap-2 text-sm', !phone && 'rounded-xl border border-line bg-subtle py-1.5 pr-1.5 pl-3')} data-testid="result-suggestion" data-kind={s.kind}>
        <Icon size={15} className="shrink-0 text-accent-text" aria-hidden />
        {phone ? (
          // inline, so a long sentence wraps with its action; the padding widens the tap area without moving the line
          <p className="min-w-0 flex-1 leading-6 text-muted">
            {t(words.text)}{' '}
            <button type="button" className="inline py-2 font-medium whitespace-nowrap text-accent-text underline-offset-2 hover:underline" onClick={act} data-testid="result-suggestion-act">
              {t(words.act)}
            </button>
          </p>
        ) : (
          <>
            <span className="min-w-0 flex-1 leading-6">{t(words.text)}</span>
            <Button size="sm" variant="primary" className="shrink-0" onClick={act} data-testid="result-suggestion-act">
              {t(words.act)}
            </Button>
          </>
        )}
        <IconButton label={t('resultTip.close')} onClick={close} data-testid="result-suggestion-close">
          <X size={15} />
        </IconButton>
      </div>
    </>
  )
}

export default ResultSuggestion
