// Stand-in for the team web page (component D) in the desktop e2e tests: opens /api/ws with a windowId, feeds
// every server frame to the shared createBrowserRelay (shared/src/desktop-bridge.ts) exactly like the real web app
// should, and reports what it sees on window.testState.
import { createBrowserRelay, getDesktopBridge } from '@mycel/shared'
import { ServerFrame } from '@mycel/shared/api'

const windowId = `w${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
const bridge = getDesktopBridge()
const state: Record<string, unknown> = { windowId, bridge: Boolean(bridge), ws: 'connecting', frames: 0, frame: null, connection: null }
;(window as unknown as { testState: typeof state }).testState = state
document.getElementById('bridge')!.textContent = bridge ? 'desktop' : 'browser'

window.addEventListener('message', (e) => {
  if (e.data && typeof e.data === 'object' && 'rtc' in e.data) state.frame = e.data
})

if (bridge) {
  void bridge.connection.get().then((c) => (state.connection = c))
  bridge.connection.onChange((c) => (state.connection = c))
}

function connect() {
  const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/ws?windowId=${windowId}`, ['mycel.v1'])
  const relay = bridge ? createBrowserRelay({ bridge, windowId, send: (f) => ws.send(JSON.stringify(f)) }) : null
  ws.onopen = () => (state.ws = 'open')
  ws.onclose = () => {
    state.ws = 'closed'
    setTimeout(connect, 300)
  }
  ws.onmessage = (m) => {
    const frame = ServerFrame.safeParse(JSON.parse(String(m.data)))
    if (!frame.success) return
    state.frames = (state.frames as number) + 1
    relay?.handle(frame.data)
  }
}
connect()
