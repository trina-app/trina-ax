import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { initMobile, mobileApp, sendFileToApp, setMobileSession, openExternal, downloadToApp, readMobileDownload, MobileFileTooLarge } from '../../src/lib/mobile'
import { clientKind } from '../../src/lib/desktop'
import { MAX_CHUNK_BYTES, MAX_FILE_BYTES, MOBILE_CAPABILITIES, type MobileConfig, type MobileMessage, type MobileReply } from '../../../mobile/src/protocol'
const config: MobileConfig = { protocol: 1, appVersion: '0.2.2', platform: 'ios', nonce: 'c'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
const win = Object.assign(new EventTarget(), { self: null as unknown, top: null as unknown, mycelMobile: { ...config }, ReactNativeWebView: { postMessage: (_raw: string) => {} } })
win.self = win; win.top = win
const doc = new EventTarget()
const prior = new Map(['window', 'document', 'location'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
let messages: MobileMessage[] = []
let handler: (m: MobileMessage) => void
function reply(m: MobileMessage, over: Partial<MobileReply> = {}) {
  win.dispatchEvent(new CustomEvent('mycel:mobile', { detail: { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}), ...over } }))
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
beforeAll(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://team.example', href: 'https://team.example/' } })
  initMobile()
})
afterAll(() => { for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else Reflect.deleteProperty(globalThis, k) } })
beforeEach(() => {
  messages = []; win.top = win; win.mycelMobile = { ...config }
  handler = m => { if (m.type === 'session-reset') { win.mycelMobile = { ...win.mycelMobile, generation: m.generation + 1 }; reply(m, { nextGeneration: m.generation + 1 }) } else reply(m) }
  win.ReactNativeWebView.postMessage = raw => { const m = JSON.parse(raw) as MobileMessage; messages.push(m); handler(m) }
  win.dispatchEvent(new Event('mycel:mobile-ready'))
})
test('only a compatible top-level native bridge signs in as mobile; ordinary browser stays web', () => {
  expect(mobileApp()?.protocol).toBe(1)
  expect(clientKind()).toBe('mobile')
  win.mycelMobile = { ...config, protocol: 0 } as unknown as MobileConfig
  expect(mobileApp()).toBeNull(); expect(clientKind()).toBe('web')
  win.mycelMobile = { ...config }; win.top = {}
  expect(mobileApp()).toBeNull()
})
test('multi-chunk transfer carries an exact hash and awaits each native ACK before sending the next', async () => {
  let first: MobileMessage | null = null
  handler = m => { if (m.type === 'file-chunk' && m.seq === 0) first = m; else reply(m) }
  const blob = new Blob([new Uint8Array(MAX_CHUNK_BYTES + 7).fill(42)], { type: 'application/octet-stream' })
  const sending = sendFileToApp(blob, '../../report.bin')
  for (let i = 0; i < 100 && !first; i++) await tick()
  expect(first).not.toBeNull()
  expect(messages.map(m => m.type)).toEqual(['file-begin', 'file-chunk'])
  reply(first!); await sending
  expect(messages.map(m => m.type)).toEqual(['file-begin', 'file-chunk', 'file-chunk', 'file-end'])
  const chunks = messages.filter((m): m is Extract<MobileMessage, { type: 'file-chunk' }> => m.type === 'file-chunk')
  const bytes = Buffer.concat(chunks.map(m => Buffer.from(m.b64, 'base64')))
  expect(bytes.length).toBe(blob.size)
  expect(messages[0]).toMatchObject({ size: blob.size, name: safeName(), sha256: createHash('sha256').update(bytes).digest('hex') })
})
function safeName() { return '_.._report.bin' }
test('forged acknowledgements cannot advance transfer; signing out cancels an in-flight transfer', async () => {
  let start: MobileMessage | null = null
  handler = m => { if (m.type === 'file-begin') start = m; else if (m.type === 'session-reset') { win.mycelMobile = { ...win.mycelMobile, generation: m.generation + 1 }; reply(m, { nextGeneration: win.mycelMobile.generation }) } }
  const sending = sendFileToApp(new Blob(['private']), 'a.txt')
  const rejection = sending.then(() => null, error => error)
  for (let i = 0; i < 20 && !start; i++) await tick()
  reply(start!, { nonce: 'e'.repeat(64) }); await tick()
  expect(messages.filter(m => m.type === 'file-chunk')).toHaveLength(0)
  setMobileSession('another-session')
  expect(await rejection).toBeInstanceOf(DOMException); await tick()
  expect(messages.filter(m => m.type === 'file-end')).toHaveLength(0)
})
test('OAuth only requests the allowlisted external endpoint and rejects arbitrary schemes', async () => {
  await openExternal('https://accounts.google.com/o/oauth2/v2/auth?state=opaque', { purpose: 'google-oauth' })
  expect(messages.at(-1)).toMatchObject({ type: 'external-open', purpose: 'google-oauth' })
  const count = messages.length
  await expect(openExternal('javascript:alert(1)', { purpose: 'google-oauth' })).rejects.toThrow()
  expect(messages).toHaveLength(count)
})

test('an operation requested before logout cannot resume under the next session after an await', async () => {
  const pendingFile = sendFileToApp(new Blob(['old-session']), 'old.txt').then(() => null, error => error)
  const pendingDownload = downloadToApp('https://team.example/api/files/old').then(() => null, error => error)
  const pendingOpen = openExternal('https://accounts.google.com/o/oauth2/v2/auth?state=old-session', { purpose: 'google-oauth' }).then(() => null, error => error)
  setMobileSession('session-after-logout')
  expect(await pendingOpen).toBeInstanceOf(DOMException)
  expect(await pendingFile).toBeInstanceOf(DOMException)
  expect(await pendingDownload).toBeInstanceOf(DOMException)
  await tick()
  expect(messages.filter(m => m.type === 'external-open')).toHaveLength(0)
})

// Synthetic stream reuses one allocation; no provider request or large resident fixture.
test('downloads enforce both declared and streaming byte limits and cancel oversized bodies', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-length': String(MAX_FILE_BYTES + 1) } })
  await expect(readMobileDownload(response)).rejects.toBeInstanceOf(MobileFileTooLarge)
  expect(cancelled).toBe(true)
  cancelled = false
  const chunk = new Uint8Array(1024 * 1024)
  let reads = 0
  const streaming = new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(chunk) }, cancel() { cancelled = true } }), { headers: { 'content-length': '1' } })
  await expect(readMobileDownload(streaming)).rejects.toBeInstanceOf(MobileFileTooLarge)
  expect(cancelled).toBe(true)
  expect(reads).toBeLessThanOrEqual(52)
  expect(await (await readMobileDownload(new Response('exact body', { headers: { 'content-type': 'text/plain' } }))).text()).toBe('exact body')
})
