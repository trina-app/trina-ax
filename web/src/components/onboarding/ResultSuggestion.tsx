// One suggestion under a result, above the message box (docs/DECISIONS.md "X — Lean onboarding"): at most one line,
// chosen by state, never two at once. The intro deck's chat is an ordinary chat here (docs/DECISIONS.md "W5": no invite
// bar under it any more; the invite is a welcome step):
//   - what the server says for the newest answer (server/src/onboarding/suggestions.ts): the same person ran the
//     same team skill for the 2nd time → "매주 이 시간에 자동으로 받을까요?" [예약하기], which asks the AI in this chat to
//     schedule the same request every week at this time (the AI's schedule card is how tasks are made: the person sees
//     the title, the time and the whole request and confirms there); a long report-like answer → [PPT로 만들기], which
//     sends "이 내용을 PPT로 만들어 줘"; an owner's or admin's answer that used team files and ran no team skill, when S's
//     rules let it become one → "이 방식대로 팀 스킬로 만들까요?" [팀 스킬로 만들기], which opens the skill card
//     (SkillShareCard: the draft, then [팀에 공유] and the invite with that skill; docs/DECISIONS.md "S", "W3": the card
//     had no entry since the first result shares the pack's own skill).
//   - under a member's first successful run of the landing skill (docs/DECISIONS.md "MC") → "내가 쓰던 스킬이나 파일도 팀에
//     올릴래요?" [올리기], which opens the member's skill folder pick (components/skills/ContributeSheet.tsx) with a link
//     to the team folder when they can write it; on a phone the line offers only that folder ("팀 폴더 열기"), and the
//     server leaves the line out there when there is none (it is asked with phone=1).
// Closing one (X) closes it for good for this person (stored on the server). Acting on one hides it under that answer.
// From 768px it is a slim box with a primary button; on a phone one frameless line over the message box, its action a
// text button at the end of the sentence (a box and a big button there sat on top of the message box).
// The promo video from the intro deck (`deck-video`, docs/DECISIONS.md "D2") is not built yet: the server never sends it
// while DECK_VIDEO_SUGGESTION is off, and this line shows nothing for it.
import clsx from 'clsx'
import { CalendarClock, FolderUp, Presentation, Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SavedSkillDraft, ResultSuggestion as Suggestion } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useLocale, useT, type MessageKey } from '../../i18n'
import type { ViewMessage } from '../../store/thread'
import { toast } from '../../store/ui'
import { Button, IconButton, Modal, useMediaQuery } from '../ui'
import { ContributeSheet } from '../skills/ContributeSheet'
import { InviteStep } from './InviteStep'
import { SkillShareCard } from './SkillShareCard'

/** Each suggestion's line and button (`deck-video` has none yet: it is never shown). */
const WORDS = {
  schedule: { text: 'resultTip.schedule.text', act: 'resultTip.schedule.act' },
  'team-skill': { text: 'resultTip.teamSkill.text', act: 'resultTip.teamSkill.act' },
  ppt: { text: 'resultTip.ppt.text', act: 'resultTip.ppt.act' },
  contribute: { text: 'resultTip.contribute.text', act: 'resultTip.contribute.act' },
} as const satisfies Record<Exclude<Suggestion['kind'], 'deck-video'>, { text: MessageKey; act: MessageKey }>
/** A phone has no folder picking: the member's line offers only the team folder there. */
const CONTRIBUTE_PHONE = { text: 'resultTip.contribute.textPhone', act: 'resultTip.contribute.actPhone' } as const satisfies { text: MessageKey; act: MessageKey }

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
  const phone = useMediaQuery('(max-width: 767.98px)')
  const last = messages.at(-1)
  const answered = !busy && last?.role === 'assistant' && last.status === 'done' && !last.local
  const [got, setGot] = useState<{ messageId: string; suggestion: Suggestion | null } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  // the skill card of "팀 스킬로 만들기" (the answer it was opened under), then the invite with the skill it shared
  const [card, setCard] = useState<string | null>(null)
  const [shared, setShared] = useState<SavedSkillDraft | null>(null)
  // the member's skill folder pick of "올리기" (the team folder they can write, or null)
  const [contribute, setContribute] = useState<{ folder: string | null } | null>(null)
  const navigate = useNavigate()
  const lastId = answered ? last!.id : null
  useEffect(() => {
    if (!lastId) return
    let live = true
    // a phone: no contribute line without a team folder (the server answers what comes next instead)
    api.call(API.getResultSuggestion, { query: { chatId, messageId: lastId, ...(phone ? { phone: '1' as const } : {}) } }).then(
      (r) => live && setGot({ messageId: lastId, suggestion: r.suggestion }),
      () => live && setGot({ messageId: lastId, suggestion: null }),
    )
    return () => { live = false }
  }, [chatId, lastId, phone])

  const closeCard = () => { setCard(null); setShared(null) }
  const cardDialog = card && (
    <Modal open onClose={closeCard} width={520} title={shared ? t('teamLink.stepTitle') : t('resultTip.teamSkill.act')}>
      {shared
        ? <InviteStep title={null} skillPath={shared.path} made onDone={closeCard} />
        : <SkillShareCard chatId={chatId} answerId={card} onShared={setShared} onLater={closeCard} />}
    </Modal>
  )
  const bar = cardDialog || (contribute && <ContributeSheet folder={contribute.folder} onClose={() => setContribute(null)} />) || null
  if (!lastId || got?.messageId !== lastId || !got.suggestion || done === lastId || got.suggestion.kind === 'deck-video') return bar
  const s = got.suggestion
  const act = () => {
    setDone(lastId)
    if (s.kind === 'team-skill') return setCard(lastId)
    if (s.kind === 'ppt') return onSend(t('resultTip.ppt.message'))
    if (s.kind === 'contribute') {
      // a phone: the team folder (Files uploads there); a computer: the skill folder pick, the folder link inside it
      if (phone) return s.folder ? navigate(`/files?path=${encodeURIComponent(s.folder)}`) : undefined
      return setContribute({ folder: s.folder })
    }
    // the request that made this answer, as the person sent it ("/ad-copy" and the form's lines)
    const request = messages.find((m) => m.id === last!.parentId)?.content.trim() || `/${s.skill.name}`
    onSend(t('resultTip.schedule.message', { ...weeklyAt(new Date(), locale), request }))
  }
  const close = () => {
    setDone(lastId)
    api.call(API.dismissSuggestion, { body: { key: s.key } }).catch(() => toast({ level: 'error', text: t('error.network') }))
  }
  // a phone without a team folder has nothing to offer here (an older server may still send the line)
  if (s.kind === 'contribute' && phone && !s.folder) return bar
  const Icon = s.kind === 'ppt' ? Presentation : s.kind === 'team-skill' ? Sparkles : s.kind === 'contribute' ? FolderUp : CalendarClock
  const words = s.kind === 'contribute' && phone ? CONTRIBUTE_PHONE : WORDS[s.kind]
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
