// Gmail, Google Calendar, Google Docs and Google Sheets for the mock team server: an in-memory version of the server's
// Google apps (shared/src/api/google-apps.ts) with the same contract. Nothing is set up on a fresh server ("not_set_up");
// tests set things up through Admin › Connectors or POST /__test/google-apps {app?, client?: 'none' | 'app' | 'drive',
// members?: boolean, reason?: 'unsupported' | 'service_limited' | null, blocked?, connect?: {userId, status?, serviceDown?,
// writePolicy?}}. A sign-in is pending once, then ready with the person's synthetic account. Never a token.
import type { GoogleAppAdminStatus, GoogleAppId, GoogleAppTool, GoogleAppView } from '@mycel/shared/api'

type Reason = 'unsupported' | 'service_limited'
type Blocked = GoogleAppAdminStatus['blocked']
interface Conn { status: 'connected' | 'needs_reconnect'; account: { name: string | null; email: string | null }; writePolicy: 'ask' | 'allow'; serviceDown: boolean }
interface App { client: 'none' | 'app' | 'drive'; members: boolean; reason: Reason | null; blocked: Blocked; conns: Map<string, Conn> }

export const GOOGLE_APP_IDS: GoogleAppId[] = ['gmail', 'calendar', 'docs', 'sheets']

const tool = (name: string, title: string, description: string, changes = false): GoogleAppTool => ({ name, title, description, changes })
export const MOCK_GOOGLE_TOOLS: Record<GoogleAppId, GoogleAppTool[]> = {
  gmail: [
    tool('search_gmail_messages', 'Search mail', 'Find emails by sender, subject, date or words in them.'),
    tool('get_gmail_message_content', 'Read an email', 'Read one email with its sender, date and text.'),
    tool('get_gmail_attachment_content', 'Read an attachment', 'Read a file attached to an email.'),
    tool('draft_gmail_message', 'Draft an email', 'Save a draft in Gmail.', true),
    tool('send_gmail_message', 'Send an email', 'Send an email from your Gmail.', true),
    tool('modify_gmail_message_labels', 'Label or archive', 'Add or remove labels, archive or mark as read.', true),
  ],
  calendar: [
    tool('list_calendars', 'List calendars', 'The calendars you can see.'),
    tool('get_events', 'Read events', 'Events in a time range.'),
    tool('manage_event', 'Add or change an event', 'Create, move or delete an event.', true),
  ],
  docs: [
    tool('search_docs', 'Find docs', 'Find Google Docs by name.'),
    tool('get_doc_content', 'Read a doc', 'Read a doc with its headings and tables.'),
    tool('create_doc', 'Create a doc', 'Make a new Google Doc.', true),
    tool('modify_doc_text', 'Edit a doc', 'Insert, replace or format text in a doc.', true),
  ],
  sheets: [
    tool('list_spreadsheets', 'Find sheets', 'Find Google Sheets by name.'),
    tool('read_sheet_values', 'Read cells', 'Read the cells of a range.'),
    tool('modify_sheet_values', 'Change cells', 'Write, add or clear cells.', true),
    tool('create_spreadsheet', 'Create a sheet', 'Make a new Google Sheet.', true),
  ],
}
const APIS: Record<GoogleAppId, { name: string; url: string }[]> = {
  gmail: [{ name: 'Gmail API', url: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com' }],
  calendar: [{ name: 'Google Calendar API', url: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com' }],
  docs: [{ name: 'Google Docs API', url: 'https://console.cloud.google.com/apis/library/docs.googleapis.com' }, { name: 'Google Drive API', url: 'https://console.cloud.google.com/apis/library/drive.googleapis.com' }],
  sheets: [{ name: 'Google Sheets API', url: 'https://console.cloud.google.com/apis/library/sheets.googleapis.com' }, { name: 'Google Drive API', url: 'https://console.cloud.google.com/apis/library/drive.googleapis.com' }],
}
const fresh = (): App => ({ client: 'none', members: true, reason: null, blocked: null, conns: new Map() })

export class MockGoogleApps {
  apps = new Map<GoogleAppId, App>(GOOGLE_APP_IDS.map((id) => [id, fresh()]))
  flows = new Map<string, { app: GoogleAppId; userId: string; polls: number; account: Conn['account'] }>()

  reset() {
    this.apps = new Map(GOOGLE_APP_IDS.map((id) => [id, fresh()]))
    this.flows.clear()
  }
  app(id: string): App | null { return this.apps.get(id as GoogleAppId) ?? null }

  reasonOf(a: App): GoogleAppView['reason'] {
    if (a.reason) return a.reason
    if (a.client === 'none') return 'not_set_up'
    return a.members ? null : 'members_off'
  }
  view(id: GoogleAppId, userId: string): GoogleAppView {
    const a = this.apps.get(id)!
    const c = a.conns.get(userId)
    const reason = this.reasonOf(a)
    return { id, available: reason === null, reason, status: c?.status ?? 'disconnected', account: c?.account ?? null, writePolicy: c?.writePolicy ?? 'ask', serviceDown: !!c?.serviceDown, tools: MOCK_GOOGLE_TOOLS[id] }
  }
  list(userId: string) { return { apps: GOOGLE_APP_IDS.map((id) => this.view(id, userId)) } }
  adminStatus(id: GoogleAppId, driveAppAvailable: boolean): GoogleAppAdminStatus {
    const a = this.apps.get(id)!
    const configured = a.client !== 'none'
    return {
      id, configured, source: a.client === 'drive' ? 'drive' : a.client === 'app' ? 'app' : 'none', canSetUp: a.blocked === null, blocked: a.blocked,
      redirectUri: a.blocked ? null : 'https://team.example.test/api/integrations/google-apps/callback', driveAppAvailable,
      apis: APIS[id], membersCanConnect: a.members, connectedMembers: [...a.conns.values()].filter((c) => c.status === 'connected').length,
    }
  }
  /** a sign-in starts: null when this person may not connect it now */
  authorize(id: GoogleAppId, userId: string, account: Conn['account']) {
    if (!this.view(id, userId).available) return null
    const flowId = `gapp-${id}-${crypto.randomUUID()}`
    this.flows.set(flowId, { app: id, userId, polls: 0, account })
    return { flowId, authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-${id}`, expiresAt: new Date(Date.now() + 600_000).toISOString() }
  }
  poll(id: GoogleAppId, flowId: string, userId: string) {
    const f = this.flows.get(flowId)
    if (!f || f.app !== id || f.userId !== userId) return null
    return { flowId, state: f.polls++ < 1 ? 'pending' as const : 'ready' as const, account: f.polls > 1 ? f.account : null, expiresAt: new Date(Date.now() + 600_000).toISOString(), reason: null }
  }
  complete(id: GoogleAppId, flowId: string, userId: string) {
    const f = this.flows.get(flowId)
    if (!f || f.app !== id || f.userId !== userId) return null
    this.flows.delete(flowId)
    const a = this.apps.get(id)!
    a.conns.set(userId, { status: 'connected', account: f.account, writePolicy: a.conns.get(userId)?.writePolicy ?? 'ask', serviceDown: false })
    return this.view(id, userId)
  }
  cancel(flowId: string) { this.flows.delete(flowId) }
  /** Disconnect: Google is asked to revoke only when it was the person's last Google sign-in here (Drive aside) */
  disconnect(id: GoogleAppId, userId: string) {
    this.apps.get(id)!.conns.delete(userId)
    const others = GOOGLE_APP_IDS.some((x) => this.apps.get(x)!.conns.has(userId))
    return { disconnected: true as const, revocation: others ? 'not_needed' as const : 'revoked' as const }
  }
  /** POST /__test/google-apps */
  control(body: Record<string, unknown>) {
    const ids = typeof body.app === 'string' ? [body.app as GoogleAppId] : GOOGLE_APP_IDS
    for (const id of ids) {
      const a = this.apps.get(id)
      if (!a) continue
      if (body.client === 'none' || body.client === 'app' || body.client === 'drive') a.client = body.client
      if (typeof body.members === 'boolean') a.members = body.members
      if ('reason' in body) a.reason = (body.reason as Reason | null) ?? null
      if ('blocked' in body) a.blocked = (body.blocked as Blocked) ?? null
      const c = body.connect as { userId: string; name?: string; email?: string; status?: Conn['status']; serviceDown?: boolean; writePolicy?: Conn['writePolicy'] } | undefined
      if (c) a.conns.set(c.userId, { status: c.status ?? 'connected', account: { name: c.name ?? 'Fixture', email: c.email ?? 'fixture@example.test' }, writePolicy: c.writePolicy ?? 'ask', serviceDown: !!c.serviceDown })
    }
  }
}
