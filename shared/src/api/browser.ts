// In-app browser (desktop app's Browser pane, driven over CDP; tab 5). The server sends browser.call over the
// WebSocket to the window that sent the turn and waits for browser.result. When WebSockets are blocked (company
// proxies) the window long-polls these endpoints instead. Owner: B (server/src/routes/browser.ts).
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { endpoint, empty, stream } from './endpoint'

/** Tool names as the engine sees them (same set as the Claude desktop app; ported from Saram desktop/pane-tools). */
export const BrowserToolName = z.enum([
  'navigate', 'read_page', 'find', 'get_page_text', 'computer', 'form_input', 'javascript_tool',
  'read_console_messages', 'read_network_requests', 'resize_window',
  'tabs_context', 'tabs_create', 'tabs_select', 'tabs_close', 'browser_batch', 'preview_start', 'file_upload',
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
  /** the person's "Allow all websites" is on: every public site is allowed (the person's Chrome reads it; the desktop app
   * keeps its own copy of the setting) */
  anySite: z.literal(true).optional(),
  /** the run this call belongs to (a chat, or a scheduled task's run): the person's Chrome gives each run its own background
   * window and tab group named after it, and one run never sees another's tabs (docs/decisions/20261128-trina-in-chrome.md) */
  run: z.object({ id: z.string().min(1).max(100), title: z.string().max(80) }).optional(),
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
  /** the person's Chrome did nothing because the call needs this site (host) and nobody allowed it: the server asks the
   * person on its site card and sends the call again (docs/decisions/20261128-trina-in-chrome.md). `office`: an
   * office-network address. */
  needSite: z.object({ host: BrowserSiteKey, office: z.boolean().optional() }).optional(),
  /** the person stopped this call's run in their Chrome (the popup's Stop, closing its window or the debugging bar): an
   * MCP app's connection pauses its browser calls (docs/decisions/20261128-mcp-browser-tools.md). An older extension
   * leaves it out. */
  stopped: z.boolean().optional(),
})
export type BrowserResult = z.infer<typeof BrowserResult>

/** `pane`: the desktop app's in-app browser version (DesktopBridge.browser.version, BROWSER_BRIDGE_VERSION), as on
 * /api/ws: the server offers file_upload only to a window that said 1 or more (an older app cannot parse it) */
export const PollQuery = z.object({ windowId: z.string().min(8).max(64), waitMs: z.coerce.number().int().min(0).max(25_000).optional(), pane: z.coerce.number().int().min(0).max(1000).optional() })

/** A file the AI attaches in the in-app browser (file_upload): the desktop app fetches it once from
 * GET /api/browser/uploads/:ticket (BROWSER.upload) through the team page's session, checks its size and sha256, and
 * sets it on the page's file field (docs/decisions/20261126-browser-file-upload.md). */
export const BROWSER_UPLOAD_PATH = '/api/browser/uploads'
/** a ticket: 32 random bytes, base64url */
export const BrowserUploadTicket = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
/** at most this many files and bytes in one file_upload call */
export const BROWSER_UPLOAD_MAX_FILES = 20
export const BROWSER_UPLOAD_MAX_BYTES = 100_000_000

export const BROWSER = {
  pollCalls: endpoint({ method: 'GET', path: '/api/browser/calls', auth: 'user', owner: 'B', query: PollQuery, response: z.object({ calls: z.array(BrowserCall) }), summary: 'Long-poll fallback: pending browser.call for this window (waits up to waitMs).' }),
  /** the bytes behind a file_upload ticket (single use, the person's own, until the call's deadline); any failure is 404 */
  browserUpload: endpoint({ method: 'GET', path: `${BROWSER_UPLOAD_PATH}/:ticket`, auth: 'user', owner: 'B', response: stream(false), summary: 'One file of a file_upload call for the desktop app (application/octet-stream, single use).' }),
  postResult: endpoint({ method: 'POST', path: '/api/browser/results', auth: 'user', owner: 'B', body: BrowserResult, response: empty, status: 204, summary: 'Long-poll fallback: browser.result.' }),
} as const
