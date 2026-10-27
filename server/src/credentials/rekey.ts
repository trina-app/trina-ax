// credentials-rekey (system/cli.ts, docs/DECISIONS.md "AI 연결" 3.2): a new key file credentials.key.<N+1>, every
// connection's secret encrypted again under it (one transaction), then the older key files removed. No screen in v1:
// the operator runs it after a suspected key leak. Rows that do not decrypt (already "needs reconnect") stay as they are.
import fs from 'node:fs'
import { Vault } from './vault'
import { listRows, type CredCtx } from './store'

export function rekeyCredentials(cc: CredCtx): number {
  const rows = listRows(cc.db)
  const next = Math.max(cc.vault.version, ...rows.map((r) => r.key_version)) + 1
  const nv = new Vault(cc.vault.secretsDir, next)
  const out: { id: string; enc: string }[] = []
  for (const r of rows) {
    let value: unknown
    try { value = cc.vault.decrypt(r.id, r.kind, r.secret_enc, r.key_version) } catch { continue }
    out.push({ id: r.id, enc: nv.encrypt(r.id, r.kind, value).enc })
  }
  const now = new Date(cc.now()).toISOString()
  cc.db.transaction(() => {
    for (const o of out) cc.db.query('UPDATE engine_credentials SET secret_enc = ?, key_version = ?, updated_at = ? WHERE id = ?').run(o.enc, next, now, o.id)
  })()
  // the older keys go once no row needs them (rows that never decrypted keep theirs: nothing lost that worked)
  const still = new Set((cc.db.query('SELECT DISTINCT key_version AS v FROM engine_credentials').all() as { v: number }[]).map((x) => x.v))
  for (let v = 1; v < next; v++) if (!still.has(v)) fs.rmSync(cc.vault.keyPath(v), { force: true })
  ;(cc as { vault: Vault }).vault = nv
  cc.cache.clear()
  return out.length
}
