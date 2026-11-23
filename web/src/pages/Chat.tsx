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
// project editor; stop: whoever asked; edit and regenerate: their own messages; no move, team files only). A message
// sent while an answer runs, mine or someone else's, waits under the conversation as in a private chat; the server sends
// the waiting messages of different people in the order they were queued, and the others see only how many wait
// (docs/decisions/20261118-shared-chat-queued-sends.md). While someone else's question is answered a line above the box
// says whose; the others get no live text, so the messages are read again when that turn starts and ends. While safe
// operations are on it is read-only.
// Files from this computer dropped anywhere on the screen (its header, the messages, the box) go into the box
// (components/FileDropZone.tsx); a chat in the trash or a read-only one says why nothing can be attached.
// `?answer=<messageId>` (an item of the widening list, components/WideningList.tsx): the branch holding that answer, for
// this view only (the chat's active branch is not changed for anyone), scrolled to it and lit for a moment; an answer
// no longer there opens the chat at its end with "That answer is no longer here." On a phone, opened from a sharing
// dialog's list, a bar "‹ Back to sharing" leads back to it (store/wideningDraft.ts).
import clsx from 'clsx'
import { composerInset } from '../components/chat/composerBox'
import { GuestNoAi, useGuestAiOff, useGuestNoAi } from '../components/GuestView'
import AiAccessBanner from '../components/chat/AiAccessBanner'
import { isNoAiReason } from '../lib/aiAccess'
import { ResultSuggestion } from '../components/onboarding/ResultSuggestion'
import { ArrowDown, ChevronLeft, Globe, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { chatErrorReason, uuidv7, type Attachment, type Chat, type EngineId, type Project } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { isPeopleShared, noLongerMemberOf, noLongerSharedWith, privateInTeamProject, refusalKey, refusalReason, shareKindOf, sharedRights } from '../lib/sharedChat'
import { answerTooLong, BoxAnswers, choiceWaiting, composerAnswer, composerQuestion, picksOf } from '../lib/askAnswer'
import { desktop, isDesktop, usePaneState } from '../lib/desktop'
import { rememberChat } from '../lib/teamAttach'
import { readDraft } from '../lib/localData'
import { fromWire } from '../lib/roomRefs'
import { useBackLink } from '../lib/back'
import { aiName } from '../lib/tabs'
import { formatDate } from '../lib/format'
import { chatPurgeAt, chatTrashDays } from '../lib/chat-trash'
import { focusInPlace, linkedAnswer, linkedStep } from '../lib/linkedAnswer'
import { CHAT_ROW, farFromBottom, holdPlace, listPlace, restorePlace, useStickToBottom } from '../lib/stickToBottom'
import { useWaitingMerge } from '../lib/mergeStart'
import { useLocale, useT } from '../i18n'
import { chatEnd, chatPlace, keepChatPlace, showThrough, useChats } from '../store/chats'
import { chatChanged } from '../store/live'
import { freshDraft, useWideningDraft } from '../store/wideningDraft'
import { useSessionMarkers } from '../store/sessionMarkers'
import { readChatMentions, useChatMentions } from '../store/chatMentions'
import { useEngines } from '../store/engines'
import { canChooseEngine, isAdmin, useMeStrict } from '../store/session'
import { useRooms } from '../store/rooms'
import { isGuestMe } from '../lib/guests'
import { emptyThread, rowButtonsWait, runningMessage, savedFilesFrom, type ViewMessage } from '../store/thread'
import { QueueFull, useSendQueue } from '../store/sendQueue'
import { toast } from '../store/ui'
import { LinkAskAccess } from '../components/LinkAskAccess'
import Composer, { type ComposerHandle, type EngineChoice } from '../components/chat/Composer'
import { changeChat, trashChat, useChatActions } from '../components/chat/chatActions'
import { AssistantMessage, UserMessage } from '../components/chat/Messages'
import { ChatEventLine, eventsBetween, useAudienceEvents } from '../components/chat/ChatEvents'
import { ImageGroup, ViewerMeta } from '../components/ImageViewer'
import QueuedMessages from '../components/chat/QueuedMessages'
import { ChatProjectCrumb, MoveToProjectDialog } from '../components/chat/ChatProject'
import type { EnginePick } from '../components/chat/EngineMenu'
import { ChatTitleMenu } from '../components/chat/ChatTitleMenu'
import { PrivateChatMark, SharedByLine, SharedChatMark, SharedReadOnly, sharedByOf } from '../components/chat/SharedChat'
import { WhoSeesLine } from '../components/chat/WhoSees'
import { askPrivately, askPrivatelyHome, lastOwnQuestion } from '../components/chat/privateAsk'
import { openChatShare, startShare, useSharedWithNames } from '../components/chat/ChatShareDialog'
import { HeaderShare, WhoSeesWords } from '../components/HeaderShare'
import { ProjectRoomButton } from '../components/rooms/ProjectRoomButton'
import { PeopleStack, useProjectPeople } from '../components/ProjectPeople'
import { ProjectMembersDialog } from '../components/ProjectMembersDialog'
import { useProjects } from '../store/projects'
import { useTrashLines } from '../components/ProjectTrashNote'
import { Button, CopyButton, EmptyState, IconButton, Skeleton, useAnnounce, useMediaQuery } from '../components/ui'
import { LoadError } from '../components/LoadError'
import { Tooltip } from '../components/Tooltip'
import { FileDropZone } from '../components/FileDropZone'
import { isolate } from '../components/handover/isolate'
import { RoomSideColumn } from '../components/rooms/RoomSideColumn'
import { ChatThreadPanel } from '../components/chat/ChatThreadPanel'
import { closeSidePanel, getSidePanel, openFilePreview, useSidePanel, type PreviewFile } from '../lib/sidePanel'
import { chatFileLinkStep, chatFileName } from '../lib/chatFileLink'
import { ChatLinks } from '../components/Markdown'
import { useFolderWords } from '../lib/folderLabels'

/** Where a link goes inside a translated sentence ({projects} in chat.notFoundManage): split there. */
const SLOT = '\u0000'

export default function ChatPage() {
  const { chatId, messageId, target } = useParams()
  // ?answer= read again when it changes on the same chat (an answer of the widening list opened from this chat's own
  // Share dialog on a phone)
  const [params] = useSearchParams()
  // /c/:chatId/t/:messageId: the thread under that answer, beside the chat (the same view: the chat stays as it was)
  // /c/:chatId/m/:target: a notification's tap on a message of a chat shared with people (push paths carry no query):
  // the same as ?answer=
  const focus = target ?? params.get('answer')
  return <ChatView key={`${chatId}:${focus ?? ''}`} chatId={chatId!} threadRoot={messageId ?? null} focus={focus} />
}

function ChatView({ chatId, threadRoot, focus }: { chatId: string; threadRoot: string | null; focus: string | null }) {
  // ?answer= (or /m/<id>): this view shows that message's branch; what is in memory for the chat may be another branch,
  // so it is read again (before the first read below)
  const [params] = useSearchParams()
  const [focusAnswer] = useState(() => {
    const id = focus
    if (id) {
      showThrough(chatId, id)
      useChats.setState((s) => { const { [chatId]: _, ...threads } = s.threads; return { threads } })
    }
    return id
  })
  useEffect(() => () => showThrough(chatId, null), [chatId])
  // ?file=<id>: a chat file's link (an answer's attached file, /c/<chat>?file=<id>): its viewer opens beside the chat,
  // named as the chat's messages name it (the bytes and every check stay behind the chat's file route)
  const fileParam = params.get('file')
  const fileName = useChats((s) => {
    if (!fileParam) return null
    for (const m of s.threads[chatId]?.messages ?? []) for (const a of (m as { attachments?: { id: string; name: string }[] }).attachments ?? []) if (a.id === fileParam) return a.name
    return null
  })
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const folderWords = useFolderWords()
  // "Add to current chat" on the file screen goes here
  useEffect(() => rememberChat(me.user.id, chatId), [me.user.id, chatId])
  // session markers: this chat is on screen in this window (store/sessionMarkers.ts marks it seen while the window is
  // visible and the list says an answer came since: Chat.unseen; the history row's dot and "?" go, in every window and on
  // every device)
  useEffect(() => {
    useSessionMarkers.getState().setOnScreen(chatId)
    return () => {
      if (useSessionMarkers.getState().onScreen === chatId) useSessionMarkers.getState().setOnScreen(null)
    }
  }, [chatId])
  // my unread mentions in this chat's threads (the counts on its row in the 프로젝트 panel and on its project's page) count
  // as read once it is open, in both places and on the rail's and the phone tab's 프로젝트 mark (store/chatMentions.ts);
  // also when they arrive after it opened (a reload straight into the chat reads them after the page is up, a new one
  // while it is on screen)
  const mentionedHere = useChatMentions((s) => s.byChat.has(chatId))
  useEffect(() => { if (mentionedHere) void readChatMentions(chatId) }, [chatId, mentionedHere])
  const announce = useAnnounce()
  const navigate = useNavigate()
  const backLink = useBackLink()
  // my chat list, or a shared chat of someone else's that this screen shows (store/chats.ts `others`)
  const chatFromList = useChats((s) => s.chats.find((c) => c.id === chatId) ?? s.others[chatId])
  // a chat opened from a list that already holds it (a project page's rows: someone else's shared chat is not in my list
  // yet) shows its title, crumb and people on the first frame, before the read comes back (QA TC-1293)
  const location = useLocation()
  const handed = (location.state as { chat?: Chat } | null)?.chat
  const [chat, setChat] = useState<Chat | null>(chatFromList ?? (handed?.id === chatId ? handed : null))
  const thread = useChats((s) => s.threads[chatId]) ?? emptyThread()
  const { loadThread, loadOlder, send, stop, regenerate, edit, selectBranch, upsertChat, discardLocal } = useChats.getState()
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loading, setLoading] = useState(!useChats.getState().threads[chatId])
  // the file link's viewer only once the chat opened and the file is mine to open (lib/chatFileLink.ts, QA TC-6935): a
  // chat that does not open keeps its own notice alone (a viewer opened from before closes), a file that does not open
  // gets one plain line and no viewer, never "This format can't be previewed" with a Download that cannot work
  const fileStep = chatFileLinkStep({ file: fileParam, loading, loadError, name: fileName })
  // once per chat and link: older messages loaded later, or the language changed, never reopen a viewer the person closed
  const fileLinkDone = useRef<string | null>(null)
  const notFoundText = useRef('')
  notFoundText.current = t('preview.notFound')
  useEffect(() => {
    if (loadError) {
      const p = getSidePanel()
      if (p?.kind === 'file' && p.file.source === 'chat' && p.file.chatId === chatId) closeSidePanel()
      return
    }
    if (!fileParam || (fileStep !== 'open' && fileStep !== 'look')) return
    const key = `${chatId}:${fileParam}`
    if (fileLinkDone.current === key) return
    fileLinkDone.current = key
    if (fileStep === 'open') return void openFilePreview({ source: 'chat', chatId, fileId: fileParam, name: fileName! })
    let live = true
    let settled = false
    api.call(API.chatFileVersions, { params: { id: chatId, fileId: fileParam } }).then(
      (v) => {
        if (!live) return
        settled = true
        const name = chatFileName(v)
        if (name) openFilePreview({ source: 'chat', chatId, fileId: fileParam, name })
        else toast({ level: 'info', text: notFoundText.current })
      },
      () => { if (live) { settled = true; toast({ level: 'info', text: notFoundText.current }) } },
    )
    return () => {
      // (left before the answer came: the next run asks again)
      if (!settled && fileLinkDone.current === key) fileLinkDone.current = null
      live = false
    }
  }, [fileStep, chatId, fileParam, fileName, loadError])
  // diagrams, images and code highlighting grow the page after the text arrived, and a phone's keyboard shrinks the
  // list: stay at the bottom if we were there (lib/stickToBottom.ts)
  const list = useStickToBottom()
  const { scroller, content, stick } = list
  const composer = useRef<ComposerHandle>(null)
  const guestNoAi = useGuestNoAi()
  const guestHere = isGuestMe(me)
  // a guest whose invite gave no AI: nothing on this page offers to ask Trina (QA TC-b4s s2)
  const guestAiOff = useGuestAiOff() && guestHere
  const [olderBusy, setOlderBusy] = useState(false)
  // the reader scrolled up far from the newest message: a round button above the box takes them back (QA AP-043)
  const [away, setAway] = useState(false)
  useEffect(() => { setAway(false) }, [chatId])
  const models = useEngines((s) => s.models)
  const engines = useEngines((s) => s.engines)
  const loadEngines = useEngines((s) => s.load)
  // the engine / model are the admin's choice: the picker and "retry with another model" only for people allowed
  const choose = canChooseEngine(me)
  // "대화방에 보내기" only from a chat known not to be confidential (Safe operations 1A: every chat while the server says so)
  // a guest with no conversation to send to (a project's guest, usually): no button that opens an empty list (guest
  // walkthrough S1). A member always has the everyone room
  const guestNowhere = useRooms((s) => isGuestMe(me) && s.loaded && !s.failed && s.rooms.length === 0)
  const shareable = !!chat && !chat.confidential && !me.server.allChatsConfidential && !guestNowhere
  const actions = useChatActions()
  // a shared project chat: what this person may do in it, whose question is being answered (not mine), and read-only
  // while safe operations are on
  const shared = chat?.shared
  const rights = sharedRights(chat, me.user.id)
  const othersTurn = shared?.answering ?? null
  const readOnly = !!shared && !!me.server.allChatsConfidential
  // no title yet while the chat is read: nothing, not "Untitled" (that is a chat without one)
  const title = chat ? chat.title || t('chat.untitled') : loading ? '' : t('chat.untitled')
  useEffect(() => {
    if (chatFromList) setChat(chatFromList)
  }, [chatFromList])
  // a merge chat made at the end of the welcome steps starts here, while it is on screen (lib/mergeStart.ts)
  useWaitingMerge(chat, {
    started: (id) => void api.call(API.getChat, { params: { id } }).then((c) => { setChat(c); upsertChat(c) }, () => {}),
    error: (e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }),
  })

  // the title menu's "Move to project" (components/chat/ChatProject.tsx); the project's name before the title comes
  // from the projects store there
  const projectId = chat?.projectId ?? null
  const [movingProject, setMovingProject] = useState(false)
  // the line under the box, once the chat is here: whether nobody else sees it by a rule (Project.alone) and its
  // members dialog, for a shared chat whose members I may change, from its project as the header's crumb asked for it
  // (store/projects.ts)
  const project = useProjects((s) => (projectId ? s.byId[projectId] : undefined))
  const [members, setMembers] = useState(false)
  // a chat shared with people and groups (docs/DECISIONS.md "Chats shared with people and groups"): its creator's line
  // opens the Share dialog; to someone not told how many see it (a group in it), the names it is shared with
  const people = isPeopleShared(chat)
  const sharedBy = sharedByOf(chat, me.user.id)
  const sharedNames = useSharedWithNames(people && !!shared?.audienceHidden ? chatId : null, shared?.by, me.user.id)
  // someone else's chat shared with me that nobody else sees now (its creator's account is off): it is still theirs,
  // shared with me, never "Only you can see this chat" (QA TC-2263)
  // who changed its people, between the messages (QA TC-7289): read again when how many see it or the messages change
  // and again when a file of the chat gets a new version (a restore's line: QA TC-v1c-01). My own chat outside projects
  // reads them once too: one that went back to being only mine keeps its lines ("{actor} left", QA TC-v1a-02); nothing
  // new comes to it while nobody else is in it
  const filesAt = useMemo(() => thread.messages.reduce((at, m) => (m.attachments ?? []).reduce((x, a) => (a.updated && a.updated.at > x ? a.updated.at : x), at), ''), [thread.messages])
  const ownLines = !!chat && !chat.shared && !chat.projectId && !chat.sideRoomId
  // ...and on every change of the chat itself (chat.updated: someone added and someone removed keeps how many see it the
  // same, QA TC-b3s-16) and every new version of one of its pages (a page's restore line, QA b3s S-033)
  const [chatRev, setChatRev] = useState(0)
  const pagesRev = useChats((s) => s.artifactsRev[chatId] ?? 0)
  const audienceEvents = useAudienceEvents((people || ownLines) && chat && !chat.deletedAt ? chatId : null, people ? `${shared?.audience ?? 0}:${thread.messages.length}:${filesAt}:${chatRev}:${pagesRev}` : `own:${pagesRev}`)
  const sharedToMeAlone = people && !!shared && !rights.creator && !shared.audienceHidden && (shared.audience ?? 0) <= 1
  const who = chat ? (
    <WhoSeesLine
      shared={shared ? { audience: shared.audience, alone: project?.alone } : null}
      place="chat"
      // its creator's account gone: that, in place of who shared it (QA TC-7431; everyone listed still sees it)
      text={people && shared?.byGone && !rights.creator ? (shared.byGone.state === 'deleted' ? t('chat.share.byGoneDeleted', { name: shared.by.name, date: formatDate(shared.byGone.until, locale) }) : t('chat.share.byGoneDisabled', { name: shared.by.name }))
        : people && shared?.audienceHidden ? (sharedNames ? t('chat.share.sharedWith', { names: sharedNames }) : t('chat.sharedLabel')) : sharedToMeAlone ? t('chat.share.sharedToMeAlone', { name: shared!.by.name }) : undefined}
      // everyone in it opens the Share dialog: its creator to change it, anyone else its read-only list (QA TC-7265)
      onOpen={people ? (!chat.deletedAt ? () => openChatShare(chat) : undefined) : shared && project?.membersEditable ? () => setMembers(true) : undefined}
      openLabel={people ? t(rights.creator ? 'chat.share.changeWho' : 'chat.share.seeWho') : undefined}
    />
  ) : undefined
  // Share at the top right of the header (docs/DECISIONS.md "Share in the title row"; components/HeaderShare.tsx), the
  // one place to share a chat (the title menu has no Share any more): what the title menu's Share opened (shareKindOf:
  // the Share dialog of my chat outside projects, the members' share of my private chat in a team project, the
  // explanation with Move of my chat in a personal project); on a shared project chat, the project's members dialog for
  // whoever may change them (as the line under the box). Anyone else: no button, who sees it stays beside where it was.
  const shareKind = chat && !chat.deletedAt ? shareKindOf(chat, project, me.user.id, !!me.server.allChatsConfidential) : null
  const projectChat = !!shared && !people
  const onShare = shareKind ? () => startShare({ id: chat!.id, title: chat!.title ?? title, projectId: chat!.projectId, shared: chat!.shared }, shareKind) : projectChat && project?.membersEditable && !chat?.deletedAt ? () => setMembers(true) : undefined
  // who sees it, beside Share (a computer; a phone's line under the box says it): a shared project chat by its project's
  // faces (they open the members, read only for whoever cannot change them), else in words
  const projectPeople = useProjectPeople(projectChat && project ? project : null)
  // (never a guest of the project but the chat's own creator: a guest sees no one else's shared chat, so is not among
  // who sees it; QA TC-b4s s2, the faces showed 정하늘 while the line said 3)
  const seers = projectChat && projectPeople ? projectPeople.people.filter((x) => !x.guest || x.id === shared?.by.id) : null
  const faces = seers && seers.length > 1 ? seers : null
  const whoWords = !chat ? null : !shared ? t('chat.whoMe') : shared.audienceHidden ? t('chat.sharedLabel') : t('projects.visibilityPeople', { n: shared.audience })
  const headerWho = faces ? <PeopleStack people={faces} onOpen={() => setMembers(true)} testId="chat-header" />
    : whoWords ? <WhoSeesWords words={whoWords} onOpen={people && !chat?.deletedAt ? () => openChatShare(chat!) : projectChat && project ? () => setMembers(true) : undefined} testId="chat-who-sees" /> : null
  // someone else's chat shared with me: when it can't be opened any more, it says so (QA TC-1405)
  const wasSharedWithMe = useRef(false)
  if (people && shared && shared.by.id !== me.user.id) wasSharedWithMe.current = true

  useEffect(() => {
    if (choose) void loadEngines()
  }, [choose, loadEngines])

  // a failed read's error stays until a read works: the notice stays while it reads again (components/LoadError.tsx).
  // When both reads fail, the page keeps the chat read's error, whichever answer came first: it is the one that says why
  // the chat cannot be opened (a project left or in the trash; QA TC-1403), the messages' plain 404 says less.
  const load = useCallback(async () => {
    try {
      const read = chatFromList ? Promise.resolve(chatFromList) : api.call(API.getChat, { params: { id: chatId } })
      const [c] = await Promise.all([read, loadThread(chatId).catch(async (e: unknown) => { await read; throw e })])
      setLoadError(null)
      setChat(c)
      // someone else's shared chat: kept up to date by chat.updated while it is on screen, without joining my list. Only a
      // copy read now: the store's own copy (chatFromList) may be older than a chat.updated that came while the messages
      // were read (opening it reads its unread messages: putting the copy of before back kept the Projects mark)
      if (c.shared && !c.shared.mine && c !== chatFromList) upsertChat(c)
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
  // a change of this chat while it is on screen (store/live.ts chatChanged): its people lines are read again, and a page
  // that could not open it ("no longer shared with me") reads it again when it comes back to me, as a reload would (QA
  // TC-b3s-16: someone added me while my old link was open)
  const failedNow = useRef<unknown>(null)
  useEffect(() => { failedNow.current = loadError }, [loadError])
  // (one read again at a time: several changes in a row are one)
  const reloading = useRef(false)
  useEffect(() => chatChanged.on((e) => {
    if (e.chatId !== chatId) return
    setChatRev((n) => n + 1)
    if (!failedNow.current || reloading.current || !e.chat || e.chat.deletedAt || e.change === 'deleted' || e.change === 'purged') return
    reloading.current = true
    void load().finally(() => { reloading.current = false })
  }), [chatId, load])
  // the chat left my lists while it is on screen (chat.updated "deleted": I lost the shared chat when a project's
  // members changed, it went to a trash or was purged; also a list read again after a reconnect): read it again, so a
  // chat I can no longer open shows the not-found page instead of its old messages and a box that cannot send, and one
  // in a trash shows the trash line, as a reload would (QA TC-961). A reply that comes after the chat came back to a
  // list (an undo, the member added back) changes nothing.
  const wasListed = useRef(!!chatFromList)
  useEffect(() => {
    const was = wasListed.current
    wasListed.current = !!chatFromList
    if (!was || chatFromList) return
    const back = () => { const s = useChats.getState(); return s.chats.some((x) => x.id === chatId) || !!s.others[chatId] }
    api.call(API.getChat, { params: { id: chatId } }).then(
      (c) => { if (!back()) setChat(c) },
      (e) => { if (isApiError(e, 'not_found') && !back()) setLoadError(e) },
    )
  }, [chatId, chatFromList])

  const messages = thread.messages
  // a chat shared with people: the files its creator added as copies (docs/decisions/20261121-share-chat-files.md) open
  // for every link to their old place, for everyone (one file, not two); a link that does not open for me offers to ask
  // the creator to add it (components/ChatFileAsk.tsx)
  const peopleChat = isPeopleShared(chat)
  const chatLinks = useMemo(() => {
    const copies = new Map<string, PreviewFile>()
    for (const m of messages) for (const a of m.role === 'assistant' ? m.attachments : []) if (a.source === 'chat' && a.origin === 'shared-copy' && a.from) copies.set(a.from, { source: 'chat', chatId, fileId: a.id, name: a.name })
    return copies.size || peopleChat ? { chatId, copies, ask: peopleChat && shared?.by.id !== me.user.id } : null
  }, [messages, chatId, peopleChat, shared?.by.id, me.user.id])
  const running = runningMessage(messages)

  // ?answer=: scroll to it and mark it (`data-focused`, no look: only the place) for a moment, once it is read; gone (or
  // hidden from me): say so
  const focused = useRef(false)
  useEffect(() => {
    if (!focusAnswer || focused.current || loading || loadError) return
    focused.current = true
    const m = messages.find((x) => x.id === focusAnswer)
    const el = m && !m.withheld ? scroller.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focusAnswer)}"]`) : null
    if (!el) { toast({ level: 'info', text: t('share.widenList.gone') }); return }
    stick.current = false
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center' })
      el.setAttribute('data-focused', '')
      setTimeout(() => el.removeAttribute('data-focused'), 2400)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAnswer, loading, loadError, messages.length])
  // a phone that came from a sharing dialog's list: the way back to it
  const phone = useMediaQuery('(max-width: 767.98px)')
  const draft = useWideningDraft((s) => s.draft)
  const backToSharing = !!focusAnswer && phone && !!draft?.left && freshDraft(draft)
  // the AI's open question in this chat (the message box answers it), and cards only their own buttons answer
  const question = useChats((s) => composerQuestion(s.requests, chatId))
  const choosing = useChats((s) => choiceWaiting(s.requests, chatId))
  const busy = !!running || messages.some((m) => m.local?.state === 'sending')
  const rowsBusy = rowButtonsWait(messages, { readOnly, othersTurn })
  /** who asked the question an answer answers (a shared chat: edit, regenerate and "send to a room" are for one's own) */
  const askedBy = (m: { parentId: string | null }) => messages.find((x) => x.id === m.parentId)?.author?.id
  const mine = (id: string | undefined) => !shared || id === me.user.id
  // a shared chat: the running answer is mine to stop only when I asked; someone else's turn holds the box instead
  const runningMine = shared ? (!!running && mine(askedBy(running))) || messages.some((m) => m.local?.state === 'sending') : busy

  // a shared chat: someone else's turn started or ended. Their question is not sent to the others as an event: the
  // messages are read again, so it appears with the answer's text so far, and the answer's live text, steps and end
  // follow as events (docs/decisions/20261118-shared-chat-live-answers.md); read again at the end too, in case one was
  // missed
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
  // back in a chat whose messages are still in memory, left with the reader part way up and nothing new since: the same
  // message in the same place, before the first frame shows (at the bottom, or when its end changed: the newest, as on
  // any open)
  const [place] = useState(() => {
    const kept = chatPlace(chatId), th = useChats.getState().threads[chatId]
    return kept && th && kept.last === chatEnd(th.messages) ? kept : null
  })
  useLayoutEffect(() => {
    const el = scroller.current
    if (place && el?.clientHeight && restorePlace(el, el.querySelector(`[data-message-id="${place.messageId}"]`), place.offset)) stick.current = false
    // leaving: where the reader is now, for the next time
    return () => {
      const at = scroller.current
      const left = at ? listPlace(at, CHAT_ROW, (row) => row.getAttribute('data-message-id'), stick.current) : null
      keepChatPlace(chatId, left && { ...left, last: chatEnd(useChats.getState().threads[chatId]?.messages ?? []) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onScroll = async () => {
    const el = scroller.current
    if (!el) return
    list.onScroll()
    setAway(farFromBottom(el))
    if (el.scrollTop < 200 && thread.nextCursor && !olderBusy) {
      setOlderBusy(true)
      // the message in sight stays where it is (lib/stickToBottom.ts holdPlace)
      const keep = holdPlace(el, CHAT_ROW, list.reanchor)
      await loadOlder(chatId).catch(() => {})
      requestAnimationFrame(keep)
      setOlderBusy(false)
    }
  }

  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })

  // an edit or a new answer goes ahead at once (docs/decisions/20261123-ask-registry-findings.md, decision 10); when the
  // part it replaces saved files, one line above the box says they stay as they are
  const [branchNote, setBranchNote] = useState(false)
  const noteBranch = (fromId: string) => setBranchNote(savedFilesFrom(messages, fromId))

  const stopIfRunning = async () => {
    if (running) await stop(chatId).catch(() => {})
  }

  /** with: another engine / model ("retry with another model", people allowed to pick only) */
  const onRegenerate = async (m: ViewMessage, with_?: EnginePick) => {
    noteBranch(m.id)
    stick.current = true
    try {
      await stopIfRunning()
      await regenerate(chatId, m.id, choose && with_ ? with_ : undefined)
    } catch (e) {
      fail(e)
    }
  }
  const onEdit = async (m: ViewMessage, text: string) => {
    noteBranch(m.id)
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
    setBranchNote(false)
    const author = { id: me.user.id, name: me.user.name }
    const queue = useSendQueue.getState()
    const waiting = queue.queues[chatId]
    // an answer is running (or messages already wait): this one waits too and goes when the answer is done. A shared
    // chat: also while someone else's question is answered, or someone else's messages wait (theirs go first)
    if (busy || waiting?.items.length || (shared && (othersTurn || shared.waiting))) {
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
    if (shared) return sendShared(text, attachments, author)
    await send({ chatId, content: text, attachments, author })
  }

  /** A shared chat with nothing running or waiting. Someone else's question began a moment ago, or their messages wait
   * (409 shared_chat_busy / shared_chat_next): the message waits under the conversation like any sent during an answer.
   * Another refusal (safe operations, a computer file) takes the message back and keeps the text in the box with the
   * reason; the chat is read again, so the box says whose turn it is. */
  const sendShared = async (text: string, attachments: Attachment[], author: { id: string; name: string }) => {
    const clientMessageId = uuidv7()
    const r = await send({ chatId, content: text, attachments, author, clientMessageId })
    const refused = (e: unknown): Error | null => {
      if (!refusalReason(e) && !isApiError(e, 'conflict')) return null // shown on the message ("not sent", send again)
      const local = useChats.getState().threads[chatId]?.messages.find((m) => m.local?.clientMessageId === clientMessageId)
      if (local) discardLocal(chatId, local.id)
      const reason = isApiError(e, 'conflict') ? e.body.params?.reason : null
      if (reason === 'shared_chat_busy' || reason === 'shared_chat_next') {
        try {
          useSendQueue.getState().enqueue(me.user.id, chatId, { content: text, attachments, author })
          announce(t('outbox.waitingOne'))
          void api.call(API.getChat, { params: { id: chatId } }).then((c) => { setChat(c); upsertChat(c) }, () => {})
          return null
        } catch { /* too many waiting: the box keeps the text with the reason below */ }
      }
      void api.call(API.getChat, { params: { id: chatId } }).then((c) => { setChat(c); upsertChat(c) }, () => {})
      const key = refusalKey(e, 'chat')
      return new Error(key ? t(key) : errorText(e, locale, t('error.network')))
    }
    // Trina is updating: the message waits on screen with its note and goes when the server is back (store/chats.ts),
    // so the box is free again now; a refusal after the update says why in a notice (the box may hold new text by then)
    const first = await Promise.race([r.sent.then(() => null, (e: unknown) => ({ e })), untilWaitingForUpdate(chatId, clientMessageId, r.sent)])
    if (first === 'updating') {
      r.sent.catch((e: unknown) => { const err = refused(e); if (err) toast({ level: 'warn', text: err.message }) })
      return
    }
    const err = first ? refused(first.e) : null
    if (err) throw err
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

  /** the picker shows the new engine / model at once; a refusal puts it back with one toast (lib/optimistic.ts) */
  const onEngine = async (e: EngineChoice) => {
    if (!chat) return
    type Pick = { engine: EngineId; model: string | null; updatedAt: string }
    await changeChat<Pick>({
      chat,
      field: 'engine',
      from: { engine: chat.engine, model: chat.model, updatedAt: chat.updatedAt },
      to: { engine: e.engine ?? chat.engine, model: e.model ?? null, updatedAt: new Date().toISOString() },
      apply: (c, v) => ({ ...c, ...v }),
      send: () => api.call(API.updateChat, { params: { id: chatId }, body: { engine: e.engine, model: e.model ?? null } }),
      confirmed: (c) => ({ engine: c.engine, model: c.model, updatedAt: c.updatedAt }),
      onShown: setChat,
    })
  }

  // the person's own words: the place in words (전사 공유 › 영업 › 보고서.md) and "my folder", which the AI is told is
  // users/<their id> (server/src/chat/prompt.ts); no raw path or id in their message
  const askOwnFolder = (path: string) => {
    if (busy) return
    composer.current?.prepareDraft(path ? t('files.summary.askOwnFolderPromptFiles', { path: folderWords.path(path, ' › ') }) : t('files.summary.askOwnFolderHiddenPromptFiles'))
  }

  // threads on a shared chat's answers (docs/decisions/20261116-chat-answer-threads.md): opened from this chat it is one
  // step back from it (‹, ✕, Esc, the browser's back); from a link or a notice it closes to the chat in its place. One
  // thing beside the chat at a time: a thread closes a file or artifact panel, and one of those closes the thread
  const fromChat = !!(location.state as { fromChat?: boolean } | null)?.fromChat
  const threadFocus = !!(location.state as { focus?: boolean } | null)?.focus
  // what opened the thread ("Reply in thread", or the line under the answer): closing it puts the focus back there, never
  // on the page (QA TC-3888); a thread opened from a link goes back to its answer's line
  const opener = useRef<{ id: string; button: boolean } | null>(null)
  const focusBack = useRef(true)
  const lastThread = useRef(threadRoot)
  useEffect(() => {
    const was = lastThread.current
    lastThread.current = threadRoot
    if (!was || threadRoot) return
    const back = focusBack.current
    focusBack.current = true
    if (!back) return
    const button = opener.current?.id === was && opener.current.button
    requestAnimationFrame(() => {
      const row = scroller.current?.querySelector(`[data-message-id="${CSS.escape(was)}"]`)
      const pick = (id: string) => row?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null
      focusInPlace(button ? pick('reply-in-thread') ?? pick('chat-thread-line') : pick('chat-thread-line') ?? pick('reply-in-thread'))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadRoot])
  const openThread = (id: string, focus: boolean) => {
    opener.current = { id, button: focus }
    closeSidePanel()
    navigate(`/c/${chatId}/t/${id}`, { replace: !!threadRoot, state: { fromChat: threadRoot ? fromChat : true, focus, here: true } })
  }
  // a thread opened from outside this chat (an Activity row, a push tap, a link): the chat goes to the answer it is under
  // and marks it (`data-focused`, no look) for a moment, reading older pages to find it (lib/linkedAnswer.ts); one opened
  // here leaves it as it was
  const lightAnswer = (id: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
    if (!el) return
    // at once, not in the next frame: a scroll event of the list's own jump to its bottom, still on its way, would make it
    // follow the bottom again first (onListScroll near the bottom), and the answer would be pushed out of sight. Then the
    // browser's scroll anchoring on again, so what grows later (a picture, the chat narrowing beside the thread) keeps it
    // in place
    el.scrollIntoView({ block: 'center' })
    stick.current = false
    list.reanchor()
    el.setAttribute('data-focused', '')
    setTimeout(() => el.removeAttribute('data-focused'), 2400)
  }
  const openedHere = !!(location.state as { here?: boolean } | null)?.here
  const linked = linkedAnswer(threadRoot, openedHere)
  const linkedAt = useRef<{ id: string | null; tries: number; done: boolean }>({ id: null, tries: 0, done: false })
  useEffect(() => {
    if (linkedAt.current.id !== linked) linkedAt.current = { id: linked, tries: 0, done: false }
    const now = linkedAt.current
    if (!linked || now.done || loading || loadError || olderBusy) return
    const step = linkedStep({ id: linked, ids: messages.map((m) => m.id), hasOlder: !!thread.nextCursor, tries: now.tries })
    if (step === 'older') {
      now.tries += 1
      setOlderBusy(true)
      void loadOlder(chatId).catch(() => { now.done = true }).finally(() => setOlderBusy(false))
      return
    }
    now.done = true
    if (step === 'show') lightAnswer(linked)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, loading, loadError, olderBusy, messages.length, thread.nextCursor])
  // a phone: the thread was over the chat, so the chat goes to that answer (lit) when the thread closes
  const lastLinked = useRef<string | null>(null)
  useEffect(() => {
    const was = lastLinked.current
    lastLinked.current = linked
    if (linked || !was || !phone) return
    requestAnimationFrame(() => lightAnswer(was))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked])
  const closeThread = useCallback(() => {
    if (fromChat) navigate(-1)
    else navigate(`/c/${chatId}`, { replace: true })
  }, [fromChat, navigate, chatId])
  const sidePanel = useSidePanel()
  useEffect(() => {
    // (the panel that opened takes the focus, not the answer)
    if (sidePanel && threadRoot) { focusBack.current = false; closeThread() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidePanel])
  // a shared chat of a project in the trash, to one of its members: the server says so (and only to them), and the page
  // says what the project's page says (QA TC-1060)
  if (loadError && isApiError(loadError, 'not_found') && loadError.body.params?.reason === 'project_in_trash' && typeof loadError.body.params.projectId === 'string')
    return <ChatOfTrashedProject projectId={loadError.body.params.projectId} />
  // a shared chat of a project I was taken out of (or left): its name, plainly (QA TC-1067)
  const goneFrom = loadError ? noLongerMemberOf(loadError) : null
  if (goneFrom)
    return (
      <div className="flex h-full flex-col justify-center" data-testid="chat-not-found" data-gone="">
        <EmptyState screen title={isolate(locale, 'projects.noLongerMember', { name: goneFrom }, ['name'])}>
          <Link to="/projects" className="mt-1 inline-block font-medium text-accent-text underline">
            {t('projects.title')}
          </Link>
        </EmptyState>
      </div>
    )
  // a chat someone shared with me, and I was taken out (or left its group): while it was open, or its link opened later
  // (the server says so only to someone who was in it: QA TC-2009). What I was typing there stays, with Copy (TC-2032)
  if (loadError && isApiError(loadError, 'not_found') && (wasSharedWithMe.current || noLongerSharedWith(loadError)))
    return <NoLongerShared userId={me.user.id} chatId={chatId} />
  // a teammate's link to a chat I am not in: Ask for access when the chat can be shared with me (QA TC-4185,
  // docs/decisions/20261116-chat-project-ask-access.md); else, and for an address that was never a chat, the one page
  // (the owner and admins: that page when no ask is possible, with its "add yourself in Projects" line)
  if (loadError && isApiError(loadError, 'not_found'))
    return <LinkAskAccess kind="chat" id={chatId} staff={isAdmin(me)} onOpen={() => { setLoading(true); void load() }} fallback={
      <div className="flex h-full flex-col justify-center" data-testid="chat-not-found">
        <EmptyState screen title={t('chat.notFound')}>
          {/* one text for every chat that cannot be opened (a chat only its creator sees, one deleted, one of a project
              I am not in): the server answers each with the same 404, so the page tells nothing about this one; the
              likely case, a teammate's link to a chat still private to them, says what to ask for (QA TC-919, TC-948;
              docs/DECISIONS.md "Team project chats shared by default") */}
          {/* a guest: no one can share a chat with them, so not "ask them to share it" but what a guest opens (QA TC-b4s s2) */}
          <p className="mb-1 break-keep" data-testid="chat-not-found-why">{t(guestHere ? 'chat.notFoundGuest' : 'chat.notFoundWhy')}</p>
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
          {/* a guest without AI asks nobody: their home instead (QA TC-b4s s2) */}
          <Link to="/" className="mt-1 inline-block font-medium text-accent-text underline" data-testid="chat-not-found-home">
            {guestAiOff ? t('notFound.home') : t('sidebar.askAi', { name: aiName(t) })}
          </Link>
        </EmptyState>
      </div>
    } />

  return (
    <div className="flex h-full" data-testid="chat-page">
    <FileDropZone className={clsx('flex h-full min-w-0 flex-1 flex-col', threadRoot && chat && 'max-md:hidden')} empty={chat?.deletedAt ? t('drop.trashed') : undefined} data-testid="chat-drop">
      {backToSharing && (
        <div className="flex h-11 shrink-0 items-center border-b border-line bg-surface px-1">
          {/* like the system Back: the screen that opened the dialog, which opens it again on the list (WideningDraftHost) */}
          {/* (a chat's own Share dialog opened its answer on the same screen, which a phone replaces: back to its address) */}
          <button type="button" onClick={() => (draft!.from.split('?')[0] === `/c/${chatId}` ? navigate(draft!.from, { replace: true }) : window.history.length > 1 ? navigate(-1) : navigate(draft!.from))} className="touch-hit inline-flex h-11 items-center gap-1 rounded-md px-2 text-sm font-medium text-accent-text hover:bg-hover" data-testid="back-to-sharing">
            <ChevronLeft size={18} aria-hidden />{t('share.widenList.back')}
          </button>
        </div>
      )}
      {/* like the top of a Claude chat: the project it is in, then its name, which opens rename and delete. On a phone
          it is the only bar (Layout drops its own here): ‹ back (where I came from, else the 트리나 tab: lib/back.ts,
          whose box is the new chat), the name and Share. No ✦: this already is a chat with Trina, and a computer's
          header never had one; ✦ in a header is a room's side chat (docs/decisions/20261118-phone-trina-button-in-ai-chats.md). */}
      {/* 48px; 56px on a phone with the "Shared by" line under the title, so the two lines and the border have room */}
      <div className={clsx('flex shrink-0 items-center gap-2 border-b border-line px-4 max-md:gap-1 max-md:px-1', sharedBy && phone ? 'h-14' : 'h-12')} data-testid="chat-bar">
        <Tooltip label={t('tabs.back')}>
          <Link to="/" replace onClick={backLink} aria-label={t('tabs.back')} className="inline-flex items-center justify-center rounded-md p-3 text-muted hover:bg-hover hover:text-ink md:hidden" data-testid="chat-back">
            <ChevronLeft size={20} aria-hidden />
          </Link>
        </Tooltip>
        {/* someone else's chat shared with me by name or group: who shared it, after the title (a phone: under it) */}
        <div className={clsx('flex min-w-0 flex-1 justify-center', sharedBy && phone ? 'flex-col items-center' : 'items-center')}>
        <div className={clsx('flex min-w-0 items-center justify-center gap-1 text-sm md:justify-start', sharedBy && phone ? 'max-w-full' : 'flex-1')}>
          <ChatProjectCrumb projectId={projectId} />
          {chat && !chat.deletedAt ? (
            <ChatTitleMenu
              chat={chat}
              title={title}
              compact={!!sharedBy && phone}
              // 상단에 고정 / 고정 해제, as the row's "···" (anyone who sees the chat; the server checks it)
              onPin={() => void actions.togglePin(chat, setChat)}
              onMute={() => void actions.toggleMute(chat, setChat)}
              onRename={rights.creator ? () => void actions.rename(chat, setChat) : undefined}
              onMove={rights.canMove ? () => setMovingProject(true) : undefined}
              onDelete={rights.canDelete ? () => void actions.remove(chat) : undefined}
              // a shared chat: the same question again in a chat only I see, in its project (my last question here); a
              // chat shared with people: Home's box, no project
              onPrivately={shared ? () => (chat.projectId ? askPrivately(navigate, chat.projectId, lastOwnQuestion(chat.id, me?.user.id)) : askPrivatelyHome(navigate, lastOwnQuestion(chat.id, me?.user.id))) : undefined}
              onHide={() => void actions.hide(chat)}
              onLeave={() => void actions.leave(chat)}
            />
          ) : (
            <h1 className="min-w-0 truncate px-1.5 font-medium text-ink" data-testid="chat-title">
              {title}
            </h1>
          )}
          {shared && <SharedChatMark audience={shared.audience} hidden={!!shared.audienceHidden} />}
          {/* a chat only I see in a team project: its lock, where a shared one has its people (QA TC-1068) */}
          {!shared && chat && privateInTeamProject(chat, project) && <PrivateChatMark />}
          {sharedBy && !phone && <SharedByLine by={sharedBy} />}
        </div>
        {sharedBy && phone && <SharedByLine by={sharedBy} line />}
        </div>
        {/* a chat of a team project: the project's chat room, one tap away (docs/decisions/20261120-project-is-room.md D5;
            a phone: its icon, a dot while something is unread) */}
        {chat && !chat.deletedAt && <ProjectRoomButton project={project} look={phone ? 'icon' : 'button'} testId="chat-project-room" />}
        {/* who sees it and Share (components/HeaderShare.tsx); a phone: the Share icon only */}
        {chat && !phone && <HeaderShare who={headerWho} onShare={onShare} testId="chat-share" />}
        {isDesktop() && <BrowserToggle />}
        {chat && phone && <HeaderShare icon onShare={onShare} testId="chat-share" />}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="messages">
        <div ref={content} className="mx-auto max-w-[780px] space-y-6 px-4 py-8 max-md:py-4">
          {olderBusy && <Loader2 size={16} className="mx-auto animate-spin text-faint" aria-label={t('common.loading')} />}
          {loading && <Skeleton lines={6} />}
          {loadError && !loading ? <LoadError error={loadError} onRetry={load} what="chat" /> : null}
          {/* the chat's pictures (attachments and answers' pictures, this branch): ← → in the image viewer walks through
              these; each says who sent it and when */}
          {/* the message box below answers the AI's open question (not when it is not shown: a trashed or read-only chat) */}
          <BoxAnswers.Provider value={chat?.deletedAt || readOnly ? null : (question?.request.requestId ?? null)}>
          <ChatLinks.Provider value={chatLinks}>
          <ImageGroup>
            {messages.map((m, i) => {
              // who changed its people since the message before (a chat shared with people; nothing before the oldest
              // message read while older ones are still to load)
              const lines = audienceEvents.length ? eventsBetween(audienceEvents, i ? messages[i - 1]!.createdAt : null, m.createdAt).filter(() => i > 0 || !thread.nextCursor) : []
              const before = lines.map((e) => <ChatEventLine key={`${e.at}-${e.kind}-${e.actor}`} e={e} />)
              if (m.role === 'user')
                return (
                  <Fragment key={m.id}>
                    {before}
                    <ViewerMeta sender={{ kind: 'user', user: m.author ?? (shared ? null : me.user) }} at={m.createdAt}>
                      <UserMessage m={m} chatId={chatId} busy={rowsBusy} onEdit={onEdit} onSelectBranch={onSelectBranch} showAuthor={!!shared} canEdit={!readOnly && mine(m.author?.id)} sideChat={!!chat?.sideRoomId} />
                    </ViewerMeta>
                  </Fragment>
                )
              const prevAssistant = messages.slice(0, i).reverse().find((x) => x.role === 'assistant')
              const switchedFrom = prevAssistant?.engine && m.engine && prevAssistant.engine !== m.engine ? (prevAssistant.engine as EngineId) : null
              return (
                <Fragment key={m.id}>
                {before}
                <ViewerMeta sender={{ kind: 'ai' }} at={m.createdAt}>
                  <AssistantMessage m={m} chatId={chatId} isLast={i === messages.length - 1} busy={rowsBusy} switchedFrom={switchedFrom} onRegenerate={onRegenerate} retryWith={choose ? { engines, models } : undefined} onSelectBranch={onSelectBranch} onAskOwnFolder={askOwnFolder} onContinue={chat?.deletedAt || readOnly || !mine(askedBy(m)) ? undefined : onContinue} shareable={shareable && mine(askedBy(m))} shareRoomId={chat?.sideRoomId ?? undefined} canRegenerate={!readOnly && mine(askedBy(m))} canSuggest={!shared} onThread={shared && !chat?.sideRoomId ? (focus) => openThread(m.id, focus) : undefined} />
                </ViewerMeta>
                </Fragment>
              )
            })}
            {eventsBetween(audienceEvents, messages.at(-1)?.createdAt ?? null, null).filter(() => messages.length || !thread.nextCursor).map((e) => <ChatEventLine key={`${e.at}-${e.kind}-${e.actor}`} e={e} />)}
          </ImageGroup>
          </ChatLinks.Provider>
          </BoxAnswers.Provider>
          {!chat?.deletedAt && <QueuedMessages chatId={chatId} onFocusComposer={() => composer.current?.focus()} shared={shared && !readOnly ? { audience: shared.audience, kind: shared.kind, othersWaiting: shared.waiting ?? 0 } : undefined} />}
        </div>
      </div>
      {away && (
        <IconButton label={t('chat.toBottom')} onClick={() => { list.toBottom(); setAway(false) }} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface shadow-md" data-testid="chat-to-bottom">
          <ArrowDown size={16} aria-hidden />
        </IconButton>
      )}
      </div>
      <div className={clsx('mx-auto w-full max-w-[780px] pb-[var(--box-bottom)]', composerInset)} data-bottom-bar>
        {chat?.deletedAt ? (
          <TrashedBanner chat={chat} onShown={setChat} />
        ) : readOnly ? (
          <SharedReadOnly />
        ) : guestNoAi ? (
          // a guest whose AI is off: one line in place of the box (components/GuestView.tsx)
          <GuestNoAi className="mb-3" />
        ) : (
          <>
          {/* I answered the AI, and the answer waits for a free place among the team's answers (Chat.waitingForPlace) */}
          {chat?.waitingForPlace && <p className="pb-2 text-sm text-muted" role="status" data-testid="waiting-for-place">{t('chat.waitingForPlace')}</p>}
          {/* an edit or a new answer replaced a part that saved files: they stay as they are (no confirm before it) */}
          {branchNote && <p className="pb-2 text-sm text-muted" role="status" data-testid="branch-files-note">{t('chat.branchNotice')}</p>}
          {/* one suggestion under the newest answer: the welcome invite on the first result, else schedule or PPT */}
          {/* (not for a guest: no team skills, schedules or welcome invite are theirs, and the server refuses it) */}
          {!guestHere && <ResultSuggestion chatId={chatId} messages={messages} busy={busy} onSend={(text) => void onSend(text, []).catch(fail)} />}
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
            hold={chat?.ending ? t('chat.endingEarlier') : undefined}
            // someone else's question is being answered: a line saying whose, and what I send now waits for it
            note={chat?.waitsFor ? t('chat.sharedWaiting', { name: chat.waitsFor }) : othersTurn ? t(othersTurn.waiting ? 'chat.sharedWaiting' : 'chat.sharedBusy', { name: othersTurn.name }) : undefined}
            later={!!othersTurn || !!shared?.waiting}
            sharedUploads={shared ? { audience: shared.audience, allowed: shared.canUpload !== false, kind: shared.kind } : undefined}
            projectId={chat?.projectId ?? null}
            autoFocus
          />
          </>
        )}
        {(chat?.deletedAt || readOnly) && <p className="pt-2 text-center text-micro text-faint max-md:hidden">{shared ? (shared.audienceHidden ? t('chat.footerAi') : t('chat.footerShared', { n: shared.audience })) : t('chat.footerPrivate')}</p>}
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
    {/* the thread in the address (a shared chat's answer): a column beside the chat on a computer, the screen on a phone */}
    {threadRoot && chat && (
      <RoomSideColumn label={t('rooms.thread')} testId="chat-thread-column" divider="thread">
        <ChatThreadPanel key={threadRoot} chat={chat} rootId={threadRoot} meId={me.user.id} onClose={closeThread} onShownBranch={messages.some((m) => m.id === threadRoot)} focusBox={threadFocus} />
      </RoomSideColumn>
    )}
    </div>
  )
}

/** "복원": the chat is back at once (the banner goes, the box comes); a refusal puts it back in the trash with a toast */
function TrashedBanner({ chat, onShown }: { chat: Chat; onShown: (c: Chat) => void }) {
  const t = useT()
  const locale = useLocale()
  const purge = chatPurgeAt(chat.deletedAt!, chatTrashDays(useMeStrict()))
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">
      <Trash2 size={16} className="shrink-0" aria-hidden />
      <span className="flex-1">{t('chat.inTrash', { date: formatDate(purge, locale) })}</span>
      <Button size="sm" onClick={() => void trashChat(chat, false, { onShown })} data-testid="chat-trash-restore">
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

/** "This chat is no longer shared with you" (a chat someone shared with me that I was taken out of) and the way Home.
 * What I had typed in its box is not lost (QA TC-2032): the box's draft is kept per chat (lib/localData.ts), so it shows
 * here with Copy, to paste into a chat of my own. */
function NoLongerShared({ userId, chatId }: { userId: string; chatId: string }) {
  const t = useT()
  const [draft] = useState(() => fromWire(readDraft(userId, chatId)).text.trim())
  return (
    <div className="flex h-full flex-col justify-center" data-testid="chat-not-found" data-gone="shared">
      <EmptyState screen title={t('notifications.event.chat.sharedGone')}>
        {draft && (
          <div className="mx-auto mt-1 mb-3 w-full max-w-md text-left" data-testid="chat-gone-draft">
            <p className="mb-1.5 text-sm break-keep text-muted">{t('chat.goneDraft')}</p>
            <div className="rounded-xl border border-line bg-surface p-3">
              <p className="max-h-40 overflow-y-auto text-sm leading-6 break-words whitespace-pre-wrap text-ink" data-testid="chat-gone-draft-text">{draft}</p>
              <div className="mt-2 flex justify-end">
                <CopyButton text={draft} showLabel />
              </div>
            </div>
          </div>
        )}
        <Link to="/" className="mt-1 inline-block font-medium text-accent-text underline" data-testid="chat-gone-home">
          {t('notFound.home')}
        </Link>
      </EmptyState>
    </div>
  )
}

/** A shared chat link of a team project in the trash, opened by one of its members: the project is in the trash, who
 * moved it there, who can restore it, and its page (where its creator or an admin restores it). The project is read
 * as its card is (GET /api/projects/:id?manage=1: its name and state only); not readable any more: the plain answer. */
function ChatOfTrashedProject({ projectId }: { projectId: string }) {
  const t = useT()
  const [project, setProject] = useState<Project | null | false>(null)
  useEffect(() => {
    let live = true
    api.call(API.getProject, { params: { id: projectId }, query: { manage: '1' } }).then((p) => live && setProject(p.inTrash ? p : false), () => live && setProject(false))
    return () => { live = false }
  }, [projectId])
  const lines = useTrashLines(project || {})
  if (project === null) return <Skeleton lines={3} className="p-6" />
  return (
    <div className="flex h-full flex-col justify-center" data-testid="chat-not-found">
      <EmptyState screen title={project ? t('chat.projectInTrash', { name: project.name }) : t('chat.notFound')}>
        {project ? (
          <>
            {lines.moved && <p className="mb-1 break-keep" data-testid="chat-project-trashed-by">{lines.moved}</p>}
            <p className="mb-1 break-keep" data-testid="chat-project-trash-restores">{project.canRestore ? t('chat.projectInTrashYou') : lines.restores}</p>
            <Link to={`/projects/${project.id}`} className="mt-1 inline-block font-medium text-accent-text underline" data-testid="chat-project-open">
              {t('chat.openProject')}
            </Link>
          </>
        ) : (
          <p className="mb-1 break-keep" data-testid="chat-not-found-why">{t('chat.notFoundWhy')}</p>
        )}
      </EmptyState>
    </div>
  )
}

/** Settles 'updating' once the message sent with `clientMessageId` waits for Trina's update or for the connection to
 * come back (store/chats.ts deliver; it goes by itself then, so the box lets go of the text and a second send cannot
 * make it twice, QA TC-r2d-06); never while it was sent or refused before (`sent` ends the watch). */
function untilWaitingForUpdate(chatId: string, clientMessageId: string, sent: Promise<void>): Promise<'updating'> {
  return new Promise((resolve) => {
    const waits = (s: ReturnType<typeof useChats.getState>) => !!s.threads[chatId]?.messages.some((m) => m.local?.clientMessageId === clientMessageId && (m.local.updating || m.local.offline))
    if (waits(useChats.getState())) { resolve('updating'); return }
    const stop = useChats.subscribe((s) => { if (waits(s)) { stop(); resolve('updating') } })
    void sent.then(stop, stop)
  })
}
