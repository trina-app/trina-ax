// Which Google app (OAuth client) each card signs in with (docs/GOOGLE-APPS.md "Setting it up"), per app:
//  - "server": the operator's: MYCEL_GOOGLE_<APP>_CLIENT_FILE, or a client file in the private folder that this page did
//    not write (the page shows it and leaves it alone);
//  - "app": its own client, set in Admin › Connectors (the downloaded file, or the ID and secret), kept like Drive's:
//    <secrets>/integrations/google-apps/<app>.json, 0600, written through a new file renamed into place, never returned
//    or logged;
//  - "drive": the same Google app as Google Drive (its client file or the operator's, followed when it changes: a new
//    Drive client is a new key, so connections made with the old one sign in again);
//  - "service": a server without a client of its own whose Drive signs in through the hosting service (hosted, or
//    self-installed with MYCEL_GOOGLE_DRIVE_BROKER_URL) uses the hosting service's Google app (the Drive broker,
//    google-drive/broker.ts, with the `app` field);
//  - "none".
// Every card's redirect address is https://<tunnel.host>/api/integrations/google-apps/callback (one callback for all
// four; the flow says which app). The settings row `integrations.googleApps.<app>.client` remembers what the page set.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { GoogleAppId } from '@mycel/shared/api'
import { GOOGLE_APPS_BROKER_TEAM_RETURN_PATH } from '@mycel/shared/cloud-protocol'
import type { AppContext } from '../../context'
import { getSetting } from '../../admin/settings'
import { resolveLayout } from '../../system/layout'
import { googleDriveOf } from '../google-drive/oauth'
import { brokerKey } from '../google-drive/broker'

export const CALLBACK_PATH = GOOGLE_APPS_BROKER_TEAM_RETURN_PATH
export interface AppClient { clientId: string; clientSecret: string; redirectUri: string }
const Schema = z.object({
  clientId: z.string().min(1).max(512), clientSecret: z.string().min(1).max(4096),
  redirectUri: z.string().url().refine((s) => {
    const u = new URL(s)
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === CALLBACK_PATH
  }),
}).strict()
export const parseAppClient = (v: unknown): AppClient | null => { const r = Schema.safeParse(v); return r.success ? r.data : null }
const keyOf = (c: AppClient) => crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex')

/** settings key: what the admin page set for an app ({by:'drive'} or {by:'app', key}) */
export const clientSettingKey = (app: GoogleAppId) => `integrations.googleApps.${app}.client`
export const clientEnvName = (app: GoogleAppId) => `MYCEL_GOOGLE_${app.toUpperCase()}_CLIENT_FILE`

export const appsSecretsDir = (ctx: AppContext) => path.join(resolveLayout(ctx.config).secretsDir, 'integrations', 'google-apps')
export const redirectUriOf = (ctx: AppContext) => (ctx.config.tunnel?.host ? `https://${ctx.config.tunnel.host}${CALLBACK_PATH}` : null)

/** Read a server-owned client file, like Drive's (google-drive/config.ts readDriveConfig): a regular private file of
 * this account, outside the team folder, never followed through a link. Invalid or missing: null, nothing logged. */
export function readAppClient(file: string, teamRoot: string): AppClient | null {
  try {
    const real = fs.realpathSync(file), team = fs.realpathSync(teamRoot)
    if (real === team || real.startsWith(team + path.sep)) return null
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile() || st.nlink !== 1 || st.size > 16_384 || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) return null
      return parseAppClient(JSON.parse(fs.readFileSync(fd, 'utf8')))
    } catch { return null } finally { fs.closeSync(fd) }
  } catch { return null }
}

export interface AppSetup {
  app: GoogleAppId
  source: 'app' | 'drive' | 'server' | 'service' | 'none'
  /** 'direct': this server's client signs in at Google; 'broker': the hosting service's; 'off' */
  mode: 'direct' | 'broker' | 'off'
  /** the client for a direct sign-in (never leaves the server) */
  client: AppClient | null
  /** which client a connection or flow was made with: another one makes them sign in again */
  key: string
  /** the operator set it (environment or a file this page did not write): the page leaves it alone */
  byOperator: boolean
  /** where this page writes its own client */
  file: string
}

/** The setup of one app as it is now (read from the files and settings each time: admins and operators change them). */
export function setupOf(ctx: AppContext, app: GoogleAppId, env: Record<string, string | undefined> = process.env): AppSetup {
  const file = path.join(appsSecretsDir(ctx), `${app}.json`)
  const off: AppSetup = { app, source: 'none', mode: 'off', client: null, key: '', byOperator: false, file }
  const envFile = env[clientEnvName(app)]
  if (envFile) {
    const c = readAppClient(envFile, ctx.config.teamRoot)
    return c ? { ...off, source: 'server', mode: 'direct', client: c, key: keyOf(c), byOperator: true } : { ...off, byOperator: true }
  }
  const set = getSetting<{ by?: unknown; key?: unknown }>(ctx.db, clientSettingKey(app))
  const own = readAppClient(file, ctx.config.teamRoot)
  if (own) {
    const k = keyOf(own)
    const byApp = set?.by === 'app' && set.key === k
    return { ...off, source: byApp ? 'app' : 'server', mode: 'direct', client: own, key: k, byOperator: !byApp }
  }
  const drive = googleDriveOf(ctx)
  if (set?.by === 'drive' && drive.config) {
    const redirectUri = new URL(CALLBACK_PATH, drive.config.redirectUri).href
    const c: AppClient = { clientId: drive.config.clientId, clientSecret: drive.config.clientSecret, redirectUri }
    return { ...off, source: 'drive', mode: 'direct', client: c, key: 'drive:' + keyOf(c) }
  }
  // no client of its own and Drive through the broker (hosted, or self-installed with the broker URL): the hosting
  // service's Google app, once it answered for this server
  if (drive.mode === 'broker' && drive.broker) return { ...off, source: 'service', mode: 'broker', key: `${brokerKey(drive.broker.o.origin)}:${app}` }
  return off
}

/** Whether Drive has a Google app of its own this card could use ("Use the same Google app as Drive"). */
export const driveAppAvailable = (ctx: AppContext) => !!googleDriveOf(ctx).config

/** Write a client where readAppClient reads it: a new private file (O_EXCL, O_NOFOLLOW, 0600) renamed into place. */
export function writeClientFile(file: string, bytes: Buffer) {
  const tmp = path.join(path.dirname(file), `.client.${crypto.randomBytes(8).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try { fs.writeSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  try { fs.renameSync(tmp, file) } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
}

/** The private folder for the clients: owned by this account, 0700, no links (like the Drive store's). */
export function safeAppsDir(dir: string, create = false): boolean {
  const root = path.dirname(path.dirname(dir))
  try {
    for (const d of [root, path.dirname(dir), dir]) {
      if (create && !fs.existsSync(d)) fs.mkdirSync(d, { mode: 0o700 })
      const st = fs.lstatSync(d)
      if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) return false
    }
    return true
  } catch { return false }
}

/** the client in an admin's request: Google's downloaded web-client JSON ({"web": {...}}, which must list our
 * redirect address), or the client ID and secret. null: not a usable web client; 'redirect': it does not list ours. */
export function clientFromBody(body: { file?: string; clientId?: string; clientSecret?: string }, redirectUri: string): AppClient | 'invalid' | 'redirect' {
  let out: unknown
  if (body.file !== undefined) {
    let j: unknown
    try { j = JSON.parse(body.file) } catch { return 'invalid' }
    const o = j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : null
    const web = o?.web && typeof o.web === 'object' && !Array.isArray(o.web) ? o.web as Record<string, unknown> : null
    if (web) {
      const uris = Array.isArray(web.redirect_uris) ? web.redirect_uris : []
      if (!uris.includes(redirectUri)) return 'redirect'
      out = { clientId: web.client_id, clientSecret: web.client_secret, redirectUri }
    } else if (o && 'clientId' in o) {
      if (Object.keys(o).some((k) => !['clientId', 'clientSecret', 'redirectUri'].includes(k))) return 'invalid'
      if (o.redirectUri !== undefined && o.redirectUri !== redirectUri) return 'redirect'
      out = { clientId: o.clientId, clientSecret: o.clientSecret, redirectUri }
    } else return 'invalid'
  } else out = { clientId: body.clientId?.trim(), clientSecret: body.clientSecret?.trim(), redirectUri }
  return parseAppClient(out) ?? 'invalid'
}
