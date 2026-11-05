// The hosting service's Higgsfield credential for the welcome steps' brand photos (the first result may make up to 4
// photos a team with the image model `z_image` through Higgsfield's developer API, fnf-api-gw.higgsfield.ai/fnf, sent
// as `Authorization: Bearer <token>` with `hf-workspace-id: <workspace>`). The hosting service pays for it, so like the
// hosting speech key (credentials/speech-key.ts) and the trial AI key (credentials/hosted-chat.ts) it comes only from
// the control plane: mycel-ctl hosted-image-key-set (admin.js hosted-image-key, hosted servers only) with
// { token, workspace } on stdin, { token: null } to take it away. It is stored like them: encrypted with the
// credentials vault (AES-256-GCM, AAD "mycel-cred-v1|onboarding.image|higgsfield-token", vault.ts) in one settings row
// under an internal dot key that GET /api/admin/settings never returns. No response, log line or audit row holds the
// token, not even its last characters (the audit says "set" or "removed"). credentials-rekey (rekey.ts) encrypts it
// again; a server that is not hosted drops it at start (main.ts: a hosted team's backup restored on the team's own
// server must not keep using the hosting service's credential); the team's export leaves it out and a restore keeps the
// current one (system/backup.ts SERVER_OWN_SETTINGS). The token is an OAuth access token that expires: the hosting
// service sends a new one before it does (the server reads it again for each request, no restart).
import type { Database } from 'bun:sqlite'
import { getSetting, HOSTED_IMAGE_KEY_SETTING, setSetting } from '../admin/settings'
import { VaultError, type Vault } from './vault'
import type { CredCtx } from './store'

export { HOSTED_IMAGE_KEY_SETTING }
const VAULT_ID = 'onboarding.image'
const KIND = 'higgsfield-token'

/** a Higgsfield developer API access token and the workspace (a UUID) it is for */
export interface HiggsfieldToken { token: string; workspace: string }
interface Stored { enc: string; keyVersion: number; updatedAt: string }

const stored = (db: Database): Stored | null => {
  const v = getSetting<Stored>(db, HOSTED_IMAGE_KEY_SETTING)
  return v && typeof v.enc === 'string' && typeof v.keyVersion === 'number' ? v : null
}

/** Store (encrypted) or remove (null) the hosting service's Higgsfield credential. Returns whether one is stored now. */
export function writeHostedImageKey(cc: Pick<CredCtx, 'db' | 'vault' | 'now'>, v: HiggsfieldToken | null): boolean {
  if (v === null) cc.db.query('DELETE FROM settings WHERE key = ?').run(HOSTED_IMAGE_KEY_SETTING)
  else {
    const { enc, keyVersion } = cc.vault.encrypt(VAULT_ID, KIND, { token: v.token, workspace: v.workspace })
    setSetting(cc.db, HOSTED_IMAGE_KEY_SETTING, { enc, keyVersion, updatedAt: new Date(cc.now()).toISOString() } satisfies Stored)
  }
  return stored(cc.db) !== null
}

/** The credential in clear for one request; null without one or when it no longer decrypts (key file lost: the hosting
 * service sends it again). */
export function readHostedImageKey(cc: Pick<CredCtx, 'db' | 'vault'>): HiggsfieldToken | null {
  const s = stored(cc.db)
  if (!s) return null
  try {
    const v = cc.vault.decrypt(VAULT_ID, KIND, s.enc, s.keyVersion) as { token?: unknown; workspace?: unknown }
    return typeof v?.token === 'string' && v.token && typeof v.workspace === 'string' && v.workspace ? { token: v.token, workspace: v.workspace } : null
  } catch (e) {
    if (e instanceof VaultError) return null
    throw e
  }
}

/** Whether the hosting service's credential is stored (it may still fail to decrypt: readHostedImageKey). */
export function hostedImageKeySet(db: Database): boolean {
  return stored(db) !== null
}

/** A server that is not hosted keeps no hosting credential (main.ts at start). Returns whether one was removed. */
export function dropHostedImageKey(db: Database): boolean {
  return db.query('DELETE FROM settings WHERE key = ?').run(HOSTED_IMAGE_KEY_SETTING).changes > 0
}

/** credentials-rekey: encrypt the credential again under `next`. Returns the key version the stored value needs
 * afterwards (none stored: empty), so the rekey keeps that key file. */
export function rekeyHostedImageKey(db: Database, from: Vault, next: Vault): { versions: number[]; write: () => void } {
  const s = stored(db)
  if (!s) return { versions: [], write: () => {} }
  let value: unknown
  try { value = from.decrypt(VAULT_ID, KIND, s.enc, s.keyVersion) } catch { return { versions: [s.keyVersion], write: () => {} } }
  const { enc, keyVersion } = next.encrypt(VAULT_ID, KIND, value)
  return { versions: [keyVersion], write: () => setSetting(db, HOSTED_IMAGE_KEY_SETTING, { ...s, enc, keyVersion }) }
}
