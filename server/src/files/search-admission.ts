// The broker alone reads mutable team files. Search consumers get copied bytes,
// never a checked pathname that they could reopen after replacement. A durable
// hash lease serializes admission with quarantine registration on ALL connections.
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { Quarantine } from '../safe-ops/quarantine'
import { sha256 } from './store'

export const sameVersion = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

export class SearchAdmission {
  readonly id = crypto.randomUUID()
  constructor(readonly quarantine?: Quarantine) {}
  transaction<T>(fn: () => T): T { return this.quarantine && !this.quarantine.db.inTransaction ? this.quarantine.db.transaction(fn).immediate() : fn() }

  /** validate must authorize the current path. Compare that identity to the held
   * descriptor, and recheck its version and path after reading. No decoder here. */
  read(abs: string, validate: () => fs.Stats | false | null, max = 50 * 1024 ** 2): { bytes: Buffer; st: fs.Stats } | null {
    return this.transaction(() => {
      let fd: number | undefined
      try {
        const expected = validate()
        if (!expected || !expected.isFile() || expected.nlink !== 1 || expected.size > max) return null
        fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
        const st = fs.fstatSync(fd), version = fs.fstatSync(fd, { bigint: true })
        if (!st.isFile() || st.nlink !== 1 || !sameVersion(expected, st)) return null
        const bytes = Buffer.alloc(st.size)
        let off = 0
        while (off < bytes.length) { const n = fs.readSync(fd, bytes, off, bytes.length - off, off); if (!n) return null; off += n }
        const after = fs.fstatSync(fd, { bigint: true }), current = validate()
        if (version.ctimeNs !== after.ctimeNs || version.mtimeNs !== after.mtimeNs || version.size !== after.size || after.nlink !== 1n || !current || !sameVersion(st, current)) return null
        if (!this.hold(bytes)) return null
        return { bytes, st }
      } catch { return null } finally { if (fd !== undefined) fs.closeSync(fd) }
    })
  }

  /** A durable empty-ledger lease permits legacy live search. The INSERT trigger
   * checks emptiness under the same write lock and blocks every first artifact
   * registration until all live consumers have exited. Never expire by PID/TTL. */
  emptyLedger(): boolean {
    if (!this.quarantine) return true
    return this.transaction(() => {
      const db = this.quarantine!.db
      if (db.query('SELECT 1 FROM safe_ops_artifacts LIMIT 1').get()
        || db.query('SELECT 1 FROM safe_ops_publications LIMIT 1').get()
        || db.query('SELECT 1 FROM safe_ops_inodes LIMIT 1').get()) return false
      db.query('INSERT INTO safe_ops_empty_searches(lease,owner_pid) VALUES(?,?)').run(this.id, process.pid)
      return true
    })
  }

  /** Also protects derived sidecar bytes before a search consumer sees them. */
  hold(bytes: Uint8Array): boolean {
    const q = this.quarantine
    if (!q) return true
    return this.transaction(() => {
      const hash = sha256(bytes)
      if (q.hasHash(hash)) return false
      q.db.query('INSERT OR IGNORE INTO safe_ops_search_inputs(lease,hash,owner_pid) VALUES(?,?,?)').run(this.id, hash, process.pid)
      return true
    })
  }
  close() {
    if (!this.quarantine) return
    this.transaction(() => {
      this.quarantine!.db.query('DELETE FROM safe_ops_search_inputs WHERE lease=?').run(this.id)
      this.quarantine!.db.query('DELETE FROM safe_ops_empty_searches WHERE lease=?').run(this.id)
    })
  }
}
