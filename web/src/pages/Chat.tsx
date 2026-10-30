// The chat screen: the visible branch with streaming answers and the composer. Regenerate and edit make a new
// branch (the AI's team-folder changes are not undone — the confirm dialog says so); "‹ 2/3 ›" switches branches.
// A message sent while an answer runs waits under the conversation and goes when the answer is done
// (store/sendQueue.ts, components/chat/QueuedMessages.tsx); while the AI waits for the answer to its question, the
// message box answers that question instead (lib/askAnswer.ts).
import { FolderKanban, Globe, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Attachment, Chat, EngineId } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { answerTooLong, choiceWaiting, composerAnswer, composerQuestion, picksOf } from '../lib/askAnswer'
import { desktop, isDesktop, usePaneState } from '../lib/desktop'
import { rememberChat } from '../lib/teamAttach'
import { formatDate } from '../lib/format'
import { chatPurgeAt, chatTrashDays } from '../lib/chat-trash'
import { useLocale, useT } from '../i18n'
import { useChats } from '../store/chats'
import { useEngines } from '../store/engines'
import { canChooseEngine, useMeStrict } from '../store/session'
import { emptyThread, runningMessage, type ViewMessage } from '../store/thread'
import { QueueFull, useSendQueue } from '../store/sendQueue'
import { toast } from '../store/ui'
import Composer, { type ComposerHandle, type EngineChoice } from '../components/chat/Composer'
import { AssistantMessage, UserMessage } from '../components/chat/Messages'
import QueuedMessages from '../components/chat/QueuedMessages'
import type { EnginePick } from '../components/chat/EngineMenu'
import { Button, ErrorNote, IconButton, Skeleton, confirmDialog, useAnnounce } from '../components/ui'

export default function ChatPage() {
  const { chatId } = useParams()
  return <ChatView key={chatId} chatId={chatId!} />
}

function ChatView({ chatId }: { chatId: string }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  // "Add to current chat" on the file screen goes here
  useEffect(() => rememberChat(me.user.id, chatId), [me.user.id, chatId])
  const announce = useAnnounce()
  const chatFromList = useChats((s) => s.chats.find((c) => c.id === chatId))
  const [chat, setChat] = useState<Chat | null>(chatFromList ?? null)
  const thread = useChats((s) => s.threads[chatId]) ?? emptyThread()
  const { loadThread, loadOlder, send, stop, regenerate, edit, selectBranch, upsertChat } = useChats.getState()
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loading, setLoading] = useState(!useChats.getState().threads[chatId])
  const scroller = useRef<HTMLDivElement>(null)
  const composer = useRef<ComposerHandle>(null)
  const stick = useRef(true)
  const [olderBusy, setOlderBusy] = useState(false)
  const models = useEngines((s) => s.models)
  const engines = useEngines((s) => s.engines)
  const loadEngines = useEngines((s) => s.load)
  // the engine / model are the admin's choice: the picker and "retry with another model" only for people allowed
  const choose = canChooseEngine(me)

  useEffect(() => {
    if (chatFromList) setChat(chatFromList)
  }, [chatFromList])

  useEffect(() => {
    if (choose) void loadEngines()
  }, [choose, loadEngines])

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [c] = await Promise.all([chatFromList ? Promise.resolve(chatFromList) : api.call(API.getChat, { params: { id: chatId } }), loadThread(chatId)])
      setChat(c)
      // messages this browser kept waiting for an answer in this chat (a reload, the app reopened)
      useSendQueue.getState().restore(me.user.id, chatId)
    } catch (e) {
      setLoadError(e)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])
  useEffect(() => {
    void load()
  }, [load])

  const messages = thread.messages
  const running = runningMessage(messages)
  // the AI's open question in this chat (the message box answers it), and cards only their own buttons answer
  const question = useChats((s) => composerQuestion(s.requests, chatId))
  const choosing = useChats((s) => choiceWaiting(s.requests, chatId))
  const busy = !!running || messages.some((m) => m.local?.state === 'sending')

  // screen readers: "answer in progress" → "answer done", never the streaming text itself
  const wasRunning = useRef<string | null>(null)
  useEffect(() => {
    if (running && !wasRunning.current) announce(t('chat.answering'))
    if (!running && wasRunning.current) {
      // how the answer ended: a failed or stopped answer is not "complete"
      const endedMessage = messages.find((m) => m.id === wasRunning.current)
      const ended = endedMessage?.status
      // an answer that paused at the per-answer limit says so (and that it can continue), not "complete"
      announce(endedMessage?.stopReason && ended === 'done' ? t('chat.limit.title') : t(ended === 'error' ? 'chat.answerFailed' : ended === 'stopped' ? 'chat.stopped' : 'chat.answerDone'))
    }
    wasRunning.current = running?.id ?? null
  }, [running, messages, announce, t])

  // keep following the answer while the reader is at the bottom
  const last = messages.at(-1)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages.length, last?.content.length, last?.steps.length])

  // diagrams, images and code highlighting grow the page after the text arrived: stay at the bottom if we were there
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = content.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const s = scroller.current
      if (s && stick.current) s.scrollTop = s.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = async () => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 200 && thread.nextCursor && !olderBusy) {
      setOlderBusy(true)
      const before = el.scrollHeight
      await loadOlder(chatId).catch(() => {})
      requestAnimationFrame(() => {
        if (scroller.current) scroller.current.scrollTop += scroller.current.scrollHeight - before
      })
      setOlderBusy(false)
    }
  }

  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })

  /** files the AI changed in the part of the branch that is about to be replaced */
  const changedFilesFrom = (id: string) => {
    const i = messages.findIndex((m) => m.id === id)
    return messages.slice(i).some((m) => (m.files?.saved.length ?? 0) > 0)
  }
  const confirmBranch = async (fromId: string) => !changedFilesFrom(fromId) || (await confirmDialog({ title: t('chat.branchConfirmTitle'), body: t('chat.branchConfirmBody'), confirm: t('common.continue') }))

  const stopIfRunning = async () => {
    if (running) await stop(chatId).catch(() => {})
  }

  /** with: another engine / model ("retry with another model", people allowed to pick only) */
  const onRegenerate = async (m: ViewMessage, with_?: EnginePick) => {
    if (!(await confirmBranch(m.id))) return
    stick.current = true
    try {
      await stopIfRunning()
      await regenerate(chatId, m.id, choose && with_ ? with_ : undefined)
    } catch (e) {
      fail(e)
    }
  }
  const onEdit = async (m: ViewMessage, text: string) => {
    if (!(await confirmBranch(m.id))) return
    stick.current = true
    try {
      await stopIfRunning()
      await edit(chatId, m.id, text, m.attachments)
    } catch (e) {
      fail(e)
    }
  }
  const onSelectBranch = (id: string) => void selectBranch(chatId, id).catch(fail)

  const onSend = async (text: string, attachments: Attachment[]) => {
    stick.current = true
    const author = { id: me.user.id, name: me.user.name }
    const queue = useSendQueue.getState()
    const waiting = queue.queues[chatId]
    // an answer is running (or messages already wait): this one waits too and goes when the answer is done
    if (busy || waiting?.items.length) {
      // nothing runs, but earlier messages were paused (stopped / failed answer): sending now takes them along, in order
      if (!busy && waiting?.paused) return queue.sendNow(chatId, { content: text, attachments, author })
      try {
        queue.enqueue(me.user.id, chatId, { content: text, attachments, author })
      } catch (e) {
        if (e instanceof QueueFull) throw new Error(t('outbox.full'))
        throw e
      }
      announce(t('outbox.waitingOne'))
      return
    }
    await send({ chatId, content: text, attachments, author })
  }

  /** Sent from the message box while the AI waits for the answer to its question: the text answers it, like the card's
   * own box ("Other" in Claude Code). On a question with several answers the options ticked on the card go along. */
  const onAnswer = async (requestId: string, text: string) => {
    // the question the box named, never another one that opened meanwhile
    const q = useChats.getState().requests[requestId]
    // the card closed in the moment before (answered in another window, timed out): the text goes like any message
    if (q?.request.kind !== 'ask_user' || q.request.origin === 'server') return onSend(text, [])
    const max = answerTooLong(q.request, text)
    if (max) throw new Error(t('composer.answerTooLong', { n: max.toLocaleString(locale) }))
    stick.current = true
    await useChats.getState().answer(requestId, { kind: 'ask_user', answer: composerAnswer(q.request, picksOf(requestId), text) })
  }

  /** "이어서 하기" under an answer that paused at the per-answer limit: a plain message in this chat; the server tells
   * the AI where it stopped (server/src/chat/prompt.ts continuationBlock) and usage counts as for any message */
  const onContinue = () => {
    composer.current?.focus()
    onSend(t('chat.limit.message'), []).catch(fail)
  }

  const onEngine = async (e: EngineChoice) => {
    try {
      const c = await api.call(API.updateChat, { params: { id: chatId }, body: { engine: e.engine, model: e.model ?? null } })
      setChat(c)
      upsertChat(c)
    } catch (err) {
      fail(err)
    }
  }

  const askOwnFolder = (path: string) => {
    if (busy) return
    composer.current?.prepareDraft(t(path ? 'files.summary.askOwnFolderPrompt' : 'files.summary.askOwnFolderHiddenPrompt', { path, folder: `users/${me.user.id}` }))
  }

  if (loadError && isApiError(loadError, 'not_found'))
    return (
      <div className="p-8 text-center text-sm text-muted">
        {t('chat.notFound')}{' '}
        <Link to="/" className="text-accent-text underline">
          {t('sidebar.newChat')}
        </Link>
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <h1 className="min-w-0 flex-1 truncate text-center text-sm font-medium text-ink md:text-left" data-testid="chat-title">
          {chat?.title || t('chat.untitled')}
        </h1>
        {chat?.projectId && (
          <Link to={`/projects/${chat.projectId}`} className="hidden items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-hover sm:inline-flex">
            <FolderKanban size={13} aria-hidden /> {t('sidebar.projects')}
          </Link>
        )}
        {isDesktop() && <BrowserToggle />}
      </div>
      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="messages">
        <div ref={content} className="mx-auto max-w-[780px] space-y-6 px-4 py-8">
          {olderBusy && <Loader2 size={16} className="mx-auto animate-spin text-faint" aria-label={t('common.loading')} />}
          {loading && <Skeleton lines={6} />}
          {loadError && !loading ? <ErrorNote onRetry={() => void load()}>{errorText(loadError, locale, t('error.network'))}</ErrorNote> : null}
          {messages.map((m, i) => {
            if (m.role === 'user') return <UserMessage key={m.id} m={m} chatId={chatId} busy={busy} onEdit={onEdit} onSelectBranch={onSelectBranch} />
            const prevAssistant = messages.slice(0, i).reverse().find((x) => x.role === 'assistant')
            const switchedFrom = prevAssistant?.engine && m.engine && prevAssistant.engine !== m.engine ? (prevAssistant.engine as EngineId) : null
            return <AssistantMessage key={m.id} m={m} chatId={chatId} isLast={i === messages.length - 1} busy={busy} switchedFrom={switchedFrom} onRegenerate={onRegenerate} retryWith={choose ? { engines, models } : undefined} onSelectBranch={onSelectBranch} onAskOwnFolder={askOwnFolder} onContinue={chat?.deletedAt ? undefined : onContinue} />
          })}
          {!chat?.deletedAt && <QueuedMessages chatId={chatId} onFocusComposer={() => composer.current?.focus()} />}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[780px] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
        {chat?.deletedAt ? (
          <TrashedBanner chat={chat} onRestored={(c) => { setChat(c); upsertChat(c) }} />
        ) : (
          <Composer
            ref={composer}
            draftId={chatId}
            ensureChat={async () => chatId}
            running={busy}
            onSend={onSend}
            answering={question ? { question: question.request.question, onAnswer: (text) => onAnswer(question.request.requestId, text) } : undefined}
            choiceWaiting={choosing}
            onStop={() => stop(chatId)}
            engine={{ engine: chat?.engine, model: chat?.model }}
            onEngine={choose ? onEngine : undefined}
            engines={engines}
            models={models}
            autoFocus
          />
        )}
        <p className="pt-2 text-center text-[11px] text-faint">{t('chat.footer')}</p>
      </div>
    </div>
  )
}

function TrashedBanner({ chat, onRestored }: { chat: Chat; onRestored: (c: Chat) => void }) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const purge = chatPurgeAt(chat.deletedAt!, chatTrashDays(useMeStrict()))
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">
      <Trash2 size={16} className="shrink-0" aria-hidden />
      <span className="flex-1">{t('chat.inTrash', { date: formatDate(purge, locale) })}</span>
      <Button
        size="sm"
        busy={busy}
        onClick={async () => {
          setBusy(true)
          try {
            onRestored(await api.call(API.restoreChat, { params: { id: chat.id } }))
          } catch (e) {
            toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
          } finally {
            setBusy(false)
          }
        }}
      >
        <RotateCcw size={14} aria-hidden /> {t('common.restore')}
      </Button>
    </div>
  )
}

/** Desktop app only: open / close the in-app Browser pane the desktop app draws next to this page. */
function BrowserToggle() {
  const t = useT()
  const pane = usePaneState()
  return (
    <IconButton label={pane.driving ? t('browser.driving') : t('browser.title')} onClick={() => desktop()?.pane.toggle()} aria-pressed={pane.open} className={pane.open ? 'bg-hover text-ink' : undefined} data-testid="browser-toggle">
      <span className="relative inline-flex">
        <Globe size={16} />
        {pane.driving && <span className="absolute -top-0.5 -right-0.5 h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />}
      </span>
    </IconButton>
  )
}
