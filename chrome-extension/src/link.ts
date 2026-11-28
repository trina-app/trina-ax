// The live connection to the team: one WebSocket (CHROME_WS_PATH, subprotocol CHROME_WS_PROTOCOL). The token goes in
// the first frame, never in the address or a header. A ping every 20 s keeps the MV3 worker awake while Chrome runs;
// an alarm reconnects within a minute after Chrome put the worker to sleep. A revoked link (close 4401) is forgotten.
import { CHROME_WS_PATH, CHROME_WS_PROTOCOL, ChromeServerFrame, ChromeWsClose, type ChromeClientFrame } from '../../shared/src/api/chrome'
import { cancelCall, handleCall } from './calls'
import { forgetLink, live, loadLink, refreshBadge, saveLink } from './state'
import { detachAll } from './tabs'

const PING_MS = 20_000
const MAX_BACKOFF_MS = 30_000

let ws: WebSocket | null = null
let backoff = 1000
let pingTimer: ReturnType<typeof setInterval> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined

/** ws(s)://<team>/api/chrome/ws: wss for https, ws only for a developer's own http://localhost. */
export function socketUrl(origin: string): string | null {
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return null
  }
  if (u.protocol === 'https:') return `wss://${u.host}${CHROME_WS_PATH}`
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return `ws://${u.host}${CHROME_WS_PATH}`
  return null
}

export function send(frame: ChromeClientFrame): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
}

/** Open the connection when linked and not open yet (alarms and wake-ups call this freely). */
export async function connect(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  clearTimeout(retryTimer)
  const link = live.link ?? (await loadLink())
  live.link = link
  refreshBadge()
  if (!link) return
  const url = socketUrl(link.origin)
  if (!url) return
  const sock = new WebSocket(url, [CHROME_WS_PROTOCOL])
  ws = sock
  sock.onopen = () => {
    sock.send(JSON.stringify({ type: 'auth', token: link.token, version: chrome.runtime.getManifest().version} satisfies ChromeClientFrame))
  }
  sock.onmessage = (ev) => {
    let frame: ChromeServerFrame
    try {
      const r = ChromeServerFrame.safeParse(JSON.parse(String(ev.data)))
      if (!r.success) return
      frame = r.data
    } catch {
      return
    }
    switch (frame.type) {
      case 'hello':
        backoff = 1000
        live.online = true
        live.clockOffset = Number.isFinite(frame.serverTime) ? Math.max(-7 * 86_400_000, Math.min(7 * 86_400_000, frame.serverTime - Date.now())) : 0
        if (live.link) {
          live.link = { ...live.link, user: frame.user, team: frame.team, teamHosts: frame.teamHosts, linkId: frame.linkId, ...(frame.label ? { label: frame.label } : {}) }
          void saveLink(live.link)
        }
        clearInterval(pingTimer)
        pingTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), Math.min(PING_MS, frame.pingIntervalMs))
        refreshBadge()
        break
      case 'browser.call':
        handleCall(frame.call, send)
        break
      case 'browser.cancel':
        cancelCall(frame.callId)
        break
      case 'pong':
        break
      case 'label':
        if (live.link) {
          live.link = { ...live.link, label: frame.label }
          void saveLink(live.link)
        }
        break
    }
  }
  sock.onclose = (ev) => {
    if (ws === sock) ws = null
    clearInterval(pingTimer)
    live.online = false
    if (ev.code === ChromeWsClose.revoked) {
      void forgetLocally()
      return
    }
    refreshBadge()
    if (!live.link) return
    retryTimer = setTimeout(() => void connect(), backoff)
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2)
  }
  sock.onerror = () => {
    // onclose follows and schedules the retry
  }
}

/** Rename this profile from the popup (only while connected: the team keeps the name). False when offline. */
export function rename(label: string): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false
  send({ type: 'label', label })
  return true
}

/** The link ends on this Chrome: the token is forgotten and the AI's tabs are let go. */
export async function forgetLocally(): Promise<void> {
  live.link = null
  live.online = false
  clearTimeout(retryTimer)
  clearInterval(pingTimer)
  const old = ws
  ws = null
  try {
    old?.close(1000)
  } catch {
    // already closed
  }
  await forgetLink()
  await detachAll()
  refreshBadge()
}

/** Disconnect in the popup: tell the server when online (it revokes the link), then forget it here anyway. */
export async function unlink(): Promise<void> {
  send({ type: 'unlink' })
  // let the frame leave before the socket closes
  await new Promise((r) => setTimeout(r, 150))
  await forgetLocally()
}

/** A new link from pairing: connect with it at once. */
export async function linked(): Promise<void> {
  const old = ws
  ws = null
  try {
    old?.close(1000)
  } catch {
    // already closed
  }
  live.link = await loadLink()
  backoff = 1000
  await connect()
}
