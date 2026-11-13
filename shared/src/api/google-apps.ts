// Gmail, Google Calendar, Google Docs and Google Sheets: built-in connectors next to Google Drive
// (docs/GOOGLE-APPS.md). Each is a person's own connection with one Google sign-in per app; the tools come from the
// Google Workspace MCP server this Trina server runs on its own machine. OAuth secrets and tokens never cross this API.
import { z } from 'zod'
import { endpoint, empty } from './endpoint'
import { DriveAccount, DriveFlow, SetDriveClientBody } from './drive'
import { IntegrationAccess } from './integrations'

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
 *  - "members_off": unused since 2026-11-12 (no members' switch); kept so an older app still parses an older server
 *  - "unsupported": this computer cannot run it (the Mac app for now)
 *  - "service_limited": a hosted team whose hosting service's Google app is still in Google's review: only its test
 *    users can sign in (a refused sign-in says so)
 * `serviceDown`: connected, but the tools cannot be reached right now (the AI says so; it comes back by itself).
 * `writePolicy`: "ask" a card before each change, "allow" the person chose Always allow.
 * `tools`: what the AI gets, for "Show all tools" (also when not connected).
 * `shared`: the team's shared account for this app (an owner or admin connected it, docs/GOOGLE-APPS.md "Shared with
 *   the team"), only when its rule includes this person; null otherwise (also for an admin it does not include). An
 *   older server sends none.
 */
export const GoogleAppShared = z.object({
  /** the shared connection's id (DELETE /api/integrations/:id/always-allow ends this person's own Always allow there) */
  id: z.string(),
  account: DriveAccount,
  status: z.enum(['connected', 'needs_reconnect']),
  /** this person chose Always allow on a card for the shared account (their own choice; the team's rule asks) */
  alwaysAllowed: z.boolean(),
})
export type GoogleAppShared = z.infer<typeof GoogleAppShared>
export const GoogleAppView = z.object({
  id: GoogleAppId,
  available: z.boolean(),
  reason: z.enum(['not_set_up', 'members_off', 'unsupported', 'service_limited']).nullable(),
  status: z.enum(['disconnected', 'connected', 'needs_reconnect']),
  account: DriveAccount.nullable(),
  writePolicy: z.enum(['ask', 'allow']),
  serviceDown: z.boolean(),
  tools: z.array(GoogleAppTool),
  shared: GoogleAppShared.nullable().optional(),
})
export type GoogleAppView = z.infer<typeof GoogleAppView>

/** The same sign-in flow shape as Google Drive's (poll it, then confirm the account). */
export const GoogleAppFlow = DriveFlow
export type GoogleAppFlow = z.infer<typeof GoogleAppFlow>

/**
 * The team's shared account for one app, as owners and admins see it: one Google account connected once, used by the
 * people its rule includes (the same rule as a team connection's) without connecting their own. `usedBy`: how many
 * active people the rule includes now. `connectedBy`: who signed it in. `id`: the shared connection (a dialog that made
 * it removes only that one). Never a token.
 */
export const GoogleAppTeam = z.object({
  id: z.string(),
  status: z.enum(['connected', 'needs_reconnect']),
  account: DriveAccount,
  access: IntegrationAccess,
  usedBy: z.number().int(),
  connectedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  connectedAt: z.string(),
})
export type GoogleAppTeam = z.infer<typeof GoogleAppTeam>

/** `connectUrl`: on a hosted team, the hosting service's own start page for this sign-in (opened first on the web). */
const Authorization = z.object({ flowId: z.string(), authorizationUrl: z.string().url(), connectUrl: z.string().url().optional(), expiresAt: z.string() })

/**
 * Admin › Connectors, one app.
 * `source`: "app" its own Google app set up here, "drive" the same Google app as Google Drive, "server" set by the
 * operator, "service" a hosted server (signs in through the hosting service), "none".
 * `blocked`: why this page cannot set it up ("hosted", "server", "public_host", "unsupported").
 * `driveAppAvailable`: Google Drive has a Google app this card can use ("Use the same Google app as Drive").
 * `apis`: the Google APIs to switch on in Google Cloud for this card (shown as a checklist).
 * `membersCanConnect`: always true (no members' switch since 2026-11-12, docs/DECISIONS.md "No members' switch for
 *   connectors"); kept for older apps.
 * `team`: the shared account an owner or admin connected for the team (GoogleAppTeam), or null. An older server sends
 *   none.
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
  team: GoogleAppTeam.nullable().optional(),
})
export type GoogleAppAdminStatus = z.infer<typeof GoogleAppAdminStatus>

/** Set up one card: the same Google app as Drive, or its own (the client file, or the ID and secret). */
export const SetGoogleAppClientBody = z.union([
  z.object({ sameAsDrive: z.literal(true) }).strict(),
  SetDriveClientBody,
])

/** The company's own Google app for the whole Google family (Drive, Gmail, Calendar, Docs, Sheets), set once by an owner
 * or admin where the hosting service is the Google sign-in (docs/GOOGLE-APPS.md "The company's own Google app").
 * - `available`: it can be set or replaced here; `blocked` says why not: "server" the operator set a Google client of
 *   their own, "not_service" this server does not sign in through the hosting service (set up each card instead),
 *   "public_host" no public https address for Google to send people back to;
 * - `active`: set now; `setBy` / `setAt`: who set it and when (null when not set; setBy null too when that person is gone);
 * - `canGoBack`: removing it goes back to the hosting service's Google sign-in. false: removing it turns Google off
 *   until it is set again (the page says so before it asks);
 * - `people`: active people with a Google connection here (Drive or any of the four apps) who connect again after a
 *   change; `shared`: Drives shared with the team plus the team's shared Google accounts, which an admin reconnects;
 * - `returnAddresses`: the two addresses to add in Google Cloud (both must be in the uploaded file), null without a
 *   public address.
 * Never the client ID or secret. */
export const GoogleOwnAppStatus = z.object({
  available: z.boolean(),
  blocked: z.enum(['server', 'not_service', 'public_host']).nullable(),
  active: z.boolean(),
  canGoBack: z.boolean(),
  setBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  setAt: z.string().nullable(),
  people: z.number().int(),
  shared: z.number().int(),
  returnAddresses: z.object({ drive: z.string(), apps: z.string() }).nullable(),
})
export type GoogleOwnAppStatus = z.infer<typeof GoogleOwnAppStatus>
/** The company's Google app: the JSON file Google Cloud downloads (it must list both return addresses), or its client ID
 * and secret (the same shape as Google Drive's setup). */
export const SetGoogleOwnAppBody = SetDriveClientBody
export type SetGoogleOwnAppBody = z.infer<typeof SetGoogleOwnAppBody>

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
  authorizeGoogleAppTeam: endpoint({ method: 'POST', path: `/api/admin/google-apps${AppParam}/team/authorize`, auth: 'admin', owner: 'C', body: z.object({}).strict(), response: Authorization, summary: "Owners and admins: start the Google sign-in of the account shared with the team for one app." }),
  googleAppTeamFlow: endpoint({ method: 'GET', path: `/api/admin/google-apps${AppParam}/team/flows/:id`, auth: 'admin', owner: 'C', response: GoogleAppFlow, summary: 'Poll the shared account sign-in started by this same signed-in session.' }),
  cancelGoogleAppTeamFlow: endpoint({ method: 'DELETE', path: `/api/admin/google-apps${AppParam}/team/flows/:id`, auth: 'admin', owner: 'C', response: empty, status: 204, summary: 'Cancel this shared account sign-in.' }),
  completeGoogleAppTeamFlow: endpoint({ method: 'POST', path: `/api/admin/google-apps${AppParam}/team/flows/:id/complete`, auth: 'admin', owner: 'C', body: z.object({ create: z.boolean().optional() }).strict(), response: GoogleAppAdminStatus, summary: "Confirm the Google account shown: it becomes the team's shared account for the app (a new one is used by nobody until its people are saved; a reconnect keeps them). `create`: only when there is none yet (else 409 team_exists: another admin connected one meanwhile). Members' own connections are not touched." }),
  setGoogleAppTeam: endpoint({ method: 'PUT', path: `/api/admin/google-apps${AppParam}/team`, auth: 'admin', owner: 'C', body: z.object({ access: IntegrationAccess }).strict(), response: GoogleAppAdminStatus, summary: 'Who may use the shared account: everyone, groups or people (the same rule as a team connection).' }),
  removeGoogleAppTeam: endpoint({ method: 'DELETE', path: `/api/admin/google-apps${AppParam}/team`, auth: 'admin', owner: 'C', query: z.object({ id: z.string().max(100).optional() }), response: z.object({ removed: z.boolean(), revocation: z.enum(['revoked', 'unavailable', 'not_needed']) }), summary: "Remove the shared account at once; Google is asked to revoke only when no other sign-in here uses the same Google account." }),
  googleOwnApp: endpoint({ method: 'GET', path: '/api/admin/google/own-app', auth: 'admin', owner: 'C', response: GoogleOwnAppStatus, summary: "Whether the company's own Google app signs in for Google Drive, Gmail, Calendar, Docs and Sheets, who set it, whether it can be set here, and how many sign-ins a change would end; never the client." }),
  setGoogleOwnApp: endpoint({ method: 'PUT', path: '/api/admin/google/own-app', auth: 'admin', owner: 'C', body: SetGoogleOwnAppBody, response: GoogleOwnAppStatus, summary: "Use the company's own Google app (the downloaded file listing both return addresses, or its client ID and secret) for all five Google apps. Only where the hosting service is the Google sign-in and the operator set no client; existing Google sign-ins connect again." }),
  removeGoogleOwnApp: endpoint({ method: 'DELETE', path: '/api/admin/google/own-app', auth: 'admin', owner: 'C', response: GoogleOwnAppStatus, summary: "Stop using the company's own Google app: the client it wrote is deleted and all five Google apps go back to the hosting service's sign-in (or turn off where there is none)." }),
  setGoogleAppMembers: endpoint({ method: 'PUT', path: `/api/admin/google-apps${AppParam}/members`, auth: 'admin', owner: 'C', body: z.object({ on: z.boolean() }).strict(), response: GoogleAppAdminStatus, summary: 'The old members switch, kept for older apps: admin-only, changes nothing (every member may connect their own once the app is set up).' }),
} as const
