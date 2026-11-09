// One click under an answer of a room's Trina side chat (docs/DECISIONS.md "Trina side chat: send here"): the answer
// goes to where it belongs at once, no picker, search or note. An answer to a question about a room message: "스레드에
// 보내기" (that message's thread) with ▾ for "대화방에 보내기"; any other answer: "대화방에 보내기" (lib/sideChatSend.ts
// decides which). A quiet text button, as the side chat's "Share to room" was. Sent, it is one line for this page's
// session (store/sideChats.ts sends): "✓ 스레드에 보냈어요 · 보기" ("앞부분만" when the server cut it: there is no warning
// before sending any more), the focus on 보기, said in a status region. 보기 is the panel's (`onView`: the thread at the
// reply, or the room at the message). When the server asks first (linked files, material some members cannot see), only
// the confirm step of "대화방에 보내기" opens (chat/ShareToRoom.tsx ShareConfirm), with the target on top; 취소, ✕ and Esc
// close it and give the focus back here. A thread that is gone: one short line under the answer (SendHereNote) and the
// room offered instead; any other failure is that line too, never a toast.
// Double sends: a guard while one is on its way, and one clientMessageId per click, reused only for that click's confirm
// and for trying the same again after a failure that may have sent it (no answer, 5xx). Never across clicks: the server
// gives the first message back for a known id, a deleted one too.
import clsx from 'clsx'
import { Check, ChevronDown, MessageSquareShare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { uuidv7, type Room } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { errorText, isApiError } from '../../lib/api'
import type { SendTarget } from '../../lib/sideChatSend'
import { useRooms } from '../../store/rooms'
import { useSideChats, type SendHereState } from '../../store/sideChats'
import { RoomOptionLabel } from '../chat/RoomRefMenu'
import { ShareConfirm, useConfirmStep, type ConfirmAsk } from '../chat/ShareToRoom'
import { MenuButton } from './MenuButton'

export type SentHere = NonNullable<SendHereState['sent']>
type To = 'thread' | 'room'

const NONE: SendHereState = {}
const BTN = 'touch-hit flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink disabled:opacity-50'

/** the sent line's words */
export const sentKey = (s: Pick<SentHere, 'to' | 'cut'>): 'sideChat.sentThreadCut' | 'sideChat.sentThread' | 'sideChat.sentRoomCut' | 'sideChat.sentRoom' =>
  s.to === 'thread' ? (s.cut ? 'sideChat.sentThreadCut' : 'sideChat.sentThread') : (s.cut ? 'sideChat.sentRoomCut' : 'sideChat.sentRoom')

export function SendHere({ chatId, answerId, roomId, target, onView }: { chatId: string; answerId: string; roomId: string; target: SendTarget | null; onView: (sent: SentHere) => void }) {
  const t = useT()
  const locale = useLocale()
  const state = useSideChats((s) => s.sends[answerId]) ?? NONE
  const patch = (p: Partial<SendHereState>) => useSideChats.getState().patchSend(answerId, p)
  const room = useRooms((s) => s.rooms.find((r) => r.id === roomId) ?? null)
  // the thread, unless it turned out to be gone
  const thread = state.noThread ? null : target
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  /** this click's id (by where it goes): its confirm and a try again after a failure that may have sent it reuse it */
  const attempt = useRef<{ to: string; id: string } | null>(null)
  const confirm = useConfirmStep<ConfirmAsk & { to: To }>()
  const control = useRef<HTMLButtonElement>(null)
  const view = useRef<HTMLButtonElement>(null)
  /** sent from here just now: the focus goes to 보기 (not when a panel opens on an answer sent before) */
  const justSent = useRef(false)
  const [said, setSaid] = useState('')
  useEffect(() => {
    if (!state.sent || !justSent.current) return
    justSent.current = false
    view.current?.focus()
  }, [state.sent])

  const send = async (to: To, yes?: { confirmKey: string; attach: string[] }) => {
    if (sending.current) return
    const rootId = to === 'thread' ? thread?.rootId : undefined
    if (to === 'thread' && !rootId) return
    const key = rootId ? `thread:${rootId}` : 'room'
    if (attempt.current?.to !== key) attempt.current = { to: key, id: uuidv7() }
    sending.current = true
    setBusy(true)
    patch({ error: null })
    try {
      const r = await useRooms.getState().shareAnswer(chatId, answerId, { roomId, ...(rootId ? { threadRootId: rootId } : {}), ...(yes ?? {}), clientMessageId: attempt.current.id })
      if (r.status === 'confirm') return confirm.asked(r, !!yes, { to })
      attempt.current = null
      confirm.close()
      const sent: SentHere = { to, roomId, rootId: rootId ?? null, messageId: r.message.id, cut: r.cut }
      justSent.current = true
      setSaid(t(sentKey(sent)))
      patch({ sent })
    } catch (e) {
      // refused (4xx): nothing went, the next click is a new one; no answer or a server failure: it may have gone, so
      // trying the same again keeps the id (the server then gives the first message back)
      if (isApiError(e) && e.status < 500) attempt.current = null
      confirm.close()
      // the asked message's thread is gone (deleted, or no longer one I see): the room instead
      const gone = !!rootId && isApiError(e) && (e.body.params?.reason === 'thread_root' || !!e.body.fields?.['body.threadRootId'])
      patch(gone ? { noThread: true, error: t('sideChat.noThread') } : { error: errorText(e, locale, t('error.network')) })
      requestAnimationFrame(() => control.current?.focus())
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  const sent = state.sent
  return (
    <>
      {sent ? (
        <span className="flex min-w-0 items-center gap-1 px-1.5 text-xs text-muted" data-testid="send-here-sent" data-to={sent.to}>
          <Check size={13} strokeWidth={2.5} className="shrink-0 text-ok" aria-hidden />
          <span className="min-w-0">{t(sentKey(sent))}</span>
          <span aria-hidden>·</span>
          <button ref={view} type="button" onClick={() => onView(sent)} className="touch-hit shrink-0 rounded-sm font-medium text-ink underline-offset-2 hover:underline" data-testid="send-here-view">
            {t('sideChat.view')}
          </button>
        </span>
      ) : thread ? (
        // the thread, with the room one choice away (▾)
        <span className="flex items-center" data-testid="send-here">
          <button ref={control} type="button" disabled={busy} aria-busy={busy} onClick={() => void send('thread')} className={clsx(BTN, 'pr-1')} data-testid="send-here-thread">
            <MessageSquareShare size={13} aria-hidden />
            {t('sideChat.sendThread')}
          </button>
          <MenuButton
            label={t('sideChat.sendElsewhere')}
            icon={<ChevronDown size={13} aria-hidden />}
            muted
            buttonClassName="touch-hit"
            items={[{ label: t('sideChat.sendRoom'), icon: <MessageSquareShare size={14} aria-hidden />, onSelect: () => { control.current?.focus(); void send('room') }, testId: 'send-here-room-item' }]}
            testId="send-here-more"
          />
        </span>
      ) : (
        <button ref={control} type="button" disabled={busy} aria-busy={busy} onClick={() => void send('room')} className={BTN} data-testid="send-here-room">
          <MessageSquareShare size={13} aria-hidden />
          {t('sideChat.sendRoom')}
        </button>
      )}
      {/* always here, so what it says is read out when it changes */}
      <span role="status" className="sr-only" data-testid="send-here-status">{said}</span>
      {confirm.ask && (
        <ShareConfirm
          title={t(confirm.ask.to === 'thread' ? 'sideChat.sendThread' : 'sideChat.sendRoom')}
          target={<Target room={room} thread={confirm.ask.to === 'thread' ? thread : null} />}
          ask={confirm.ask}
          others={Math.max(0, (room?.memberCount ?? 1) - 1)}
          attach={confirm.attach}
          onAttach={confirm.setAttach}
          busy={busy}
          onSend={(yes) => void send(confirm.ask!.to, yes)}
          onCancel={() => {
            attempt.current = null
            confirm.close()
          }}
          returnTo={control.current}
        />
      )}
    </>
  )
}

/** The failure of the last click under this answer, one short line under it (null: none). */
export function SendHereNote({ answerId }: { answerId: string }) {
  const error = useSideChats((s) => s.sends[answerId]?.error)
  if (!error) return null
  return (
    <p role="alert" className="mt-1 text-xs leading-5 break-keep text-danger" data-testid="send-here-error">
      {error}
    </p>
  )
}

/** Where it goes, on top of the confirm step: the room, and for a thread the message asked about as the question quoted it. */
function Target({ room, thread }: { room: Room | null; thread: SendTarget | null }) {
  return (
    <div className="space-y-2">
      {room && (
        <div className="flex items-center gap-2.5">
          <RoomOptionLabel room={room} />
        </div>
      )}
      {thread && (
        <div className="border-l-2 border-line-strong pl-2.5 text-xs" data-testid="share-room-thread">
          {thread.head && <p className="font-medium text-ink">{thread.head}</p>}
          {thread.text && <p className="line-clamp-2 break-words whitespace-pre-wrap text-muted">{thread.text}</p>}
        </div>
      )}
    </div>
  )
}
