// The checks every one-time return address of the desktop app on this computer shares (RFC 8252 section 7.3): the
// connector sign-in's (./sign-in-return.ts) and the hosting console's (./console-return.ts). Each listener is its own
// server on its own port: opening or closing one never touches another.
//
// Rules: bound to 127.0.0.1 only, on a port the system picks; a request counts only from the address it was asked at
// (Host 127.0.0.1:<port>), as a page the browser opens (Sec-Fetch-Mode navigate and Sec-Fetch-Dest document when the
// browser sends them: never a fetch, an image or a frame of another page). Pure apart from node:http.
import { createServer, type IncomingMessage, type Server } from 'node:http'

export const LOOPBACK_HOST = '127.0.0.1'

/** Whether the browser opens it as a page: Sec-Fetch-Mode navigate and Sec-Fetch-Dest document, when it says (a
 * browser without Fetch Metadata, or a non-browser, sends neither and is let through) */
export function navigation(headers: Record<string, string | string[] | undefined>): boolean {
  const mode = headers['sec-fetch-mode'], dest = headers['sec-fetch-dest']
  return (mode === undefined || mode === 'navigate') && (dest === undefined || dest === 'document')
}

/** a GET page load sent to exactly the address the listener was opened at */
export function ownPageLoad(req: IncomingMessage, port: number): boolean {
  return req.method === 'GET' && req.headers.host === `${LOOPBACK_HOST}:${port}` && navigation(req.headers)
}

/** A new server listening on 127.0.0.1 at a port the system picks, with short request timeouts; null when none can be
 * opened. */
export async function listenLoopback(): Promise<{ server: Server; port: number } | null> {
  const server = createServer({ maxHeaderSize: 16 * 1024 })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ port: 0, host: LOOPBACK_HOST, exclusive: true }, () => resolve())
    })
  } catch {
    server.close()
    return null
  }
  const addr = server.address()
  if (!addr || typeof addr === 'string' || addr.address !== LOOPBACK_HOST) {
    server.close()
    return null
  }
  return { server, port: addr.port }
}

/** Close a listener and the connections it still holds (a browser keeps one open). */
export function closeLoopback(server: Server) {
  server.close()
  ;(server as Server & { closeAllConnections?: () => void }).closeAllConnections?.()
}

/** The small page the browser shows after a return: the words come from the app (its language). */
export function donePage(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc}</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;min-height:90vh;align-items:center;justify-content:center;color:#14110f;background:#fcfbf8}@media (prefers-color-scheme:dark){body{color:#f2ede6;background:#171411}}</style></head><body><p>${esc}</p></body></html>`
}

/** The headers of that page: nothing loads, nothing is kept. */
export const DONE_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  Connection: 'close',
} as const
