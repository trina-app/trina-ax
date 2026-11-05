// admin.js commands for the hosted service's tenant commands that need the server's own data (control-plane 3.5.3,
// CT-1). mycel-ctl (root) runs them as the server account and adds what only root sees (kit and root versions,
// /api/health, cgroup / PSI / disk, the update lock):
//
//   cloud-status [--onboarding]          the app's part of TenantStatus (no names, mail, IPs, chats or tokens);
//                                        --onboarding adds the team's first days (onboarding/tenant-status.ts)
//   reset-link [--username U]            a one-time password reset link at publicOrigins[0]: { url, expiresAt }
//   credentials-escrow-out --recipient R the AI connections' key, age-armored to R: { keyAge, keyVersion } | { absent }
//   hosted-speech-key < { key | null }   the hosting service's speech-to-text key, kept encrypted: { ok, set }
//   hosted-chat-key < { key, capUsd, endsAt, enabled } | { key: null }
//                                        the hosting service's trial AI credit, key kept encrypted: { ok, set, usedUsd }
//   hosted-image-key < { token, workspace } | { token: null }
//                                        the hosting service's Higgsfield credential (brand photos), kept encrypted:
//                                        { ok, set }
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
import { HostedChatKeyInput, HostedImageKeyInput, HostedSpeechKeyInput } from '@mycel/shared/cloud-protocol'
import { isHosted } from './deployment'
import { makeCredCtx } from '../credentials/store'
import { writeHostedSpeechKey } from '../credentials/speech-key'
import { writeHostedChatKey } from '../credentials/hosted-chat'
import { writeHostedImageKey } from '../credentials/hosted-image'
import { audit } from '../admin/audit'
import type { Logger } from '../log'
import { tenantOnboarding } from '../onboarding/tenant-status'

export class CloudTenantError extends Error { name = 'CloudTenantError' }

/** the fields of TenantStatus the app answers; mycel-ctl fills the rest (at, kitVersion, rootVersion, app, resources, update) */
export type AppTenantStatus = Pick<TenantStatus, 'setupNeeded' | 'activeMembers' | 'queue' | 'relay' | 'lastLocalBackup' | 'lastUploadedLocalId' | 'overall' | 'checks' | 'ai' | 'credentialsKey' | 'onboarding'>

const LOCAL_ID = /^[0-9]{8}T[0-9]{6}Z-(daily|manual|pre-update|final)(-[0-9]+)?$/
const CHECK_ID = /^[a-z0-9_.-]{1,64}$/
const CODE = /^[a-z0-9_]{1,40}$/
/** status/status.json is written every 30 s; older than this, its queue and checks are not reported */
const STATUS_FRESH_MS = 3 * 60_000

/** `onboarding`: the reader asked for TenantStatus.onboarding (opt-in: ax-hostd's schema is strict, and a team that
 * is not asked is not counted). */
export function cloudStatus(o: { db: Database; config: AppConfig; dataDir: string; statusDir: string; secretsDir: string; backups: BackupMeta[]; now?: number; onboarding?: boolean }): AppTenantStatus {
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
  // only when asked; counts only; left out while there is no account (and never fatal to the rest of the status)
  let onboarding: TenantStatus['onboarding']
  if (o.onboarding) try { onboarding = tenantOnboarding(o.db, o.config.teamRoot, now) } catch { onboarding = undefined }
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
    ...(onboarding ? { onboarding } : {}),
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

/**
 * hosted-speech-key: the OpenRouter key the hosting service made for this team (hosted voice input and video sound,
 * 10 free hours a month; credentials/speech-key.ts), or null to take it away. Hosted servers only. The key comes on
 * stdin (never in argv), is stored encrypted with the credentials vault, and is in no output, error or audit row: the
 * audit says "set" or "removed". The server reads it at its next speech request (no restart).
 */
export function setHostedSpeechKey(o: { db: Database; secretsDir: string; config: AppConfig; log: Pick<Logger, 'info' | 'warn' | 'error'> }, input: unknown): { ok: true; set: boolean } {
  if (!isHosted(o.config)) throw new CloudTenantError('hosted-speech-key is for hosted servers only (server.json deployment "hosted")')
  const p = HostedSpeechKeyInput.safeParse(input)
  if (!p.success) throw new CloudTenantError('stdin must be { key: an OpenRouter key | null }')
  const cc = makeCredCtx({ db: o.db, secretsDir: o.secretsDir, config: o.config, log: o.log })
  const set = writeHostedSpeechKey(cc, p.data.key)
  audit(o.db, { actor: null, action: 'speech.hosted_key', target: null, detail: { key: set ? 'set' : 'removed' } })
  return { ok: true, set }
}

/**
 * hosted-chat-key: the trial AI credit the hosting service gives this team (credentials/hosted-chat.ts): an OpenRouter
 * key for the API engine (never Claude Code, docs/DECISIONS.md "Z") with its dollar cap, end time and switch, or
 * { key: null } to take it away. Hosted servers only. The
 * key comes on stdin (never in argv), is stored encrypted with the credentials vault and is in no output, error or audit
 * row: the audit says "set" or "removed" with the cap, end and switch. The answer carries what the team spent of the
 * credit so far (the server's own count, across key rotations), so the hosting service can size a new cap. The next
 * turn reads it (no restart).
 */
export function setHostedChatKey(o: { db: Database; secretsDir: string; config: AppConfig; log: Pick<Logger, 'info' | 'warn' | 'error'> }, input: unknown): { ok: true; set: boolean; usedUsd: number } {
  if (!isHosted(o.config)) throw new CloudTenantError('hosted-chat-key is for hosted servers only (server.json deployment "hosted")')
  const p = HostedChatKeyInput.safeParse(input)
  if (!p.success) throw new CloudTenantError('stdin must be { key: an OpenRouter key, capUsd, endsAt, enabled } or { key: null }')
  const cc = makeCredCtx({ db: o.db, secretsDir: o.secretsDir, config: o.config, log: o.log })
  const grant = p.data.key === null ? null : p.data as Extract<HostedChatKeyInput, { capUsd: number }>
  const r = writeHostedChatKey(cc, grant)
  audit(o.db, { actor: null, action: 'ai.hosted_trial_key', target: null, detail: grant ? { key: 'set', capUsd: grant.capUsd, endsAt: grant.endsAt, enabled: grant.enabled } : { key: 'removed' } })
  return { ok: true, ...r }
}

/**
 * hosted-image-key: the Higgsfield credential the hosting service gives this team for the welcome steps' brand photos
 * (credentials/hosted-image.ts): a developer API access token and its workspace id, or { token: null } to take it
 * away. Hosted servers only. The token comes on stdin (never in argv), is stored encrypted with the credentials vault
 * and is in no output, error or audit row: the audit says "set" or "removed". The next photo request reads it (no
 * restart).
 */
export function setHostedImageKey(o: { db: Database; secretsDir: string; config: AppConfig; log: Pick<Logger, 'info' | 'warn' | 'error'> }, input: unknown): { ok: true; set: boolean } {
  if (!isHosted(o.config)) throw new CloudTenantError('hosted-image-key is for hosted servers only (server.json deployment "hosted")')
  const p = HostedImageKeyInput.safeParse(input)
  if (!p.success) throw new CloudTenantError('stdin must be { token: a Higgsfield access token, workspace: its workspace id } or { token: null }')
  const cc = makeCredCtx({ db: o.db, secretsDir: o.secretsDir, config: o.config, log: o.log })
  const set = writeHostedImageKey(cc, p.data.token === null ? null : p.data as Extract<HostedImageKeyInput, { workspace: string }>)
  audit(o.db, { actor: null, action: 'onboarding.hosted_image_key', target: null, detail: { key: set ? 'set' : 'removed' } })
  return { ok: true, set }
}
