// In-app browser (desktop app's Browser pane, driven over CDP; tab 5). The server sends browser.call over the
// WebSocket to the window that sent the turn and waits for browser.result. When WebSockets are blocked (company
// proxies) the window long-polls these endpoints instead. Owner: B (server/src/routes/browser.ts).
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { endpoint, empty } from './endpoint'

/** Tool names as the engine sees them (same set as the Claude desktop app; ported from Saram desktop/pane-tools). */
export const BrowserToolName = z.enum([
  'navigate', 'read_page', 'find', 'get_page_text', 'computer', 'form_input', 'javascript_tool',
  'read_console_messages', 'read_network_requests', 'resize_window',
  'tabs_context', 'tabs_create', 'tabs_select', 'tabs_close', 'browser_batch', 'preview_start',
])
export type BrowserToolName = z.infer<typeof BrowserToolName>

export const BrowserCall = z.object({
  /** unique per call; the window must not run the same callId twice (dedupe after reconnects) */
  callId: z.string().min(1).max(100),
  turnId: Uuid7,
  chatId: Uuid7,
  tool: BrowserToolName,
  /** tool input exactly as the engine sent it (validated by the desktop app against its own schemas) */
  args: z.record(z.string(), z.unknown()),
  /** epoch ms after which the server stops waiting */
  deadline: z.number().int(),
})
export type BrowserCall = z.infer<typeof BrowserCall>

export const BrowserResultContent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(2_000_000) }),
  /** screenshots: base64 PNG/JPEG; shareToChat = the AI asked to show it in the answer */
  z.object({ type: z.literal('image'), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string().max(20_000_000), shareToChat: z.boolean().optional() }),
])
export const BrowserResult = z.object({
  callId: z.string().min(1).max(100),
  ok: z.boolean(),
  content: z.array(BrowserResultContent).max(20),
  error: z.string().max(4000).optional(),
})
export type BrowserResult = z.infer<typeof BrowserResult>

export const PollQuery = z.object({ windowId: z.string().min(8).max(64), waitMs: z.coerce.number().int().min(0).max(25_000).optional() })

export const BROWSER = {
  pollCalls: endpoint({ method: 'GET', path: '/api/browser/calls', auth: 'user', owner: 'B', query: PollQuery, response: z.object({ calls: z.array(BrowserCall) }), summary: 'Long-poll fallback: pending browser.call for this window (waits up to waitMs).' }),
  postResult: endpoint({ method: 'POST', path: '/api/browser/results', auth: 'user', owner: 'B', body: BrowserResult, response: empty, status: 204, summary: 'Long-poll fallback: browser.result.' }),
} as const
