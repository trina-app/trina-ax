// connect_service for Gmail, Google Calendar, Google Docs or Google Sheets (docs/GOOGLE-APPS.md): these are built-in
// Google apps, connected on their own page (Settings › Connectors › the app: Connect, then Google's sign-in), never by an
// address. Asked to add a Calendar event, the AI searched the web for Google's preview MCP endpoint, filled in an
// unknown service at calendarmcp.googleapis.com (which cannot sign in without the team's own Google app,
// docs/INTEGRATIONS.md "Your own app"), cited "Calendar MCP server" pages to the person and asked for the event's length
// and place before anything was connected (AI scenario CON-01.calendar, 2026-11-17). The tool now answers for these
// four by name, or by a Google API address, with the app's real state and the one next step; no card.
import type { GoogleAppId, GoogleAppView, Locale } from '@mycel/shared/api'
import { SCREEN } from '../policy/refusal'

/** What people type for each app (spaces, dots and dashes ignored, any letter case): English and Korean names. */
const NAMES: Record<GoogleAppId, readonly string[]> = {
  gmail: ['gmail', 'googlemail', 'googlegmail', '지메일', '구글메일', '구글지메일'],
  calendar: ['googlecalendar', 'gcal', 'googlecal', '구글캘린더', '구글달력', '구글일정', 'googleカレンダー', '谷歌日历'],
  docs: ['googledocs', 'googledoc', 'googledocuments', '구글문서', '구글독스', '구글닥스', 'googleドキュメント'],
  sheets: ['googlesheets', 'googlesheet', 'googlespreadsheets', '구글시트', '구글스프레드시트', 'googleスプレッドシート'],
}
const squash = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s._\-·]+/g, '')

/** The built-in Google app this connect_service call is for: by its name, or by an address at googleapis.com that
 * names it (gmailmcp.googleapis.com, calendar-json.googleapis.com, www.googleapis.com/calendar/…). Null otherwise. */
export function googleAppAsked(name: string | undefined, url: string | undefined): GoogleAppId | null {
  const n = name ? squash(name) : ''
  for (const [app, names] of Object.entries(NAMES) as [GoogleAppId, readonly string[]][]) if (names.includes(n)) return app
  if (!url) return null
  let u: URL
  try { u = new URL(url) } catch { return null }
  const host = u.hostname.toLowerCase()
  if (host !== 'googleapis.com' && !host.endsWith('.googleapis.com')) return null
  const where = `${host}${u.pathname.toLowerCase()}`
  return /gmail/.test(where) ? 'gmail' : /calendar/.test(where) ? 'calendar' : /docs|documents/.test(where) ? 'docs' : /sheets|spreadsheets/.test(where) ? 'sheets' : null
}

/** What the AI is told, by the app's state for this person (GoogleApps.view). `connected` true: not a refusal. */
export function googleAppWay(app: { name: string; status: GoogleAppView['status']; reason: GoogleAppView['reason']; serviceDown?: boolean; shared?: { status: 'connected' | 'needs_reconnect' } | null }, admin: boolean, L: Locale): { text: string; connected: boolean } {
  const page = SCREEN.connectors(L, app.name)
  const builtIn = `${app.name} is one of the app's built-in Google apps: it connects on its own page, never with connect_service or an address (do not look one up).`
  const meanwhile = 'Ask nothing about the task until it is connected, and offer what you can do now (a draft, or the details for them to add themselves).'
  const tools = 'Its tools are yours in this chat; if you do not have them now, from the person\'s next message.'
  // connected but its tools cannot be reached right now (GoogleAppView.serviceDown): it comes back by itself
  if (app.status === 'connected' && app.serviceDown) return { connected: false, text: `${app.name} is connected for this person, but it is not answering right now; it comes back by itself. Next step: say so in one sentence and offer to try again in a while. ${meanwhile}` }
  if (app.status === 'connected') return { connected: true, text: `${app.name} is already connected for this person. ${tools}` }
  // the team's shared account this person may use (Admin › Connected apps): it is theirs too, nothing to connect
  if (app.shared?.status === 'connected') return { connected: true, text: `${app.name} is connected for this person through the team's shared account. ${tools}` }
  if (app.shared?.status === 'needs_reconnect' && app.status === 'disconnected') return { connected: false, text: `${builtIn} The team's shared ${app.name} account this person uses needs a new sign-in: ${admin ? `they do it in ${SCREEN.adminMcp(L)} › ${app.name}` : 'the owner or an admin does it'}; they can also connect their own account in ${page}. Next step: tell them so in one or two sentences. ${meanwhile}` }
  if (app.status === 'needs_reconnect') return { connected: false, text: `${builtIn} It needs a new sign-in: the person presses Reconnect in ${page}. Next step: tell them so in one sentence. ${meanwhile}` }
  if (app.reason === 'unsupported') return { connected: false, text: `${builtIn} It is not available on this team's app yet, so nobody can connect it now. Next step: say so plainly in one sentence, with no technical words. ${meanwhile}` }
  if (app.reason === 'service_limited') return { connected: false, text: `${builtIn} It is not open to everyone yet (it opens once Google has approved it), so it cannot be connected now. Next step: say so plainly in one sentence. ${meanwhile}` }
  if (app.reason === 'not_set_up' || app.reason === 'members_off') {
    return { connected: false, text: `${builtIn} It is not set up for this team yet. Next step: ${admin
      ? `tell the user, in one or two sentences, that they set it up once in ${SCREEN.adminMcp(L)} › ${app.name} (Set up), then connect their own account in ${page}.`
      : `tell the user in one sentence that the owner or an admin has to set it up first; its page, ${page}, has a button to ask them.`} ${meanwhile}` }
  }
  return { connected: false, text: `${builtIn} Next step: tell the user in one or two plain sentences to open ${page}, press Connect and sign in with their Google account, then ask you again. ${meanwhile}` }
}

/** An owner or admin asked for one that is not connected for them and can be connected now: a card offers Connect for
 * the team (the dialog of Admin › Connected apps, a shared Google account) beside their own on its page (#253), as the
 * welcome tools step does. A member keeps the words above (their own on its page); so does an app that is connected
 * (for them, or through the team's account they may use), not answering, needing their own new sign-in, or not
 * available. A team account that needs a new sign-in gets the card too: its dialog signs it in again. */
export function googleAppTeamCard(app: { status: GoogleAppView['status']; reason: GoogleAppView['reason']; shared?: { status: 'connected' | 'needs_reconnect' } | null }, admin: boolean): boolean {
  return admin && app.status === 'disconnected' && app.reason === null && app.shared?.status !== 'connected'
}
