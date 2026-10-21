// Team files on their way into a composer ("Ask AI about this" / "Add to current chat" on the file screen and in the
// file preview, drag from the file screen, the preview or a message). Only paths travel here; the composer attaches
// them through POST /api/attachments/team-file, where the server checks the person's access as for any attach.
// Also what a composer keeps while it is not on screen: its chips (per person and draft, so files can be collected
// one at a time from the file screen) and the chat a new-chat draft created for them. Attached chips and draft chats
// are also kept in this tab's sessionStorage (a reload keeps them; another tab or browser never sees them). Signing
// out forgets all of it.
import type { Attachment } from '@mycel/shared/api'

/** What a composer reports after attaching handed-over paths. */
export interface AttachResult { added: number; failed: number; error?: string }
type Listener = (paths: string[]) => Promise<AttachResult>

/** drag-and-drop type carrying a team-relative path (file screen / preview / message -> composer) */
export const TEAM_FILE_DRAG_TYPE = 'application/x-mycel-team-file'

const queued = new Map<string, { paths: string[]; done: ((r: AttachResult) => void)[] }>()
const mounted = new Map<string, Listener>()
const LAST_CHAT_KEY = 'mycel.lastChat'
let lastChat: { userId: string; chatId: string } | null = null

const session = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** Hand paths to the composer of `draftId` (a chat id, or "new"): now if it is on screen, else when it opens. */
export function sendToComposer(draftId: string, paths: string[]): Promise<AttachResult> {
  const live = mounted.get(draftId)
  if (live) return live(paths)
  return new Promise((done) => {
    const q = queued.get(draftId) ?? { paths: [], done: [] }
    q.paths.push(...paths)
    q.done.push(done)
    queued.set(draftId, q)
  })
}

/** A composer registers itself; paths queued for it are handed over right away. Returns the unregister function. */
export function registerComposer(draftId: string, fn: Listener): () => void {
  mounted.set(draftId, fn)
  const waiting = queued.get(draftId)
  if (waiting?.paths.length) {
    queued.delete(draftId)
    void fn(waiting.paths).then((r) => waiting.done.forEach((d) => d(r)))
  }
  return () => {
    if (mounted.get(draftId) === fn) mounted.delete(draftId)
  }
}

/** The composer on screen now (a chat, or a new-chat draft), else null. */
export function composerOnScreen(): string | null {
  for (const id of mounted.keys()) return id
  return null
}

/** The last chat the person had open (for "Add to current chat" from the file screen; kept for this tab). */
export function rememberChat(userId: string, chatId: string) {
  lastChat = { userId, chatId }
  try { session()?.setItem(LAST_CHAT_KEY, JSON.stringify(lastChat)) } catch { /* storage blocked */ }
}
function lastOpenChat(userId: string): string | null {
  if (!lastChat) {
    try {
      const v = JSON.parse(session()?.getItem(LAST_CHAT_KEY) ?? 'null')
      if (v && typeof v.userId === 'string' && typeof v.chatId === 'string') lastChat = v
    } catch { /* nothing kept */ }
  }
  return lastChat && lastChat.userId === userId ? lastChat.chatId : null
}

/** "Ask AI about this": a new chat with the files attached. */
export function askAiAbout(paths: string[], navigate: (to: string) => void): Promise<AttachResult> {
  const r = sendToComposer('new', paths)
  navigate('/')
  return r
}

/** Where "Add to current chat" goes: the composer on screen, else the last chat opened (null: nowhere). A draft id
 * ("new", "project:<id>") means a chat that is not created yet. */
export const currentChatTarget = (userId: string): string | null => composerOnScreen() ?? lastOpenChat(userId)

/** "Add to current chat": into the composer on screen, or into the last chat opened (which is then shown). Resolves
 * once the server has taken (or refused) the files; null when there is no chat to add to. */
export function addToCurrentChat(userId: string, paths: string[], navigate: (to: string) => void): Promise<AttachResult> | null {
  const here = composerOnScreen()
  if (here) return sendToComposer(here, paths)
  const chat = lastOpenChat(userId)
  if (!chat) return null
  const r = sendToComposer(chat, paths)
  navigate(`/c/${chat}`)
  return r
}

// ---------------- what a composer keeps while it is not on screen ----------------
const stashes = new Map<string, unknown[]>()
const draftChats = new Map<string, Promise<string>>()
const key = (userId: string, draftId: string) => `${userId}:${draftId}`
const CHIPS_PREFIX = 'mycel.chips:'
const DRAFT_CHAT_PREFIX = 'mycel.draftChat:'

/** An attached chip as kept across a reload (only finished ones: the server has the attachment). */
export interface SavedChip { id: string; source: 'upload' | 'team'; name: string; size: number | null; path?: string; attachment: Attachment }
export function saveChips(userId: string, draftId: string, chips: SavedChip[]) {
  try {
    if (chips.length) session()?.setItem(CHIPS_PREFIX + key(userId, draftId), JSON.stringify(chips))
    else session()?.removeItem(CHIPS_PREFIX + key(userId, draftId))
  } catch { /* storage full or blocked */ }
}
export function loadChips(userId: string, draftId: string): SavedChip[] {
  try {
    const v = JSON.parse(session()?.getItem(CHIPS_PREFIX + key(userId, draftId)) ?? '[]')
    return Array.isArray(v) ? v.filter((c) => c && typeof c.id === 'string' && c.attachment && typeof c.attachment.id === 'string') : []
  } catch {
    return []
  }
}

/** The chips a composer had for this draft (attached or still uploading), or []. */
export const readStash = <T>(userId: string, draftId: string): T[] => (stashes.get(key(userId, draftId)) as T[] | undefined) ?? []
export function writeStash<T>(userId: string, draftId: string, items: T[]) {
  if (items.length) stashes.set(key(userId, draftId), items)
  else stashes.delete(key(userId, draftId))
}
const stashSubs = new Map<string, (items: unknown[]) => void>()
/** Change one chip of a draft, on screen or not (an upload finishing after the person left the page and came back
 * goes to the composer showing that draft now). */
export function patchStash<T extends { id: string }>(userId: string, draftId: string, id: string, patch: Partial<T>) {
  const k = key(userId, draftId)
  const cur = stashes.get(k) as T[] | undefined
  if (!cur) return
  const next = cur.map((x) => (x.id === id ? { ...x, ...patch } : x))
  stashes.set(k, next)
  stashSubs.get(k)?.(next)
}
/** The composer showing a draft hears about patches to its chips. Returns the unsubscribe function. */
export function subscribeStash<T>(userId: string, draftId: string, fn: (items: T[]) => void): () => void {
  const k = key(userId, draftId)
  const f = fn as (items: unknown[]) => void
  stashSubs.set(k, f)
  return () => {
    if (stashSubs.get(k) === f) stashSubs.delete(k)
  }
}

/** The chat a new-chat draft created for its attachments (so chips kept for the draft are sent into that chat). */
export function draftChat(userId: string, draftId: string, create: () => Promise<string>): Promise<string> {
  const k = key(userId, draftId)
  let p = draftChatIfAny(userId, draftId)
  if (!p) {
    const made = create()
    p = made
    draftChats.set(k, made)
    made.then(
      (id) => {
        try { session()?.setItem(DRAFT_CHAT_PREFIX + k, id) } catch { /* storage blocked */ }
      },
      () => draftChats.get(k) === made && draftChats.delete(k),
    )
  }
  return p
}
export function draftChatIfAny(userId: string, draftId: string): Promise<string> | null {
  const k = key(userId, draftId)
  const have = draftChats.get(k)
  if (have) return have
  let id: string | null = null
  try { id = session()?.getItem(DRAFT_CHAT_PREFIX + k) ?? null } catch { /* storage blocked */ }
  if (!id) return null
  const p = Promise.resolve(id)
  draftChats.set(k, p)
  return p
}
export function forgetDraftChat(userId: string, draftId: string) {
  draftChats.delete(key(userId, draftId))
  try { session()?.removeItem(DRAFT_CHAT_PREFIX + key(userId, draftId)) } catch { /* storage blocked */ }
}

/** Sign-out: nothing of the previous person's drafts, chips or last chat stays for the next one in this tab. */
export function forgetTeamAttach() {
  queued.clear()
  stashes.clear()
  draftChats.clear()
  lastChat = null
  const s = session()
  try {
    const keys: string[] = []
    for (let i = 0; i < (s?.length ?? 0); i++) {
      const k = s!.key(i)
      if (k && (k === LAST_CHAT_KEY || k.startsWith(CHIPS_PREFIX) || k.startsWith(DRAFT_CHAT_PREFIX))) keys.push(k)
    }
    for (const k of keys) s!.removeItem(k)
  } catch { /* storage blocked */ }
}
