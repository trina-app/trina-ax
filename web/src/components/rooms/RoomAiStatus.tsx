// The AI at work in a room (docs/DECISIONS.md "대화방의 트리나"), under the messages. My own question: the AI's name,
// "답하는 중" (or its place in the queue), what it does now in plain words ("파일 찾는 중", "'예산' 문서 읽는 중": no
// search patterns or paths), a card it asks me (ask_user, a confirmation) and Stop; when it stopped or failed, one line
// I can close under that question (EndedRun, in RoomMessages). Anyone else's question: only "트리나가 답하는 중",
// nobody named and no steps (step labels name files and searches). A finished answer is a message of the room (or my
// private preview); one that stayed private to someone else ends as "○○ 님에게만 답했어요" under their question
// (RoomMessages, PrivateAnswered).
import { Lock, Sparkles, Square, X } from 'lucide-react'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { RoomAiRun } from '@mycel/shared/api'
import { errorText } from '../../lib/api'
import { roomStepWords, runActive } from '../../lib/rooms'
import { useLocale, useT } from '../../i18n'
import { useChats } from '../../store/chats'
import { useRooms, type RoomAi } from '../../store/rooms'
import { toast } from '../../store/ui'
import AskCard from '../chat/AskCard'
import { Button, IconButton } from '../ui'

const NONE: RoomAi = { answering: 0, runs: [] }

/** `threadRootId`: under a thread's replies, my questions asked there (the room-wide "answering" line for the others'
 * questions stays under the timeline: nobody is told where they asked). */
export function RoomAiStatus({ roomId, threadRootId = null }: { roomId: string; threadRootId?: string | null }) {
  const t = useT()
  const ai = useRooms((s) => s.ai[roomId]) ?? NONE
  const working = ai.runs.filter(runActive)
  const here = working.filter((r) => (r.threadRootId ?? null) === threadRootId)
  const others = threadRootId ? 0 : Math.max(0, ai.answering - working.length)
  if (!here.length && !others) return null
  return (
    <div data-testid="room-ai-status">
      {here.map((r) => (
        <MyRun key={r.turnId} roomId={roomId} run={r} />
      ))}
      {others > 0 && (
        <div className="flex items-center gap-3 pt-3" role="status" data-testid="room-ai-answering">
          <AiMark />
          <span className="text-sm text-muted">{t('rooms.aiAnswering')}</span>
          <Dots />
        </div>
      )}
    </div>
  )
}

/** My question whose answer stopped or failed: one line I can close, under that question (RoomMessages), not at the
 * end of the room where it would read as the answer to whatever came last. */
export function EndedRun({ roomId, run }: { roomId: string; run: RoomAiRun }) {
  const t = useT()
  const failed = run.state === 'error'
  return (
    <div className="flex items-start gap-2 text-sm" role={failed ? 'alert' : 'status'} data-testid="room-ai-ended" data-state={run.state}>
      <span className={failed ? 'min-w-0 flex-1 py-1 text-danger' : 'min-w-0 flex-1 py-1 text-muted'}>
        {failed ? `${t('rooms.aiFailed')}${run.error?.message ? ` ${run.error.message}` : ''}` : t('rooms.aiStopped')}
      </span>
      <IconButton tip label={t('rooms.aiDismiss')} onClick={() => useRooms.getState().dismissAi(roomId, run.turnId)} className="p-1">
        <X size={14} />
      </IconButton>
    </div>
  )
}

/** Someone else's question that the AI answered to them only (a private preview): one quiet line under the question,
 * in place of "트리나가 답하는 중". Nothing of the answer or why. */
export function PrivateAnswered({ name }: { name: string }) {
  const t = useT()
  return (
    <p className="flex items-center gap-1 py-0.5 text-xs text-faint" role="status" data-testid="room-ai-private-for">
      <Lock size={12} className="shrink-0" aria-hidden />
      {t('rooms.aiAnsweredTo', { name })}
    </p>
  )
}

function AiMark() {
  return (
    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
      <Sparkles size={15} />
    </span>
  )
}

function Dots() {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      <span className="dot h-1.5 w-1.5 rounded-full bg-faint" />
      <span className="dot h-1.5 w-1.5 rounded-full bg-faint" />
      <span className="dot h-1.5 w-1.5 rounded-full bg-faint" />
    </span>
  )
}

function MyRun({ roomId, run }: { roomId: string; run: RoomAiRun }) {
  const t = useT()
  const locale = useLocale()
  const [stopping, setStopping] = useState(false)
  // a card the AI raised while answering me (a question, a confirmation): answered here like in the AI chat
  const requests = useChats(useShallow((s) => Object.values(s.requests).filter((r) => r.turnId === run.turnId)))
  // what it does now, in plain words: no search patterns or paths (a file by its name only)
  const last = run.steps.at(-1)
  const words = last ? roomStepWords(last) : null
  const now = !words ? '' : words.kind === 'read' ? t('rooms.aiStepRead', { name: words.name }) : words.kind === 'find' ? t('rooms.aiStepFind') : words.kind === 'web' ? t('rooms.aiStepWeb') : t('rooms.aiStepWork')
  const stop = async () => {
    setStopping(true)
    try {
      await useRooms.getState().stopAi(roomId, run.turnId)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setStopping(false)
    }
  }
  return (
    <div className="flex gap-3 pt-3" data-testid="room-ai-run" data-state={run.state} aria-busy>
      <AiMark />
      <div className="min-w-0 flex-1">
        <p className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
          {/* "트리나가 답하는 중" names the AI already; waiting in the queue says whose turn it is */}
          <span className="text-sm font-medium text-ink" role="status">
            {run.state === 'queued' && run.position > 0 ? `${t('rooms.aiName')} · ${t('rooms.aiQueued', { n: run.position })}` : t('rooms.aiAnswering')}
          </span>
          {!requests.length && <Dots />}
          <Button size="sm" variant="secondary" className="ml-auto" busy={stopping} onClick={() => void stop()} data-testid="room-ai-stop">
            <Square size={11} className="fill-current" aria-hidden /> {t('rooms.aiStop')}
          </Button>
        </p>
        {now && (
          <p className="truncate text-label text-muted" data-testid="room-ai-step">
            {now}
          </p>
        )}
        {requests.map((r) => (r.request.kind === 'connect_service' ? null : <AskCard key={r.request.requestId} req={r} />))}
      </div>
    </div>
  )
}
