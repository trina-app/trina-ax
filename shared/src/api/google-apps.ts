// Gmail, Google Calendar, Google Docs and Google Sheets: built-in connectors next to Google Drive
// (docs/GOOGLE-APPS.md). Each is a person's own connection with one Google sign-in per app; the tools come from the
// Google Workspace MCP server this Trina server runs on its own machine. OAuth secrets and tokens never cross this API.
import { z } from 'zod'
import { endpoint, empty } from './endpoint'
import { DriveAccount, DriveFlow, SetDriveClientBody } from './drive'

export const GOOGLE_APP_IDS = ['gmail', 'calendar', 'docs', 'sheets'] as const
export const GoogleAppId = z.enum(GOOGLE_APP_IDS)
export type GoogleAppId = z.infer<typeof GoogleAppId>

/** One tool the AI gets from the app. `changes`: it changes or sends something (asks on a card unless Always allow). */
export const GoogleAppTool = z.object({ name: z.string(), title: z.string(), description: z.string(), changes: z.boolean() })
export type GoogleAppTool = z.infer<typeof GoogleAppTool>

/**
 * A person's view of one app.
 * `available`: the person can connect it now. `reason` when not:
 *  - "not_set_up": no Google app for this card on this server (members: ask an admin; admins: set it up)
 *  - "members_off": the team does not let members connect it (Admin › Connectors)
 *  - "unsupported": this computer cannot run it (the Mac app for now)
 *  - "service_limited": a hosted team whose hosting service's Google app is still in Google's review: only its test
 *    users can sign in (a refused sign-in says so)
 * `serviceDown`: connected, but the tools cannot be reached right now (the AI says so; it comes back by itself).
 * `writePolicy`: "ask" a card before each change, "allow" the person chose Always allow.
 * `tools`: what the AI gets, for "Show all tools" (also when not connected).
 */
export const GoogleAppView = z.object({
  id: GoogleAppId,
  available: z.boolean(),
  reason: z.enum(['not_set_up', 'members_off', 'unsupported', 'service_limited']).nullable(),
  status: z.enum(['disconnected', 'connected', 'needs_reconnect']),
  account: DriveAccount.nullable(),
  writePolicy: z.enum(['ask', 'allow']),
  serviceDown: z.boolean(),
  tools: z.array(GoogleAppTool),
})
export type GoogleAppView = z.infer<typeof GoogleAppView>

/** The same sign-in flow shape as Google Drive's (poll it, then confirm the account). */
export const GoogleAppFlow = DriveFlow
export type GoogleAppFlow = z.infer<typeof GoogleAppFlow>

/** `connectUrl`: on a hosted team, the hosting service's own start page for this sign-in (opened first on the web). */
const Authorization = z.object({ flowId: z.string(), authorizationUrl: z.string().url(), connectUrl: z.string().url().optional(), expiresAt: z.string() })

/**
 * Admin › Connectors, one app.
 * `source`: "app" its own Google app set up here, "drive" the same Google app as Google Drive, "server" set by the
 * operator, "service" a hosted server (signs in through the hosting service), "none".
 * `blocked`: why this page cannot set it up ("hosted", "server", "public_host", "unsupported").
 * `driveAppAvailable`: Google Drive has a Google app this card can use ("Use the same Google app as Drive").
 * `apis`: the Google APIs to switch on in Google Cloud for this card (shown as a checklist).
 * `membersCanConnect`: the team switch, on by default.
 */
export const GoogleAppAdminStatus = z.object({
  id: GoogleAppId,
  configured: z.boolean(),
  source: z.enum(['app', 'drive', 'server', 'service', 'none']),
  canSetUp: z.boolean(),
  blocked: z.enum(['hosted', 'server', 'public_host', 'unsupported']).nullable(),
  redirectUri: z.string().nullable(),
  driveAppAvailable: z.boolean(),
  apis: z.array(z.object({ name: z.string(), url: z.string().url() })),
  membersCanConnect: z.boolean(),
  connectedMembers: z.number().int(),
})
export type GoogleAppAdminStatus = z.infer<typeof GoogleAppAdminStatus>

/** Set up one card: the same Google app as Drive, or its own (the client file, or the ID and secret). */
export const SetGoogleAppClientBody = z.union([
  z.object({ sameAsDrive: z.literal(true) }).strict(),
  SetDriveClientBody,
])

const AppParam = '/:app'
export const GOOGLE_APPS = {
  myGoogleApps: endpoint({ method: 'GET', path: '/api/integrations/google-apps', auth: 'user', owner: 'C', response: z.object({ apps: z.array(GoogleAppView) }), summary: 'Own Gmail, Calendar, Docs and Sheets connections and whether each can be connected; never a token.' }),
  authorizeGoogleApp: endpoint({ method: 'POST', path: `/api/integrations/google-apps${AppParam}/authorize`, auth: 'user', owner: 'C', body: z.object({}), response: Authorization, summary: 'Start the Google sign-in for one app (gmail, calendar, docs or sheets).' }),
  googleAppFlow: endpoint({ method: 'GET', path: `/api/integrations/google-apps${AppParam}/flows/:id`, auth: 'user', owner: 'C', response: GoogleAppFlow, summary: 'Poll the sign-in started by this same signed-in session.' }),
  completeGoogleAppFlow: endpoint({ method: 'POST', path: `/api/integrations/google-apps${AppParam}/flows/:id/complete`, auth: 'user', owner: 'C', body: z.object({}).strict(), response: GoogleAppView, summary: 'Confirm the Google account shown by this sign-in; the app is connected.' }),
  cancelGoogleAppFlow: endpoint({ method: 'DELETE', path: `/api/integrations/google-apps${AppParam}/flows/:id`, auth: 'user', owner: 'C', response: empty, status: 204, summary: 'Cancel this own sign-in.' }),
  updateGoogleApp: endpoint({ method: 'PATCH', path: `/api/integrations/google-apps${AppParam}`, auth: 'user', owner: 'C', body: z.object({ writePolicy: z.enum(['ask', 'allow']) }).strict(), response: GoogleAppView, summary: "Ask before each change, or Always allow, for the person's own connection." }),
  disconnectGoogleApp: endpoint({ method: 'DELETE', path: `/api/integrations/google-apps${AppParam}`, auth: 'user', owner: 'C', response: z.object({ disconnected: z.literal(true), revocation: z.enum(['revoked', 'unavailable', 'not_needed']) }), summary: "Remove this app's sign-in at once; Google is asked to revoke only when it was the person's last Google sign-in here." }),
  googleAppsAdminStatus: endpoint({ method: 'GET', path: '/api/admin/google-apps', auth: 'admin', owner: 'C', response: z.object({ apps: z.array(GoogleAppAdminStatus) }), summary: 'Whether each Google app is set up, by whom, the APIs to switch on, the team switch and how many members connected; never the client.' }),
  setGoogleAppClient: endpoint({ method: 'PUT', path: `/api/admin/google-apps${AppParam}/client`, auth: 'admin', owner: 'C', body: SetGoogleAppClientBody, response: GoogleAppAdminStatus, summary: "Set up one app with the same Google app as Google Drive, or its own Google OAuth web client. Refused on hosted servers, without a public address, when the operator set it, and where it cannot run." }),
  setGoogleAppMembers: endpoint({ method: 'PUT', path: `/api/admin/google-apps${AppParam}/members`, auth: 'admin', owner: 'C', body: z.object({ on: z.boolean() }).strict(), response: GoogleAppAdminStatus, summary: 'Let members connect their own account for this app, or not (off: their connections are not used and none can be made).' }),
} as const
