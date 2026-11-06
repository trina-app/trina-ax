// Setting up Google Drive from Admin › App connectors, instead of the installer's --google-drive-client: an admin gives
// the Google OAuth web client (the JSON file Google Cloud downloads, or its client ID and secret), and the server writes
// the same private file the installer writes (<secrets>/integrations/google-drive/client.json, mode 0600, through a new
// file that is renamed into place) and reads it back with the same checks (config.ts readDriveConfig). Members can then
// connect their own Google account; the Drive tools are offered from then on (tools/drive.ts `available`).
//
// What the page may not change:
//  - a hosted server: the hosting service owns its setup (as the installer refuses --google-drive-client there);
//  - a client the operator set (MYCEL_GOOGLE_DRIVE_CLIENT_FILE, or a client.json the installer or the operator wrote):
//    the page shows it as "set by the server" and leaves it alone. Only a client set on this page can be replaced here;
//  - a server without a public https address (tunnel.host): Google has no address to send people back to.
// The redirect URI is always https://<tunnel.host>/api/integrations/google-drive/callback; a downloaded file must list it.
//
// The client secret never leaves the server: not in a response, the audit log (only "drive.client_set"), or a log line.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DriveAdminStatus } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { audit } from '../../admin/audit'
import { getSetting, setSetting } from '../../admin/settings'
import { isHosted } from '../../system/deployment'
import { CALLBACK_PATH, parseDriveConfig, type DriveConfig } from './config'
import { googleDriveOf } from './oauth'
import { DriveError } from './store'

/** the key of the client set on this page (configKey): a client.json with another key was written by someone else */
export const DRIVE_CLIENT_BY_APP = 'integrations.googleDriveClientByApp'

export const driveRedirectUri = (ctx: AppContext) => (ctx.config.tunnel?.host ? `https://${ctx.config.tunnel.host}${CALLBACK_PATH}` : null)

export function driveAdminStatus(ctx: AppContext): DriveAdminStatus {
  const svc = googleDriveOf(ctx)
  const configured = !!svc.config
  const byApp = configured && getSetting<string>(ctx.db, DRIVE_CLIENT_BY_APP) === svc.key && !svc.clientFromEnv
  const source = !configured ? 'none' : byApp ? 'app' : 'server'
  const redirectUri = driveRedirectUri(ctx)
  const blocked = isHosted(ctx.config) ? 'hosted' : svc.clientFromEnv || source === 'server' ? 'server' : !redirectUri ? 'public_host' : null
  const connectedMembers = configured
    ? (ctx.db.query(`SELECT count(*) n FROM drive_connections d JOIN users u ON u.id=d.user_id
        WHERE d.config_key=? AND d.status='connected' AND u.status='active' AND u.deleted_at IS NULL`).get(svc.key) as { n: number }).n
    : 0
  return { configured, source, canSetUp: blocked === null, blocked, redirectUri: blocked === 'hosted' ? null : redirectUri, connectedMembers }
}

/** The client from the request: Google's downloaded web-client JSON ({"web": {...}}, which must list our redirect URI),
 * our own file format, or the client ID and secret. Throws DriveError('client_invalid' | 'client_redirect'). */
export function clientFromRequest(body: { file?: string; clientId?: string; clientSecret?: string }, redirectUri: string): DriveConfig {
  let out: unknown
  if (body.file !== undefined) {
    let j: unknown
    try { j = JSON.parse(body.file) } catch { throw new DriveError('client_invalid') }
    const o = j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : null
    const web = o?.web && typeof o.web === 'object' && !Array.isArray(o.web) ? o.web as Record<string, unknown> : null
    if (web) {
      const uris = Array.isArray(web.redirect_uris) ? web.redirect_uris : []
      if (!uris.includes(redirectUri)) throw new DriveError('client_redirect')
      out = { clientId: web.client_id, clientSecret: web.client_secret, redirectUri }
    } else if (o && 'clientId' in o) {
      if (o.redirectUri !== undefined && o.redirectUri !== redirectUri) throw new DriveError('client_redirect')
      out = { clientId: o.clientId, clientSecret: o.clientSecret, redirectUri }
      if (Object.keys(o).some((k) => !['clientId', 'clientSecret', 'redirectUri'].includes(k))) throw new DriveError('client_invalid')
    } else throw new DriveError('client_invalid') // e.g. {"installed": …}: a desktop client cannot take a web redirect
  } else out = { clientId: body.clientId?.trim(), clientSecret: body.clientSecret?.trim(), redirectUri }
  const cfg = parseDriveConfig(out)
  if (!cfg) throw new DriveError('client_invalid')
  return cfg
}

/** Write the client where readDriveConfig reads it, private to the server account, without following links: a new
 * file (O_EXCL, O_NOFOLLOW, 0600) renamed over client.json, so a reader never sees half a file. */
function writeClientFile(file: string, bytes: Buffer) {
  const tmp = path.join(path.dirname(file), `.client.${crypto.randomBytes(8).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try { fs.writeSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  try { fs.renameSync(tmp, file) } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
}

export function setDriveClient(ctx: AppContext, actor: string, body: { file?: string; clientId?: string; clientSecret?: string }): DriveAdminStatus {
  const before = driveAdminStatus(ctx)
  if (!before.canSetUp || !before.redirectUri) throw new DriveError(`setup_${before.blocked ?? 'public_host'}`, 409)
  const cfg = clientFromRequest(body, before.redirectUri)
  const svc = googleDriveOf(ctx)
  svc.store.safeDirectory(true) // the private secrets subtree: owned by this account, 0700, no links
  const previous = (() => { try { return fs.readFileSync(svc.clientFile) } catch { return null } })()
  try { writeClientFile(svc.clientFile, Buffer.from(JSON.stringify(cfg, null, 2) + '\n')) } catch { throw new DriveError('setup_write', 500) }
  if (!svc.reload()) {
    // read back failed: put the earlier file back (or none), so Drive stays as it was
    try { if (previous) writeClientFile(svc.clientFile, previous); else fs.rmSync(svc.clientFile, { force: true }) } catch {}
    svc.reload()
    throw new DriveError('setup_write', 500)
  }
  setSetting(ctx.db, DRIVE_CLIENT_BY_APP, svc.key)
  audit(ctx.db, { actor, action: 'drive.client_set', detail: { replaced: before.configured } })
  return driveAdminStatus(ctx)
}
