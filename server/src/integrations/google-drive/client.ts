import { DriveError } from './store'
export type DriveFetch = (url: string, init?: RequestInit) => Promise<Response>
export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke'
export const DRIVE_API = 'https://www.googleapis.com/drive/v3/'

export function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw new DriveError('cancelled', 409) }

/** Cancel one waiter without aborting a refresh shared by other requests. */
export function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DriveError('cancelled', 409))
    const cleanup = () => signal.removeEventListener('abort', abort)
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
export function backoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DriveError('cancelled', 409)) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/** No provider body, request URL, headers or exception message is ever surfaced or logged. */
export class GoogleTransport {
  constructor(readonly fetcher: DriveFetch = fetch) {}
  async request(url: string, init: RequestInit = {}, maxBytes = 1_048_576): Promise<{ status: number; bytes: Uint8Array }> {
    const allowed = url === GOOGLE_TOKEN || url === GOOGLE_REVOKE || url.startsWith(DRIVE_API)
    if (!allowed) throw new DriveError('invalid_endpoint')
    const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(init.signal ? [init.signal] : [])])
    checkAbort(signal)
    try {
      const r = await this.fetcher(url, { ...init, redirect: 'manual', signal })
      if (r.status >= 300 && r.status < 400) { await r.body?.cancel(); throw new DriveError('provider_redirect', 502) }
      const cap = r.ok ? maxBytes : Math.min(maxBytes, 16_384)
      if (Number(r.headers.get('content-length')) > cap) { await r.body?.cancel(); throw new DriveError('too_large', 413) }
      const chunks: Uint8Array[] = []
      let size = 0
      if (r.body) {
        const reader = r.body.getReader()
        const abort = () => { void reader.cancel().catch(() => {}) }
        signal.addEventListener('abort', abort, { once: true })
        try {
          while (true) {
            checkAbort(signal)
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > cap) { await reader.cancel(); throw new DriveError('too_large', 413) }
            chunks.push(value)
          }
        } finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
      }
      checkAbort(signal)
      return { status: r.status, bytes: new Uint8Array(Buffer.concat(chunks)) }
    } catch (e) {
      if (e instanceof DriveError) throw e
      throw new DriveError(signal.aborted ? 'cancelled' : 'provider_unavailable', 503)
    }
  }
  async json(url: string, init: RequestInit = {}, maxBytes = 1_048_576): Promise<Record<string, any>> {
    const r = await this.request(url, init, maxBytes)
    if (r.status < 200 || r.status >= 300) {
      if (url === GOOGLE_TOKEN) {
        let code = ''
        try { code = JSON.parse(new TextDecoder().decode(r.bytes)).error } catch {}
        if (code === 'invalid_grant') throw new DriveError('needs_reconnect', 409)
      }
      throw responseError(r.status)
    }
    try {
      const v = JSON.parse(new TextDecoder().decode(r.bytes))
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error()
      return v
    } catch { throw new DriveError('invalid_provider_response', 502) }
  }
}
export function responseError(status: number) {
  if (status === 401) return new DriveError('unauthorized_provider', 401)
  if (status === 403 || status === 404) return new DriveError('not_found', 404)
  if (status === 429) return new DriveError('rate_limited', 503)
  return new DriveError('provider_unavailable', 503)
}
