import { Vault, detectVersion } from '../../credentials/vault'
import { DriveStore, type ConnectionRow, type FlowRow } from './store'

/** Rotate Drive only, including pending verifiers/tokens. Keep old keys for in-flight processes and backups. */
export function rekeyDrive(store: DriveStore): number {
  store.safeDirectory(true)
  let count = 0
  store.db.transaction(() => {
    const nv = new Vault(store.secretsDir, detectVersion(store.secretsDir) + 1)
    for (const table of ['drive_connections', 'drive_oauth_flows'] as const) {
      const rows = store.db.query(`SELECT * FROM ${table} WHERE secret_enc IS NOT NULL`).all() as (ConnectionRow | FlowRow)[]
      for (const row of rows) {
        let value: unknown
        try { value = store.open(row) } catch { continue }
        const sealed = nv.encrypt(`${row.user_id}:${row.id}`, 'google-drive', value)
        store.db.query(`UPDATE ${table} SET secret_enc=?,key_version=? WHERE id=?`).run(sealed.enc, sealed.keyVersion, row.id)
        count++
      }
    }
    store.vault = nv
  }).immediate()
  return count
}
