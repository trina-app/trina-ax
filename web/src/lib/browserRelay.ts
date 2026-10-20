// browser.call → this window's in-app Browser pane (desktop app) → browser.result over the WebSocket.
// The server sends each call only to the window that sent the turn and may re-send it after a reconnect, so calls
// are deduped by callId. A window without the pane (plain browser, PWA) answers at once with an error the AI can
// act on, instead of letting the turn wait for the deadline.
import type { BrowserCall, BrowserResult, ClientFrame } from '@mycel/shared/api'
import { desktop, type DesktopApi, type DesktopToolResult } from './desktop'

const SEEN_MAX = 500

export const NO_PANE_ERROR = 'This window has no in-app browser. The person is using the web or mobile app; the browser tools work only in the Team AX desktop app.'

export function toBrowserResult(callId: string, r: DesktopToolResult): BrowserResult {
  const content: BrowserResult['content'] = []
  for (const c of r.content.slice(0, 20)) {
    if (c.type === 'text') content.push({ type: 'text', text: c.text.slice(0, 2_000_000) })
    else if (c.mimeType === 'image/png' || c.mimeType === 'image/jpeg' || c.mimeType === 'image/webp') content.push({ type: 'image', mime: c.mimeType, data: c.data, shareToChat: c.shareToChat })
  }
  const errText = r.isError ? r.content.find((c) => c.type === 'text')?.text : undefined
  return { callId, ok: !r.isError, content, error: errText ? errText.slice(0, 4000) : undefined }
}

export class BrowserRelay {
  private seen = new Set<string>()
  private running = new Map<string, string>() // callId -> chatId

  constructor(private send: (f: ClientFrame) => void, private app: () => DesktopApi | undefined = desktop) {}

  handleCall(call: BrowserCall) {
    if (this.seen.has(call.callId)) return
    this.seen.add(call.callId)
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!)
    this.send({ type: 'browser.ack', callId: call.callId })
    const app = this.app()
    if (!app) {
      this.send({ type: 'browser.result', result: { callId: call.callId, ok: false, content: [], error: NO_PANE_ERROR } })
      return
    }
    if (Date.now() > call.deadline) return
    this.running.set(call.callId, call.chatId)
    void app.browser
      .call(call.chatId, call.tool, call.args, call.callId)
      .catch((e: unknown): DesktopToolResult => ({ content: [{ type: 'text', text: `Browser pane error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }))
      .then((r) => {
        if (!this.running.delete(call.callId)) return // cancelled meanwhile
        this.send({ type: 'browser.result', result: toBrowserResult(call.callId, r) })
      })
  }

  cancel(callId: string) {
    if (!this.running.delete(callId)) return
    this.app()?.browser.cancel(callId)
  }
}
