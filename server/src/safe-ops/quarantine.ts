import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { sha256, readRegular } from '../files/store'
import { ToolError } from '../policy/errors'

/** Content-addressed, durable and independent of the feature switch. Copies and
 * renames of exact bytes remain quarantined, including uploads and history. */
export class Quarantine {
  constructor(readonly db: Database, readonly root: string) {}
  add(bytes: Uint8Array, kind: 'pptx' | 'image') {
    const hash = sha256(bytes)
    this.db.query('INSERT OR IGNORE INTO safe_ops_artifacts(hash,size,kind) VALUES(?,?,?)').run(hash, bytes.byteLength, kind)
    return hash
  }
  hasHash(hash: string) { return !!this.db.query('SELECT 1 FROM safe_ops_artifacts WHERE hash=?').get(hash) }
  hasBytes(bytes: Uint8Array) {
    if (!this.db.query('SELECT 1 FROM safe_ops_artifacts WHERE size=? LIMIT 1').get(bytes.byteLength)) return false
    return this.hasHash(sha256(bytes))
  }
  hasFile(abs: string) {
    const st = fs.lstatSync(abs)
    if (this.db.query('SELECT 1 FROM safe_ops_publications WHERE destination=? LIMIT 1').get(path.relative(this.root,abs))) return true
    if (this.db.query('SELECT 1 FROM safe_ops_inodes WHERE identity=?').get(`${st.dev}:${st.ino}`)) return true
    if (!st.isFile() || !this.db.query('SELECT 1 FROM safe_ops_artifacts WHERE size=? LIMIT 1').get(st.size)) return false
    return this.hasBytes(readRegular(abs, 32 * 1024 ** 2).bytes)
  }
  assertBytes(bytes: Uint8Array) {
    if (this.hasBytes(bytes)) throw new ToolError('Generated output is download-only; indexing, text extraction and in-app previews are disabled.', 'safe_ops_quarantined')
  }
}
