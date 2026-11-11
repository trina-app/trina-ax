// The chat screen: the visible branch with streaming answers and the composer. Regenerate and edit make a new
// branch (the AI's team-folder changes are not undone — the confirm dialog says so); "‹ 2/3 ›" switches branches.
// A message sent while an answer runs waits under the conversation and goes when the answer is done
// (store/sendQueue.ts, components/chat/QueuedMessages.tsx); while the AI waits for the answer to its question, the
// message box answers that question instead (lib/askAnswer.ts).
// Under the box every chat says who sees it (components/chat/WhoSees.tsx, docs/DECISIONS.md "Who sees it, always"): "나만
// 봐요", "나와 관리자만 봐요" or how many people; in a shared chat, for whoever may change its project's members, the line
// opens the members dialog, and the chat is read again after a save.
// A shared project chat (Chat.shared, docs/DECISIONS.md "Shared project chats"): the people of its project see it and may
// continue it. The header has its mark, the line under the box says how many see it, other people's messages carry
// their names, and only what the person may do is offered (rename and the engine: its creator; delete: its creator or a
// project editor; stop: whoever asked; edit and regenerate: their own messages; no move, no queued sends, team files
// only). While someone else's question is answered the box holds the text with a line saying whose; the others get no
// live text, so the messages are read again when that turn starts and ends. While safe operations are on it is read-only.
// Files from this computer dropped anywhere on the screen (its header, the messages, the box) go into the box
// (components/FileDropZone.tsx); a chat in the trash or a read-only one says why nothing can be attached.
import AiAccessBanner from '../components/chat/AiAccessBanner'
import { isNoAiReason } from '../lib/aiAccess'
import { ResultSuggestion } from '../components/onboarding/ResultSuggestion'
import { ChevronLeft, Globe, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { chatErrorReason, uuidv7, type Attachment, type Chat, type EngineId } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { refusalKey, refusalReason, sharedRights } from '../lib/sharedChat'
import { answerTooLong, choiceWaiting, composerAnswer, composerQuestion, picksOf } from '../lib/askAnswer'
import { desktop, isDesktop, usePaneState } from '../lib/desktop'
import { rememberChat } from '../lib/teamAttach'
import { useBackLink } from '../lib/back'
import { aiName } from '../lib/tabs'
import { formatDate } from '../lib/format'
import { chatPurgeAt, chatTrashDays } from '../lib/chat-trash'
import { CHAT_ROW, holdPlace, useStickToBottom } from '../lib/stickToBottom'
import { useWaitingMerge } from '../lib/mergeStart'
import { useLocale, useT } from '../i18n'
import { useChats } from '../store/chats'
import { useSessionMarkers } from '../store/sessionMarkers'
import { useEngines } from '../store/engines'
import { canChooseEngine, isAdmin, useMeStrict } from '../store/session'
import { emptyThread, runningMessage, type ViewMessage } from '../store/thread'
import { QueueFull, useSendQueue } from '../store/sendQueue'
import { toast } from '../store/ui'
import Composer, { type ComposerHandle, type EngineChoice } from '../components/chat/Composer'
import { useChatActions } from '../components/chat/chatActions'
import { AssistantMessage, UserMessage } from '../components/chat/Messages'
import { ImageGroup, ViewerMeta } from '../components/ImageViewer'
import QueuedMessages from '../components/chat/QueuedMessages'
import { ChatProjectCrumb, MoveToProjectDialog } from '../components/chat/ChatProject'
import type { EnginePick } from '../components/chat/EngineMenu'
import { ChatTitleMenu } from '../components/chat/ChatTitleMenu'
import { SharedChatMark, SharedReadOnly } from '../components/chat/SharedChat'
import { WhoSeesLine } from '../components/chat/WhoSees'
import { ProjectMembersDialog } from '../components/ProjectMembersDialog'
import { useProjects } from '../store/projects'
import { Button, EmptyState, IconButton, Skeleton, confirmDialog, useAnnounce } from '../components/ui'
import { LoadError } from '../components/LoadError'
import { Tooltip } from '../components/Tooltip'
import { FileDropZone } from '../components/FileDropZone'
import { AiMark } from '../components/rooms/AiFace'
import { useFolderWords } from '../lib/folderLabels'

/** Where a link goes inside a translated sentence ({projects} in chat.notFoundManage): split there. */
const SLOT = '\u0000'

export default function ChatPage() {
  const { chatId } = useParams()
  return <ChatView key={chatId} chatId={chatId!} />
}

function ChatView({ chatId }: { chatId: string }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const folderWords = useFolderWords()
  // "Add to current chat" on the file screen goes here
  useEffect(() => rememberChat(me.user.id, chatId), [me.user.id, chatId])
  // session markers: this chat is on screen in this window (store/sessionMarkers.ts marks it seen while the window is
  // visible and the list says an answer came since: Chat.unseen; the sidebar's dot and "?" go, in every window and on
  // every device)
  useEffect(() => {
    useSessionMarkers.getState().setOnScreen(chatId)
    return () => {
      if (useSessionMarkers.getState().onScreen === chatId) useSessionMarkers.getState().setOnScreen(null)
    }
  }, [chatId])
  const announce = useAnnounce()
  const navigate = useNavigate()
  const backLink = useBackLink()
  // my chat list, or a shared chat of someone else's that this screen shows (store/chats.ts `others`)
  const chatFromList = useChats((s) => s.chats.find((c) => c.id === chatId) ?? s.others[chatId])
  const [chat, setChat] = useState<Chat | null>(chatFromList ?? null)
  const thread = useChats((s) => s.threads[chatId]) ?? emptyThread()
  const { loadThread, loadOlder, send, stop, regenerate, edit, selectBranch, upsertChat, discardLocal } = useChats.getState()
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loading, setLoading] = useState(!useChats.getState().threads[chatId])
  // diagrams, images and code highlighting grow the page after the text arrived, and a phone's keyboard shrinks the
  // list: stay at the bottom if we were there (lib/stickToBottom.ts)
  const list = useStickToBottom()
  const { scroller, content, stick } = list
  const composer = useRef<ComposerHandle>(null)
  const [olderBusy, setOlderBusy] = useState(false)
  const models = useEngines((s) => s.models)
  const engines = useEngines((s) => s.engines)
  const loadEngines = useEngines((s) => s.load)
  // the engine / model are the admin's choice: the picker and "retry with another model" only for people allowed
  const choose = canChooseEngine(me)
  // "대화방에 보내기" only from a chat known not to be confidential (Safe operations 1A: every chat while the server says so)
  const shareable = !!chat && !chat.confidential && !me.server.allChatsConfidential
  const actions = useChatActions()
  // a shared project chat: what this person may do in it, whose question is being answered (not mine), and read-only
  // while safe operations are on
  const shared = chat?.shared
  const rights = sharedRights(chat, me.user.id)
  const othersTurn = shared?.answering ?? null
  const readOnly = !!shared && !!me.server.allChatsConfidential
  const title = chat?.title || t('chat.untitled')
  useEffect(() => {
    if (chatFromList) setChat(chatFromList)
  }, [chatFromList])
  // a merge chat made at the end of the welcome steps starts here, while it is on screen (lib/mergeStart.ts)
  useWaitingMerge(chat, {
    started: (id) => void api.call(API.getChat, { params: { id } }).then((c) => { setChat(c); upsertChat(c) }, () => {}),
    error: (e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }),
  })

  // the title menu's "Move to project…" (components/chat/ChatProject.tsx); the project's name before the title comes
  // from the projects store there
  const projectId = chat?.projectId ?? null
  const [movingProject, setMovingProject] = useState(false)
  // the line under the box, once the chat is here: whether nobody else sees it by a rule (Project.alone) and its
  // members dialog, for a shared chat whose members I may change, from its project as the header's crumb asked for it
  // (store/projects.ts)
  const project = useProjects((s) => (projectId ? s.byId[projectId] : undefined))
  const [members, setMembers] = useState(false)
  const who = chat ? <WhoSeesLine shared={shared ? { audience: shared.audience, alone: project?.alone } : null} place="chat" onOpen={shared && project?.membersEditable ? () => setMembers(true) : undefined} /> : undefined

  useEffect(() => {
    if (choose) void loadEngines()
  }, [choose, loadEngines])

  // a failed read's error stays until a read works: the notice stays while it reads again (components/LoadError.tsx)
  const load = useCallback(async () => {
    try {
      const [c] = await Promise.all([chatFromList ? Promise.resolve(chatFromList) : api.call(API.getChat, { params: { id: chatId } }), loadThread(chatId)])
      setLoadError(null)
      setChat(c)
      // someone else's shared chat: kept up to date by chat.updated while it is on screen, without joining my list
      if (c.shared && !c.shared.mine) upsertChat(c)
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
  /** who asked the question an answer answers (a shared chat: edit, regenerate and "send to a room" are for one's own) */
  const askedBy = (m: { parentId: string | null }) => messages.find((x) => x.id === m.parentId)?.author?.id
  const mine = (id: string | undefined) => !shared || id === me.user.id
  // a shared chat: the running answer is mine to stop only when I asked; someone else's turn holds the box instead
  const runningMine = shared ? (!!running && mine(askedBy(running))) || messages.some((m) => m.local?.state === 'sending') : busy

  // a shared chat: someone else's turn started or ended. Its question and answer are not streamed to the others (phase
  // 1): the messages are read again, so they appear
  const othersTurnNow = !!othersTurn
  const wasOthersTurn = useRef<boolean | null>(null)
  useEffect(() => {
    if (!chat) return
    const before = wasOthersTurn.current
    wasOthersTurn.current = othersTurnNow
    if (before !== null && before !== othersTurnNow) void loadThread(chatId).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, othersTurnNow])

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
    list.follow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, last?.content.length, last?.steps.length])

  const onScroll = async () => {
    const el = scroller.current
    if (!el) return
    list.onScroll()
    if (el.scrollTop < 200 && thread.nextCursor && !olderBusy) {
      setOlderBusy(true)
      // the message in sight stays where it is (lib/stickToBottom.ts holdPlace)
      const keep = holdPlace(el, CHAT_ROW)
      await loadOlder(chatId).catch(() => {})
      requestAnimationFrame(keep)
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
    if (shared) return sendShared(text, attachments, author)
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

  /** A shared chat: nothing waits to be sent (the box holds the text while an answer runs). A refusal (someone else's
   * question began a moment ago, safe operations, a computer file) takes the message back and keeps the text in the box
   * with the reason; the chat is read again, so the box says whose turn it is. */
  const sendShared = async (text: string, attachments: Attachment[], author: { id: string; name: string }) => {
    // (the box does not send then; a suggestion's button might: the text stays with the line's words)
    if (othersTurn) throw new Error(t(othersTurn.waiting ? 'chat.sharedWaiting' : 'chat.sharedBusy', { name: othersTurn.name }))
    const clientMessageId = uuidv7()
    const r = await send({ chatId, content: text, attachments, author, clientMessageId })
    try {
      await r.sent
    } catch (e) {
      if (!refusalReason(e) && !isApiError(e, 'conflict')) return // shown on the message ("not sent", send again)
      const local = useChats.getState().threads[chatId]?.messages.find((m) => m.local?.clientMessageId === clientMessageId)
      if (local) discardLocal(chatId, local.id)
      void api.call(API.getChat, { params: { id: chatId } }).then((c) => { setChat(c); upsertChat(c) }, () => {})
      const key = refusalKey(e, 'chat')
      throw new Error(key ? t(key) : errorText(e, locale, t('error.network')))
    }
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

  // the person's own words: the place in words (전사 공유 › 영업 › 보고서.md) and "my folder", which the AI is told is
  // users/<their id> (server/src/chat/prompt.ts); no raw path or id in their message
  const askOwnFolder = (path: string) => {
    if (busy) return
    composer.current?.prepareDraft(path ? t('files.summary.askOwnFolderPrompt', { path: folderWords.path(path, ' › ') }) : t('files.summary.askOwnFolderHiddenPrompt'))
  }

  if (loadError && isApiError(loadError, 'not_found'))
    return (
      <div className="flex h-full flex-col justify-center" data-testid="chat-not-found">
        <EmptyState title={t('chat.notFound')}>
          {/* the owner and admins: a chat of a project they are not in is "not found" too (its contents are its members',
              docs/DECISIONS.md "Project contents only for members"); the same line for every missing chat, so it tells
              nothing about this one */}
          {isAdmin(me) && (
            <p className="mb-1" data-testid="chat-not-found-manage">
              {/* "Projects" is the way there (a phone has no back button here) */}
              {t('chat.notFoundManage', { projects: SLOT }).split(SLOT).map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && (
                    <Link to="/projects" className="font-medium text-accent-text underline" data-testid="chat-not-found-projects">
                      {t('projects.title')}
                    </Link>
                  )}
                  {part}
                </Fragment>
              ))}
            </p>
          )}
          <Link to="/" className="mt-1 inline-block font-medium text-accent-text underline">
            {t('sidebar.askAi', { name: aiName(t) })}
          </Link>
        </EmptyState>
      </div>
    )

  return (
    <FileDropZone className="flex h-full flex-col" empty={chat?.deletedAt ? t('drop.trashed') : undefined} data-testid="chat-drop">
      {/* like the top of a Claude chat: the project it is in, then its name, which opens rename and delete. On a phone
          it is the only bar (Layout drops its own here): ‹ back (where I came from, else the 트리나 tab: lib/back.ts),
          the name, and a new chat (✦, as a room's header asks Trina). */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 max-md:gap-1 max-md:px-1">
        <Tooltip label={t('tabs.back')}>
          <Link to="/" replace onClick={backLink} aria-label={t('tabs.back')} className="inline-flex items-center justify-center rounded-md p-3 text-muted hover:bg-hover hover:text-ink md:hidden" data-testid="chat-back">
            <ChevronLeft size={20} aria-hidden />
          </Link>
        </Tooltip>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-1 text-sm md:justify-start">
          <ChatProjectCrumb projectId={projectId} />
          {chat && !chat.deletedAt ? (
            <ChatTitleMenu
              chat={chat}
              title={title}
              onRename={rights.creator ? () => void actions.rename(chat).then((c) => c && setChat(c)) : undefined}
              onMove={rights.canMove ? () => setMovingProject(true) : undefined}
              onDelete={rights.canDelete ? () => void actions.remove(chat) : undefined}
            />
          ) : (
            <h1 className="min-w-0 truncate px-1.5 font-medium text-ink" data-testid="chat-title">
              {title}
            </h1>
          )}
          {shared && <SharedChatMark audience={shared.audience} />}
        </div>
        {isDesktop() && <BrowserToggle />}
        <IconButton label={t('sidebar.askAi', { name: aiName(t) })} onClick={() => navigate('/')} className="size-11 shrink-0 md:hidden" data-testid="chat-new">
          <AiMark />
        </IconButton>
      </div>
      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="messages">
        <div ref={content} className="mx-auto max-w-[780px] space-y-6 px-4 py-8 max-md:py-4">
          {olderBusy && <Loader2 size={16} className="mx-auto animate-spin text-faint" aria-label={t('common.loading')} />}
          {loading && <Skeleton lines={6} />}
          {loadError && !loading ? <LoadError error={loadError} onRetry={load} what="chat" /> : null}
          {/* the chat's pictures (attachments and answers' pictures, this branch): ← → in the image viewer walks through
              these; each says who sent it and when */}
          <ImageGroup>
            {messages.map((m, i) => {
              if (m.role === 'user')
                return (
                  <ViewerMeta key={m.id} sender={{ kind: 'user', user: m.author ?? (shared ? null : me.user) }} at={m.createdAt}>
                    <UserMessage m={m} chatId={chatId} busy={busy || readOnly} onEdit={onEdit} onSelectBranch={onSelectBranch} showAuthor={!!shared} canEdit={!readOnly && mine(m.author?.id)} sideChat={!!chat?.sideRoomId} />
                  </ViewerMeta>
                )
              const prevAssistant = messages.slice(0, i).reverse().find((x) => x.role === 'assistant')
              const switchedFrom = prevAssistant?.engine && m.engine && prevAssistant.engine !== m.engine ? (prevAssistant.engine as EngineId) : null
              return (
                <ViewerMeta key={m.id} sender={{ kind: 'ai' }} at={m.createdAt}>
                  <AssistantMessage m={m} chatId={chatId} isLast={i === messages.length - 1} busy={busy || readOnly} switchedFrom={switchedFrom} onRegenerate={onRegenerate} retryWith={choose ? { engines, models } : undefined} onSelectBranch={onSelectBranch} onAskOwnFolder={askOwnFolder} onContinue={chat?.deletedAt || readOnly || !mine(askedBy(m)) ? undefined : onContinue} shareable={shareable && mine(askedBy(m))} shareRoomId={chat?.sideRoomId ?? undefined} canRegenerate={!readOnly && mine(askedBy(m))} canSuggest={!shared} />
                </ViewerMeta>
              )
            })}
          </ImageGroup>
          {!chat?.deletedAt && <QueuedMessages chatId={chatId} onFocusComposer={() => composer.current?.focus()} />}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[780px] px-4 pb-[var(--box-bottom)]" data-bottom-bar>
        {chat?.deletedAt ? (
          <TrashedBanner chat={chat} onRestored={(c) => { setChat(c); upsertChat(c) }} />
        ) : readOnly ? (
          <SharedReadOnly />
        ) : (
          <>
          {/* I answered the AI, and the answer waits for a free place among the team's answers (Chat.waitingForPlace) */}
          {chat?.waitingForPlace && <p className="pb-2 text-sm text-muted" role="status" data-testid="waiting-for-place">{t('chat.waitingForPlace')}</p>}
          {/* one suggestion under the newest answer: the welcome invite on the first result, else schedule or PPT */}
          <ResultSuggestion chatId={chatId} messages={messages} busy={busy} onSend={(text) => void onSend(text, []).catch(fail)} />
          {/* the newest answer failed for want of AI: its own line has the button, one is enough */}
          {!noAiError(messages.at(-1)) && <AiAccessBanner />}
          <Composer
            ref={composer}
            draftId={chatId}
            ensureChat={async () => chatId}
            running={runningMine}
            onSend={onSend}
            answering={question ? { question: question.request.question, onAnswer: (text) => onAnswer(question.request.requestId, text) } : undefined}
            choiceWaiting={choosing}
            onStop={() => stop(chatId)}
            engine={{ engine: chat?.engine, model: chat?.model }}
            onEngine={choose && rights.creator ? onEngine : undefined}
            engines={engines}
            models={models}
            placeholder={t('chat.reply')}
            footer={t('chat.footerAi')}
            who={who}
            // the earlier answer ended but the end of its work is not confirmed yet (Chat.ending): one plain line, no send
            hold={chat?.ending ? t('chat.endingEarlier') : othersTurn ? t(othersTurn.waiting ? 'chat.sharedWaiting' : 'chat.sharedBusy', { name: othersTurn.name }) : undefined}
            queueing={!shared}
            sharedUploads={shared ? { audience: shared.audience, allowed: shared.canUpload !== false } : undefined}
            projectId={chat?.projectId ?? null}
            autoFocus
          />
          </>
        )}
        {(chat?.deletedAt || readOnly) && <p className="pt-2 text-center text-micro text-faint max-md:hidden">{shared ? t('chat.footerShared', { n: shared.audience }) : t('chat.footer')}</p>}
      </div>
      {members && project && (
        <ProjectMembersDialog
          project={project}
          onClose={() => setMembers(false)}
          // who sees the chat now (its count, and whether anyone else does by a rule)
          onSaved={() => void api.call(API.getChat, { params: { id: chatId } }).then((c) => { setChat(c); upsertChat(c) }, () => {})}
        />
      )}
      {movingProject && chat && (
        <MoveToProjectDialog
          chat={chat}
          onClose={() => setMovingProject(false)}
          onMoved={(c) => {
            setChat(c)
            upsertChat(c)
          }}
        />
      )}
    </FileDropZone>
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

/** the answer failed because nothing answers this person (the button to connect or ask is on it) */
const noAiError = (m: { role: string; status?: string; error?: Parameters<typeof chatErrorReason>[0] | null } | undefined) =>
  !!m && m.role === 'assistant' && m.status === 'error' && !!m.error && isNoAiReason(chatErrorReason(m.error))
