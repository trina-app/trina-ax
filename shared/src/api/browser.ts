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

/** A site or host as the desktop app's site permissions key it: host[:port] in lower case, without "www." (also a
 * registrable domain such as naver.com, which covers its subdomains there). */
export const BrowserSiteKey = z.string().min(1).max(260).regex(/^[a-z0-9.\-\[\]:_]+$/)
/** At most this many sites in one call (a person's sites for good are listed with every call). */
export const BROWSER_CALL_SITES_MAX = 2000

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
  /** public sites the person already allowed for this call (their sites for good, the address the server's card or their
   * own message just approved): the desktop app opens them for this answer without its own site card (one Always per
   * person, docs/decisions/20261125-one-site-always-desktop-browser.md). An older desktop app ignores it. */
  sites: z.array(BrowserSiteKey).max(BROWSER_CALL_SITES_MAX).optional(),
  /** office-network addresses the person already allowed (the server's office card, for good or for this answer) */
  office: z.array(BrowserSiteKey).max(BROWSER_CALL_SITES_MAX).optional(),
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
  /** what the person answered "Always allow" to on the desktop app's site cards during this call (hosts): the server
   * keeps it as the person's own allowance, so it holds on every computer and on the server's cards too. An older
   * server ignores it. */
  always: z.object({ sites: z.array(BrowserSiteKey).max(50).optional(), office: z.array(BrowserSiteKey).max(50).optional() }).optional(),
})
export type BrowserResult = z.infer<typeof BrowserResult>

export const PollQuery = z.object({ windowId: z.string().min(8).max(64), waitMs: z.coerce.number().int().min(0).max(25_000).optional() })

export const BROWSER = {
  pollCalls: endpoint({ method: 'GET', path: '/api/browser/calls', auth: 'user', owner: 'B', query: PollQuery, response: z.object({ calls: z.array(BrowserCall) }), summary: 'Long-poll fallback: pending browser.call for this window (waits up to waitMs).' }),
  postResult: endpoint({ method: 'POST', path: '/api/browser/results', auth: 'user', owner: 'B', body: BrowserResult, response: empty, status: 204, summary: 'Long-poll fallback: browser.result.' }),
} as const
