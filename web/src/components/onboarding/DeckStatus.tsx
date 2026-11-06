// The intro deck building behind the welcome steps (docs/DECISIONS.md "K — 내 스킬 가져오기"): the first result starts
// it and the steps move on at once (내 스킬 가져오기, 팀 파일 가져오기) while it builds on the server. One quiet status
// line on those steps ("회사 소개서 만드는 중", "회사 소개서가 다 됐어요 · 보기") opens the deck's chat with the deck
// beside it; when the person reaches the end of the steps before it is done, the next screen is its live progress
// (DeckWait), never an empty wait, and the finished deck opens by itself. What it reads: the deck chat's latest answer
// (GET /api/chats/:id/messages): streaming, done, or ended without a deck; and the step on screen in it.
import { Check, CircleAlert, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DECK_ARTIFACT_KEY, DECK_TOOL, type Message } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { useChats } from '../../store/chats'
import { Button } from '../ui'

/** How often the status reads the deck chat while it builds. */
export const DECK_POLL_MS = 4000

export type DeckRun =
  /** not read yet */
  | { state: 'unknown' }
  /** the answer is on its way; `step`: what it does now (a step label), when it says */
  | { state: 'building'; step: string | null }
  | { state: 'done' }
  /** the answer ended without a deck (an error, stopped) */
  | { state: 'failed' }

/** What the deck chat's latest answer says (pure: tested). No answer yet: building (the message was just sent). */
export function deckRunOf(messages: Pick<Message, 'role' | 'status' | 'steps'>[]): DeckRun {
  const answer = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!answer) return messages.some((m) => m.role === 'user') ? { state: 'building', step: null } : { state: 'unknown' }
  if (answer.status === 'streaming') {
    const running = [...answer.steps].reverse().find((s) => s.status === 'running')
    return { state: 'building', step: running?.label ?? null }
  }
  if (answer.status === 'done') return answer.steps.some((s) => s.tool === DECK_TOOL && s.status === 'error') && !answer.steps.some((s) => s.tool === DECK_TOOL && s.status === 'ok') ? { state: 'failed' } : { state: 'done' }
  return { state: 'failed' }
}

/** The deck chat's state, read now and every DECK_POLL_MS while it builds; `onFinish` once when it turns done or
 * failed while this is mounted. */
export function useDeckRun(chatId: string | null, onFinish?: (run: DeckRun) => void): DeckRun {
  const [run, setRun] = useState<DeckRun>({ state: 'unknown' })
  const finish = useRef(onFinish)
  finish.current = onFinish
  useEffect(() => {
    if (!chatId) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let last: DeckRun['state'] = 'unknown'
    const read = async () => {
      try {
        const page = await api.call(API.listMessages, { params: { id: chatId }, query: { limit: 4 } })
        if (!live) return
        const next = deckRunOf(page.items)
        setRun(next)
        if (last === 'building' && (next.state === 'done' || next.state === 'failed')) finish.current?.(next)
        last = next.state
        if (next.state === 'done' || next.state === 'failed') return
      } catch {
        // a failed read keeps what it showed; the next one tries again
      }
      if (live) timer = setTimeout(() => void read(), DECK_POLL_MS)
    }
    void read()
    return () => { live = false; clearTimeout(timer) }
  }, [chatId])
  return run
}

/** The deck's chat with the deck open beside it (Layout opens it once the chat is on screen). */
export function useOpenDeck() {
  const navigate = useNavigate()
  return (chatId: string) => {
    useChats.setState({ autoOpen: { chatId, key: DECK_ARTIFACT_KEY, at: Date.now() } })
    navigate(`/c/${chatId}`)
  }
}

const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink'

/** One quiet line above the step: building / done / failed, opening the deck's chat. */
export function DeckStatusLine({ run, chatId }: { run: DeckRun; chatId: string }) {
  const t = useT()
  const open = useOpenDeck()
  if (run.state === 'unknown') return null
  return (
    <p className="mt-4 flex min-w-0 items-center gap-2 text-label text-muted" aria-live="polite" data-testid="welcome-deck-status" data-state={run.state}>
      {run.state === 'building' ? <Loader2 size={14} className="shrink-0 animate-spin text-faint" aria-hidden />
        : run.state === 'done' ? <Check size={14} className="shrink-0 text-ok" aria-hidden />
        : <CircleAlert size={14} className="shrink-0 text-warn" aria-hidden />}
      <span className="min-w-0 truncate">
        {t(run.state === 'building' ? 'welcome.deck.building' : run.state === 'done' ? 'welcome.deck.ready' : 'welcome.deck.failed')}
        <span aria-hidden> · </span>
        <button type="button" className={quietLink} onClick={() => open(chatId)} data-testid="welcome-deck-open">
          {t('welcome.deck.open')}
        </button>
      </span>
    </p>
  )
}

/**
 * The end of the steps while the deck still builds: its live progress (what it does now), never an empty wait. When it
 * is done the deck's chat opens with the deck beside it ([팀에 공유] under the answer goes to the invite); when it ended
 * without one, one line says so and the invite is next. "먼저 팀원 초대하기" goes on without waiting.
 */
export function DeckWait({ run, chatId, onInvite }: { run: DeckRun; chatId: string; onInvite: () => void }) {
  const t = useT()
  const open = useOpenDeck()
  const failed = run.state === 'failed'
  return (
    <div className="space-y-5" data-testid="welcome-deck-wait" data-state={run.state}>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-ink">{t(failed ? 'welcome.deck.waitFailedTitle' : 'welcome.deck.waitTitle')}</h2>
        <p className="text-sm text-balance text-muted">{t(failed ? 'welcome.deck.waitFailedDesc' : 'welcome.deck.waitDesc')}</p>
      </div>
      {!failed && (
        <p className="flex min-w-0 items-center gap-2 text-sm text-ink" aria-live="polite" data-testid="welcome-deck-now">
          <Loader2 size={15} className="shrink-0 animate-spin text-accent-text" aria-hidden />
          <span className="min-w-0 truncate">{run.state === 'building' && run.step ? run.step : t('welcome.deck.building')}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={failed ? 'primary' : 'secondary'} className="max-sm:w-full" onClick={() => open(chatId)} data-testid="welcome-deck-chat">
          {t('welcome.deck.openChat')}
        </Button>
        <button type="button" className={`text-sm ${quietLink}`} onClick={onInvite} data-testid="welcome-deck-invite">
          {t(failed ? 'welcome.deck.inviteNow' : 'welcome.deck.inviteFirst')}
        </button>
      </div>
    </div>
  )
}
