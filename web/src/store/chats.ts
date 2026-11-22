// Chats, the visible branch of each open chat, and everything the WebSocket says about them: streaming text, steps,
// queue position, ask_user / browser site / connect_service cards, artifacts being written. REST gives the state,
// events keep it current, and after a reconnect that the server could not resume (reset/resync) everything is
// reloaded from REST.
import { create } from 'zustand'
import { CARD_NEWS_ARTIFACT_KEY, DECK_ARTIFACT_KEY, PROMO_ARTIFACT_KEY, uuidv7, type Attachment, type Chat, type ChatQueueSnapshot, type EngineId, type Message, type ServerEvent, type ServerEventData, type TurnConnectBody, type TurnConnectResult, type TurnRequest, type TurnStarted } from '@mycel/shared/api'
import { api, API, ApiError, isNetworkError } from '../lib/api'
import { optimisticEdits, optimisticPending } from '../lib/optimistic'
import { waitForUpdate, waitsForUpdate } from '../lib/serverUpdating'
import { connectionDown, whenConnected } from '../lib/connectionWait'
import { readUnsentChat, writeUnsentChat, type KeptChatSend } from '../lib/unsentChats'
import { draftKey } from '../lib/localData'
import { useSession } from './session'
import { keepFaces } from '../lib/sharedChat'
import { browserTimeZone } from '../lib/time-zones'
import { applyCreated, applyDelta, applyDone, applyStep, emptyThread, markLocal, mergeFresh, mergeTurnStarted, optimisticUserMessage, prependPage, runningMessage, type Delta, type Thread } from './thread'

const PAGE = 50
/** Artifacts that are the whole answer of their skill: the panel opens them by itself once they are saved (the intro
 * deck, the promo video, the card news). */
const OPENS_BY_ITSELF = new Set<string>([DECK_ARTIFACT_KEY, PROMO_ARTIFACT_KEY, CARD_NEWS_ARTIFACT_KEY])
/** Keep retrying a send that failed on the network for this long (same clientMessageId: the server dedupes). */
export const SEND_RETRY_MS = 30_000

export interface LiveArtifact {
  key: string
  chatId: string
  messageId: string | null
  type: ServerEventData<'artifact.updated'>['type']
  title: string | null
  status: 'writing' | 'done'
  content: string
  artifactId: string | null
  version: number | null
}

/** An open card of a turn. `chatId`: the chat it shows in. */
export interface OpenRequest { turnId: string; chatId?: string; messageId: string; request: TurnRequest }
/** What a connect_service card's button sends (POST /api/turns/:id/connect) besides the card's id. A key only ever
 * goes sealed (lib/connectCard.ts): the store never holds one. */
export type ConnectAction = TurnConnectBody extends infer B ? (B extends unknown ? Omit<B, 'requestId'> : never) : never

type Pending = { deltas: Delta[]; steps: ServerEventData<'message.step'>[]; done: Message | null }

interface ChatsState {
  chats: Chat[]
  /** shared project chats on screen that are not in my list (I neither made them nor wrote in them: Chat.shared.mine is
   * false): kept up to date by chat.updated without being added to my history (docs/DECISIONS.md "Shared project
   * chats") */
  others: Record<string, Chat>
  chatsCursor: string | null
  chatsLoaded: boolean
  threads: Record<string, Thread>
  /** messageId -> estimated dispatch rank (1 = first queued, 0 = running), not turns ahead */
  queue: Record<string, number>
  /** messageId -> true while the AI provider is busy and the engine tries again (turn.busy, QA TC-388) */
  busy: Record<string, true>
  /** open ask_user / browser_site / dev_env_site / connect_service cards by requestId */
  requests: Record<string, OpenRequest>
  /** chatId -> key -> artifact being written or just saved */
  liveArtifacts: Record<string, Record<string, LiveArtifact>>
  /** bumped when a chat's saved artifacts changed (artifact panel / cards refetch) */
  artifactsRev: Record<string, number>
  /** artifact the panel should open by itself (the AI started writing one, or an intro deck, a promo video or a card news
   * was saved) */
  autoOpen: { chatId: string; key: string; at: number } | null
  /** chatId -> the answer whose intro deck build already opened the panel by itself (store/deckBuilds.ts): its saved
   * deck does not open it again (the person may have closed it meanwhile) */
  buildOpened: Record<string, string>

  loadChats: (reset?: boolean) => Promise<void>
  upsertChat: (c: Chat) => void
  removeChat: (id: string) => void
  loadThread: (chatId: string) => Promise<void>
  loadOlder: (chatId: string) => Promise<void>
  /** `sent`: settles when the server took the message (rejects with its reason when it was not sent in the end); the
   * message shows as "sending" meanwhile, so most callers need not wait for it */
  send: (o: SendInput) => Promise<{ chatId: string; sent: Promise<void> }>
  resend: (chatId: string, localId: string) => Promise<void>
  discardLocal: (chatId: string, localId: string) => void
  stop: (chatId: string) => Promise<void>
  regenerate: (chatId: string, assistantId: string, engine?: { engine?: EngineId; model?: string | null }) => Promise<void>
  edit: (chatId: string, userMessageId: string, content: string, attachments: Attachment[]) => Promise<void>
  selectBranch: (chatId: string, messageId: string) => Promise<void>
  answer: (requestId: string, body: { kind: 'ask_user'; answer: string | string[] | null } | { kind: 'browser_site' | 'dev_env_site'; decision: 'once' | 'always' | 'deny' }) => Promise<void>
  /** a connect_service card's button: the server's outcome (null: the card is no longer open here). A connected or
   * skipped card closes right away (the server also closes it with turn.request.closed). */
  connect: (requestId: string, body: ConnectAction) => Promise<TurnConnectResult | null>
  handleEvent: (ev: ServerEvent) => void
  reloadAll: () => Promise<void>
  reset: () => void
}

export interface SendInput {
  chatId: string | null
  content: string
  attachments: Attachment[]
  author: { id: string; name: string }
  projectId?: string | null
  engine?: EngineId
  model?: string | null
  /** messages that waited for an answer (store/sendQueue.ts): the same messages always go with the same id */
  clientMessageId?: string
  /** a chat shared with people: the people picked with "@" (ids) */
  mentions?: string[]
  /** the server still has an answer running in this chat (409): the message is taken back instead of "not sent" */
  onConflict?: (e: ApiError) => void
  /** answer under the newest end of the branch through the last message this page shows (SendMessageBody.after), not
   * that message itself (a shared chat's waiting messages: someone else's turn may have ended a moment ago and not be
   * read yet; a send under the older answer would make a branch) */
  atEnd?: boolean
  /** a new chat is a side chat of this room (✦ Trina, components/rooms/SideChatPanel.tsx) */
  sideRoomId?: string
  /** a new chat in a team project starts "Only me" (CreateChatBody.private; docs/DECISIONS.md "Team project chats
   * shared by default") */
  private?: boolean
}

/** Sends waiting for the network to come back: localId -> body. Kept on this device per chat as they change (keepUnsent,
 * lib/unsentChats.ts): a reload does not lose them. */
type OutboxJob = { chatId: string; clientMessageId: string; content: string; mentions?: string[]; attachments: Attachment[]; attachmentIds: string[]; parentId: string | undefined; after?: string; engine?: EngineId; model?: string | null; firstTry: number; onConflict?: (e: ApiError) => void; author: { id: string; name: string }; createdAt: string; failed?: { error?: string } }
const outbox = new Map<string, OutboxJob>()
/** clientMessageIds of sends this page saw end (sent, let go): never put back from the device, whatever another tab of
 * mine still keeps */
const goneHere = new Set<string>()
/** localIds of sends waiting for the connection to come back (Stop does not wait for them) */
const waitingOffline = new Set<string>()
/** chats whose kept sends this page has put back already (once per chat and session) */
const restoredUnsent = new Set<string>()
const myId = () => {
  const st = useSession.getState().status
  return st.kind === 'signed-in' ? st.me.user.id : null
}
/** This chat's sends on their way or not sent onto this device: this page's, and the ones another tab of mine kept that
 * this page has not seen end. */
function keepUnsent(chatId: string) {
  const me = myId()
  if (!me) return
  const mine: KeptChatSend[] = [...outbox.entries()].filter(([, j]) => j.chatId === chatId && j.author.id === me).map(([localId, j]) => ({
    localId, clientMessageId: j.clientMessageId, content: j.content, ...(j.mentions?.length ? { mentions: j.mentions } : {}), attachments: j.attachments.filter((a) => j.attachmentIds.includes(a.id)),
    ...(j.parentId ? { parentId: j.parentId } : {}), ...(j.after ? { after: j.after } : {}), ...(j.engine ? { engine: j.engine } : {}), ...(j.model !== undefined ? { model: j.model } : {}),
    author: j.author, createdAt: j.createdAt, ...(j.failed ? { failed: true as const, ...(j.failed.error ? { error: j.failed.error } : {}) } : {}),
  }))
  const ids = new Set(mine.map((p) => p.clientMessageId))
  const others = readUnsentChat(me, chatId).filter((p) => !ids.has(p.clientMessageId) && !goneHere.has(p.clientMessageId))
  writeUnsentChat(me, chatId, [...mine, ...others])
}
/** a send of this page ended (sent, let go, taken back to wait): gone from the device too */
function endSend(localId: string) {
  const job = outbox.get(localId)
  if (!job) return
  outbox.delete(localId)
  goneHere.add(job.clientMessageId)
  keepUnsent(job.chatId)
}
/** Another tab of mine changed a chat's kept sends (the window's "storage" event): a "not sent" bubble of this page whose
 * send is gone from there was let go or sent in that tab, and goes here too (one on its way stays: its own answer
 * decides). Nothing is ever sent from here. */
export function onChatUnsentElsewhere(key: string | null, value: string | null) {
  const me = myId()
  const head = draftKey(me ?? '', 'chatUnsent:')
  if (!me || !key?.startsWith(head)) return
  const chatId = key.slice(head.length)
  let there: Set<string>
  try {
    const v = JSON.parse(value || '[]') as unknown
    there = new Set(Array.isArray(v) ? v.map((p) => (p as { clientMessageId?: unknown })?.clientMessageId).filter((x): x is string => typeof x === 'string') : [])
  } catch { return }
  const gone = [...outbox.entries()].filter(([, j]) => j.chatId === chatId && j.failed && !there.has(j.clientMessageId)).map(([id]) => id)
  if (!gone.length) return
  for (const id of gone) {
    goneHere.add(outbox.get(id)!.clientMessageId)
    outbox.delete(id)
  }
  useChats.setState((s) => {
    const t = s.threads[chatId]
    return t ? { threads: { ...s.threads, [chatId]: { ...t, messages: t.messages.filter((m) => !gone.includes(m.id)) } } } : {}
  })
}

/** A send that waited (offline, or put back after a reload): the conversation may have gone on meanwhile, so it goes
 * under the newest end of the branch through the message it answered, not under that message (a new version). */
function goesAtEnd(job: OutboxJob) {
  if (!job.parentId) return
  job.after = job.parentId
  job.parentId = undefined
}
/**
 * Events for messages we don't know yet (they raced the POST answer). Bounded: a message that never shows up (another
 * branch, a lost response) must not keep its events forever; the oldest entries go first, and past the per-message
 * cap the thread is simply reloaded from REST when the message appears.
 */
const pending = new Map<string, Pending>()
/** localId -> the send of a message still on its way (settles either way when it ends): Stop waits for it, because the
 * server has no turn it could stop until the send returns one */
const delivering = new Map<string, { chatId: string; done: Promise<void> }>()
/**
 * chatId -> the reload of its messages that is running (one per chat at a time). Answer text, steps and new messages
 * that arrive meanwhile wait in `events` and are applied on top of the server's copy once it is in (overlap is cut by
 * offset, ws.ts); without that, each piece after the copy was read looked like a gap and started yet another reload.
 * `again`: newer data was asked for while it ran (a gap, a branch changed elsewhere, a reconnect), read once more.
 */
type Load = { promise: Promise<void>; events: ServerEvent[]; again: boolean }
const loads = new Map<string, Load>()
/** a chat shown on the branch of one answer, for this view only (a widening list item: /c/<id>?answer=<messageId>;
 * GET …/messages `through`): its reads ask for that branch until the page leaves or another branch is picked */
const throughs = new Map<string, string>()
/** Show `chatId` on the branch holding `answerId` (null: its active branch again). */
export function showThrough(chatId: string, answerId: string | null) {
  if (answerId) throughs.set(chatId, answerId)
  else throughs.delete(chatId)
}
const throughOf = (chatId: string) => { const id = throughs.get(chatId); return id ? { through: id } : {} }
/** This device's time zone, sent with every turn: the screen shows times in it, so the AI gives its times in it too
 * (QA TC-4549); the server uses the team's zone without it. */
const turnTimeZone = (): string | undefined => browserTimeZone() ?? undefined

/** chatId -> local changes of the visible branch (a send, regenerate or edit answered, a branch switch): a reload that
 * began before one is read again instead of used (it would take the new question and answer away) */
const changes = new Map<string, number>()
const changed = (chatId: string) => changes.set(chatId, (changes.get(chatId) ?? 0) + 1)
/** a reload asked for again and again (the server keeps changing the branch) gives up after this many reads */
const LOAD_ROUNDS = 3
/** a read that failed is tried once more after this long */
export const LOAD_RETRY_MS = 3000
/** chatId -> the retry waiting after a failed read (one per chat) */
const loadRetries = new Map<string, ReturnType<typeof setTimeout>>()
/** An answer still running on this page that nothing was heard about for this long is read again from the server: its
 * end may never have reached this page (QA TC-3521: an answer that failed at once stayed on "Thinking…", and Stop did
 * nothing). The wait doubles while the answer stays quiet and running, up to QUIET_CHECK_MAX_MS. */
export const QUIET_CHECK_MS = 20_000
export const QUIET_CHECK_MAX_MS = 120_000
/** messageId -> the read waiting for a quiet running answer (one per answer; `timer` null while that read runs) */
const quietChecks = new Map<string, { timer: ReturnType<typeof setTimeout> | null }>()
/** requests closed lately: a listTurnRequests answer computed before the close must not bring the card back */
const closedRequests = new Set<string>()
let generation = 0
let queueEpoch: string | null = null
const retiredEpochs = new Set<string>()
type QueueUpdate = Omit<ChatQueueSnapshot, 'epoch' | 'revision'> & { epoch?: string; revision?: number }
const queueVersions = new Map<string, QueueUpdate>()
const finishedMessages = new Set<string>()
const outputMessages = new Set<string>()
const remember = (set: Set<string>, id: string) => {
  set.add(id)
  if (set.size > 512) set.delete(set.values().next().value!)
}
const CLOSED_REQUESTS_MAX = 200
const rememberClosed = (id: string) => {
  closedRequests.add(id)
  if (closedRequests.size > CLOSED_REQUESTS_MAX) closedRequests.delete(closedRequests.values().next().value!)
}

/**
 * This chat's open cards after a listTurnRequests answer: the server's list, plus cards that arrived over the socket
 * while the request was on its way (not in `before`); cards closed meanwhile stay closed; other chats untouched.
 * `scope` is the chat's id, or which cards the list speaks for.
 */
export function mergeOpenRequests(current: Record<string, OpenRequest>, scope: string | ((r: OpenRequest) => boolean), open: OpenRequest[], before: ReadonlySet<string>): Record<string, OpenRequest> {
  const ours = typeof scope === 'string' ? (r: OpenRequest) => r.chatId === scope : scope
  const listed = new Set(open.map((r) => r.request.requestId))
  const next: Record<string, OpenRequest> = {}
  for (const [id, r] of Object.entries(current)) if (!ours(r) || listed.has(id) || !before.has(id)) next[id] = r
  for (const r of open) if (ours(r) && !closedRequests.has(r.request.requestId)) next[r.request.requestId] = r
  return next
}
export const PENDING_MESSAGES_MAX = 50
export const PENDING_EVENTS_MAX = 2000
const pendingOf = (id: string) => {
  let p = pending.get(id)
  if (!p) {
    pending.set(id, (p = { deltas: [], steps: [], done: null }))
    while (pending.size > PENDING_MESSAGES_MAX) pending.delete(pending.keys().next().value!)
  }
  return p
}
const pendingFull = (p: Pending) => p.deltas.length + p.steps.length >= PENDING_EVENTS_MAX
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const initial = () => ({
  chats: [] as Chat[],
  others: {} as Record<string, Chat>,
  chatsCursor: null as string | null,
  chatsLoaded: false,
  threads: {} as Record<string, Thread>,
  queue: {} as Record<string, number>,
  busy: {} as Record<string, true>,
  requests: {} as Record<string, OpenRequest>,
  liveArtifacts: {} as Record<string, Record<string, LiveArtifact>>,
  artifactsRev: {} as Record<string, number>,
  autoOpen: null as ChatsState['autoOpen'],
  buildOpened: {} as Record<string, string>,
})

/** Where the reader was in the chats left lately (pages/Chat.tsx, lib/stickToBottom.ts listPlace), the last left
 * last, with the chat's last message as it was then (`last`: chatEnd): going back to one puts the same message in the
 * same place while that is unchanged (an answer that went on or a new message meanwhile: at the bottom, with it in
 * sight). Only while the reader was part way up (at the bottom a chat opens at the bottom), in this window's memory
 * only, gone at sign-out with the chats. */
export interface ChatPlace { messageId: string; offset: number; last: string }
const chatPlaces = new Map<string, ChatPlace>()
export const CHAT_PLACES = 20
/** a chat's last message as it is now: which one, how long, how far */
export const chatEnd = (messages: readonly Pick<Message, 'id' | 'content' | 'status'>[]) => {
  const m = messages.at(-1)
  return m ? `${m.id}:${m.content.length}:${m.status}` : ''
}
export const chatPlace = (chatId: string) => chatPlaces.get(chatId) ?? null
export function keepChatPlace(chatId: string, place: ChatPlace | null) {
  chatPlaces.delete(chatId)
  if (!place) return
  chatPlaces.set(chatId, place)
  while (chatPlaces.size > CHAT_PLACES) chatPlaces.delete(chatPlaces.keys().next().value!)
}

/** A chat's fields that a change made here (lib/optimistic.ts, components/chat/chatActions.ts) sets, by its key's field */
const PENDING_FIELDS: Record<string, (keyof Chat)[]> = { pin: ['pinnedAt'], title: ['title'], engine: ['engine', 'model'], project: ['projectId', 'folderId'], folder: ['folderId'] }

/** A chat read or heard while a change of mine to it (a pin, its name, engine, project, folder) is still on its way: it
 * keeps that value on screen (the copy may be from before it; the change's own answer decides). */
function keepPending(s: Pick<ChatsState, 'chats' | 'others'>, c: Chat): Chat {
  const fields = Object.keys(PENDING_FIELDS).filter((f) => optimisticPending(`chat:${c.id}:${f}`))
  if (!fields.length) return c
  const now = s.chats.find((x) => x.id === c.id) ?? s.others[c.id]
  if (!now) return c
  const out: Record<string, unknown> = { ...c }
  for (const k of fields.flatMap((f) => PENDING_FIELDS[f]!)) {
    if (now[k] === undefined) delete out[k]
    else out[k] = now[k]
  }
  // a name, engine or project stamps the chat: the row stays where it went
  if (now.updatedAt > c.updatedAt && fields.some((f) => f !== 'pin' && f !== 'folder')) out.updatedAt = now.updatedAt
  return out as Chat
}

/** a delete or restore of mine of the chat is still on its way (what is on screen decides, not a read or an event) */
const trashPending = (id: string) => optimisticPending(`chat:${id}:trash`)
const isChatEdit = (key: string) => key.startsWith('chat:')

const sortChats = (list: Chat[]) => list.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))

export const useChats = create<ChatsState>((set, get) => {
  const thread = (chatId: string) => get().threads[chatId] ?? emptyThread()
  const setThread = (chatId: string, fn: (t: Thread) => Thread) =>
    set((s) => ({ threads: { ...s.threads, [chatId]: fn(s.threads[chatId] ?? emptyThread()) } }))

  /** Apply what arrived for a message before we knew it (event raced the POST response). */
  const flushPending = (chatId: string, ids: string[]) => {
    for (const id of ids) {
      const p = pending.get(id)
      if (!p) continue
      pending.delete(id)
      let msgs = thread(chatId).messages
      for (const d of p.deltas) {
        const r = applyDelta(msgs, d)
        if (r.kind === 'applied') msgs = r.messages
      }
      for (const st of p.steps) msgs = applyStep(msgs, st.messageId, st.step) ?? msgs
      if (p.done) msgs = applyDone(msgs, p.done) ?? msgs
      setThread(chatId, (t) => ({ ...t, messages: msgs }))
    }
  }

  /** replaying what came during a read that failed: a gap only marks the chat stale (the retry reads it) */
  let replayingFailed = false
  const markStale = (chatId: string) => {
    if (!get().threads[chatId]) return
    setThread(chatId, (t) => ({ ...t, stale: true }))
    if (!replayingFailed) load(chatId, true).catch(() => {})
  }

  /** One read of the thread from REST; false: a local change came in meanwhile, so its answer was not used. */
  const readThread = async (chatId: string): Promise<boolean> => {
    const session = generation, epoch = queueEpoch, change = changes.get(chatId) ?? 0
    // open ask_user / browser site cards come with the thread: after a reload or a resync the events that opened
    // them are not replayed, and the running turn would otherwise wait for an answer nobody can give
    const before = new Set(Object.keys(get().requests))
    const [page, open, queue] = await Promise.all([
      api.call(API.listMessages, { params: { id: chatId }, query: { limit: PAGE, ...throughOf(chatId) } }),
      api.call(API.listTurnRequests, { params: { id: chatId } }).catch(() => null),
      api.call(API.getChatQueue, { params: { id: chatId } }).catch(() => null),
    ])
    if (session !== generation) return true
    if ((changes.get(chatId) ?? 0) !== change) return false
    setThread(chatId, (t) => ({ messages: mergeFresh(t.messages, page.items), nextCursor: page.nextCursor, stale: false }))
    flushPending(chatId, page.items.map((m) => m.id))
    for (const m of thread(chatId).messages) if (m.role === 'assistant' && m.status !== 'streaming') { remember(finishedMessages, m.id); clearQueue(m.id); ended(m.id) }
    const live = runningMessage(thread(chatId).messages)
    if (live && !quietChecks.has(live.id)) heard(chatId, live.id)
    if (queue) acceptQueue(chatId, queue, epoch)
    if (open) set((s) => ({ requests: mergeOpenRequests(s.requests, chatId, open.items, before) }))
    return true
  }

  /** Reload a chat's messages, one reload per chat at a time; `fresh`: one already running is not new enough, so it
   * reads once more when it is done (a missed piece, a reconnect). */
  const load = (chatId: string, fresh: boolean, retry = true): Promise<void> => {
    const running = loads.get(chatId)
    if (running) {
      if (fresh) running.again = true
      return running.promise
    }
    const session = generation
    const l: Load = { promise: Promise.resolve(), events: [], again: false }
    loads.set(chatId, l)
    l.promise = (async () => {
      let failed = false
      try {
        for (let round = 0; ; round++) {
          l.again = false
          const used = await readThread(chatId)
          if (session !== generation || (used && !l.again) || round + 1 >= LOAD_ROUNDS) return
        }
      } catch (e) {
        failed = true
        throw e
      } finally {
        if (loads.get(chatId) === l) loads.delete(chatId)
        if (session === generation) {
          // what came over the socket meanwhile, on top of the server's copy (a piece still beyond it reloads again);
          // after a failed read nothing reads again for each of them: the chat is marked stale and read once more a
          // moment later (then the socket's next gap or a reconnect does)
          replayingFailed = failed
          try {
            for (const ev of l.events) get().handleEvent(ev)
          } finally {
            replayingFailed = false
          }
          // the sends this device kept for the chat come back, after the server's copy is in (or could not be read)
          restoreUnsent(chatId)
          if (failed && retry && get().threads[chatId]) {
            setThread(chatId, (t) => ({ ...t, stale: true }))
            if (!loadRetries.has(chatId)) loadRetries.set(chatId, setTimeout(() => {
              loadRetries.delete(chatId)
              if (session === generation && get().threads[chatId]?.stale) load(chatId, true, false).catch(() => {})
            }, LOAD_RETRY_MS))
          }
          // asked for again during the last round allowed: one more read of its own
          else if (!failed && l.again) load(chatId, false).catch(() => {})
        }
      }
    })()
    return l.promise
  }
  /** Events of a chat whose messages are being read: kept for after (true), or not (false). */
  const held = (chatId: string, ev: ServerEvent) => {
    const l = loads.get(chatId)
    if (!l) return false
    if (l.events.length < PENDING_EVENTS_MAX) l.events.push(ev)
    else l.again = true
    return true
  }

  /** Something was heard about a running answer (or it is on screen): read the chat again if nothing more is heard for
   * `wait` (QUIET_CHECK_MS). After that read an answer still running waits twice as long, up to QUIET_CHECK_MAX_MS. */
  const heard = (chatId: string, messageId: string, wait = QUIET_CHECK_MS) => {
    const prev = quietChecks.get(messageId)
    if (prev?.timer) clearTimeout(prev.timer)
    const session = generation
    const runningHere = () => !finishedMessages.has(messageId) && thread(chatId).messages.some((m) => m.id === messageId && m.status === 'streaming')
    const q: { timer: ReturnType<typeof setTimeout> | null } = { timer: null }
    quietChecks.set(messageId, q)
    q.timer = setTimeout(() => {
      q.timer = null
      if (session !== generation || !get().threads[chatId] || !runningHere()) { ended(messageId); return }
      load(chatId, true).catch(() => {}).finally(() => {
        // something heard meanwhile armed a new check (or the answer ended): that one stays
        if (session !== generation || quietChecks.get(messageId) !== q) return
        if (runningHere()) heard(chatId, messageId, Math.min(wait * 2, QUIET_CHECK_MAX_MS))
        else ended(messageId)
      })
    }, wait)
  }
  const ended = (messageId: string) => {
    const q = quietChecks.get(messageId)
    if (q?.timer) clearTimeout(q.timer)
    quietChecks.delete(messageId)
  }

  /** the busy line goes when the answer shows text or a step, or ends */
  const clearBusy = (messageId: string) => {
    if (!get().busy[messageId]) return
    set((s) => {
      const b = { ...s.busy }
      delete b[messageId]
      return { busy: b }
    })
  }

  const clearQueue = (messageId: string) => {
    if (get().queue[messageId] === undefined) return
    set((s) => {
      const q = { ...s.queue }
      delete q[messageId]
      return { queue: q }
    })
  }

  // Socket revisions and REST snapshots share one ordering. A response from before a new epoch or logout must
  // never resurrect a completed turn or overwrite the new server's queue.
  const acceptQueue = (chatId: string, next: QueueUpdate, requestEpoch?: string | null) => {
    if (next.epoch !== undefined && next.revision !== undefined) {
      if (retiredEpochs.has(next.epoch)) return false
      if (requestEpoch !== undefined && requestEpoch !== queueEpoch && next.epoch !== queueEpoch) return false
      if (queueEpoch !== next.epoch) {
        if (queueEpoch) { remember(retiredEpochs, queueEpoch) }
        queueEpoch = next.epoch
        queueVersions.clear()
        set({ queue: {} })
      }
    }
    const previous = queueVersions.get(chatId)
    if (previous?.epoch && (next.epoch === undefined || next.revision === undefined)) return false
    if (previous?.epoch === next.epoch && previous?.revision !== undefined && next.revision !== undefined && next.revision < previous.revision) return false
    queueVersions.set(chatId, next)
    const message = next.messageId ? thread(chatId).messages.find(m => m.id === next.messageId) : undefined
    const terminal = next.messageId && (finishedMessages.has(next.messageId) || message && message.status !== 'streaming')
    const output = next.messageId && outputMessages.has(next.messageId)
    set(s => {
      const queue = { ...s.queue }
      if (previous?.messageId) delete queue[previous.messageId]
      if (next.messageId) {
        delete queue[next.messageId]
        if (!terminal && !output && next.position !== null) queue[next.messageId] = next.position
      }
      const state = terminal ? 'idle' : output ? 'running' : next.state
      const other = s.others[chatId]
      return { queue, chats: s.chats.map(c => c.id === chatId ? { ...c, runState: state } : c), ...(other ? { others: { ...s.others, [chatId]: { ...other, runState: state } } } : {}) }
    })
    return true
  }

  const afterStarted = (chatId: string, started: TurnStarted, o: { replaceId?: string; cutAt?: string; keepPlace?: boolean }, requestEpoch: string | null) => {
    const existing = thread(chatId).messages.find(m => m.id === started.assistantMessage.id)
    if (existing && existing.status !== 'streaming') started = { ...started, assistantMessage: existing }
    else if (existing && started.assistantMessage.status === 'streaming') {
      const posted = started.assistantMessage
      const liveSteps = new Map(existing.steps.map(s => [s.id, s]))
      started = { ...started, assistantMessage: { ...posted,
        content: existing.content.length > posted.content.length && existing.content.startsWith(posted.content) ? existing.content : posted.content,
        steps: [...posted.steps.filter(s => !liveSteps.has(s.id)), ...existing.steps],
      } }
    }
    changed(chatId)
    // keepPlace: the server's copy is on screen already, in its place; only the bubble goes
    setThread(chatId, (t) => ({ ...t, messages: o.keepPlace ? t.messages.filter((m) => m.id !== o.replaceId) : mergeTurnStarted(t.messages, started, o) }))
    // text or steps that raced ahead of this response mean the turn is already running: no queue position
    const early = pending.get(started.assistantMessage.id)
    if (early?.done) remember(finishedMessages, started.assistantMessage.id)
    if (early?.deltas.length || early?.steps.length) remember(outputMessages, started.assistantMessage.id)
    flushPending(chatId, [started.assistantMessage.id, ...(started.userMessage ? [started.userMessage.id] : [])])
    if (!finishedMessages.has(started.assistantMessage.id)) heard(chatId, started.assistantMessage.id)
    acceptQueue(chatId, { state: started.queuePosition > 0 ? 'queued' : 'running', turnId: started.turnId,
      messageId: started.assistantMessage.id, position: started.queuePosition, epoch: started.queueEpoch, revision: started.queueRevision }, requestEpoch)
  }

  /** POST the message; on network failure retry with the same clientMessageId until SEND_RETRY_MS has passed. */
  const deliver = async (localId: string) => {
    const session = generation
    const job = outbox.get(localId)
    if (!job) return
    for (let attempt = 0; ; attempt++) {
      try {
        if (session !== generation || !outbox.has(localId)) return
        const epoch = queueEpoch
        const started = await api.call(API.sendMessage, {
          params: { id: job.chatId },
          body: { content: job.content, ...(job.mentions?.length ? { mentions: job.mentions } : {}), attachmentIds: job.attachmentIds, parentId: job.parentId, ...(job.after ? { after: job.after } : {}), engine: job.engine, model: job.model, clientMessageId: job.clientMessageId, timeZone: turnTimeZone() },
        })
        if (session !== generation) return
        endSend(localId)
        // a send put back after a reload that the server did get before (its answer was lost when the page went): the
        // server's copy is on screen already, in its place; only the bubble goes
        const shown = !!started.userMessage && thread(job.chatId).messages.some((m) => m.id === started.userMessage!.id && !m.local)
        afterStarted(job.chatId, started, { replaceId: localId, keepPlace: shown }, epoch)
        return
      } catch (e) {
        if (session !== generation) return
        // Trina is updating (lib/serverUpdating.ts): the message stays "sending" with a note and goes once the server
        // is back, with the same clientMessageId (the server keeps the first one; the update's stand-in kept none)
        if (waitsForUpdate(e)) {
          setThread(job.chatId, (t) => ({ ...t, messages: markLocal(t.messages, localId, 'sending', undefined, true) }))
          await waitForUpdate()
          if (session !== generation || !outbox.has(localId)) return
          setThread(job.chatId, (t) => ({ ...t, messages: markLocal(t.messages, localId, 'sending') }))
          job.firstTry = Date.now()
          attempt = -1
          continue
        }
        // offline (QA TC-r2d-06): it stays "sending", however long, and goes once the connection is back; only a
        // connection that is back and still fails for SEND_RETRY_MS turns it into "not sent"
        if (isNetworkError(e) && connectionDown()) {
          goesAtEnd(job)
          keepUnsent(job.chatId)
          waitingOffline.add(localId)
          // marked on the message: a shared chat's box lets go of the text now (pages/Chat.tsx), as while Trina updates
          setThread(job.chatId, (t) => ({ ...t, messages: markLocal(t.messages, localId, 'sending', undefined, undefined, undefined, true) }))
          try { await whenConnected() } finally { waitingOffline.delete(localId) }
          if (session !== generation || !outbox.has(localId)) return
          setThread(job.chatId, (t) => ({ ...t, messages: markLocal(t.messages, localId, 'sending') }))
          job.firstTry = Date.now()
          attempt = -1
          continue
        }
        if (isNetworkError(e) && Date.now() - job.firstTry < SEND_RETRY_MS) {
          await sleep(Math.min(8000, 1000 * 2 ** attempt))
          continue
        }
        // waiting messages sent the moment an answer ended, while another one already runs (another window or device
        // started it): they go back to waiting, nothing is lost and nothing shows as failed
        if (job.onConflict && e instanceof ApiError && e.code === 'conflict') {
          endSend(localId)
          setThread(job.chatId, (t) => ({ ...t, messages: t.messages.filter((m) => m.id !== localId) }))
          job.onConflict(e)
          return
        }
        // team files the person attached but can no longer open: the message is marked "not sent" with the reason,
        // those files show as unavailable, and "send again" sends it without them
        const gone = e instanceof ApiError && e.body.params?.reason === 'team_files_unavailable' ? new Set(String(e.body.params.ids ?? '').split(',').filter(Boolean)) : null
        if (gone?.size) {
          job.attachmentIds = job.attachmentIds.filter((id) => !gone.has(id))
          setThread(job.chatId, (t) => ({
            ...t,
            messages: t.messages.map((m) => (m.id === localId ? { ...m, attachments: m.attachments.map((a) => (gone.has(a.id) ? { id: a.id, name: '', path: '', size: 0, mime: 'application/octet-stream', kind: 'other' as const, source: 'team' as const, unavailable: true } : a)) } : m)),
          }))
        }
        // the server's reason is already in the person's words (budget used up, attachment gone, …); a network
        // failure has only the browser's English text, so the screen says "not sent" without it
        setThread(job.chatId, (t) => ({ ...t, messages: markLocal(t.messages, localId, 'failed', e instanceof ApiError ? e.message : undefined, undefined, e instanceof ApiError && e.code === 'budget_exceeded') }))
        job.failed = e instanceof ApiError ? { error: e.message } : {}
        keepUnsent(job.chatId)
        throw e
      }
    }
  }

  /** deliver, and remember it as on its way until it ends (Stop waits for it) */
  const deliverTracked = (localId: string) => {
    const job = outbox.get(localId)
    const sent = deliver(localId)
    if (job) {
      const done = sent.then(() => {}, () => {})
      delivering.set(localId, { chatId: job.chatId, done })
      void done.then(() => { if (delivering.get(localId)?.done === done) delivering.delete(localId) })
    }
    return sent
  }

  /** The chat's sends this device kept (a reload, the app closed while offline) back on screen, once per chat: the ones
   * on their way go again (the same clientMessageId: one the server did get comes back as that message, never a second
   * one), the ones that did not go show "not sent [send again]". */
  const restoreUnsent = (chatId: string) => {
    const me = myId()
    if (!me || restoredUnsent.has(chatId) || !get().threads[chatId]) return
    restoredUnsent.add(chatId)
    const kept = readUnsentChat(me, chatId)
    if (!kept.length) return
    const have = new Set([...outbox.values()].map((j) => j.clientMessageId))
    const shown = thread(chatId).messages
    const back: string[] = []
    for (const p of kept) {
      if (have.has(p.clientMessageId) || goneHere.has(p.clientMessageId) || shown.some((m) => m.id === p.localId)) continue
      const job: OutboxJob = { chatId, clientMessageId: p.clientMessageId, content: p.content, ...(p.mentions?.length ? { mentions: p.mentions } : {}), attachments: p.attachments, attachmentIds: p.attachments.map((a) => a.id), parentId: p.parentId, after: p.after, engine: p.engine, model: p.model, firstTry: Date.now(), author: p.author, createdAt: p.createdAt, ...(p.failed ? { failed: { error: p.error } } : {}) }
      goesAtEnd(job)
      outbox.set(p.localId, job)
      const msg = optimisticUserMessage({ id: p.localId, chatId, parentId: null, content: p.content, author: p.author, attachments: p.attachments, clientMessageId: p.clientMessageId, now: p.createdAt })
      setThread(chatId, (t) => ({ ...t, messages: markLocal([...t.messages, msg], p.localId, p.failed ? 'failed' : 'sending', p.error) }))
      if (!p.failed) back.push(p.localId)
    }
    keepUnsent(chatId)
    for (const localId of back) deliverTracked(localId).catch(() => {})
  }

  return {
    ...initial(),

    reset: () => {
      generation++
      queueEpoch = null
      retiredEpochs.clear()
      queueVersions.clear()
      finishedMessages.clear()
      outputMessages.clear()
      outbox.clear()
      goneHere.clear()
      restoredUnsent.clear()
      waitingOffline.clear()
      pending.clear()
      delivering.clear()
      loads.clear()
      changes.clear()
      for (const t of loadRetries.values()) clearTimeout(t)
      loadRetries.clear()
      for (const q of quietChecks.values()) if (q.timer) clearTimeout(q.timer)
      quietChecks.clear()
      closedRequests.clear()
      chatPlaces.clear()
      set(initial())
    },

    async loadChats(reset = true) {
      const session = generation
      const cursor = reset ? undefined : get().chatsCursor ?? undefined
      if (!reset && !cursor) return
      const edits = optimisticEdits(isChatEdit)
      const page = await api.call(API.listChats, { query: { limit: PAGE, cursor } })
      if (session !== generation) return
      // a change of a chat made here while it was asked (lib/optimistic.ts): the page may be from before it, ask again
      if (edits !== optimisticEdits(isChatEdit)) return get().loadChats(reset)
      set((s) => {
        // a chat going to the trash or coming back from it stays as it is on screen
        const items = page.items.filter((c) => !trashPending(c.id) || s.chats.some((x) => x.id === c.id)).map((c) => keepPending(s, c))
        const kept = reset ? s.chats.filter((c) => trashPending(c.id) && !items.some((x) => x.id === c.id)) : []
        const merged = reset ? (kept.length ? sortChats([...items, ...kept]) : items) : [...s.chats, ...items.filter((c) => !s.chats.some((x) => x.id === c.id))]
        return { chats: merged, chatsCursor: page.nextCursor, chatsLoaded: true }
      })
      // the shared chats with messages I have not read that are in no list of mine (a project's shared chat I never
      // wrote in): kept with `others`, so the Projects mark and the app icon count them after a reload too. Older
      // servers refuse the query: nothing changes
      if (reset) void api.call(API.listChats, { query: { unread: '1' } }).then((u) => {
        if (session !== generation) return
        set((s) => {
          const add = u.items.filter((c) => !s.chats.some((x) => x.id === c.id))
          return add.length ? { others: { ...s.others, ...Object.fromEntries(add.map((c) => [c.id, keepPending(s, c)])) } } : s
        })
      }, () => {})
    },

    upsertChat(next) {
      set((s) => {
        // a single chat or an action's answer has no faces: the row keeps the ones its list gave it
        const c = keepFaces(s.chats.find((x) => x.id === next.id) ?? s.others[next.id], next)
        // someone else's shared chat that I have not written in is not mine to list: it is kept only while a screen
        // shows it (its thread is open), so its header and composer follow along, or while it has messages I have not
        // read (a project's shared chat: the Projects mark, the app icon and the desktop notice read them here)
        if (c.shared && !c.shared.mine && !s.chats.some((x) => x.id === c.id)) return s.threads[c.id] || s.others[c.id] || c.unreadCount ? { others: { ...s.others, [c.id]: c } } : s
        const others = c.id in s.others ? Object.fromEntries(Object.entries(s.others).filter(([id]) => id !== c.id)) : s.others
        return { chats: sortChats([c, ...s.chats.filter((x) => x.id !== c.id)]), others }
      })
    },

    removeChat(id) {
      const active = queueVersions.get(id)
      if (active?.messageId) { remember(finishedMessages, active.messageId); clearQueue(active.messageId) }
      queueVersions.delete(id)
      set((s) => ({ chats: s.chats.filter((c) => c.id !== id), others: id in s.others ? Object.fromEntries(Object.entries(s.others).filter(([k]) => k !== id)) : s.others }))
    },

    // a caller reads because something changed (another person's turn started or ended): a read already on its way
    // may be older than that, so it reads once more after it
    loadThread(chatId) {
      return load(chatId, true)
    },

    async loadOlder(chatId) {
      const session = generation
      const cur = thread(chatId)
      if (!cur.nextCursor) return
      const page = await api.call(API.listMessages, { params: { id: chatId }, query: { limit: PAGE, cursor: cur.nextCursor, ...throughOf(chatId) } })
      if (session !== generation) return
      setThread(chatId, (t) => ({ ...t, messages: prependPage(t.messages, page.items), nextCursor: page.nextCursor }))
    },

    async send(o) {
      const session = generation
      let chatId = o.chatId
      if (!chatId) {
        const chat = await api.call(API.createChat, { body: { projectId: o.projectId ?? null, engine: o.engine, model: o.model ?? undefined, ...(o.sideRoomId ? { sideRoomId: o.sideRoomId } : {}), ...(o.private ? { private: true } : {}) } })
        if (session !== generation) throw new Error('Session changed while creating the chat')
        get().upsertChat(chat)
        chatId = chat.id
        setThread(chatId, () => ({ ...emptyThread() }))
      }
      const t = thread(chatId)
      // answer under the last message we show; when nothing is loaded yet (a chat opened a moment ago), leave it to the
      // server's active leaf — null would start a new conversation at the root
      const last = t.messages.filter((m) => !m.local).at(-1)
      const localId = uuidv7()
      const clientMessageId = o.clientMessageId ?? uuidv7()
      const msg = optimisticUserMessage({ id: localId, chatId, parentId: last?.id ?? null, content: o.content, author: o.author, attachments: o.attachments, clientMessageId, now: new Date().toISOString() })
      setThread(chatId, (th) => ({ ...th, messages: [...th.messages, msg] }))
      outbox.set(localId, { chatId, clientMessageId, content: o.content, ...(o.mentions?.length ? { mentions: o.mentions } : {}), attachments: o.attachments, attachmentIds: o.attachments.map((a) => a.id), parentId: o.atEnd ? undefined : last?.id, ...(o.atEnd && last ? { after: last.id } : {}), engine: o.engine, model: o.model, firstTry: Date.now(), onConflict: o.onConflict, author: o.author, createdAt: msg.createdAt })
      keepUnsent(chatId)
      // the message shows as "sending" right away; a failure turns it into "not sent [send again]"
      const sent = deliverTracked(localId)
      sent.catch(() => {})
      return { chatId, sent }
    },

    async resend(chatId, localId) {
      const job = outbox.get(localId)
      if (!job) return
      job.firstTry = Date.now()
      job.failed = undefined
      keepUnsent(chatId)
      setThread(chatId, (t) => ({ ...t, messages: markLocal(t.messages, localId, 'sending') }))
      await deliverTracked(localId).catch(() => {})
    },

    discardLocal(chatId, localId) {
      endSend(localId)
      setThread(chatId, (t) => ({ ...t, messages: t.messages.filter((m) => m.id !== localId) }))
    },

    async stop(chatId) {
      // Stop pressed while the message is still on its way: the server has no turn yet, so a stop now would find
      // nothing and the answer would start anyway. Wait until the send returns its turn (or fails), then stop it.
      // (a send started after this press is not waited for: the box holds new messages while an answer runs)
      const session = generation
      // (one waiting for the connection to come back is not waited for: the stop goes now)
      const sending = [...delivering.entries()].filter(([id, d]) => d.chatId === chatId && !waitingOffline.has(id)).map(([, d]) => d.done)
      if (sending.length) {
        await Promise.all(sending)
        if (session !== generation) return
      }
      const r = await api.call(API.stop, { params: { id: chatId } })
      // nothing was running there: the answer on screen ended already and its end never reached this page (QA TC-3521:
      // Stop did nothing while "Thinking…" stayed). Read the chat again, so it shows how the answer ended
      if (!r.stopped && session === generation && runningMessage(thread(chatId).messages)) await load(chatId, true).catch(() => {})
    },

    async regenerate(chatId, assistantId, engine) {
      const session = generation, epoch = queueEpoch
      const started = await api.call(API.regenerate, { params: { id: chatId, messageId: assistantId }, body: { engine: engine?.engine, model: engine?.model, timeZone: turnTimeZone() } })
      if (session === generation) afterStarted(chatId, started, { cutAt: assistantId }, epoch)
    },

    async edit(chatId, userMessageId, content, attachments) {
      const session = generation, epoch = queueEpoch
      // a team file that is no longer available stays out of the edited copy (the server would refuse it)
      const started = await api.call(API.editMessage, { params: { id: chatId, messageId: userMessageId }, body: { content, attachmentIds: attachments.filter((a) => !a.unavailable).map((a) => a.id), clientMessageId: uuidv7(), timeZone: turnTimeZone() } })
      if (session === generation) afterStarted(chatId, started, { cutAt: userMessageId }, epoch)
    },

    async selectBranch(chatId, messageId) {
      throughs.delete(chatId)
      const session = generation
      const page = await api.call(API.selectBranch, { params: { id: chatId }, body: { messageId } })
      if (session !== generation) return
      changed(chatId)
      setThread(chatId, () => ({ messages: page.items, nextCursor: page.nextCursor, stale: false }))
    },

    async answer(requestId, body) {
      const session = generation
      const r = get().requests[requestId]
      if (!r) return
      await api.call(API.answerTurn, { params: { id: r.turnId }, body: { ...body, requestId } as never })
      if (session !== generation) return
      set((s) => {
        const next = { ...s.requests }
        delete next[requestId]
        return { requests: next }
      })
    },

    async connect(requestId, body) {
      const session = generation
      const r = get().requests[requestId]
      if (!r || r.request.kind !== 'connect_service') return null
      const res = await api.call(API.connectTurn, { params: { id: r.turnId }, body: { ...body, requestId } })
      if (session === generation && (res.state === 'connected' || res.state === 'skipped')) {
        rememberClosed(requestId)
        set((s) => {
          const next = { ...s.requests }
          delete next[requestId]
          return { requests: next }
        })
      }
      return res
    },

    async reloadAll() {
      const open = Object.keys(get().threads)
      await Promise.allSettled([get().loadChats(true), ...open.map((id) => load(id, true))])
    },

    handleEvent(ev) {
      switch (ev.type) {
        case 'message.created': {
          const { chatId, message } = ev.data
          if (held(chatId, ev) || !get().threads[chatId]) return
          const r = applyCreated(thread(chatId).messages, message)
          if (r === 'stale') markStale(chatId)
          else {
            setThread(chatId, (t) => ({ ...t, messages: r }))
            flushPending(chatId, [message.id])
            if (message.role === 'assistant' && message.status === 'streaming' && !finishedMessages.has(message.id)) heard(chatId, message.id)
          }
          return
        }
        case 'message.delta': {
          const { chatId, messageId, offset, text, reset } = ev.data
          const d = { messageId, offset, text, ...(reset ? { reset } : {}) }
          clearQueue(messageId)
          if (text) clearBusy(messageId)
          remember(outputMessages, messageId)
          if (get().threads[chatId] && quietChecks.has(messageId)) heard(chatId, messageId)
          if (held(chatId, ev) || !get().threads[chatId]) return
          const r = applyDelta(thread(chatId).messages, d)
          if (r.kind === 'applied') setThread(chatId, (t) => ({ ...t, messages: r.messages }))
          else if (r.kind === 'unknown') {
            const p = pendingOf(messageId)
            if (pendingFull(p)) {
              pending.delete(messageId)
              markStale(chatId)
            } else p.deltas.push(d)
          }
          else if (r.kind === 'gap') markStale(chatId)
          return
        }
        case 'message.step': {
          const { chatId, messageId, step } = ev.data
          clearQueue(messageId)
          clearBusy(messageId)
          remember(outputMessages, messageId)
          if (get().threads[chatId] && quietChecks.has(messageId)) heard(chatId, messageId)
          if (held(chatId, ev) || !get().threads[chatId]) return
          const r = applyStep(thread(chatId).messages, messageId, step)
          if (r) setThread(chatId, (t) => ({ ...t, messages: r }))
          else {
            const p = pendingOf(messageId)
            if (pendingFull(p)) {
              pending.delete(messageId)
              markStale(chatId)
            } else p.steps.push(ev.data)
          }
          return
        }
        case 'message.attachments': {
          // the AI attached a file to a running answer (a chat shared with people): its tiles show at once; a message not
          // loaded here gets them with message.done or the next load
          const { chatId, messageId, attachments } = ev.data
          if (held(chatId, ev) || !get().threads[chatId]) return
          const msgs = thread(chatId).messages
          if (!msgs.some((x) => x.id === messageId)) return
          setThread(chatId, (t) => ({ ...t, messages: t.messages.map((x) => (x.id === messageId ? { ...x, attachments } : x)) }))
          return
        }
        case 'message.done': {
          const { chatId, message } = ev.data
          clearQueue(message.id)
          clearBusy(message.id)
          remember(finishedMessages, message.id)
          ended(message.id)
          set((s) => ({ artifactsRev: { ...s.artifactsRev, [chatId]: (s.artifactsRev[chatId] ?? 0) + 1 } }))
          if (!get().threads[chatId]) { pendingOf(message.id).done = message; return }
          const r = applyDone(thread(chatId).messages, message)
          if (r) setThread(chatId, (t) => ({ ...t, messages: r }))
          else pendingOf(message.id).done = message
          return
        }
        case 'turn.busy': {
          const { messageId, busy } = ev.data
          // a late frame for an answer that already ended is ignored; an answer with text or steps can be busy again (the
          // next request after a tool step), and the server says busy: false before that request's text
          if (!busy || finishedMessages.has(messageId)) clearBusy(messageId)
          else if (!get().busy[messageId]) set((s) => ({ busy: { ...s.busy, [messageId]: true } }))
          return
        }
        case 'queue.position':
          acceptQueue(ev.data.chatId, { ...ev.data, state: ev.data.position > 0 ? 'queued' : 'running' })
          return
        case 'chat.updated': {
          const { chatId, change, chat } = ev.data
          // my delete or restore of it on its way: its answer decides (an event from before it would undo it on screen)
          if (trashPending(chatId)) return
          // a chat in the trash is in no list, also when the end of a turn there tells about it after the delete
          if (change === 'deleted' || change === 'purged' || chat?.deletedAt) get().removeChat(chatId)
          else if (chat) get().upsertChat(keepPending(get(), chat))
          return
        }
        case 'turn.request': {
          const { turnId, chatId, messageId, request } = ev.data
          set((s) => ({ requests: { ...s.requests, [request.requestId]: { turnId, chatId, messageId, request } } }))
          return
        }
        case 'turn.request.closed':
          rememberClosed(ev.data.requestId)
          set((s) => {
            const next = { ...s.requests }
            delete next[ev.data.requestId]
            return { requests: next }
          })
          return
        case 'artifact.updated': {
          const d = ev.data
          const prev = get().liveArtifacts[d.chatId]?.[d.key]
          const live: LiveArtifact = {
            key: d.key,
            chatId: d.chatId,
            messageId: d.messageId,
            type: d.type,
            title: d.title,
            status: d.status,
            content: d.content ?? prev?.content ?? '',
            artifactId: d.artifact?.id ?? prev?.artifactId ?? null,
            version: d.artifact?.version ?? prev?.version ?? null,
          }
          set((s) => ({
            liveArtifacts: { ...s.liveArtifacts, [d.chatId]: { ...(s.liveArtifacts[d.chatId] ?? {}), [d.key]: live } },
            artifactsRev: d.status === 'done' ? { ...s.artifactsRev, [d.chatId]: (s.artifactsRev[d.chatId] ?? 0) + 1 } : s.artifactsRev,
            // the panel opens by itself when the AI starts writing (Claude parity). The team server sends no "writing"
            // previews yet, only the saved artifact: an intro deck, a promo video or a card news opens when it is saved,
            // since it is the whole answer (the welcome steps' first result and every later run, docs/DECISIONS.md "W2",
            // "V", "D2")
            // ("D2" round 2: an intro deck whose build opened the panel already does not open it again when it is saved)
            autoOpen: !prev && (d.status === 'writing' || (OPENS_BY_ITSELF.has(d.key) && !(d.key === DECK_ARTIFACT_KEY && d.messageId && s.buildOpened[d.chatId] === d.messageId))) ? { chatId: d.chatId, key: d.key, at: Date.now() } : s.autoOpen,
          }))
          return
        }
        default:
          return
      }
    },
  }
})

/** The AI provider is busy for this answer and the engine tries again (turn.busy, QA TC-388). */
export const useProviderBusy = (messageId: string | undefined) => useChats((s) => (messageId ? !!s.busy[messageId] : false))
/** Queue position of a message, or undefined when not queued. */
export const useQueuePosition = (messageId: string | undefined) => useChats((s) => (messageId ? s.queue[messageId] : undefined))

// another tab of mine changed what this device keeps of a chat's sends
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => onChatUnsentElsewhere(e.key, e.newValue))
}
