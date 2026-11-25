// The Microsoft (Entra) app this server signs in to Microsoft 365 with (docs/decisions/20261125-m365-connector.md).
// Microsoft has no MCP server a third-party app can sign in to, so the Microsoft 365 connection's tools are this
// server's own (mcp-server.ts) and its sign-in goes through ONE Entra app the server holds, like GitHub's
// (github/app.ts): a person only presses Connect and signs in at Microsoft.
//
// Where it comes from (read each time: an operator may put the file in place while the server runs):
//  - MYCEL_MICROSOFT_APP_FILE: a file the operator names;
//  - else <secrets>/integrations/microsoft/app.json (a hosted server: the hosting service writes it with the tenant
//    command microsoft-app-set).
// A private file of the server account, read like GitHub's: a regular file, one link, mode 0600 or stricter, outside
// the team folder, never followed through a link. Shape:
//   { "clientId": "<application (client) ID, a GUID>", "clientSecret": "…", "tenant": "common" }
// `tenant` (optional): the Entra authority's tenant: `common` (default), `organizations` (both: any work or school
// account; personal Microsoft accounts are not supported) or one directory's ID (a GUID) for a company's own app. The
// client secret never leaves the server except to Microsoft's token address.
//
// Used only for a connection at Microsoft 365's exact listed address (serverAppAt) that has no own app of its own.
// Sign-in and token addresses are Microsoft's, fixed here, never discovered.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AppContext } from '../../context'
import { resolveLayout } from '../../system/layout'

export const MICROSOFT_APP_ENV = 'MYCEL_MICROSOFT_APP_FILE'
export const MICROSOFT_LOGIN = 'https://login.microsoftonline.com'
/** The delegated permissions a sign-in asks for, all at once (one consent screen, one token). `offline_access` brings a
 * refresh token; `openid profile email` and `User.Read` name the account. None of them needs an admin's consent in a
 * tenant that lets people consent to apps (Microsoft Graph permissions reference, checked 2026-11-25). */
export const MICROSOFT_SCOPES = [
  'openid', 'profile', 'email', 'offline_access', 'User.Read',
  'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite', 'Files.ReadWrite.All', 'Sites.Read.All', 'Chat.ReadWrite',
] as const
export const MICROSOFT_SCOPE = MICROSOFT_SCOPES.join(' ')

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const Schema = z.object({
  clientId: z.string().regex(GUID),
  clientSecret: z.string().regex(/^[!-~]{1,4096}$/),
  tenant: z.union([z.enum(['common', 'organizations']), z.string().regex(GUID)]).optional(),
}).strict()
export type MicrosoftApp = z.infer<typeof Schema>
export const parseMicrosoftApp = (v: unknown): MicrosoftApp | null => { const r = Schema.safeParse(v); return r.success ? r.data : null }

/** Microsoft's sign-in and token addresses for the app's tenant (v2.0 endpoints) */
export const microsoftAuthorizeUrl = (app: Pick<MicrosoftApp, 'tenant'>) => `${MICROSOFT_LOGIN}/${app.tenant ?? 'common'}/oauth2/v2.0/authorize`
export const microsoftTokenUrl = (app: Pick<MicrosoftApp, 'tenant'>) => `${MICROSOFT_LOGIN}/${app.tenant ?? 'common'}/oauth2/v2.0/token`

export const microsoftAppFile = (ctx: AppContext) => path.join(resolveLayout(ctx.config).secretsDir, 'integrations', 'microsoft', 'app.json')

/** Read a server-owned app file. Invalid, missing or unsafe: null, nothing logged (no path, no content). */
export function readMicrosoftApp(file: string, teamRoot: string): MicrosoftApp | null {
  try {
    const real = fs.realpathSync(file), team = fs.realpathSync(teamRoot)
    if (real === team || real.startsWith(team + path.sep)) return null
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
      const st = fs.fstatSync(fd)
      // Windows has no owner bits or uid: only the size and the kind of file are checked there
      const posix = process.platform !== 'win32'
      if (!st.isFile() || st.nlink !== 1 || st.size > 16_384 || (posix && (st.mode & 0o077)) || (posix && process.getuid && st.uid !== process.getuid())) return null
      return parseMicrosoftApp(JSON.parse(fs.readFileSync(fd, 'utf8')))
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

/** The server's Microsoft app now, or null (not set up: the Microsoft 365 card says "Not set up yet", and a connection
 * can still sign in with an own app). The environment's file wins; a set but unusable one is null. */
export function microsoftAppOf(ctx: AppContext, env: Record<string, string | undefined> = process.env): MicrosoftApp | null {
  const named = env[MICROSOFT_APP_ENV]?.trim()
  return readMicrosoftApp(named || microsoftAppFile(ctx), ctx.config.teamRoot)
}

/** What the Connectors page may know of it: whether people can connect Microsoft 365 here. Never the client. */
export function microsoftAppView(ctx: AppContext): { ready: boolean } {
  return { ready: !!microsoftAppOf(ctx) }
}
