import { MAX_CHUNK_BYTES, MAX_FILE_BYTES, safeFileName, sameTeam, googleOAuthUrl, validConfig, type MobileConfig, type MobileMessage, type MobileReply } from '../../../mobile/src/protocol'

type PhoneWindow = Window & { mycelMobile?: unknown; ReactNativeWebView?: { postMessage(raw: string): void } }
export function mobileApp(): MobileConfig | null {
  if (typeof window === 'undefined' || window.top !== window.self) return null
  const w = window as PhoneWindow
  return validConfig(w.mycelMobile) && typeof w.ReactNativeWebView?.postMessage === 'function' ? w.mycelMobile : null
}
interface Pending { config: MobileConfig; type: MobileMessage['type']; seq?: number; resolve: (reply: MobileReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
const pending = new Map<string, Pending>()
const downloads = new Set<AbortController>()
let epoch = 0, busy = false, initialized = false
let sessionKey: string | null = null
let barrier: Promise<void> = Promise.resolve()
let onError: (error: unknown) => void = () => {}
const cancelled = () => new DOMException('Mobile operation cancelled', 'AbortError')
const keyOf = (id: string, type: string, seq?: number) => `${id}:${type}:${seq ?? ''}`
const current = (c: MobileConfig) => { const a = mobileApp(); return !!a && a.nonce === c.nonce && a.generation === c.generation }
export const reportMobileError = (error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) onError(error) }
export class MobileFileTooLarge extends Error { constructor() { super('mobile_file_too_large') } }

function receive(event: Event) {
  const r = (event as CustomEvent<unknown>).detail
  if (!r || typeof r !== 'object') return
  const reply = r as MobileReply
  const p = pending.get(keyOf(reply.id, reply.for, reply.seq))
  if (!p || reply.v !== 1 || reply.type !== 'mobile-result' || reply.nonce !== p.config.nonce || reply.generation !== p.config.generation || typeof reply.ok !== 'boolean') return
  pending.delete(keyOf(reply.id, reply.for, reply.seq)); clearTimeout(p.timer)
  if (reply.ok) p.resolve(reply); else p.reject(new Error('mobile_operation_failed'))
}
function request(message: MobileMessage, config: MobileConfig): Promise<MobileReply> {
  if (!current(config)) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const seq = 'seq' in message ? message.seq : undefined, key = keyOf(message.id, message.type, seq)
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('mobile_timeout')) }, 60_000)
    pending.set(key, { config, type: message.type, seq, resolve, reject, timer })
    try { (window as PhoneWindow).ReactNativeWebView!.postMessage(JSON.stringify(message)) }
    catch { clearTimeout(timer); pending.delete(key); reject(new Error('mobile_unavailable')) }
  })
}
const envelope = (config: MobileConfig, id = crypto.randomUUID()) => ({ v: 1 as const, nonce: config.nonce, generation: config.generation, id })
function abortPending(preserveReset = false) {
  epoch++
  for (const [key, p] of pending) {
    if (preserveReset && p.type === 'session-reset') continue
    clearTimeout(p.timer); p.reject(cancelled()); pending.delete(key)
  }
  for (const controller of downloads) controller.abort()
  downloads.clear()
}
/** Session identity stays in JS memory. Only an opaque generation reset crosses the native bridge. */
export function setMobileSession(key: string | null): void {
  if (key === sessionKey) return
  sessionKey = key
  resetMobileSession()
}
export function resetMobileSession(): void {
  abortPending(true)
  barrier = barrier.catch(() => {}).then(async () => {
    const config = mobileApp(); if (!config) return
    const reply = await request({ ...envelope(config), type: 'session-reset' }, config)
    if (reply.nextGeneration !== config.generation + 1) throw new Error('mobile_protocol_mismatch')
    // Native also installs this config before delivering its acknowledgement.
    if (!mobileApp() || mobileApp()!.generation !== reply.nextGeneration) throw new Error('mobile_protocol_mismatch')
  })
  void barrier.catch(reportMobileError)
}
function base64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}
export async function sendFileToApp(blob: Blob, name: string): Promise<void> {
  if (blob.size > MAX_FILE_BYTES) throw new MobileFileTooLarge()
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  const config = mobileApp()
  if (!config) throw new Error('mobile_unavailable')
  if (busy) throw new Error('mobile_transfer_busy')
  busy = true
  const env = envelope(config)
  const check = () => { if (turn !== epoch || !current(config)) throw cancelled() }
  try {
    const bytes = await blob.arrayBuffer(); check()
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join(''); check()
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(blob.type) ? blob.type : 'application/octet-stream'
    await request({ ...env, type: 'file-begin', name: safeFileName(name), mime, size: blob.size, sha256 }, config)
    let seq = 0
    for (let off = 0; off < bytes.byteLength; off += MAX_CHUNK_BYTES) {
      check()
      await request({ ...env, type: 'file-chunk', seq: seq++, b64: base64(new Uint8Array(bytes, off, Math.min(MAX_CHUNK_BYTES, bytes.byteLength - off))) }, config)
    }
    check(); await request({ ...env, type: 'file-end', seq }, config)
  } catch (error) {
    if (current(config)) (window as PhoneWindow).ReactNativeWebView?.postMessage(JSON.stringify({ ...env, type: 'file-abort' }))
    throw error
  } finally { busy = false }
}
export async function downloadToApp(url: string, name?: string): Promise<void> {
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  const resolved = new URL(url, location.href)
  if (!sameTeam(location.origin, resolved.href)) throw new Error('mobile_external_download')
  const controller = new AbortController()
  downloads.add(controller)
  try {
    const r = await fetch(resolved.href, { credentials: 'same-origin', redirect: 'error', signal: controller.signal })
    if (!r.ok || (r.url && !sameTeam(location.origin, r.url))) throw new Error('mobile_download_failed')
    const blob = await readMobileDownload(r)
    if (turn !== epoch) throw cancelled()
    let fromHeader = /filename\*=UTF-8''([^;]+)/i.exec(r.headers.get('content-disposition') ?? '')?.[1]
    try { fromHeader = fromHeader ? decodeURIComponent(fromHeader) : undefined } catch { fromHeader = undefined }
    await sendFileToApp(blob, name || fromHeader || resolved.pathname.split('/').at(-1) || 'file')
  } finally { downloads.delete(controller) }
}
/** Bound streaming bodies even when the server omits or understates Content-Length. */
export async function readMobileDownload(r: Response): Promise<Blob> {
  if (Number(r.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) { await r.body?.cancel(); throw new MobileFileTooLarge() }
  const chunks: Uint8Array[] = []; let size = 0
  const reader = r.body?.getReader()
  if (reader) for (;;) {
    const { done, value } = await reader.read(); if (done) break
    size += value.byteLength
    if (size > MAX_FILE_BYTES) { await reader.cancel(); throw new MobileFileTooLarge() }
    chunks.push(value)
  }
  return new Blob(chunks as BlobPart[], { type: r.headers.get('content-type') ?? '' })
}
/** Google code/state remain in the external browser and server callback. The original app session polls its flow. */
export async function openExternal(url: string, options: { purpose: 'google-oauth' }): Promise<void> {
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  if (options.purpose !== 'google-oauth' || !googleOAuthUrl(url)) throw new Error('mobile_external_refused')
  const config = mobileApp(); if (!config) throw new Error('mobile_unavailable')
  await request({ ...envelope(config), type: 'external-open', url, purpose: options.purpose }, config)
}
export function initMobile(errorHandler?: (error: unknown) => void): void {
  if (typeof window === 'undefined' || initialized) return
  initialized = true; onError = errorHandler ?? onError
  window.addEventListener('mycel:mobile', receive)
  window.addEventListener('mycel:mobile-ready', () => { abortPending(); barrier = Promise.resolve() })
  window.addEventListener('pagehide', () => abortPending())
  window.addEventListener('mycel:download', (event) => {
    const url = (event as CustomEvent<{ url?: unknown }>).detail?.url
    if (mobileApp() && typeof url === 'string') void downloadToApp(url).catch(reportMobileError)
  })
  document.addEventListener('click', (event) => {
    if (!mobileApp()) return
    const anchor = (event.target as Element | null)?.closest?.('a[download]') as HTMLAnchorElement | null
    if (!anchor || !sameTeam(location.origin, anchor.href)) return
    event.preventDefault()
    void downloadToApp(anchor.href, anchor.getAttribute('download') || undefined).catch(reportMobileError)
  }, true)
}
