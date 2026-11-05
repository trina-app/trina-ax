// One suggestion under a result, above the message box (docs/DECISIONS.md "X — Lean onboarding"): at most one line,
// chosen by state, never two at once.
//   - the lead's first result: the welcome invite bar (WelcomeInviteBar, which shares the skill that made it), nothing else;
//   - else what the server says for the newest answer (server/src/onboarding/suggestions.ts): the same person ran the
//     same team skill for the 2nd time → "매주 이 시간에 자동으로 받을까요?" [예약하기], which asks the AI in this chat to
//     schedule the same request every week at this time (the AI's schedule card is how tasks are made: the person sees
//     the title, the time and the whole request and confirms there); a long report-like answer → [PPT로 만들기], which
//     sends "이 내용을 PPT로 만들어 줘".
// Closing one (X) closes it for good for this person (stored on the server). Acting on one hides it under that answer.
import { CalendarClock, Presentation, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ResultSuggestion as Suggestion } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { showInviteBar } from '../../lib/welcome'
import { useLocale, useT } from '../../i18n'
import { isOwner, useMe } from '../../store/session'
import type { ViewMessage } from '../../store/thread'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { Button, IconButton } from '../ui'
import { WelcomeInviteBar } from './WelcomeInviteBar'

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
  const welcomeLoaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  const last = messages.at(-1)
  const answered = !busy && last?.role === 'assistant' && last.status === 'done' && !last.local
  // the owner's first-result chat has the invite bar; until the steps' progress is known, nothing else is asked
  const inviteHere = owner && (!welcomeLoaded || (!!progress && showInviteBar(progress, chatId)))
  const [got, setGot] = useState<{ messageId: string; suggestion: Suggestion | null } | null>(null)
  const [done, setDone] = useState<string | null>(null)
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

  const bar = <WelcomeInviteBar chatId={chatId} answered={answered} messages={messages} />
  if (inviteHere || !lastId || got?.messageId !== lastId || !got.suggestion || done === lastId) return bar
  const s = got.suggestion
  const act = () => {
    setDone(lastId)
    if (s.kind === 'ppt') return onSend(t('resultTip.ppt.message'))
    // the request that made this answer, as the person sent it ("/ad-copy" and the form's lines)
    const request = messages.find((m) => m.id === last!.parentId)?.content.trim() || `/${s.skill.name}`
    onSend(t('resultTip.schedule.message', { ...weeklyAt(new Date(), locale), request }))
  }
  const close = () => {
    setDone(lastId)
    api.call(API.dismissSuggestion, { body: { key: s.key } }).catch(() => toast({ level: 'error', text: t('error.network') }))
  }
  const Icon = s.kind === 'ppt' ? Presentation : CalendarClock
  return (
    <>
      {bar}
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-subtle py-1.5 pr-1.5 pl-3 text-sm" data-testid="result-suggestion" data-kind={s.kind}>
        <Icon size={15} className="shrink-0 text-accent-text max-sm:hidden" aria-hidden />
        <span className="min-w-0 flex-1 leading-6">{t(s.kind === 'ppt' ? 'resultTip.ppt.text' : 'resultTip.schedule.text')}</span>
        <Button size="sm" variant="primary" className="shrink-0" onClick={act} data-testid="result-suggestion-act">
          {t(s.kind === 'ppt' ? 'resultTip.ppt.act' : 'resultTip.schedule.act')}
        </Button>
        <IconButton label={t('resultTip.close')} onClick={close} data-testid="result-suggestion-close">
          <X size={15} />
        </IconButton>
      </div>
    </>
  )
}

export default ResultSuggestion
