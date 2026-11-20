// The GitHub App this server signs in to GitHub with (docs/INTEGRATIONS.md "GitHub"). GitHub's remote MCP server
// (https://api.githubcopilot.com/mcp/, shared/src/service-catalog.ts) registers no apps (no dynamic client
// registration), so a GitHub connection signs in through ONE GitHub App the server holds, and a person only presses
// Connect and signs in at GitHub: no token to paste, no app of their own.
//
// Where it comes from (read each time: an operator may put the file in place while the server runs):
//  - MYCEL_GITHUB_APP_FILE: a file the operator names (a hosted server: the hosting service writes it);
//  - else <secrets>/integrations/github/app.json.
// Both are private files of the server account, read like Google's client files (google-drive/config.ts): a regular
// file, one link, mode 0600 or stricter, outside the team folder, never followed through a link. Shape:
//   { "clientId": "Iv23…", "clientSecret": "…", "slug": "trina-ax" }
// `slug` (optional) is the app's name in its GitHub address (github.com/apps/<slug>): the page's "Choose repositories"
// link goes to its installation page. The client secret never leaves the server except to GitHub's token address.
//
// One app serves many team addresses: the app's callback URL is registered once with GitHub's wildcard matching, e.g.
// https://<team domain>/api/integrations/oauth/callback, which then also takes every <team>.<team domain> address with
// that path (docs.github.com "About the user authorization callback URL"). A server on an address of its own (a company's
// own host) uses an app of its own: the same file with its own app, or a team template with "Sign in with my own app".
//
// Used only for a connection at GitHub's exact official address (serverAppAt) that has no own app of its own: the
// token a sign-in gets goes nowhere else. Sign-in and token addresses are GitHub's, fixed here, never discovered.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AppContext } from '../../context'
import { resolveLayout } from '../../system/layout'
import { serviceRequest, type NetOptions } from '../connections/net'

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_APP_ENV = 'MYCEL_GITHUB_APP_FILE'
/** GitHub's call that ends one user token of an app (docs.github.com REST "Delete an app token"): the app's ID and
 * secret as basic auth, the token in the body; 204 when it ended. The person's authorization of the app stays (GitHub ›
 * Settings › Applications lists it until they revoke it there); only this token stops working. */
export const githubRevokeUrl = (clientId: string) => `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`

const Schema = z.object({
  clientId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  clientSecret: z.string().min(1).max(4096),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/).optional(),
}).strict()
export type GitHubApp = z.infer<typeof Schema>
export const parseGitHubApp = (v: unknown): GitHubApp | null => { const r = Schema.safeParse(v); return r.success ? r.data : null }

export const githubAppFile = (ctx: AppContext) => path.join(resolveLayout(ctx.config).secretsDir, 'integrations', 'github', 'app.json')

/** Read a server-owned app file. Invalid, missing or unsafe: null, nothing logged (no path, no content). */
export function readGitHubApp(file: string, teamRoot: string): GitHubApp | null {
  try {
    const real = fs.realpathSync(file), team = fs.realpathSync(teamRoot)
    if (real === team || real.startsWith(team + path.sep)) return null
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile() || st.nlink !== 1 || st.size > 16_384 || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) return null
      return parseGitHubApp(JSON.parse(fs.readFileSync(fd, 'utf8')))
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

/** The server's GitHub App now, or null (not set up: a GitHub connection then needs an own app, like any service that
 * registers none). The environment's file wins; a set but unusable one is null (never the default file instead). */
export function githubAppOf(ctx: AppContext, env: Record<string, string | undefined> = process.env): GitHubApp | null {
  const named = env[GITHUB_APP_ENV]?.trim()
  return readGitHubApp(named || githubAppFile(ctx), ctx.config.teamRoot)
}

/** Disconnect: end the connection's token at GitHub, best effort (true: GitHub said 204). The secret goes only to
 * api.github.com, never anywhere a service named. */
export async function revokeGitHubToken(app: GitHubApp, accessToken: string, net: NetOptions): Promise<boolean> {
  try {
    const r = await serviceRequest(githubRevokeUrl(app.clientId), {
      method: 'DELETE',
      headers: [
        ['Authorization', 'Basic ' + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')],
        ['Accept', 'application/vnd.github+json'], ['Content-Type', 'application/json'], ['X-GitHub-Api-Version', '2022-11-28'],
      ],
      body: Buffer.from(JSON.stringify({ access_token: accessToken })),
      maxBytes: 64 * 1024,
    }, net)
    return r.status === 204
  } catch { return false }
}

/** What the Connectors page may know of it: whether people can connect GitHub here, and where they choose the
 * repositories the app may see (its installation page; null without a slug). Never the client ID or secret. */
export function githubAppView(ctx: AppContext): { ready: boolean; installUrl: string | null } {
  const app = githubAppOf(ctx)
  return { ready: !!app, installUrl: app?.slug ? `https://github.com/apps/${app.slug}/installations/new` : null }
}
