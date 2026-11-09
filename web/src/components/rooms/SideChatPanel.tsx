// The room side chat (✦ Trina, docs/DECISIONS.md "트리나 사이드 채팅"): a private AI chat of mine beside a room, opened from
// the room's header. Where a thread opens (a column beside the room on computers, the whole screen on phones), and one
// of the two at a time. It is an ordinary chat of mine (chats.side_room_id): the AI is told the room and reads it with
// its room tools as I see it (chat/room-tools.ts); nothing goes to the room until I press "Share to room" under an
// answer (the "send to a chat room" dialog, components/chat/ShareToRoom.tsx, with this room picked: the files and
// material some members cannot see are checked there). The newest side chat of the room opens again; "New chat"
// starts another one with the next question. Cards the AI raises (a yes before a change, a question) are answered in
// the full chat: "Open as a full chat" goes there.
import { ChevronLeft, ExternalLink, Loader2, SquarePen, X } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { EngineId } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { aiName } from '../../lib/tabs'
import { followsAfterScroll, jumpToBottom, stickToBottom } from '../../lib/stickToBottom'
import { THREAD_PANEL } from '../../lib/panelWidth'
import { useLocale, useT } from '../../i18n'
import { useChats } from '../../store/chats'
import { useMeStrict } from '../../store/session'
import { emptyThread, runningMessage, type ViewMessage } from '../../store/thread'
import { toast } from '../../store/ui'
import { AssistantMessage, UserMessage } from '../chat/Messages'
import { PanelDivider } from '../PanelDivider'
import { ErrorNote, IconButton } from '../ui'
import { AiFace } from './AiFace'

/** the newest side chat of mine for this room (not deleted), or null: one asks the server, as the panel opens */
export async function newestSideChat(roomId: string): Promise<string | null> {
  const r = await api.call(API.listChats, { query: { sideRoomId: roomId, limit: 1 } })
  return r.items[0]?.id ?? null
}

export function SideChatPanel({ roomId, roomTitle, onClose }: { roomId: string; roomTitle: string; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const navigate = useNavigate()
  /** undefined: still looking for the room's side chat; null: none yet (the first question makes one) */
  const [chatId, setChatId] = useState<string | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [draft, setDraft] = useState('')
  const thread = useChats((s) => (chatId ? s.threads[chatId] : undefined)) ?? emptyThread()
  const chat = useChats((s) => (chatId ? s.chats.find((c) => c.id === chatId) : undefined))
  const messages = thread.messages
  const running = runningMessage(messages)
  const busy = !!running || messages.some((m) => m.local?.state === 'sending')
  const shareable = !chat?.confidential && !me.server.allChatsConfidential
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  const lastTop = useRef(0)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const id = await newestSideChat(roomId)
      if (id) await useChats.getState().loadThread(id)
      setChatId(id)
    } catch (e) {
      setLoadError(e)
    }
  }, [roomId])
  useEffect(() => { void load() }, [load])
  useEffect(() => { box.current?.focus() }, [])

  const last = messages.at(-1)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) jumpToBottom(el, lastTop)
  }, [last?.id, last?.content.length, messages.length])
  useEffect(() => {
    const s = scroller.current, c = content.current
    if (!s || !c) return
    return stickToBottom(s, c, () => stick.current, undefined, () => { lastTop.current = s.scrollTop })
  }, [])
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    stick.current = followsAfterScroll(el, stick.current, lastTop.current)
    lastTop.current = el.scrollTop
  }

  const fail = (e: unknown) => toast({ level: 'warn', text: errorText(e, locale, t('error.network')) })
  const send = async () => {
    const text = draft.trim()
    if (!text || busy || chatId === undefined) return
    stick.current = true
    setDraft('')
    try {
      const r = await useChats.getState().send({ chatId, content: text, attachments: [], author: { id: me.user.id, name: me.user.name }, sideRoomId: roomId })
      if (r.chatId !== chatId) setChatId(r.chatId)
      await r.sent
    } catch (e) {
      setDraft((d) => d || text)
      fail(e)
    }
  }
  const newChat = () => {
    if (busy) return
    setChatId(null)
    setDraft('')
    box.current?.focus()
  }
  const onRegenerate = (m: ViewMessage) => {
    if (!chatId) return
    stick.current = true
    void useChats.getState().regenerate(chatId, m.id).catch(fail)
  }
  const onEdit = (m: ViewMessage, text: string) => {
    if (!chatId) return
    stick.current = true
    void useChats.getState().edit(chatId, m.id, text, m.attachments).catch(fail)
  }
  const onSelectBranch = (id: string) => { if (chatId) void useChats.getState().selectBranch(chatId, id).catch(fail) }
  const name = aiName(t)

  return (
    <section
      className={clsx(
        'flex min-h-0 min-w-0 flex-1 flex-col bg-surface md:relative md:flex-none md:border-l md:border-line',
        'md:w-[var(--panel-w,clamp(320px,calc(100%-420px),400px))] md:min-w-[320px] xl:w-[var(--panel-w,clamp(320px,calc(100%-420px),440px))]',
      )}
      aria-label={t('sideChat.title', { name })}
      data-testid="room-side-chat"
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2 max-md:pl-0.5 md:px-4">
        <IconButton tip label={t('sideChat.close')} onClick={onClose} className="touch-hit p-3 md:hidden" data-testid="side-chat-back">
          <ChevronLeft size={20} aria-hidden />
        </IconButton>
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-base font-medium text-ink">{t('sideChat.title', { name })}</span>
          <span className="truncate text-xs text-faint" data-testid="side-chat-room">{roomTitle}</span>
        </h2>
        {chatId && (
          <IconButton tip label={t('sideChat.openFull')} onClick={() => navigate(`/c/${chatId}`)} className="touch-hit" data-testid="side-chat-open-full">
            <ExternalLink size={15} aria-hidden />
          </IconButton>
        )}
        <IconButton tip label={t('sideChat.new')} onClick={newChat} disabled={busy || !chatId} className="touch-hit" data-testid="side-chat-new">
          <SquarePen size={15} aria-hidden />
        </IconButton>
        <IconButton tip label={t('sideChat.close')} onClick={onClose} className="touch-hit max-md:hidden" data-testid="side-chat-close">
          <X size={16} aria-hidden />
        </IconButton>
      </div>
      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="side-chat-scroller">
        <div ref={content} className="space-y-5 px-4 pt-3 pb-4">
          {chatId === undefined && !loadError && <Loader2 size={16} className="mx-auto my-6 animate-spin text-faint" aria-label={t('common.loading')} />}
          {!!loadError && <ErrorNote onRetry={() => void load()}>{errorText(loadError, locale, t('error.network'))}</ErrorNote>}
          {chatId !== undefined && !messages.length && (
            <div className="flex flex-col items-center gap-3 py-10 text-center" data-testid="side-chat-empty">
              <AiFace size={40} />
              <p className="max-w-[280px] text-sm text-muted">{t('sideChat.empty', { name })}</p>
            </div>
          )}
          {chatId && messages.map((m, i) =>
            m.role === 'user' ? (
              <UserMessage key={m.id} m={m} chatId={chatId} busy={busy} onEdit={onEdit} onSelectBranch={onSelectBranch} />
            ) : (
              <AssistantMessage key={m.id} m={m} chatId={chatId} isLast={i === messages.length - 1} busy={busy} switchedFrom={null as EngineId | null} onRegenerate={onRegenerate} onSelectBranch={onSelectBranch} onAskOwnFolder={() => {}} shareable={shareable} shareRoomId={roomId} canSuggest={false} />
            ),
          )}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-[max(0.75rem,var(--safe-bottom))]">
        <div className="rounded-xl border border-line bg-canvas focus-within:border-line-strong">
          <textarea
            ref={box}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            rows={2}
            maxLength={20_000}
            placeholder={t('sideChat.placeholder', { name })}
            aria-label={t('sideChat.placeholder', { name })}
            className="block max-h-40 w-full resize-none bg-transparent px-3 pt-2.5 text-sm text-ink outline-none placeholder:text-faint"
            data-testid="side-chat-input"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <span className="text-xs text-faint" data-testid="side-chat-private">{t('sideChat.private')}</span>
            <button type="button" onClick={() => void send()} disabled={!draft.trim() || busy || chatId === undefined} className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent disabled:opacity-40" data-testid="side-chat-send">
              {t('sideChat.send')}
            </button>
          </div>
        </div>
      </div>
      <PanelDivider sizing={THREAD_PANEL} label={t('rooms.threadResize')} testId="side-chat-divider" overlayTestId="side-chat-drag-overlay" />
    </section>
  )
}
