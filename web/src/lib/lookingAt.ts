// What this window shows now, told to the server for the AI's looking_at tool (shared/src/api/ws.ts `looking`;
// server/src/realtime/looking.ts; docs/decisions/20261116-ai-screen-and-shared-tools.md). So "summarise this file" or
// "reply in that thread" needs no guess, and nothing about the screen rides on every message.
//
// - lookingOf: the frame for an address and the side panel. The screen's name and ids only (a chat, a room and its
//   thread, a project, a team file's path, a file link's id): never a title or text. An id of the wrong shape is left
//   out (the server would refuse the whole frame).
// - A confidential chat on the screen: `screen: null`, and the server forgets what this window told before.
// - LookingSender: one frame per change, at most one every LOOKING_EVERY_MS (the last state wins), the same state never
//   twice, and the current state once more after each reconnect (the server drops a window's state with its socket).
//   A window where nothing changes sends nothing: no timer runs while it is idle.
// - One place reports (components/LookingReporter.tsx, in the layout).
import { isUuid7 } from '@mycel/shared'
import { LOOKING_EVERY_MS, LOOKING_PATH_MAX, type LookingFrame, type LookingScreen } from '@mycel/shared/api'
import type { SidePanel } from './sidePanel'

export type Looking = Omit<LookingFrame, 'type'>
export const NOTHING: Looking = { screen: null }

const LINK_ID = /^[A-Za-z0-9_-]{22}$/
const seg = (s: string | undefined) => { try { return s ? decodeURIComponent(s) : '' } catch { return '' } }

/** What an address and the side panel show. `confidential`: the chat on the screen is confidential (or not known yet). */
export function lookingOf(pathname: string, search: string, panel: SidePanel | null, confidential = false): Looking {
  if (confidential) return NOTHING
  const p = pathname.split('/').filter(Boolean).map(seg)
  const q = new URLSearchParams(search)
  let screen: LookingScreen = 'other'
  const ids: { chatId?: string; projectId?: string; roomId?: string; threadRootId?: string; filePath?: string; linkId?: string } = {}
  const path = (v: string | null | undefined) => { if (v && v.length <= LOOKING_PATH_MAX) ids.filePath = v }
  const project = (v: string | null | undefined) => { if (v && v.length <= 64) ids.projectId = v }
  if (!p.length || p[0] === 'new') {
    screen = 'home'
    project(q.get('project'))
  } else if (p[0] === 'c') {
    screen = 'chat'
    if (isUuid7(p[1])) {
      ids.chatId = p[1]
      // an answer's thread beside the chat (/c/<chat>/t/<answer>): the AI's answer_comments puts it first
      if (p[2] === 't' && isUuid7(p[3])) ids.threadRootId = p[3]
    }
  } else if (p[0] === 'rooms') {
    screen = p[1] ? 'room' : 'rooms'
    if (isUuid7(p[1])) {
      ids.roomId = p[1]
      if (p[2] === 't' && isUuid7(p[3])) ids.threadRootId = p[3]
    }
  } else if (p[0] === 'files') {
    if (p[1] === 'view') { screen = 'file'; path(q.get('path')) }
    else screen = q.get('view') === 'shared' ? 'shared_files' : 'files'
  } else if (p[0] === 'f') {
    if (p[1] === 'batch') screen = 'shared_files'
    else { screen = 'shared_file'; if (p[1] && LINK_ID.test(p[1])) ids.linkId = p[1] }
  } else if (p[0] === 'projects') {
    screen = p[1] ? 'project' : 'projects'
    project(p[1])
  } else if (p[0] === 'activity' || p[0] === 'skills' || p[0] === 'scheduled' || p[0] === 'trash' || p[0] === 'admin' || p[0] === 'settings') screen = p[0]
  // a team file open in the panel beside the page (a file the page itself shows wins)
  if (!ids.filePath && panel?.kind === 'file' && panel.file.source === 'team') path(panel.file.path)
  return { screen, ...ids }
}

const keyOf = (l: Looking) => JSON.stringify([l.screen, l.chatId ?? null, l.projectId ?? null, l.roomId ?? null, l.threadRootId ?? null, l.filePath ?? null, l.linkId ?? null])

export interface LookingTimers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void; now(): number }
const realTimers: LookingTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>), now: () => Date.now() }

export class LookingSender {
  private want: Looking | null = null
  private sentKey: string | null = null
  private sentAt = -Infinity
  private timer: unknown = null
  constructor(private send: (f: LookingFrame) => boolean | void, private t: LookingTimers = realTimers) {}

  /** The screen changed (or is the same: then nothing goes). */
  report(l: Looking) {
    this.want = l
    this.flush()
  }

  /** The socket is open again: the server knows nothing of this window, so the current state goes once more. */
  connected() {
    this.sentKey = null
    this.flush()
  }

  /** Signed out or stopped: nothing is kept and no timer runs. */
  reset() {
    if (this.timer !== null) this.t.clearTimeout(this.timer)
    this.timer = null
    this.want = null
    this.sentKey = null
    this.sentAt = -Infinity
  }

  private flush() {
    if (!this.want || keyOf(this.want) === this.sentKey) return
    if (this.timer !== null) return // the waiting send takes the newest state
    const wait = this.sentAt + LOOKING_EVERY_MS - this.t.now()
    if (wait > 0) {
      this.timer = this.t.setTimeout(() => { this.timer = null; this.flush() }, wait)
      return
    }
    const l = this.want
    // not sent (no connection now): tried again after the next hello, never queued
    if (this.send({ type: 'looking', ...l }) === false) return
    this.sentKey = keyOf(l)
    this.sentAt = this.t.now()
  }
}

let sender: LookingSender | null = null
/** Where this window's `looking` frames go (store/live.ts: the socket; false when it is not open). null: nowhere. */
export function setLookingOut(send: ((f: LookingFrame) => boolean | void) | null) {
  sender?.reset()
  sender = send ? new LookingSender(send) : null
  if (sender && last) sender.report(last)
}
let last: Looking | null = null
/** The layout's one report of what is on the screen. */
export function reportLooking(l: Looking) {
  last = l
  sender?.report(l)
}
/** After each hello (store/live.ts). */
export const lookingConnected = () => sender?.connected()
