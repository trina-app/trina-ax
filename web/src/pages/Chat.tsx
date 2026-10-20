// The chat screen: the visible branch with streaming answers and the composer. Regenerate and edit make a new
// branch (the AI's team-folder changes are not undone — the confirm dialog says so); "‹ 2/3 ›" switches branches.
import { FolderKanban, Globe, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Attachment, Chat, EngineId } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { isDesktop } from '../lib/desktop'
import { formatDate } from '../lib/format'
import { setSidePanel } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import { useChats } from '../store/chats'
import { useEngines } from '../store/engines'
import { isAdmin, useMeStrict, useSession } from '../store/session'
import { emptyThread, runningMessage, type ViewMessage } from '../store/thread'
import { toast } from '../store/ui'
import Composer, { type EngineChoice } from '../components/chat/Composer'
import { AssistantMessage, UserMessage } from '../components/chat/Messages'
import { Button, ErrorNote, IconButton, Skeleton, confirmDialog, useAnnounce } from '../components/ui'

export default function ChatPage() {
  const { chatId } = useParams()
  return <ChatView key={chatId} chatId={chatId!} />
}

function ChatView({ chatId }: { chatId: string }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const announce = useAnnounce()
  const chatFromList = useChats((s) => s.chats.find((c) => c.id === chatId))
  const [chat, setChat] = useState<Chat | null>(chatFromList ?? null)
  const thread = useChats((s) => s.threads[chatId]) ?? emptyThread()
  const { loadThread, loadOlder, send, stop, regenerate, edit, selectBranch, upsertChat } = useChats.getState()
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loading, setLoading] = useState(!useChats.getState().threads[chatId])
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [olderBusy, setOlderBusy] = useState(false)
  const models = useEngines((s) => s.models)
  const loadEngines = useEngines((s) => s.load)

  useEffect(() => {
    if (chatFromList) setChat(chatFromList)
  }, [chatFromList])

  useEffect(() => {
    if (isAdmin(me)) void loadEngines()
  }, [me, loadEngines])

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [c] = await Promise.all([chatFromList ? Promise.resolve(chatFromList) : api.call(API.getChat, { params: { id: chatId } }), loadThread(chatId)])
      setChat(c)
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
  const busy = !!running || messages.some((m) => m.local?.state === 'sending')

  // screen readers: "answer in progress" → "answer done", never the streaming text itself
  const wasRunning = useRef(false)
  useEffect(() => {
    if (running && !wasRunning.current) announce(t('chat.answering'))
    if (!running && wasRunning.current) announce(t('chat.answerDone'))
    wasRunning.current = !!running
  }, [running, announce, t])

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

  const onRegenerate = async (m: ViewMessage) => {
    if (!(await confirmBranch(m.id))) return
    stick.current = true
    try {
      await stopIfRunning()
      await regenerate(chatId, m.id)
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
    await send({ chatId, content: text, attachments, author: { id: me.user.id, name: me.user.name } })
  }

  const onEngine = async (e: EngineChoice) => {
    try {
      const c = await api.call(API.updateChat, { params: { id: chatId }, body: { engine: e.engine, model: e.model ?? null } })
      setChat(c)
      upsertChat(c)
      void useSession.getState().updatePrefs({ engine: e.engine, model: e.model ?? undefined }).catch(() => {})
    } catch (err) {
      fail(err)
    }
  }

  const askOwnFolder = (path: string) =>
    void send({ chatId, content: t('files.summary.askOwnFolderPrompt', { path: path || '-', folder: `users/${me.user.id}` }), attachments: [], author: { id: me.user.id, name: me.user.name } }).catch(fail)

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
        {isDesktop() && (
          <IconButton label={t('browser.title')} onClick={() => setSidePanel({ kind: 'browser' })}>
            <Globe size={16} />
          </IconButton>
        )}
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
            return <AssistantMessage key={m.id} m={m} chatId={chatId} isLast={i === messages.length - 1} busy={busy} switchedFrom={switchedFrom} onRegenerate={onRegenerate} onSelectBranch={onSelectBranch} onAskOwnFolder={askOwnFolder} />
          })}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[780px] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
        {chat?.deletedAt ? (
          <TrashedBanner chat={chat} onRestored={(c) => { setChat(c); upsertChat(c) }} />
        ) : (
          <Composer
            draftId={chatId}
            ensureChat={async () => chatId}
            running={busy}
            onSend={onSend}
            onStop={() => stop(chatId)}
            engine={{ engine: chat?.engine, model: chat?.model }}
            onEngine={onEngine}
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
  const purge = new Date(Date.parse(chat.deletedAt!) + 7 * 86400_000).toISOString()
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

