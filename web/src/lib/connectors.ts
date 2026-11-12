// The "Discover" list of External services: MCP servers to add by name instead of by address. An entry only fills the
// add dialog (components/integrations/IntegrationDialog.tsx), so who may use it and what the AI may change stay the
// person's choice, with the same checks and the same asking as any other connection.
//
// The services come from the remote servers listed on mcpservers.org. A listing is not enough: every address answered
// like this server needs on 2026-11-02 (docs/INTEGRATIONS.md "Discover"), Streamable HTTP and OAuth with dynamic client
// registration. Services that need an app of their own stay out however well known they are, because they would fail at
// sign-in: Slack, GitHub, Asana, HubSpot, Box, Zoom, Docusign, PagerDuty, Granola, Clerk. Descriptions are the message
// keys integrations.catalog.<id>; logos are files in web/public/icons/connectors (this server's own, because the
// content security policy loads no image from elsewhere).
import { canonicalService, SERVICE_CATALOG, type CatalogServiceId } from '@mycel/shared'

/** each listed service's logo (the list itself, with names and official addresses, is shared/src/service-catalog.ts) */
const LOGOS: Record<CatalogServiceId, string> = {
  notion: 'notion.svg',
  linear: 'linear.svg',
  atlassian: 'atlassian.svg',
  canva: 'canva.svg',
  figma: 'figma.svg',
  stripe: 'stripe.svg',
  supabase: 'supabase.svg',
  cloudflare: 'cloudflare.svg',
  higgsfield: 'higgsfield.png',
  ahrefs: 'ahrefs.svg',
  airtable: 'airtable.svg',
  brex: 'brex.svg',
  calendly: 'calendly.svg',
  clickup: 'clickup.svg',
  cloudinary: 'cloudinary.svg',
  gitlab: 'gitlab.svg',
  indeed: 'indeed.svg',
  intercom: 'intercom.svg',
  mermaid: 'mermaid.svg',
  mintlify: 'mintlify.svg',
  monday: 'monday.png',
  neon: 'neon.svg',
  netlify: 'netlify.svg',
  openrouter: 'openrouter.svg',
  paypal: 'paypal.svg',
  planetscale: 'planetscale.svg',
  posthog: 'posthog.svg',
  postman: 'postman.svg',
  railway: 'railway.svg',
  razorpay: 'razorpay.svg',
  resend: 'resend.svg',
  sanity: 'sanity.svg',
  sentry: 'sentry.svg',
  square: 'square.svg',
  todoist: 'todoist.svg',
  vercel: 'vercel.svg',
  webflow: 'webflow.svg',
  wix: 'wix.svg',
  wordpress: 'wordpress.svg',
}

export const CONNECTORS = SERVICE_CATALOG.map((c) => ({ ...c, logo: LOGOS[c.id] }))

export type Connector = (typeof CONNECTORS)[number]

export const connectorLogo = (c: Connector) => `/icons/connectors/${c.logo}`

/** App connectors: apps this server's AI connects to for a person, with the person's own account and a connect flow
 * built into the server (not an MCP server someone adds): Settings › App connectors, one card each
 * (components/integrations/DriveConnector.tsx for Google Drive, GoogleAppConnector.tsx for the Google apps). Another platform is one more entry here and one card.
 * Not the same as AI apps below (outside AI apps that use this server). Their logos sit beside the MCP ones. */
export const APP_CONNECTORS = [
  { id: 'google-drive', name: 'Google Drive', logo: 'google-drive.svg' },
  // Gmail, Google Calendar, Google Docs and Google Sheets (docs/GOOGLE-APPS.md): one card and one Google sign-in each;
  // their ids are the server's (shared/src/api/google-apps.ts GOOGLE_APP_IDS) and their Connectors page addresses
  { id: 'gmail', name: 'Gmail', logo: 'gmail.svg' },
  { id: 'calendar', name: 'Google Calendar', logo: 'google-calendar.svg' },
  { id: 'docs', name: 'Google Docs', logo: 'google-docs.svg' },
  { id: 'sheets', name: 'Google Sheets', logo: 'google-sheets.svg' },
] as const
export type AppConnector = (typeof APP_CONNECTORS)[number]
export const appConnectorLogo = (a: AppConnector) => `/icons/connectors/${a.logo}`
/** the earlier name of APP_CONNECTORS (the logo checks in test/unit/connectors.test.ts) */
export const BUILT_IN = APP_CONNECTORS
export const builtInLogo = (id: AppConnector['id']) => appConnectorLogo(APP_CONNECTORS.find((b) => b.id === id)!)

/** Outside AI apps that can use this server's MCP connector (Settings › AI apps, components/integrations/
 * AiAppConnect.tsx). Only apps whose sign-in the server accepts are named: the connector's OAuth takes claude.ai's
 * callback (Claude on the web, desktop and phone) and a loopback http://localhost/…/callback (Claude Code, Codex and
 * other apps that sign in on the computer); server/src/connectors/remote-mcp/policy.ts redirectAllowed. `logo: null` is the
 * generic card for any other MCP app. */
export const AI_APPS = [
  { id: 'claude', name: 'Claude', logo: 'claude.svg' },
  { id: 'claude-code', name: 'Claude Code', logo: 'claude.svg' },
  { id: 'codex', name: 'Codex', logo: 'codex.svg' },
  { id: 'other', name: null, logo: null },
] as const
export type AiApp = (typeof AI_APPS)[number]
export const aiAppLogo = (a: AiApp) => (a.logo ? `/icons/connectors/${a.logo}` : null)

/** The listed service at this address, if there is one (a connection added by hand shows its logo too). */
export const connectorFor = (url: string): Connector | undefined => CONNECTORS.find((c) => canonicalService(c.url) === canonicalService(url))

/** A connection to this service is already in `urls`. */
export const isConnected = (c: Connector, urls: string[]) => urls.some((u) => canonicalService(u) === canonicalService(c.url))
