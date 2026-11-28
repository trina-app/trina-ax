// The one API client of the web app: same-origin (served by the team server), cookie session, CSRF + window headers
// added by ApiClient. Every call goes through the shared contract (`API.x`), so request and response shapes are the
// server's own zod schemas.
import { API, ApiClient, ApiError, ERROR_MESSAGES, LOCALE_HEADER, isDefaultErrorMessage, type ErrorCode, type Locale } from '@mycel/shared/api'
import { APP_RETURN_HEADER, APP_RETURN_KEY_HEADER, appReturnKeyOf, appReturnPortOf } from '@mycel/shared/desktop-bridge'
import { currentLocale, t } from '../i18n'
import { desktop, noPurchaseLinks } from './desktop'
import { downloadToApp, mobileApp, reportMobileError, sendFileToApp } from './mobile'
import { xhrFetch } from './xhr'
import { noteAnswer } from './serverUpdating'

const WINDOW_KEY = 'mycel.windowId'

function randomId(): string {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * This window's id (X-Mycel-Window, WebSocket ?windowId=). Kept per tab in sessionStorage so a reload resumes the
 * same window (browser tool calls of a running turn keep coming here). A duplicated tab copies sessionStorage; the
 * server then closes the older socket with 4409 and that window picks a new id (lib/realtime.ts).
 */
export function loadWindowId(): string {
  try {
    const v = sessionStorage.getItem(WINDOW_KEY)
    if (v && /^[A-Za-z0-9_-]{8,64}$/.test(v)) return v
  } catch { /* storage blocked: a fresh id per load */ }
  // not renewWindowId(): this runs while windowIdValue below is still being initialised (a fresh tab has no stored id,
  // and assigning it then threw "Cannot access 'windowIdValue' before initialization")
  return storeNewWindowId()
}

function storeNewWindowId(): string {
  const id = randomId()
  try { sessionStorage.setItem(WINDOW_KEY, id) } catch { /* ignore */ }
  return id
}

export function renewWindowId(): string {
  windowIdValue = storeNewWindowId()
  return windowIdValue
}

let windowIdValue = typeof window === 'undefined' ? randomId() : loadWindowId()
export const windowId = () => windowIdValue

/** The desktop app's return address for sign-in codes (DesktopBridge.codeReturn): its port goes with every call, so
 * the server can send a sign-in's browser back to this app on its computer, whatever the browser (an app link needs a
 * browser that opens apps). Asked once; an app from before, or none open: no header, the app link as before. */
let appReturnPort: number | null = null
/** and the app's key for this team (DesktopBridge.codeReturn.key: the sha256 of a secret only the app's main process
 * sends, on its claim): a result the server holds for the app's code is then redeemed only by this app (server
 * google-drive/app-return.ts). An app from before has none. */
let appReturnKey: string | null = null
try {
  const back = desktop()?.codeReturn
  void back?.port().then((p) => { appReturnPort = appReturnPortOf(p) }, () => {})
  void back?.key?.().then((k) => { appReturnKey = appReturnKeyOf(k) }, () => {})
} catch { /* no bridge */ }

/** A request that always carries the current window id (ApiClient reads it once, so wrap) and the language on screen
 * (the server uses it only without a session, so messages before sign-in match the page). */
const inWindow = (init?: RequestInit): RequestInit => {
  const headers = new Headers(init?.headers)
  headers.set('x-mycel-window', windowIdValue)
  headers.set(LOCALE_HEADER, currentLocale())
  if (appReturnPort) headers.set(APP_RETURN_HEADER, String(appReturnPort))
  if (appReturnKey) headers.set(APP_RETURN_KEY_HEADER, appReturnKey)
  return { ...init, headers, credentials: 'same-origin' }
}
/** A store app (lib/desktop.ts noPurchaseLinks) says "the plan's seats are full" without the server's "change the plan:
 * <account page>": the refusal that carries `changePlan` (server/src/system/limits.ts assertSeatFree) gets this app's
 * words, and its manageUrl is dropped. Anything else, and every answer outside a store app, is returned as it came. */
export async function storeSafeError(res: Response, store = noPurchaseLinks()): Promise<Response> {
  if (!store || res.status !== 409) return res
  let body: { error?: { code?: unknown; message?: unknown; params?: Record<string, unknown> } }
  try { body = await res.clone().json() } catch { return res }
  const e = body?.error
  if (!e || e.code !== 'plan_limit' || e.params?.changePlan !== true) return res
  const params = { ...e.params }
  delete params.manageUrl
  const limit = typeof params.limit === 'number' ? params.limit : 0
  const fixed = { ...body, error: { ...e, message: t('plan.seatLimitStore', { limit }), params } }
  const headers = new Headers(res.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify(fixed), { status: res.status, statusText: res.statusText, headers })
}

const writeListeners = new Set<() => void>()
/** Told when a request of this window that may change something on the server (any method but GET and HEAD) is over,
 * answered or not: what was read before may be old now (store/adminPeople.ts). Returns the unsubscribe. */
export function onApiWrite(fn: () => void): () => void {
  writeListeners.add(fn)
  return () => { writeListeners.delete(fn) }
}
const afterWrite = async <R,>(init: RequestInit | undefined, run: () => Promise<R>): Promise<R> => {
  const m = (init?.method ?? 'GET').toUpperCase()
  if (m === 'GET' || m === 'HEAD') return run()
  try { return await run() } finally { for (const fn of writeListeners) fn() }
}

const demoLimitListeners = new Set<() => void>()
/** Told when a request is refused at a free-roam demo's limit (403, params.reason "demo_limit": a send, a skill run):
 * store/demo.ts opens the limit dialog and stops the AI message boxes. Returns the unsubscribe. */
export function onDemoLimit(fn: () => void): () => void {
  demoLimitListeners.add(fn)
  return () => { demoLimitListeners.delete(fn) }
}
/** a 403's body read once more for its reason (only 403: nothing else carries the demo limit) */
function noteDemoLimit(res: Response) {
  if (res.status !== 403 || !demoLimitListeners.size) return
  void res.clone().json().then((b: { error?: { params?: { reason?: unknown } } }) => {
    if (b?.error?.params?.reason === 'demo_limit') for (const fn of demoLimitListeners) fn()
  }, () => {})
}

// uploads (fetchWithProgress below) are not wrapped: no seat refusal comes that way
// (an answer that says Trina is updating starts the window's wait for it: lib/serverUpdating.ts)
const fetchWithWindow = (async (input: RequestInfo | URL, init?: RequestInit) => afterWrite(init, async () => {
  const res = await fetch(input, inWindow(init))
  noteAnswer(res)
  noteDemoLimit(res)
  return storeSafeError(res)
})) as typeof fetch

export const api = new ApiClient({ baseUrl: '', fetch: fetchWithWindow, fetchWithProgress: (input, init, onSent) => afterWrite(init, () => xhrFetch(input, inWindow(init), onSent)) })
export { API, ApiError }

/** Network-level failure (offline, relay dropped, DNS): worth retrying, unlike an ApiError. */
export const isNetworkError = (e: unknown) => e instanceof TypeError || (e instanceof DOMException && e.name !== 'AbortError')

export const isApiError = (e: unknown, code?: ErrorCode): e is ApiError => e instanceof ApiError && (code === undefined || e.code === code)

/** The connection, not the server's answer: no answer at all (isNetworkError), or a 502–504 `unavailable` with no
 * reason of the server's own: the relay (the team server offline, restarting, busy, its link lost) or a proxy without
 * the server's JSON. It passes by itself, so a list that could not be read tries again by itself
 * (components/LoadError.tsx). A reason the server gives (a quarantined file, the queue draining) is not this. */
export const isConnectionError = (e: unknown) =>
  isNetworkError(e) || (e instanceof ApiError && e.code === 'unavailable' && e.status >= 502 && e.status <= 504 && (e.body.params?.reason === undefined || isTeamWaking(e) || isServerUpdating(e)))

/** The relay says the team's server is starting after a pause (a free trial's server turns off when unused): not an
 * error to fear. It is a connection error too (it passes by itself), but the words say "Resuming your team". */
export const isTeamWaking = (e: unknown) => e instanceof ApiError && e.status === 503 && e.body.params?.reason === 'team_waking'

/** Trina is updating (an update migrates the server's database, or the control plane updates a hosted team's server):
 * a connection error too, it passes by itself, but the words say "Trina is updating" and what waits goes when it is
 * back (lib/serverUpdating.ts). */
export const isServerUpdating = (e: unknown) => e instanceof ApiError && e.status === 503 && e.body.params?.reason === 'updating'

/**
 * Text for an error, in the UI language. Server messages are already in the user's language (tab 4), but before
 * sign-in the server only knows the page's language header, so codes are re-translated here; network failures get our own text.
 */
export function errorText(e: unknown, locale: Locale, networkText: string): string {
  if (e instanceof ApiError) {
    // a free-roam demo's fence (server/src/demo/guard.ts): one short line, the same everywhere, not an error to fix
    if (e.body.params?.reason === 'demo_fenced') return t('demo.free.fenced')
    if (e.body.params?.reason === 'demo_busy') return t('demo.free.busy')
    if (e.body.params?.reason === 'demo_rest') return t('demo.free.rest')
    const known = ERROR_MESSAGES[e.code]
    // handler-specific messages (e.g. "Someone else saved first.") are kept; default ones, older wordings included
    // (a Korean default saved with an answer before 0.2.16), follow the UI language
    const isDefault = !!known && isDefaultErrorMessage(e.code, e.message)
    if (e.code === 'validation' && e.body.fields) {
      // a specific message is already in the person's language; the field detail is for developers (English)
      if (e.message && !isDefault) return e.message
      const first = Object.values(e.body.fields)[0]
      return first ? `${known?.[locale] ?? e.message} (${first})` : known?.[locale] ?? e.message
    }
    return isDefault ? known[locale] : e.message || known?.[locale] || String(e.status)
  }
  if (isNetworkError(e)) return networkText
  if (e instanceof Error) return e.message
  return String(e)
}

/** URL of a team file for <img>/<a> (same origin, cookie session). Download responses always carry
 * Content-Disposition: attachment + a sandbox CSP, so they never run as a page of this origin. */
export function fileUrl(path: string, disposition: 'inline' | 'attachment' = 'attachment'): string {
  return api.url(API.download, { query: { path, disposition } })
}

export function versionDownloadUrl(versionId: string): string {
  return api.url(API.versionDownload, { params: { versionId } })
}

export function thumbnailUrl(attachmentId: string): string {
  return api.url(API.attachmentThumbnail, { params: { id: attachmentId } })
}

/**
 * Fetch a team file's bytes for an in-app preview, never more than `max`: a Content-Length above it is refused at
 * once, and a response without one (chunked, or a relay that drops the header) is read up to `max` and then cut off.
 */
export async function fetchFileBlob(path: string, max = 60 * 1024 * 1024, signal?: AbortSignal, o: { truncate?: boolean; embedIn?: string } = {}): Promise<Blob> {
  // embedIn: the HTML file whose preview puts this file into its page (lib/frame-files.ts; the server refuses a file
  // that some readers of that page cannot read)
  const res = await api.call(API.download, { query: { path, disposition: 'attachment', preview: 'true', ...(o.embedIn !== undefined ? { embedIn: o.embedIn } : {}) }, signal })
  return readBounded(res, max, o)
}

/** This sign-in's media key (Me.session.mediaKey; App.tsx keeps it in step with the session), or null. */
let mediaKey: string | null = null
export function setMediaKey(k: string | null) {
  mediaKey = k
}

/** URL of a file sent in a room (the member check on every read): `download` as an attachment, `thumb` an image's small
 * preview. Inline, a page or script type comes as text with a sandbox CSP (never a page of this origin). A thumbnail
 * carries this sign-in's media key, so this browser keeps it for this sign-in only (a room file never changes;
 * server/src/auth/media-key.ts); the next person on this browser gets other addresses. Only a thumbnail: it is only
 * ever an <img>, never an address a link opens (which would stay in the browser's history). */
export function roomFileUrl(roomId: string, fileId: string, query: { download?: '1'; thumb?: '1' } = {}): string {
  return api.url(API.roomFile, { params: { id: roomId, fileId }, query: query.thumb && !query.download && mediaKey ? { ...query, k: mediaKey } : query })
}

/** URL of a file from the computer kept with a chat shared with people (Attachment source 'chat'; checked on every read:
 * whoever sees the chat now): `download` as an attachment, `thumb` an image's small preview. */
export function chatFileUrl(chatId: string, fileId: string, query: { download?: '1'; thumb?: '1'; version?: number } = {}): string {
  return api.url(API.chatFile, { params: { id: chatId, fileId }, query })
}

/** A chat file's bytes for the preview panel, never more than `max` (readBounded). */
export async function fetchChatFileBlob(chatId: string, fileId: string, max: number, signal?: AbortSignal, o: { truncate?: boolean; version?: number } = {}): Promise<Blob> {
  const res = await api.call(API.chatFile, { params: { id: chatId, fileId }, signal, ...(o.version ? { query: { version: o.version } } : {}) })
  return readBounded(res, max, o)
}

/** A room file's bytes for the preview panel, never more than `max` (readBounded; `truncate`: a text preview's start). */
export async function fetchRoomFileBlob(roomId: string, fileId: string, max: number, signal?: AbortSignal, o: { truncate?: boolean } = {}): Promise<Blob> {
  const res = await api.call(API.roomFile, { params: { id: roomId, fileId }, signal })
  return readBounded(res, max, o)
}

/**
 * A JPEG made on the server for a photo the browser cannot draw (HEIC / HEIF, `serverPreview` in ./preview), never
 * more than `max`. No converter on the server: ApiError 'unavailable' (the panel shows "cannot preview").
 */
export async function fetchServerPreview(path: string, max: number, signal?: AbortSignal): Promise<Blob> {
  const res = await api.call(API.preview, { query: { path }, signal })
  return readBounded(res, max)
}

/**
 * The body of `res`, at most `max` bytes. Too large: PreviewTooLargeError — or, with `truncate` (text previews show
 * only the beginning), the first `max` + 1 bytes (one more than `max`, so the caller can tell it was cut).
 */
export async function readBounded(res: Response, max: number, o: { truncate?: boolean } = {}): Promise<Blob> {
  const type = res.headers.get('content-type') ?? ''
  const len = Number(res.headers.get('content-length') ?? '0')
  if (len > max && !o.truncate) {
    await res.body?.cancel().catch(() => {})
    throw new PreviewTooLargeError(len)
  }
  if (!res.body) return new Blob([], { type })
  const parts: Uint8Array[] = []
  let size = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      if (!o.truncate) throw new PreviewTooLargeError(len || size)
      parts.push(value.subarray(0, value.byteLength - (size - max - 1)))
      break
    }
    parts.push(value)
  }
  return new Blob(parts as BlobPart[], { type })
}

export class PreviewTooLargeError extends Error {
  constructor(public size: number) {
    super('too large to preview')
    this.name = 'PreviewTooLargeError'
  }
}

/** Let the browser download a URL (streams to disk; nothing is held in memory). */
export function startDownload(url: string, name?: string) {
  if (mobileApp()) { void downloadToApp(url, name).catch(reportMobileError); return }
  const a = document.createElement('a')
  a.href = url
  if (name) a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Save a Blob made in the page (artifact source, copied table) as a file. */
export function saveBlob(blob: Blob, name: string) {
  if (mobileApp()) { void sendFileToApp(blob, name).catch(reportMobileError); return }
  const url = URL.createObjectURL(blob)
  startDownload(url, name)
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
