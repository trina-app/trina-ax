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
import { catalogAt, SERVICE_CATALOG, type CatalogServiceId } from '@mycel/shared'

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

/** Where the person's own connections are: Settings › Connectors (pages/Connectors.tsx; docs/DECISIONS.md "Connectors
 * in Settings"). Its pages: a built-in or listed service's (`connectorHref`), one of the person's connections or a team
 * connection they may use (`connectionHref`). The old /connectors addresses lead to the same places (App.tsx). */
export const CONNECTORS_HOME = '/settings/connectors'
export const connectorHref = (id: string) => `${CONNECTORS_HOME}/${encodeURIComponent(id)}`
export const connectionHref = (id: string) => `${CONNECTORS_HOME}/mcp/${encodeURIComponent(id)}`

/** Connectors' old addresses (/connectors, /connectors/<id>, /connectors/mcp/<id>, until 2026-11-12 a page of the
 * sidebar), which App.tsx opens as Settings over the page they came from. Not an outside app's consent page
 * (/connectors/authorize). */
export const isOldConnectorsPath = (path: string) => (path === '/connectors' || path.startsWith('/connectors/')) && !/^\/connectors\/authorize(\/|$)/.test(path)
/** Where an old address leads: the same place in Settings, its query and hash kept. */
export const oldConnectorsTarget = (pathname: string, search = '', hash = '') => `/settings${pathname}${search}${hash}`

/** What a listed service's page shows before it is connected (QA TC-132): its privacy policy, terms and MCP help page,
 * and, where the service itself lists them, the tools it offers (their names as the service writes them, the same
 * names its page shows once connected) with the page that lists them. Only values checked on the service's own pages
 * on 2026-11-12 (each cited next to it); a service missing here, or without `tools`, shows the links and a plain line.
 * Left out on purpose: Linear (its MCP page names no tools), Atlassian's tools (its v2 address offers discover/execute
 * tools; the full list, https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/, is only behind
 * `?tools=all`) and Canva's (its tool list, https://www.canva.dev/docs/apps/mcp/tools/, is for the address that needs an
 * app of one's own, not the one listed). */
export interface ConnectorDocs { privacy: string; terms: string; docs: string; toolsUrl?: string; tools?: readonly string[] }
export const CONNECTOR_DOCS: Partial<Record<Connector['id'], ConnectorDocs>> = {
  notion: {
    privacy: 'https://www.notion.com/trust/privacy-policy',
    // Notion's terms hub (its Master Subscription Agreement and Personal Use Terms)
    terms: 'https://trust.notion.com/terms-and-privacy',
    docs: 'https://developers.notion.com/guides/mcp/mcp-supported-tools',
    // https://developers.notion.com/guides/mcp/mcp-supported-tools and its pages tools-search, tools-comments,
    // tools-pages, tools-databases, tools-files, tools-skills-agents, tools-calendars
    toolsUrl: 'https://developers.notion.com/guides/mcp/mcp-supported-tools',
    tools: [
      'notion-search', 'notion-connector-search', 'notion-fetch', 'notion-list-private-pages', 'notion-list-shared-pages', 'notion-list-favorite-pages',
      'notion-list-recent-pages', 'notion-list-page-backlinks', 'notion-query-meeting-notes', 'notion-get-self', 'notion-get-teams', 'notion-get-groups',
      'notion-get-users', 'notion-get-tool-access', 'notion-get-version-changes', 'notion-view-version', 'notion-restore-version', 'notion-restore-pages',
      'notion-get-comments', 'notion-create-comment', 'notion-update-comment', 'notion-delete-comment', 'notion-set-discussion-resolved',
      'notion-set-comment-reaction', 'notion-create-suggested-edit', 'notion-get-suggested-edit', 'notion-resolve-suggested-edit', 'notion-create-pages',
      'notion-update-page', 'notion-move-pages', 'notion-duplicate-page', 'notion-delete-pages', 'notion-get-async-task', 'notion-create-database',
      'notion-update-data-source', 'notion-query-data-sources', 'notion-query-multiple-data-sources', 'notion-create-view', 'notion-update-view',
      'notion-delete-databases', 'notion-create-file-upload', 'notion-create-attachment', 'notion-download-attachment', 'notion-get-file-download-urls',
      'notion-create-folder', 'notion-update-folder', 'notion-convert-page-to-skill', 'notion-download-skill', 'notion-upload-skill',
      'notion-get-enabled-skills', 'notion-update-enabled-skills', 'notion-memory-search', 'notion-search-agents', 'notion-query-sessions',
      'notion-search-sessions', 'notion-spawn-session', 'notion-send-message-to-session', 'notion-get-session-status', 'notion-wait-session',
      'notion-stop-session', 'notion-list-session-events', 'notion-read-session-event', 'notion-calendar-list-calendars', 'notion-calendar-list-events',
      'notion-calendar-list-coworkers-events', 'notion-calendar-list-calendar-resources', 'notion-calendar-list-contacts', 'notion-calendar-create-events',
      'notion-calendar-update-events', 'notion-calendar-cancel-events',
    ],
  },
  linear: {
    privacy: 'https://linear.app/privacy',
    terms: 'https://linear.app/terms',
    // https://linear.app/docs/mcp (the address; it names no tools)
    docs: 'https://linear.app/docs/mcp',
  },
  atlassian: {
    privacy: 'https://www.atlassian.com/legal/privacy-policy',
    terms: 'https://www.atlassian.com/legal/atlassian-customer-agreement',
    // https://developer.atlassian.com/cloud/rovo-mcp/ (the v2 address the list uses)
    docs: 'https://developer.atlassian.com/cloud/rovo-mcp/',
  },
  figma: {
    privacy: 'https://www.figma.com/legal/privacy/',
    terms: 'https://www.figma.com/legal/tos/',
    docs: 'https://developers.figma.com/docs/figma-mcp-server/',
    // https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/
    toolsUrl: 'https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/',
    tools: [
      'get_design_context', 'get_screenshot', 'get_metadata', 'get_variable_defs', 'get_figjam', 'get_motion_context', 'download_assets',
      'create_new_file', 'generate_diagram', 'generate_figma_design', 'generate_image', 'html_to_figma', 'upload_assets', 'use_figma',
      'add_code_connect_map', 'get_code_connect_map', 'get_code_connect_suggestions', 'get_context_for_code_connect', 'get_libraries',
      'search_design_system', 'send_code_connect_mappings', 'create_generative_plugin', 'get_generative_plugin', 'update_generative_plugin',
      'list_generative_plugins', 'create_shader', 'get_shader', 'update_shader', 'list_shaders', 'list_file_shaders', 'send_code_to_figma', 'whoami',
      // "Figma Weave" on the same page (2026-11-12; the page does not say which server has them)
      'weave_list_tools', 'weave_get_tool_inputs', 'weave_upload_asset', 'weave_run_tool', 'weave_get_tool_run_output', 'weave_cancel_tool_run',
      'weave_find_model', 'weave_run_model', 'weave_get_model_run_output',
    ],
  },
  canva: {
    privacy: 'https://www.canva.com/policies/privacy-policy/',
    // the Terms link of Canva's developer docs (https://www.canva.dev/docs/apps/mcp/ footer)
    terms: 'https://www.canva.com/policies/',
    // https://www.canva.dev/docs/apps/mcp/ (its pages now give https://api.canva.com/connect/v1/mcp as the address)
    docs: 'https://www.canva.dev/docs/apps/mcp/',
  },
  stripe: {
    privacy: 'https://stripe.com/privacy',
    terms: 'https://stripe.com/legal/ssa',
    // https://docs.stripe.com/mcp (the address and the tools)
    docs: 'https://docs.stripe.com/mcp',
    toolsUrl: 'https://docs.stripe.com/mcp',
    tools: [
      'stripe_api_search', 'stripe_api_details', 'stripe_api_read', 'stripe_api_write', 'get_stripe_account_info', 'atlas_company_formation',
      'stripe_analytics', 'get_balance_summary', 'convert_currency', 'send_money', 'setup_recipient', 'transfer_money', 'search_stripe_documentation',
      'stripe_implementation_planner', 'send_stripe_feedback',
    ],
  },
  supabase: {
    privacy: 'https://supabase.com/privacy',
    terms: 'https://supabase.com/terms',
    // https://supabase.com/docs/guides/getting-started/mcp (the address and the tools)
    docs: 'https://supabase.com/docs/guides/getting-started/mcp',
    toolsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    tools: [
      'list_tables', 'list_extensions', 'list_migrations', 'apply_migration', 'execute_sql', 'query_logs', 'get_advisors', 'get_project_url',
      'get_publishable_keys', 'generate_typescript_types', 'list_edge_functions', 'get_edge_function', 'deploy_edge_function',
      'create_edge_function_secret', 'list_projects', 'get_project', 'create_project', 'pause_project', 'restore_project', 'list_organizations',
      'get_organization', 'get_cost', 'confirm_cost', 'search_docs', 'create_branch', 'list_branches', 'delete_branch', 'merge_branch', 'reset_branch',
      'rebase_branch', 'submit_feedback', 'delete_feedback', 'list_storage_buckets', 'get_storage_config', 'update_storage_config', 'list_notebooks',
      'get_notebook', 'create_notebook', 'run_notebook', 'delete_notebook',
    ],
  },
}

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

/** Slack (docs/SLACK.md): not an app the AI uses for a person but the team's way to ask the AI in Slack, set up by the
 * owner. One row of Admin › Connected apps (the owner's only), its page at /admin/connectors/slack. */
export const SLACK_APP = { id: 'slack', name: 'Slack', logo: 'slack.svg' } as const
export const slackLogo = `/icons/connectors/${SLACK_APP.logo}`
export const SLACK_ADMIN_PATH = `/admin/connectors/${SLACK_APP.id}`

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
/** A connection at any official address of the listed service (Atlassian's v1 and v2, shared/src/service-catalog.ts
 * otherUrls) is that service: its logo, "connected" in Discover, its page. */
export const servesAt = (c: Connector, url: string) => catalogAt(url)?.id === c.id
export const connectorFor = (url: string): Connector | undefined => { const at = catalogAt(url); return at && CONNECTORS.find((c) => c.id === at.id) }

/** A connection to this service is already in `urls`. */
export const isConnected = (c: Connector, urls: string[]) => urls.some((u) => servesAt(c, u))
