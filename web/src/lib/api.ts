// The one API client of the web app: same-origin (served by the team server), cookie session, CSRF + window headers
// added by ApiClient. Every call goes through the shared contract (`API.x`), so request and response shapes are the
// server's own zod schemas.
import { API, ApiClient, ApiError, ERROR_MESSAGES, type ErrorCode, type Locale } from '@mycel/shared/api'

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
  return renewWindowId()
}

export function renewWindowId(): string {
  const id = randomId()
  try { sessionStorage.setItem(WINDOW_KEY, id) } catch { /* ignore */ }
  windowIdValue = id
  return id
}

let windowIdValue = typeof window === 'undefined' ? randomId() : loadWindowId()
export const windowId = () => windowIdValue

/** fetch that always carries the current window id (ApiClient reads it once, so wrap). */
const fetchWithWindow = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('x-mycel-window', windowIdValue)
  return fetch(input, { ...init, headers, credentials: 'same-origin' })
}) as typeof fetch

export const api = new ApiClient({ baseUrl: '', fetch: fetchWithWindow })
export { API, ApiError }

/** Network-level failure (offline, relay dropped, DNS): worth retrying, unlike an ApiError. */
export const isNetworkError = (e: unknown) => e instanceof TypeError || (e instanceof DOMException && e.name !== 'AbortError')

export const isApiError = (e: unknown, code?: ErrorCode): e is ApiError => e instanceof ApiError && (code === undefined || e.code === code)

/**
 * Text for an error, in the UI language. Server messages are already in the user's language (tab 4), but before
 * sign-in the server only knows Accept-Language, so codes are re-translated here; network failures get our own text.
 */
export function errorText(e: unknown, locale: Locale, networkText: string): string {
  if (e instanceof ApiError) {
    const known = ERROR_MESSAGES[e.code]
    if (e.code === 'validation' && e.body.fields) {
      const first = Object.values(e.body.fields)[0]
      return first ? `${known?.[locale] ?? e.message} (${first})` : known?.[locale] ?? e.message
    }
    // handler-specific messages (e.g. "Someone else saved first.") are kept; default ones follow the UI language
    const isDefault = known && Object.values(known).includes(e.message)
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

/** Fetch a team file's bytes for an in-app preview (bounded: previews refuse files above `max`). */
export async function fetchFileBlob(path: string, max = 60 * 1024 * 1024, signal?: AbortSignal): Promise<Blob> {
  const res = await api.call(API.download, { query: { path, disposition: 'attachment' }, signal })
  const len = Number(res.headers.get('content-length') ?? '0')
  if (len > max) {
    await res.body?.cancel()
    throw new PreviewTooLargeError(len)
  }
  return await res.blob()
}

export class PreviewTooLargeError extends Error {
  constructor(public size: number) {
    super('too large to preview')
    this.name = 'PreviewTooLargeError'
  }
}

/** Let the browser download a URL (streams to disk; nothing is held in memory). */
export function startDownload(url: string, name?: string) {
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
  const url = URL.createObjectURL(blob)
  startDownload(url, name)
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
