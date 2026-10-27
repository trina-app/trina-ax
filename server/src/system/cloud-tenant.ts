// admin.js commands for the hosted service's tenant commands that need the server's own data (control-plane 3.5.3,
// CT-1). mycel-ctl (root) runs them as the server account and adds what only root sees (kit and root versions,
// /api/health, cgroup / PSI / disk, the update lock):
//
//   cloud-status                         the app's part of TenantStatus (no names, mail, IPs, chats or tokens)
//   reset-link [--username U]            a one-time password reset link at publicOrigins[0]: { url, expiresAt }
//   credentials-escrow-out --recipient R the AI connections' key, age-armored to R: { keyAge, keyVersion } | { absent }
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { StatusFile } from '@mycel/shared/install'
import type { TenantStatus } from '@mycel/shared/cloud-protocol'
import { allowedCredentialKinds, type AppConfig } from '../app-config'
import { teamCredentialSummary } from '../credentials/resolve'
import { Vault, keyFileName, readKeyFile } from '../credentials/vault'
import type { BackupMeta } from './backup'
import { lastUploadedLocalId } from './cloud-admin'
import { seatsUsed } from './limits'
import { ageArmorTo } from './streams'

export class CloudTenantError extends Error { name = 'CloudTenantError' }

/** the fields of TenantStatus the app answers; mycel-ctl fills the rest (at, kitVersion, rootVersion, app, resources, update) */
export type AppTenantStatus = Pick<TenantStatus, 'setupNeeded' | 'activeMembers' | 'queue' | 'relay' | 'lastLocalBackup' | 'lastUploadedLocalId' | 'overall' | 'checks' | 'ai' | 'credentialsKey'>

const LOCAL_ID = /^[0-9]{8}T[0-9]{6}Z-(daily|manual|pre-update|final)(-[0-9]+)?$/
const CHECK_ID = /^[a-z0-9_.-]{1,64}$/
const CODE = /^[a-z0-9_]{1,40}$/
/** status/status.json is written every 30 s; older than this, its queue and checks are not reported */
const STATUS_FRESH_MS = 3 * 60_000

export function cloudStatus(o: { db: Database; config: AppConfig; dataDir: string; statusDir: string; secretsDir: string; backups: BackupMeta[]; now?: number }): AppTenantStatus {
  const now = o.now ?? Date.now()
  let st: StatusFile | null = null
  try {
    const p = StatusFile.safeParse(JSON.parse(fs.readFileSync(path.join(o.statusDir, 'status.json'), 'utf8')))
    if (p.success && now - Date.parse(p.data.writtenAt) < STATUS_FRESH_MS) st = p.data
  } catch {}
  const users = (o.db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  const allowed = allowedCredentialKinds(o.config)
  const ai = (family: 'anthropic' | 'openai'): 'none' | 'ok' | 'problem' => {
    const s = teamCredentialSummary(o.db, family, allowed, new Date(now))
    return s.total === 0 ? 'none' : s.usable > 0 ? 'ok' : 'problem'
  }
  const vault = new Vault(o.secretsDir)
  const key = vault.check()
  const last = o.backups.filter((b) => LOCAL_ID.test(b.id)).at(-1) ?? null
  const uploaded = lastUploadedLocalId(o.dataDir)
  return {
    setupNeeded: users === 0,
    activeMembers: seatsUsed(o.db),
    queue: st ? { running: st.queue.running, queued: st.queue.queued } : null,
    relay: st ? { state: st.connection.state, detail: st.connection.detail && CODE.test(st.connection.detail) ? st.connection.detail : null } : null,
    lastLocalBackup: last ? { id: last.id, at: new Date(last.createdAt).toISOString() } : null,
    lastUploadedLocalId: uploaded && LOCAL_ID.test(uploaded) ? uploaded : null,
    overall: st?.overall ?? 'unknown',
    checks: (st?.checks ?? []).filter((c) => CHECK_ID.test(c.id)).slice(0, 100),
    ai: { claude: ai('anthropic'), codex: ai('openai') },
    credentialsKey: { present: key.state === 'ok', version: key.state === 'ok' ? vault.version : null },
  }
}

/** reset-link: the owner (default) or the account `username`, at the team's public address. */
export function resetLinkBase(config: Pick<AppConfig, 'publicOrigins'>): string {
  const base = config.publicOrigins[0]
  if (!base) throw new CloudTenantError('no public address (publicOrigins) to put the link on')
  return base.replace(/\/+$/, '')
}

/**
 * The escrow copy of the AI connections' key for the control plane (it keeps it to restore a team onto a new VM).
 * The plaintext is the key file's line; for a key version above 1 (after credentials-rekey) it starts with the file
 * name, "credentials.key.<N> <base64>", so mycel-enroll restores it under the name the rows were encrypted with.
 */
export async function credentialsEscrowOut(secretsDir: string, recipient: string): Promise<{ keyAge: string; keyVersion: number } | { absent: true }> {
  if (!/^age1[02-9ac-hj-np-z]{58}$/.test(recipient)) throw new CloudTenantError('--recipient must be an age X25519 recipient')
  const vault = new Vault(secretsDir)
  const v = vault.version
  const key = readKeyFile(path.join(secretsDir, keyFileName(v)))
  if (!key) return { absent: true }
  const line = v <= 1 ? key.toString('base64') : `${keyFileName(v)} ${key.toString('base64')}`
  return { keyAge: await ageArmorTo(line + '\n', [recipient]), keyVersion: v }
}

