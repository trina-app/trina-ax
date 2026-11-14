// How the page reaches the demo's in-page server (web/demo/server.ts) instead of a team server:
// - fetch('/api/…') is answered by DemoServer.handle in the page;
// - new WebSocket('/api/ws') is an in-page socket on the mock's own protocol code (MockServer.socketOpen/…);
// - <img src="/api/…"> and downloads go to the service worker (web/demo/sw.js, served as /sw.js), which asks this page.
// Installed before any of the app's modules run (web/demo/main.tsx), with the server still being made: requests wait
// for it. No runtime imports here, so the entry chunk evaluates nothing of the app before this is in place.
import type { MockSocket } from '../test/mock/server'
import type { DemoServer } from './server'

/** shared/src/api/ws.ts WS_PATH (not imported: see above) */
const WS_PATH = '/api/ws'
const ours = (url: URL) => url.origin === location.origin && url.pathname.startsWith('/api/') && url.pathname !== WS_PATH

export function installBridge(ready: Promise<DemoServer>) {
  const realFetch = window.fetch.bind(window)
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // the address first: a Request's body is read only when the answer is ours
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    if (!ours(url)) return realFetch(input, init)
    return (await ready).handle(new Request(input, init), '')
  }) as typeof fetch

  navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null } | null
    if (d?.type !== 'demo.fetch' || !e.ports[0]) return
    const port = e.ports[0]
    void (async () => {
      try {
        const res = await (await ready).handle(new Request(d.url, { method: d.method, headers: d.headers, body: d.body }), '')
        const body = [101, 204, 205, 304].includes(res.status) ? null : await res.arrayBuffer()
        port.postMessage({ status: res.status, headers: [...res.headers], body }, body ? [body] : [])
      } catch {
        port.postMessage({ status: 500, headers: [], body: null })
      }
    })()
  })

  const RealSocket = window.WebSocket
  class PageSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readyState = 0
    protocol = 'mycel.v1'
    onopen: ((ev: unknown) => void) | null = null
    onclose: ((ev: { code: number; reason?: string }) => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    private peer: MockSocket | null = null
    private server: DemoServer | null = null
    constructor(url: string) {
      void ready.then((server) => {
        if (this.readyState !== 0) return
        this.server = server
        this.peer = {
          data: server.socketData(new Request(url.replace(/^ws/, 'http'))),
          // in order, after the current task, as a socket would
          send: (text: string) => { setTimeout(() => { if (this.readyState === 1) this.onmessage?.({ data: text }) }, 0) },
          close: (code?: number, reason?: string) => this.end(code ?? 1000, reason),
        }
        this.readyState = 1
        this.onopen?.({})
        server.socketOpen(this.peer)
      })
    }
    send(text: string) { if (this.readyState === 1 && this.peer) this.server!.socketMessage(this.peer, text) }
    close(code = 1000, reason?: string) { this.end(code, reason) }
    private end(code: number, reason?: string) {
      if (this.readyState === 3) return
      this.readyState = 3
      if (this.peer) this.server!.socketClose(this.peer)
      setTimeout(() => this.onclose?.({ code, reason }), 0)
    }
  }
  const Socket = function (url: string | URL, protocols?: string | string[]) {
    const u = new URL(String(url), location.href)
    if (u.host === location.host && u.pathname === WS_PATH) return new PageSocket(u.href)
    return new RealSocket(url, protocols)
  } as unknown as typeof WebSocket
  Object.assign(Socket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  window.WebSocket = Socket
}

/** The worker that answers pictures and downloads; resolves once it controls this page (or at once without one). */
export async function startWorker(): Promise<void> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return
  try {
    const mine = new URL(`${import.meta.env.BASE_URL}sw.js`, location.href).href
    await navigator.serviceWorker.register(mine, { scope: import.meta.env.BASE_URL })
    // this demo's own worker: another language's demo above this one (/demo/ over /demo/ko/) may hold the page until
    // ours takes it (the narrower scope wins)
    if (navigator.serviceWorker.controller?.scriptURL === mine) return
    await new Promise<void>((done) => {
      const check = () => { if (navigator.serviceWorker.controller?.scriptURL === mine) done() }
      navigator.serviceWorker.addEventListener('controllerchange', check)
      setTimeout(done, 4000)
    })
  } catch { /* pictures fall back to their placeholders */ }
}
