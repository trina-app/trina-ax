// The room side chat (✦ Trina, docs/DECISIONS.md "Trina side chat"): a private AI chat of mine beside a room, opened from
// the room's header. Where a thread opens (a column beside the room on computers, the whole screen on phones), and one
// of the two at a time. It is an ordinary chat of mine (chats.side_room_id): the AI is told the room and reads it with
// its room tools as I see it (chat/room-tools.ts); nothing goes to the room until I press the one button under an
// answer (components/rooms/SendHere.tsx): "스레드에 보내기" for an answer about a message of the room (that message's
// thread, named in the question's quote: lib/sideChatSend.ts; ▾ for the room), else "대화방에 보내기". It goes at once;
// the server's checks of files and material some members cannot see ask first with the confirm step of
// components/chat/ShareToRoom.tsx. Sent, its 보기 opens the thread at the reply (in this column; ✦ brings this chat back)
// or the room at the message (a phone: this panel closes). The newest side chat of the room opens again; "New chat"
// starts another one with the next question; 🕘 lists the room's side chats (newest first) and opens one. Cards the AI
// raises (a yes before a change, a question) show under its answer as in the full chat; while it waits for the answer
// to its question, what I type in the box answers it (lib/askAnswer.ts), as the full chat's box does.
// Files and pictures go with a question as in the full chat's box, with its own parts (components/chat/ComposerFiles.tsx):
// 📎, pasted into the box, or dropped anywhere on the panel; each is uploaded into this side chat at once (my own
// attachments folder, as in any chat of mine; a side chat not made yet is made by the first file) and shows above the
// box, a picture as its 64 px square, with ✕. At most 20 per message, the same messages when one fails. They go with what
// is typed in the box (a starter or quick question goes alone, and an answer to the AI's question is its text alone);
// "Share to room" sends the answer, never these. No team-folder files here (the full chat has them).
// Which chat it shows, its draft, its quote and its files are kept per room on this page (store/sideChats.ts; the files in
// the composer's stash, `side:<room id>`): every panel of the room is the same chat. The files were uploaded into the chat
// shown, so another chat (New chat, 🕘) drops them. The column around it is components/rooms/RoomSideColumn.tsx: drawn
// here (`frame`), or by the room page around this (frame={false}). `closeX`: the ✕ at every width, never the phone's ‹
// (the file viewer's sheet on a phone, which closes back to the file).
import { ArrowUp, ChevronLeft, ExternalLink, Eye, History, Loader2, Paperclip, SquarePen, X } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SIDE_CHAT_QUICK, SIDE_QUICK_FILE, SIDE_QUICK_MESSAGE, threadRefToken, type Chat, type EngineId } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { composerAnswer, composerQuestion, picksOf } from '../../lib/askAnswer'
import { formatDate, formatDateTime } from '../../lib/format'
import { closeImageViewer } from '../../lib/imageViewer'
import { quotes, sendTargets } from '../../lib/sideChatSend'
import { aiName } from '../../lib/tabs'
import { followsAfterScroll, jumpToBottom, stickToBottom } from '../../lib/stickToBottom'
import { useLocale, useT } from '../../i18n'
import { useChats } from '../../store/chats'
import { useRooms } from '../../store/rooms'
import { useMeStrict } from '../../store/session'
import { sideChatOnScreen } from '../../store/sessionMarkers'
import { SEED_KEYS_MAX, sideChatOf, useSideChats, type SideChatState } from '../../store/sideChats'
import { emptyThread, runningMessage, type ViewMessage } from '../../store/thread'
import { toast } from '../../store/ui'
import { ComposerFileList, useComposerFiles, useFileDrop } from '../chat/ComposerFiles'
import { AssistantMessage, UserMessage } from '../chat/Messages'
import { ImageGroup, ViewerMeta } from '../ImageViewer'
import { Tooltip } from '../Tooltip'
import { ErrorNote, IconButton } from '../ui'
import { AiFace } from './AiFace'
import { RoomSideColumn } from './RoomSideColumn'
import type { SentHere } from './SendHere'

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

/** the side chat being made for the room's first question or file, per room */
const making = new Map<string, Promise<string>>()
/** the chat each room's box files were uploaded into (they go with a question there only) */
const filesOf = new Map<string, string>()
/** The side chat a question or a file goes into: the one the panel shows; while it is still looked for, the room's
 * newest; none, a new side chat of the room, made once however many files and questions come at once (one path for both,
 * so a file and the first question never make two), which the panel shows from then on. */
function chatToWrite(roomId: string): Promise<string> {
  const shown = sideChatOf(useSideChats.getState(), roomId).chatId
  if (shown) return Promise.resolve(shown)
  let p = making.get(roomId)
  if (!p) {
    p = (async () => {
      const current = () => sideChatOf(useSideChats.getState(), roomId).chatId
      let id = shown === undefined ? await findSideChat(roomId) : null
      if (!current() && !id) {
        const c = await api.call(API.createChat, { body: { projectId: null, sideRoomId: roomId } })
        useChats.getState().upsertChat(c)
        id = c.id
      }
      if (!current()) useSideChats.getState().patch(roomId, { chatId: id })
      // the chat the panel shows by now (another one picked from 🕘 meanwhile: that one)
      return current() || id!
    })().finally(() => making.delete(roomId))
    making.set(roomId, p)
  }
  return p
}

/** A message of the room asked about ("Ask Trina about this" on it): quoted in front of the next question. `key`
 * changes with every ask, so asking about the same message again quotes it again. */
export interface SideSeed { key: string; author: string; at: string; text: string
  /** a file sent in this room ("Ask Trina about this file" in its preview): the AI reads it with room_file */
  file?: { id: string; name: string }
  /** the thread an answer about the message goes to with one click (lib/sideChatAsk.ts messageSeed): its first message */
  thread?: string }
/** the longest quote that goes with a question (the AI can read the whole room with room_read) */
export const SEED_QUOTE_MAX = 4000

/** The question as it is sent: the message quoted (who, when, its lines as a Markdown quote), then what I ask. The
 * header line ends with the message's thread when it can have one (shared rooms.ts threadRefToken: the app hides it, the
 * answers below send there with one click, lib/sideChatSend.ts). */
export function withQuote(seed: SideSeed | null, question: string, time: (iso: string) => string): string {
  if (!seed) return question
  // a file: its name and id in this room (the AI opens it with room_file), not its text
  if (seed.file) return `> 📎 ${seed.file.name} (file_id ${seed.file.id} in this room)\n\n${question}`
  const text = seed.text.length > SEED_QUOTE_MAX ? `${seed.text.slice(0, SEED_QUOTE_MAX).trimEnd()}…` : seed.text
  const head = `> ${seed.author} · ${time(seed.at)}`.trimEnd() + (seed.thread ? threadRefToken(seed.thread) : '')
  const quote = [head, ...text.split('\n').map((l) => `> ${l}`.trimEnd())].join('\n')
  return `${quote}\n\n${question}`
}

/** the questions an empty side chat offers (like Slackbot's): what I missed, what is for me, the latest discussion */
export const STARTERS = ['catchUp', 'forMe', 'summarize'] as const
/** the quick questions under a quoted message, and under a quoted file (팀 폴더에 저장: the AI saves it with
 * save_room_file, whose card says where and who will see it); their words and questions are shared (rooms.ts
 * SIDE_CHAT_QUICK): the server names a new side chat "<word>: <the quote's first words>" from them */
export const QUICK_MESSAGE = SIDE_QUICK_MESSAGE
export const QUICK_FILE = SIDE_QUICK_FILE

/** how many of the room's side chats 🕘 lists */
export const SIDE_HISTORY_MAX = 30
/** at most this many older pages are read to find where an answer goes (its question further up than the page read) */
export const OLDER_PAGES_MAX = 10

/** `frame` false: the column around it is the caller's (RoomSideColumn). `autoFocus` false: the box does not take the
 * focus as the panel opens (a new `seed` still does: it was asked for). `closeX`: ✕ instead of a phone's ‹. */
export function SideChatPanel({ roomId, roomTitle, onClose, seed = null, frame = true, autoFocus = true, closeX = false }: { roomId: string; roomTitle: string; onClose: () => void; seed?: SideSeed | null; frame?: boolean; autoFocus?: boolean; closeX?: boolean }) {
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
  // session markers: the chat this panel shows is on screen in this window, as a full chat is (store/sessionMarkers.ts
  // marks its answer seen: no "New answer" dot in Trina history, no notification); not while the 🕘 list covers it
  const listOpen = !!history
  useEffect(() => {
    if (chatId && !listOpen) return sideChatOnScreen(chatId)
  }, [chatId, listOpen])
  // the AI's open question in this chat: the box answers it
  const question = useChats((s) => (chatId ? composerQuestion(s.requests, chatId) : null))
  const thread = useChats((s) => (chatId ? s.threads[chatId] : undefined)) ?? emptyThread()
  const chat = useChats((s) => (chatId ? s.chats.find((c) => c.id === chatId) : undefined))
  const messages = thread.messages
  const running = runningMessage(messages)
  const busy = !!running || messages.some((m) => m.local?.state === 'sending')
  const shareable = !chat?.confidential && !me.server.allChatsConfidential
  // where each answer goes with one click: the thread its question (or the one it follows up) asked about, or the room
  const targets = useMemo(() => sendTargets(messages), [messages])
  // an answer above the first question that quotes something depends on older messages than the page read (a long chat
  // after a reload): those pages too, so it goes where it did before
  const firstQuote = messages.findIndex((m) => m.role === 'user' && quotes(m.content))
  const needOlder = !!chatId && !!thread.nextCursor && messages.slice(0, firstQuote < 0 ? undefined : firstQuote).some((m) => m.role === 'assistant')
  const olderRead = useRef<{ chatId: string | null | undefined; pages: number }>({ chatId, pages: 0 })
  useEffect(() => {
    if (olderRead.current.chatId !== chatId) olderRead.current = { chatId, pages: 0 }
    if (!needOlder || !chatId || olderRead.current.pages >= OLDER_PAGES_MAX) return
    olderRead.current.pages++
    void useChats.getState().loadOlder(chatId).catch(() => {})
  }, [needOlder, chatId, thread.nextCursor])
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  const lastTop = useRef(0)
  // the box's files (the full chat box's own parts), kept per room like the draft, in every panel of the room
  const [fileError, setFileError] = useState<string | null>(null)
  const files = useComposerFiles({
    userId: me.user.id,
    draftId: `side:${roomId}`,
    ensureChat: async () => {
      const id = await chatToWrite(roomId)
      filesOf.set(roomId, id)
      return id
    },
    onError: setFileError,
    reload: false,
  })
  const { drag, dropProps } = useFileDrop((all) => void files.addFiles(all))
  const picker = useRef<HTMLInputElement>(null)
  // they were uploaded into one chat: once another shows (New chat, 🕘, the chat deleted meanwhile, the room left and
  // joined again), they go, in every panel of the room
  const clearFiles = useRef(files.clear)
  clearFiles.current = files.clear
  useEffect(() => {
    const owner = filesOf.get(roomId)
    if (!owner || chatId === undefined || chatId === owner) return
    filesOf.delete(roomId)
    clearFiles.current()
    setFileError(null)
  }, [roomId, chatId])

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
    const taken = sideChatOf(useSideChats.getState(), roomId).seedKeys
    if (!seed || taken.includes(seed.key)) return
    patch({ quoted: seed, seedKeys: [...taken, seed.key].slice(-SEED_KEYS_MAX) })
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
  // what the box sends: its text and its files (all uploaded); an answer to the AI's question is the text alone
  const canSend = chatId !== undefined && (question ? !!draft.trim() : !busy && !files.uploading && (!!draft.trim() || files.ready.length > 0))
  const sendLabel = question ? t('sideChat.answer') : t('sideChat.send')
  const send = async (asked?: string) => {
    const text = (asked ?? draft).trim()
    // the box's files go with what is typed in it; a starter or quick question goes alone (and leaves them, as it leaves
    // the text)
    const atts = asked === undefined && !question ? files.attachments() : []
    if ((!text && !atts.length) || chatId === undefined) return
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
    if (busy || (asked === undefined && files.uploading)) return
    stick.current = true
    const q = quoted
    if (asked === undefined) setDraft('')
    setQuoted(null)
    try {
      const content = withQuote(q, text, (iso) => formatDateTime(iso, locale))
      // the room's first question makes its side chat the way a first file does (one path: never two chats)
      const into = chatId ?? (await chatToWrite(roomId))
      const r = await useChats.getState().send({ chatId: into, content, attachments: atts, author: { id: me.user.id, name: me.user.name }, sideRoomId: roomId })
      if (r.chatId !== chatId) setChatId(r.chatId)
      // the files are in the message now (a send that fails keeps them there, with "send again")
      if (atts.length) {
        files.clearSent()
        setFileError(null)
      }
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
  // 보기 under a sent answer: the thread at the reply (it takes this column, or the whole screen on a phone; ✦ brings this
  // chat back), or the room at the message (a phone: this panel closes so the room shows). From the file viewer's column
  // the viewer closes first.
  const view = (s: SentHere) => closeImageViewer(true, () => {
    if (s.to === 'thread' && s.rootId) return navigate(`/rooms/${s.roomId}/t/${s.rootId}?m=${s.messageId}`, { state: { fromRoom: true } })
    if (!window.matchMedia?.('(min-width: 48rem)').matches) useRooms.getState().setSide(s.roomId, null)
    navigate(`/rooms/${s.roomId}?m=${s.messageId}`, { replace: window.location.pathname === `/rooms/${s.roomId}` })
  })
  const name = aiName(t)
  // what the box asks: the answer to the AI's question, or about the file or message quoted, or about the room
  const boxLabel = question ? t('sideChat.answerPlaceholder', { name }) : quoted?.file ? t('sideChat.placeholderQuotedFile', { name }) : quoted ? t('sideChat.placeholderQuoted', { name }) : t('sideChat.placeholder', { name })

  const body = (
    // files dropped anywhere on the panel go with the next question (the box shows the drop)
    <div
      className="flex min-h-0 flex-1 flex-col"
      {...dropProps}
      // moving between the panel's own parts is not leaving it (the box's drop ring would flicker)
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) dropProps.onDragLeave() }}
      data-testid="side-chat-panel"
    >
      <div className={clsx('flex h-12 shrink-0 items-center gap-1 border-b border-line', closeX ? 'pr-2 pl-4 md:px-4' : 'px-2 max-md:pl-0.5 md:px-4')}>
        {!closeX && (
          <IconButton tip label={t('sideChat.close')} onClick={onClose} className="touch-hit p-3 md:hidden" data-testid="side-chat-back">
            <ChevronLeft size={20} aria-hidden />
          </IconButton>
        )}
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
        {/* (a chat with nothing in it yet, made for a file, is a new chat already) */}
        <IconButton tip label={t('sideChat.new')} onClick={newChat} disabled={busy || !chatId || !messages.length} className="touch-hit" data-testid="side-chat-new">
          <SquarePen size={15} aria-hidden />
        </IconButton>
        <IconButton tip label={t('sideChat.close')} onClick={onClose} className={clsx('touch-hit', !closeX && 'max-md:hidden')} data-testid="side-chat-close">
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
                  <UserMessage m={m} chatId={chatId} busy={busy} onEdit={onEdit} onSelectBranch={onSelectBranch} sideChat />
                </ViewerMeta>
              ) : (
                <ViewerMeta key={m.id} sender={{ kind: 'ai' }} at={m.createdAt}>
                  <AssistantMessage m={m} chatId={chatId} isLast={i === messages.length - 1} busy={busy} switchedFrom={null as EngineId | null} onRegenerate={onRegenerate} onSelectBranch={onSelectBranch} onAskOwnFolder={() => {}} shareable={shareable} sendHere={{ roomId, target: targets.get(m.id) ?? null, onView: view }} canSuggest={false} />
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
                  <button key={k} type="button" disabled={busy || chatId === undefined} onClick={() => void send(SIDE_CHAT_QUICK[k].ask[locale])}
                    className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink disabled:opacity-40" data-testid={`side-chat-quick-${k}`}>
                    {SIDE_CHAT_QUICK[k].label[locale]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className={clsx('rounded-xl border bg-canvas transition', drag ? 'border-accent ring-2 ring-accent/30' : 'border-line focus-within:border-line-strong')} data-testid="side-chat-box">
          <ComposerFileList files={files.files} onRemove={files.removeFile} className="px-3 pt-2.5" />
          <textarea
            ref={box}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={files.onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            rows={2}
            maxLength={20_000}
            placeholder={boxLabel}
            aria-label={boxLabel}
            className="block max-h-40 w-full resize-none bg-transparent px-3 pt-2.5 text-sm text-ink outline-none placeholder:text-faint"
            data-testid="side-chat-input"
          />
          <div className="flex items-center justify-between gap-2 pr-2 pb-2 pl-1.5">
            <IconButton tip label={t('composer.attach')} onClick={() => picker.current?.click()} className="touch-hit" data-testid="side-chat-attach">
              <Paperclip size={15} aria-hidden />
            </IconButton>
            <input ref={picker} type="file" multiple hidden onChange={files.onPicked} data-testid="side-chat-file-input" />
            {/* the room box's send button (RoomComposer): ↑ on a round button, its name (보내기, or 답하기 while the AI waits
                for an answer to its question) in the tooltip */}
            <Tooltip label={sendLabel}>
              <button
                type="button"
                onClick={() => void send()}
                disabled={!canSend}
                aria-label={sendLabel}
                className={clsx('touch-hit flex size-9 shrink-0 items-center justify-center rounded-full transition max-sm:size-10', canSend ? 'bg-accent text-accent-ink hover:bg-accent-hover' : 'bg-subtle text-faint')}
                data-testid="side-chat-send"
              >
                <ArrowUp size={18} aria-hidden />
              </button>
            </Tooltip>
          </div>
        </div>
        {fileError && <p role="alert" className="pt-1.5 text-xs text-danger" data-testid="side-chat-file-error">{fileError}</p>}
        <p className="pt-1.5 text-center text-[11px] text-faint" data-testid="side-chat-disclaimer">{t('sideChat.disclaimer', { name })}</p>
      </div>
    </div>
  )
  if (!frame) return body
  return (
    <RoomSideColumn label={t('sideChat.title', { name })} testId="room-side-chat" divider="side-chat">
      {body}
    </RoomSideColumn>
  )
}
