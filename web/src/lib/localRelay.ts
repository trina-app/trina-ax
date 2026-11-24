// local.call → the desktop app's apps on this computer (DesktopBridge.localApps) → local.result over the WebSocket
// (docs/decisions/20261118-local-app-connectors.md). The server sends each call only to the window the turn was sent
// from (or that asked for the Settings check) and sends it again after a reconnect until the window acks it: a call
// is run once here, a repeated one gets its ack or its kept result. A window without the desktop app (a browser, the
// phone app) answers at once with not_desktop, and a desktop app too old for these calls with too_old, so the server
// can tell the AI in plain words instead of waiting for the deadline.
import { LOCAL_APPS_BRIDGE_VERSION, type ClientFrame, type LocalCall, type LocalResult } from '@mycel/shared/api'
import { desktop, type DesktopBridge } from './desktop'
import { t } from '../i18n'
import { toast, useUi } from '../store/ui'

const KEEP = 100
const KEEP_CHARS = 32 * 1024 * 1024

export class LocalRelay {
  private done = new Map<string, { r: LocalResult; size: number }>()
  private doneChars = 0
  private inFlight = new Set<string>()

  constructor(private send: (f: ClientFrame) => void, private app: () => DesktopBridge | null = desktop) {}

  private out(f: ClientFrame) {
    // a closed WebSocket throws: the result stays kept and goes out again when the call is sent again
    try { this.send(f) } catch { /* see above */ }
  }

  private keep(r: LocalResult) {
    const size = JSON.stringify(r).length
    this.done.set(r.callId, { r, size })
    this.doneChars += size
    while (this.done.size > 1 && (this.done.size > KEEP || this.doneChars > KEEP_CHARS)) {
      const [k, e] = this.done.entries().next().value as [string, { size: number }]
      this.done.delete(k)
      this.doneChars -= e.size
    }
  }

  handleCall(call: LocalCall) {
    const kept = this.done.get(call.callId)
    if (kept) return this.out({ type: 'local.result', result: kept.r })
    if (this.inFlight.has(call.callId)) return this.out({ type: 'local.ack', callId: call.callId })
    this.inFlight.add(call.callId)
    this.out({ type: 'local.ack', callId: call.callId })
    const finish = (r: LocalResult) => {
      this.inFlight.delete(call.callId)
      const result: LocalResult = { ...r, callId: call.callId }
      this.keep(result)
      this.out({ type: 'local.result', result })
    }
    const bridge = this.app()
    const apps = bridge?.localApps
    if (!bridge) return finish({ callId: call.callId, ok: false, failure: 'not_desktop', error: 'this window is not the desktop app' })
    if (!apps || apps.version < LOCAL_APPS_BRIDGE_VERSION) return finish({ callId: call.callId, ok: false, failure: 'too_old', error: 'the desktop app is too old for apps on this computer' })
    let p: Promise<LocalResult>
    try { p = apps.run(call) } catch (e) { p = Promise.reject(e) }
    p.then(finish, (e: unknown) => finish({ callId: call.callId, ok: false, failure: 'failed', error: e instanceof Error ? e.message.slice(0, 500) : 'the desktop app failed' }))
  }

  cancel(callId: string) {
    if (this.inFlight.has(callId)) this.app()?.localApps?.cancel(callId)
  }
}

/** While the desktop app's own "Connect a program" window waits for the person (a turn's first call of a new command),
 * a notice in this window says so: that window can sit behind others, and the chat only spun meanwhile (QA on Windows,
 * 2026-11-24). It goes when the window is answered or closed. Returns the stop. */
export function watchLocalAsking(app: () => DesktopBridge | null = desktop): () => void {
  const apps = app()?.localApps
  if (!apps?.onAsking) return () => {}
  const shown = new Map<string, number>()
  const off = apps.onAsking((s) => {
    if (!s || typeof s.id !== 'string') return
    const was = shown.get(s.id)
    if (was !== undefined) { useUi.getState().dismiss(was); shown.delete(s.id) }
    if (s.asking) shown.set(s.id, toast({ level: 'info', sticky: true, text: t('localApps.asking', { name: String(s.name ?? '').slice(0, 60) }) }))
  })
  return () => { off(); for (const id of shown.values()) useUi.getState().dismiss(id); shown.clear() }
}
