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
import { canonicalService } from './integrations'

export const CONNECTORS = [
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', logo: 'notion.svg' },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', logo: 'linear.svg' },
  { id: 'atlassian', name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp', logo: 'atlassian.svg' },
  { id: 'canva', name: 'Canva', url: 'https://mcp.canva.com/mcp', logo: 'canva.svg' },
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', logo: 'figma.svg' },
  { id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com/', logo: 'stripe.svg' },
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', logo: 'supabase.svg' },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://mcp.cloudflare.com/mcp', logo: 'cloudflare.svg' },
  { id: 'higgsfield', name: 'Higgsfield', url: 'https://mcp.higgsfield.ai/mcp', logo: 'higgsfield.png' },
  { id: 'ahrefs', name: 'Ahrefs', url: 'https://api.ahrefs.com/mcp/mcp', logo: 'ahrefs.svg' },
  { id: 'airtable', name: 'Airtable', url: 'https://mcp.airtable.com/mcp', logo: 'airtable.svg' },
  { id: 'brex', name: 'Brex', url: 'https://api.brex.com/mcp', logo: 'brex.svg' },
  { id: 'calendly', name: 'Calendly', url: 'https://mcp.calendly.com', logo: 'calendly.svg' },
  { id: 'clickup', name: 'ClickUp', url: 'https://mcp.clickup.com/mcp', logo: 'clickup.svg' },
  { id: 'cloudinary', name: 'Cloudinary', url: 'https://asset-management.mcp.cloudinary.com/mcp', logo: 'cloudinary.svg' },
  { id: 'gitlab', name: 'GitLab', url: 'https://gitlab.com/api/v4/mcp', logo: 'gitlab.svg' },
  { id: 'indeed', name: 'Indeed', url: 'https://mcp.indeed.com/claude/mcp', logo: 'indeed.svg' },
  { id: 'intercom', name: 'Intercom', url: 'https://mcp.intercom.com/mcp', logo: 'intercom.svg' },
  { id: 'mermaid', name: 'Mermaid Chart', url: 'https://mcp.mermaid.ai/mcp', logo: 'mermaid.svg' },
  { id: 'mintlify', name: 'Mintlify', url: 'https://mcp.mintlify.com', logo: 'mintlify.svg' },
  { id: 'monday', name: 'Monday', url: 'https://mcp.monday.com/mcp', logo: 'monday.png' },
  { id: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp', logo: 'neon.svg' },
  { id: 'netlify', name: 'Netlify', url: 'https://netlify-mcp.netlify.app/mcp', logo: 'netlify.svg' },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://mcp.openrouter.ai/mcp', logo: 'openrouter.svg' },
  { id: 'paypal', name: 'PayPal', url: 'https://mcp.paypal.com/mcp', logo: 'paypal.svg' },
  { id: 'planetscale', name: 'PlanetScale', url: 'https://mcp.pscale.dev/mcp/planetscale', logo: 'planetscale.svg' },
  { id: 'posthog', name: 'PostHog', url: 'https://mcp.posthog.com/mcp', logo: 'posthog.svg' },
  { id: 'postman', name: 'Postman', url: 'https://mcp.postman.com/mcp', logo: 'postman.svg' },
  { id: 'railway', name: 'Railway', url: 'https://mcp.railway.com', logo: 'railway.svg' },
  { id: 'razorpay', name: 'Razorpay', url: 'https://mcp.razorpay.com/mcp', logo: 'razorpay.svg' },
  { id: 'resend', name: 'Resend', url: 'https://mcp.resend.com/mcp', logo: 'resend.svg' },
  { id: 'sanity', name: 'Sanity', url: 'https://mcp.sanity.io', logo: 'sanity.svg' },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', logo: 'sentry.svg' },
  { id: 'square', name: 'Square', url: 'https://mcp.squareup.com/mcp', logo: 'square.svg' },
  { id: 'todoist', name: 'Todoist', url: 'https://ai.todoist.net/mcp', logo: 'todoist.svg' },
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com/', logo: 'vercel.svg' },
  { id: 'webflow', name: 'Webflow', url: 'https://mcp.webflow.com/mcp', logo: 'webflow.svg' },
  { id: 'wix', name: 'Wix', url: 'https://mcp.wix.com/mcp', logo: 'wix.svg' },
  { id: 'wordpress', name: 'WordPress.com', url: 'https://public-api.wordpress.com/wpcom/v2/mcp/v1', logo: 'wordpress.svg' },
] as const

export type Connector = (typeof CONNECTORS)[number]

export const connectorLogo = (c: Connector) => `/icons/connectors/${c.logo}`

/** App connectors: apps this server's AI connects to for a person, with the person's own account and a connect flow
 * built into the server (not an MCP server someone adds): Settings › App connectors, one card each
 * (components/integrations/DriveConnector.tsx for Google Drive). Another platform is one more entry here and one card.
 * Not the same as AI apps below (outside AI apps that use this server). Their logos sit beside the MCP ones. */
export const APP_CONNECTORS = [{ id: 'google-drive', name: 'Google Drive', logo: 'google-drive.svg' }] as const
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
