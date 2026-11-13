// The company's own Google app for the whole Google family (docs/GOOGLE-APPS.md "The company's own Google app",
// docs/AGENTS/plan/20261113-0917-google-own-app.md). A company on Google Workspace makes one Internal Google app (no
// Google review, no user limit) and an owner or admin adds it once; from then on Google Drive, Gmail, Google Calendar,
// Google Docs and Google Sheets sign in with it instead of the hosting service's.
//
// Stored as today's files, so the existing sign-in, refresh, revoke and "a new app ends old sign-ins" code runs unchanged:
//  - the client is written as Drive's client.json (0600, a new O_EXCL file renamed into place, read back; the earlier
//    file is put back when the read fails), which wins over the hosting service in oauth.ts;
//  - each of the four apps is set to "the same Google app as Drive" (`{by:'drive'}`, google-apps/config.ts setupOf);
//  - settings `integrations.googleOwnApp` = `{ key, by, at, apps }`: key = the client's fingerprint (configKey), so a
//    client.json someone else wrote later is never taken for this one; apps = the four apps' settings before it, put
//    back on removal for each app still on "same as Drive".
//
// Where: ONLY where the hosting service is the Google sign-in (a hosted server, whether or not the hosting service
// answers yet, or a self-installed server it serves) and the operator set no Google client (MYCEL_GOOGLE_DRIVE_CLIENT_FILE,
// MYCEL_GOOGLE_<APP>_CLIENT_FILE, or a client file this setting did not write). Self-installed servers the hosting service
// does not serve keep the per-card setup. The uploaded file must list both return addresses (Drive's and the apps').
//
// Removing it deletes only a client.json this setting wrote and puts the four apps back, so all five go back to the
// hosting service at once (its status is asked right away; oauth.ts keeps its sign-in ready behind this client, even
// after a restart). Where there is no hosting service sign-in (`canGoBack` false), Google turns off until set again.
//
// Removal when someone wrote another client over it since: only the settings row goes; the client and the cards ("same
// as Drive", following that client) are left alone, so they keep working.
//
// `stale`: the team's address changed since it was set (a hosted rename changes publicOrigins). The client keeps the
// old return address (never rewritten: Google accepts only what is listed in Google Cloud); the page asks the admin to
// add the new addresses and Replace. `canGoBack`: the hosting service answered that it serves this team (GET asks it
// again, bounded: ownAppStatusFresh).
//
// The client ID and secret are in no answer, log line or audit entry (audit `google.own_app_set` { replaced } and
// `google.own_app_removed` {}). While it is set, the cards keep no setup of their own (blocked 'hosted', as on a hosted
// server), also on a self-installed server the hosting service serves.
import fs from 'node:fs'
import type { GoogleAppId, GoogleOwnAppStatus } from '@mycel/shared/api'
import { GOOGLE_APP_IDS } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { audit } from '../../admin/audit'
import { getSetting, setSetting } from '../../admin/settings'
import { isHosted, publicHostOf } from '../../system/deployment'
import { CALLBACK_PATH as DRIVE_CALLBACK, OWN_APP_SETTING, configKey, readDriveConfig, type DriveConfig } from './config'
import { clientFromRequest } from './admin-setup'
import { DriveError } from './store'
import { googleDriveOf } from './oauth'
import { CALLBACK_PATH as APPS_CALLBACK, clientFromBody, clientSettingKey, setupOf, writeClientFile } from '../google-apps/config'
import { googleAppsOf } from '../google-apps/service'

interface OwnAppRow { key: string; by: string; at: string; apps?: Partial<Record<GoogleAppId, unknown>> }

/** A refusal: `reason` is the code the page shows in the person's words. */
export class GoogleOwnAppError extends Error {
  constructor(readonly reason: string, readonly status = 400) { super(`google_own_app_${reason}`) }
}

const rowOf = (ctx: AppContext) => {
  const r = getSetting<OwnAppRow>(ctx.db, OWN_APP_SETTING)
  return r && typeof r === 'object' && typeof r.key === 'string' ? r : null
}

/** The returning addresses Google needs for this server, or null without a public https address. */
export function ownAppReturnAddresses(ctx: AppContext): { drive: string; apps: string } | null {
  const h = publicHostOf(ctx.config)
  return h ? { drive: `https://${h}${DRIVE_CALLBACK}`, apps: `https://${h}${APPS_CALLBACK}` } : null
}

function stateOf(ctx: AppContext, env: Record<string, string | undefined>) {
  const svc = googleDriveOf(ctx)
  const row = rowOf(ctx)
  // the client file on disk now (not the one in memory: an operator may have written another since): set now only
  // while it is the one this setting wrote (not the operator's file, not one someone wrote over it)
  const onDisk = svc.clientFromEnv ? svc.config : readDriveConfig(svc.clientFile, ctx.config.teamRoot)
  const active = !!row && !!onDisk && !svc.clientFromEnv && configKey(onDisk) === row.key
  // the operator's own client: Drive's environment file or a client.json this setting did not write; any app's
  // environment file or a client file of its own (that card would not follow Drive's)
  const operator = svc.clientFromEnv || (!!onDisk && !active)
    || GOOGLE_APP_IDS.some((a) => { const s = setupOf(ctx, a, env); return s.byOperator || s.source === 'app' })
  // the hosting service is the sign-in: hosted (answering yet or not), or served now, or it was when this was set
  // (its sign-in stays ready behind the company's client: oauth.ts)
  const service = isHosted(ctx.config) || svc.mode === 'broker' || (active && !!svc.broker)
  const addresses = ownAppReturnAddresses(ctx)
  const blocked: GoogleOwnAppStatus['blocked'] = operator ? 'server' : !service ? 'not_service' : !addresses ? 'public_host' : null
  // the team's address changed since it was set: the client still sends people back to the old address (never
  // rewritten here: Google only accepts the addresses listed in Google Cloud). The admin adds the new ones, then Replace.
  const stale = active && !!addresses && onDisk!.redirectUri !== addresses.drive
  return { svc, row, active, stale, blocked, addresses, onDisk }
}

export function ownAppStatus(ctx: AppContext, env: Record<string, string | undefined> = process.env): GoogleOwnAppStatus {
  const { svc, row, active, stale, blocked, addresses } = stateOf(ctx, env)
  const who = active && row ? ctx.db.query('SELECT id, name FROM users WHERE id=? AND deleted_at IS NULL').get(row.by) as { id: string; name: string } | null : null
  const people = (ctx.db.query(`SELECT count(*) n FROM users u WHERE u.status='active' AND u.deleted_at IS NULL AND (
      EXISTS (SELECT 1 FROM drive_connections d WHERE d.user_id=u.id)
      OR EXISTS (SELECT 1 FROM integrations i WHERE i.owner_user_id=u.id AND i.scope='personal' AND i.google_app IS NOT NULL))`).get() as { n: number }).n
  const shared = (ctx.db.query('SELECT count(*) n FROM drive_team_shares').get() as { n: number }).n
    + (ctx.db.query("SELECT count(*) n FROM integrations WHERE scope='team' AND google_app IS NOT NULL").get() as { n: number }).n
  return {
    // canGoBack: the hosting service's sign-in is there AND its last answer said it serves this team (not only set up)
    available: blocked === null, blocked, active, stale, canGoBack: svc.brokerServes,
    setBy: who ? { id: who.id, name: who.name } : null, setAt: active && row ? row.at : null,
    people, shared, returnAddresses: addresses,
  }
}

/** The admin page's GET: the status with a fresh answer from the hosting service (asked again when older than a
 * minute, waiting at most 2.5 s), so canGoBack says whether going back would really work. */
export async function ownAppStatusFresh(ctx: AppContext, env: Record<string, string | undefined> = process.env): Promise<GoogleOwnAppStatus> {
  try { await googleDriveOf(ctx).brokerFresh() } catch {}
  return ownAppStatus(ctx, env)
}

/** Use the company's Google app for all five (or replace it). Throws GoogleOwnAppError. */
export function setOwnApp(ctx: AppContext, actor: string, body: { file?: string; clientId?: string; clientSecret?: string }, env: Record<string, string | undefined> = process.env): GoogleOwnAppStatus {
  const st = stateOf(ctx, env)
  if (st.blocked || !st.addresses) throw new GoogleOwnAppError(st.blocked ?? 'public_host', 409)
  // the same parsing as Drive's and a card's own setup, once per return address: a downloaded file must list both
  let cfg: DriveConfig
  try { cfg = clientFromRequest(body, st.addresses.drive) } catch (e) {
    throw new GoogleOwnAppError(e instanceof DriveError && e.reason === 'client_redirect' ? 'client_redirect_drive' : 'client_invalid')
  }
  const forApps = clientFromBody(body, st.addresses.apps)
  if (forApps === 'invalid') throw new GoogleOwnAppError('client_invalid')
  if (forApps === 'redirect') throw new GoogleOwnAppError('client_redirect_apps')

  const svc = st.svc
  try { svc.store.safeDirectory(true) } catch { throw new GoogleOwnAppError('key_unsafe', 503) }
  const previous = (() => { try { return fs.readFileSync(svc.clientFile) } catch { return null } })()
  try { writeClientFile(svc.clientFile, Buffer.from(JSON.stringify(cfg, null, 2) + '\n')) } catch { throw new GoogleOwnAppError('setup_write', 500) }
  const restore = () => {
    try { if (previous) writeClientFile(svc.clientFile, previous); else fs.rmSync(svc.clientFile, { force: true }) } catch {}
    svc.reload()
  }
  if (!svc.reload() || svc.key !== configKey(cfg)) { restore(); throw new GoogleOwnAppError('setup_write', 500) }

  try {
    ctx.db.transaction(() => {
      // the four apps' settings before the company's app (kept from the first set when it is replaced)
      const apps: Partial<Record<GoogleAppId, unknown>> = { ...(st.row?.apps ?? {}) }
      for (const app of GOOGLE_APP_IDS) {
        const cur = getSetting<{ by?: unknown }>(ctx.db, clientSettingKey(app))
        if (cur?.by === 'drive') continue
        apps[app] = cur ?? null
        setSetting(ctx.db, clientSettingKey(app), { by: 'drive' })
      }
      setSetting(ctx.db, OWN_APP_SETTING, { key: svc.key, by: actor, at: new Date().toISOString(), apps } satisfies OwnAppRow)
    })()
  } catch { restore(); throw new GoogleOwnAppError('setup_write', 500) }
  audit(ctx.db, { actor, action: 'google.own_app_set', detail: { replaced: st.active } })
  try { googleAppsOf(ctx).syncLibrary() } catch { ctx.log.warn('Google apps library check deferred') }
  return ownAppStatus(ctx, env)
}

/** Stop using the company's Google app: delete only a client.json it wrote, put the four apps back, and ask the hosting
 * service at once whether it serves this server, so all five go back to it without a restart. */
export async function removeOwnApp(ctx: AppContext, actor: string, env: Record<string, string | undefined> = process.env): Promise<GoogleOwnAppStatus> {
  const row = rowOf(ctx)
  if (!row) return ownAppStatus(ctx, env)
  const svc = googleDriveOf(ctx)
  // the file on disk now, not the one in memory: delete it only while it is still the one this setting wrote
  const onDisk = svc.clientFromEnv ? null : readDriveConfig(svc.clientFile, ctx.config.teamRoot)
  const ours = !!onDisk && configKey(onDisk) === row.key
  // someone wrote another client since (the operator's file, or their environment file): the cards on "same as Drive"
  // follow that client and keep working, so only this setting goes; the client and the cards are left alone
  const replaced = svc.clientFromEnv || (!!onDisk && !ours)
  if (ours) {
    try { fs.rmSync(svc.clientFile, { force: true }) } catch { throw new GoogleOwnAppError('setup_write', 500) }
  }
  ctx.db.transaction(() => {
    for (const app of replaced ? [] : GOOGLE_APP_IDS) {
      if (!row.apps || !(app in row.apps)) continue // not set by the company's app
      if (getSetting<{ by?: unknown }>(ctx.db, clientSettingKey(app))?.by !== 'drive') continue // changed since
      const before = row.apps[app]
      if (before === null || before === undefined) ctx.db.query('DELETE FROM settings WHERE key=?').run(clientSettingKey(app))
      else setSetting(ctx.db, clientSettingKey(app), before)
    }
    ctx.db.query('DELETE FROM settings WHERE key=?').run(OWN_APP_SETTING)
  })()
  svc.reload()
  audit(ctx.db, { actor, action: 'google.own_app_removed', detail: {} })
  if (!svc.config && svc.broker) { try { await svc.checkBroker() } catch {} }
  try { googleAppsOf(ctx).syncLibrary() } catch { ctx.log.warn('Google apps library check deferred') }
  return ownAppStatus(ctx, env)
}
