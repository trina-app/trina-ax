// The room side chat (✦ Trina, docs/DECISIONS.md "Trina side chat"): a private AI chat of mine beside a room, opened from
// the room's header. Where a thread opens (a column beside the room on computers, the whole screen on phones), and one
// of the two at a time. It is an ordinary chat of mine (chats.side_room_id): the AI is told the room and reads it with
// its room tools as I see it (chat/room-tools.ts); nothing goes to the room until I press "Share to room" under an
// answer (the "send to a chat room" dialog, components/chat/ShareToRoom.tsx, with this room picked: the files and
// material some members cannot see are checked there). The newest side chat of the room opens again; "New chat"
// starts another one with the next question; 🕘 lists the room's side chats (newest first) and opens one. Cards the AI
// raises (a yes before a change, a question) show under its answer as in the full chat; while it waits for the answer
// to its question, what I type in the box answers it (lib/askAnswer.ts), as the full chat's box does.
// Which chat it shows, its draft and its quote are kept per room on this page (store/sideChats.ts): every panel of the
// room is the same chat. The column around it is components/rooms/RoomSideColumn.tsx: drawn here (`frame`), or by the
// room page around this (frame={false}).
import { ChevronLeft, ExternalLink, Eye, History, Loader2, Paperclip, SquarePen, X } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Chat, EngineId } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { composerAnswer, composerQuestion, picksOf } from '../../lib/askAnswer'
import { formatDate, formatDateTime } from '../../lib/format'
import { aiName } from '../../lib/tabs'
import { followsAfterScroll, jumpToBottom, stickToBottom } from '../../lib/stickToBottom'
import { useLocale, useT } from '../../i18n'
import { useChats } from '../../store/chats'
import { useMeStrict } from '../../store/session'
import { sideChatOf, useSideChats, type SideChatState } from '../../store/sideChats'
import { emptyThread, runningMessage, type ViewMessage } from '../../store/thread'
import { toast } from '../../store/ui'
import { AssistantMessage, UserMessage } from '../chat/Messages'
import { ImageGroup, ViewerMeta } from '../ImageViewer'
import { ErrorNote, IconButton } from '../ui'
import { AiFace } from './AiFace'
import { RoomSideColumn } from './RoomSideColumn'

/** the newest side chat of mine for this room (not deleted), or null: one asks the server, as the panel opens */
export async function newestSideChat(roomId: string): Promise<string | null> {
  const r = await api.call(API.listChats, { query: { sideRoomId: roomId, limit: 1 } })
  return r.items[0]?.id ?? null
}
/** the room's newest side chat with its messages read, asked once however many panels of the room open together */
const looking = new Map<string, Promise<string | null>>()
function findSideChat(roomId: string): Promise<string | null> {
  let p = looking.get(roomId)
  if (!p) {
    p = (async () => {
      const id = await newestSideChat(roomId)
      if (id) await useChats.getState().loadThread(id)
      return id
    })().finally(() => looking.delete(roomId))
    looking.set(roomId, p)
  }
  return p
}

/** A message of the room asked about ("Ask Trina about this" on it): quoted in front of the next question. `key`
 * changes with every ask, so asking about the same message again quotes it again. */
export interface SideSeed { key: string; author: string; at: string; text: string
  /** a file sent in this room ("Ask Trina about this file" in its preview): the AI reads it with room_file */
  file?: { id: string; name: string } }
/** the longest quote that goes with a question (the AI can read the whole room with room_read) */
export const SEED_QUOTE_MAX = 4000

/** The question as it is sent: the message quoted (who, when, its lines as a Markdown quote), then what I ask. */
export function withQuote(seed: SideSeed | null, question: string, time: (iso: string) => string): string {
  if (!seed) return question
  // a file: its name and id in this room (the AI opens it with room_file), not its text
  if (seed.file) return `> 📎 ${seed.file.name} (file_id ${seed.file.id} in this room)\n\n${question}`
  const text = seed.text.length > SEED_QUOTE_MAX ? `${seed.text.slice(0, SEED_QUOTE_MAX).trimEnd()}…` : seed.text
  const quote = [`${seed.author} · ${time(seed.at)}`, ...text.split('\n')].map((l) => `> ${l}`.trimEnd()).join('\n')
  return `${quote}\n\n${question}`
}

/** the questions an empty side chat offers (like Slackbot's): what I missed, what is for me, the latest discussion */
export const STARTERS = ['catchUp', 'forMe', 'summarize'] as const
/** the quick questions under a quoted message, and under a quoted file */
export const QUICK_MESSAGE = ['translate', 'summarize', 'explain'] as const
export const QUICK_FILE = ['fileSummarize', 'fileKeyPoints', 'fileCheck'] as const

/** how many of the room's side chats 🕘 lists */
export const SIDE_HISTORY_MAX = 30

/** `frame` false: the column around it is the caller's (RoomSideColumn). `autoFocus` false: the box does not take the
 * focus as the panel opens (a new `seed` still does: it was asked for). */
export function SideChatPanel({ roomId, roomTitle, onClose, seed = null, frame = true, autoFocus = true }: { roomId: string; roomTitle: string; onClose: () => void; seed?: SideSeed | null; frame?: boolean; autoFocus?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const navigate = useNavigate()
  // the room's side chat as every panel of it shows it: undefined chat: still looking for it; null: none yet (the first
  // question makes one)
  const { chatId, draft, quoted } = useSideChats((s) => sideChatOf(s, roomId))
  const patch = useCallback((p: Partial<SideChatState>) => useSideChats.getState().patch(roomId, p), [roomId])
  const setChatId = (id: string | null) => patch({ chatId: id })
  const setDraft = (f: string | ((d: string) => string)) => patch({ draft: typeof f === 'function' ? f(sideChatOf(useSideChats.getState(), roomId).draft) : f })
  const setQuoted = (f: SideSeed | null | ((q: SideSeed | null) => SideSeed | null)) => patch({ quoted: typeof f === 'function' ? f(sideChatOf(useSideChats.getState(), roomId).quoted) : f })
  const [loadError, setLoadError] = useState<unknown>(null)
  /** 🕘: the room's side chats, newest first (null: the list is not open) */
  const [history, setHistory] = useState<Chat[] | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  // the AI's open question in this chat: the box answers it
  const question = useChats((s) => (chatId ? composerQuestion(s.requests, chatId) : null))
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
      patch({ chatId: await findSideChat(roomId) })
    } catch (e) {
      setLoadError(e)
    }
  }, [roomId, patch])
  // the chat this page shows for the room already (another panel of it, or before this one was closed): read again;
  // gone meanwhile (deleted in the full chat), the room's newest; none known yet: the room's newest
  useEffect(() => {
    const known = sideChatOf(useSideChats.getState(), roomId).chatId
    if (known === undefined) return void load()
    if (known) void useChats.getState().loadThread(known).catch(() => { if (sideChatOf(useSideChats.getState(), roomId).chatId === known) void load() })
  }, [roomId, load])
  useEffect(() => { if (autoFocus) box.current?.focus() }, [])
  // a message asked about: quoted in front of the next question, until it is sent or taken off (once per ask: a panel
  // drawn again, or a second panel of the room, does not quote it again)
  useEffect(() => {
    if (!seed || sideChatOf(useSideChats.getState(), roomId).seedKey === seed.key) return
    patch({ quoted: seed, seedKey: seed.key })
    setHistory(null)
    box.current?.focus()
  }, [seed?.key])

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
  const send = async (asked?: string) => {
    const text = (asked ?? draft).trim()
    if (!text || chatId === undefined) return
    // the AI waits for the answer to its question: the text answers it (never a new message while its answer runs)
    if (question && chatId) {
      stick.current = true
      setDraft('')
      try {
        await useChats.getState().answer(question.request.requestId, { kind: 'ask_user', answer: composerAnswer(question.request, picksOf(question.request.requestId), text) })
      } catch (e) {
        setDraft((d) => d || text)
        fail(e)
      }
      return
    }
    if (busy) return
    stick.current = true
    const q = quoted
    if (asked === undefined) setDraft('')
    setQuoted(null)
    try {
      const content = withQuote(q, text, (iso) => formatDateTime(iso, locale))
      const r = await useChats.getState().send({ chatId, content, attachments: [], author: { id: me.user.id, name: me.user.name }, sideRoomId: roomId })
      if (r.chatId !== chatId) setChatId(r.chatId)
      await r.sent
    } catch (e) {
      if (asked === undefined) setDraft((d) => d || text)
      setQuoted((x) => x ?? q)
      fail(e)
    }
  }
  const newChat = () => {
    if (busy) return
    setHistory(null)
    setChatId(null)
    setDraft('')
    box.current?.focus()
  }
  const toggleHistory = async () => {
    if (history) return setHistory(null)
    setHistoryBusy(true)
    try {
      const r = await api.call(API.listChats, { query: { sideRoomId: roomId, limit: SIDE_HISTORY_MAX } })
      setHistory(r.items)
    } catch (e) {
      fail(e)
    } finally {
      setHistoryBusy(false)
    }
  }
  const openPast = async (id: string) => {
    setHistory(null)
    if (id === chatId) return
    stick.current = true
    try {
      await useChats.getState().loadThread(id)
      setChatId(id)
    } catch (e) {
      fail(e)
    }
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

  const body = (
    <>
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
        <IconButton tip label={t('sideChat.history')} onClick={() => void toggleHistory()} disabled={historyBusy} aria-expanded={!!history} className={clsx('touch-hit', history && 'bg-hover')} data-testid="side-chat-history">
          <History size={15} aria-hidden />
        </IconButton>
        <IconButton tip label={t('sideChat.new')} onClick={newChat} disabled={busy || !chatId} className="touch-hit" data-testid="side-chat-new">
          <SquarePen size={15} aria-hidden />
        </IconButton>
        <IconButton tip label={t('sideChat.close')} onClick={onClose} className="touch-hit max-md:hidden" data-testid="side-chat-close">
          <X size={16} aria-hidden />
        </IconButton>
      </div>
      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="side-chat-scroller">
        <div ref={content} className="space-y-5 px-4 pt-3 pb-4">
          {history && (
            <nav aria-label={t('sideChat.history')} className="-mx-2" data-testid="side-chat-history-list">
              <p className="px-2 pb-1 text-xs text-faint">{t('sideChat.historyTitle', { room: roomTitle })}</p>
              {!history.length && <p className="px-2 py-3 text-sm text-muted" data-testid="side-chat-history-empty">{t('sideChat.historyEmpty')}</p>}
              <ul>
                {history.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => void openPast(c.id)} aria-current={c.id === chatId ? 'true' : undefined}
                      className={clsx('flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-hover', c.id === chatId ? 'font-medium text-ink' : 'text-muted')} data-testid="side-chat-history-item">
                      <span className="min-w-0 flex-1 truncate">{c.title || t('chat.untitled')}</span>
                      <span className="shrink-0 text-xs text-faint">{formatDate(c.updatedAt, locale)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {!history && chatId === undefined && !loadError && <Loader2 size={16} className="mx-auto my-6 animate-spin text-faint" aria-label={t('common.loading')} />}
          {!history && !!loadError && <ErrorNote onRetry={() => void load()}>{errorText(loadError, locale, t('error.network'))}</ErrorNote>}
          {!history && chatId !== undefined && !messages.length && (
            <div className="flex flex-col items-center gap-3 py-10 text-center" data-testid="side-chat-empty">
              <AiFace size={40} />
              {/* what Trina reads here: this room, as I see it (Slackbot's "함께 확인하는 중") */}
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-muted" data-testid="side-chat-context">
                <Eye size={12} aria-hidden className="shrink-0" /><span className="truncate">{t('sideChat.context', { room: roomTitle })}</span>
              </span>
              <p className="max-w-[280px] text-sm text-muted">{t('sideChat.empty', { name })}</p>
              {!quoted && (
                <div className="flex flex-wrap justify-center gap-1.5" data-testid="side-chat-starters">
                  {STARTERS.map((k) => (
                    <button key={k} type="button" disabled={busy || chatId === undefined} onClick={() => void send(t(`sideChat.starter.${k}`))}
                      className="rounded-full border border-line px-3 py-1 text-xs text-ink hover:bg-hover disabled:opacity-40" data-testid={`side-chat-starter-${k}`}>
                      {t(`sideChat.starterLabel.${k}`)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* its pictures are one pane of the image viewer (← →), each with who sent it and when, like the AI chat's */}
          <ImageGroup>
            {!history && chatId && messages.map((m, i) =>
              m.role === 'user' ? (
                <ViewerMeta key={m.id} sender={{ kind: 'user', user: m.author ?? me.user }} at={m.createdAt}>
                  <UserMessage m={m} chatId={chatId} busy={busy} onEdit={onEdit} onSelectBranch={onSelectBranch} />
                </ViewerMeta>
              ) : (
                <ViewerMeta key={m.id} sender={{ kind: 'ai' }} at={m.createdAt}>
                  <AssistantMessage m={m} chatId={chatId} isLast={i === messages.length - 1} busy={busy} switchedFrom={null as EngineId | null} onRegenerate={onRegenerate} onSelectBranch={onSelectBranch} onAskOwnFolder={() => {}} shareable={shareable} shareRoomId={roomId} canSuggest={false} />
                </ViewerMeta>
              ),
            )}
          </ImageGroup>
        </div>
      </div>
      <div className="shrink-0 px-4 pb-[max(0.75rem,var(--safe-bottom))]">
        {quoted && (
          <div className="mb-2 rounded-lg border border-line bg-canvas p-2" data-testid="side-chat-quote">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 border-l-2 border-line-strong pl-2 text-xs">
                {!quoted.file && <p className="font-medium text-ink">{quoted.author} <span className="font-normal text-faint">{formatDateTime(quoted.at, locale)}</span></p>}
                {quoted.file ? (
                  <p className="flex min-w-0 items-center gap-1 text-muted" data-testid="side-chat-quote-file"><Paperclip size={12} aria-hidden className="shrink-0" /><span className="truncate">{quoted.file.name}</span></p>
                ) : (
                  <p className="line-clamp-3 break-words whitespace-pre-wrap text-muted">{quoted.text}</p>
                )}
              </div>
              <IconButton label={t('sideChat.quoteRemove')} onClick={() => setQuoted(null)} className="touch-hit -mt-0.5 shrink-0" data-testid="side-chat-quote-remove">
                <X size={13} aria-hidden />
              </IconButton>
            </div>
            {!question && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(quoted.file ? QUICK_FILE : QUICK_MESSAGE).map((k) => (
                  <button key={k} type="button" disabled={busy || chatId === undefined} onClick={() => void send(t(`sideChat.ask.${k}`))}
                    className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink disabled:opacity-40" data-testid={`side-chat-quick-${k}`}>
                    {t(`sideChat.quick.${k}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
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
            placeholder={question ? t('sideChat.answerPlaceholder', { name }) : quoted ? t('sideChat.placeholderQuoted', { name }) : t('sideChat.placeholder', { name })}
            aria-label={question ? t('sideChat.answerPlaceholder', { name }) : quoted ? t('sideChat.placeholderQuoted', { name }) : t('sideChat.placeholder', { name })}
            className="block max-h-40 w-full resize-none bg-transparent px-3 pt-2.5 text-sm text-ink outline-none placeholder:text-faint"
            data-testid="side-chat-input"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <span className="text-xs text-faint" data-testid="side-chat-private">{t('sideChat.private')}</span>
            <button type="button" onClick={() => void send()} disabled={!draft.trim() || (busy && !question) || chatId === undefined} className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent disabled:opacity-40" data-testid="side-chat-send">
              {question ? t('sideChat.answer') : t('sideChat.send')}
            </button>
          </div>
        </div>
        <p className="pt-1.5 text-center text-[11px] text-faint" data-testid="side-chat-disclaimer">{t('sideChat.disclaimer', { name })}</p>
      </div>
    </>
  )
  if (!frame) return body
  return (
    <RoomSideColumn label={t('sideChat.title', { name })} testId="room-side-chat" divider="side-chat">
      {body}
    </RoomSideColumn>
  )
}
