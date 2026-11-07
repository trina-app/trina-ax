// Browser errors to the team server, which scrubs them again and passes them to Sentry (server/src/system/error-report.ts).
// Off unless GET /api/me says server.errorReports, so an ordinary install never sends this. It goes to the server and
// not to Sentry: the Content Security Policy stays as it is, and the browser never holds a key.
import { API, api } from './api'
import { isChunkLoadError } from './chunk-reload'

const MAX_PER_PAGE_LOAD = 10

let enabled = false
let sent = 0
const seen = new Set<string>()

export function setErrorReports(on: boolean): void { enabled = on }

/** Only the first part of the address: the rest can hold a file path, and the query an invite or reset token. */
export function reportPage(pathname: string): string {
  const first = pathname.split('/')[1] ?? ''
  return /^[a-z0-9-]{1,32}$/.test(first) ? `/${first}` : '/'
}

/** Only the app's own code: an error from a browser extension or a pasted script is not ours to look at. */
export function reportableError(e: unknown): e is Error {
  return e instanceof Error && !!e.stack?.includes('/assets/') && !isChunkLoadError(e)
}

export function reportError(e: unknown, pathname = location.pathname): void {
  if (!enabled || sent >= MAX_PER_PAGE_LOAD || !reportableError(e)) return
  const key = `${e.name}|${e.message}`
  if (seen.has(key)) return
  seen.add(key)
  sent++
  const body = { type: e.name.slice(0, 80), message: e.message.slice(0, 1000), stack: (e.stack ?? '').slice(0, 6000), page: reportPage(pathname) }
  // a report that fails is simply lost: it must not show the person anything, or fail again here
  void api.call(API.reportClientError, { body }).catch(() => {})
}

export function initErrorReports(): void {
  window.addEventListener('error', (e) => reportError(e.error))
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason))
}

export function _resetErrorReportsForTest(): void {
  enabled = false
  sent = 0
  seen.clear()
}
