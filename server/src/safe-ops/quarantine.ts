import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { sha256, sha256Regular } from '../files/store'
import { ToolError } from '../policy/errors'

/** Content-addressed, durable and independent of the feature switch. Copies and
 * renames of exact bytes remain quarantined, including uploads and history. */
export class Quarantine {
  constructor(readonly db: Database, readonly root: string) {}
  add(bytes: Uint8Array, kind: 'pptx' | 'image') {
    const hash = sha256(bytes)
    try {
      this.db.query('INSERT OR IGNORE INTO safe_ops_artifacts(hash,size,kind) VALUES(?,?,?)').run(hash, bytes.byteLength, kind)
    } catch (e) {
      if (String(e).includes('safe_ops_search_busy')) throw new ToolError('An active search holds these bytes. Retry after it finishes.', 'safe_ops_search_busy')
      throw e
    }
    return hash
  }
  hasHash(hash: string) { return !!this.db.query('SELECT 1 FROM safe_ops_artifacts WHERE hash=?').get(hash) }
  hasBytes(bytes: Uint8Array) {
    if (!this.db.query('SELECT 1 FROM safe_ops_artifacts WHERE size=? LIMIT 1').get(bytes.byteLength)) return false
    return this.hasHash(sha256(bytes))
  }
  hasFile(abs: string) {
    const st = fs.lstatSync(abs)
    if (this.db.query("SELECT 1 FROM safe_ops_publications WHERE destination=? AND state!='conflict' LIMIT 1").get(path.relative(this.root,abs))) return true
    if (this.db.query('SELECT 1 FROM safe_ops_inodes WHERE identity=?').get(`${st.dev}:${st.ino}`)) return true
    if (!st.isFile() || !this.db.query('SELECT 1 FROM safe_ops_artifacts WHERE size=? LIMIT 1').get(st.size)) return false
    // streamed, whatever the size: with a read cap here, a download-only artifact larger than the cap would make every
    // read of a file of its size fail ("file is too large") in authorize(). Today's artifacts stay under it (decks
    // 32 MiB, images 1 MiB); the check must not depend on that. Hashed only for a file of an artifact's exact size.
    return this.hasHash(sha256Regular(abs))
  }
  assertBytes(bytes: Uint8Array) {
    if (this.hasBytes(bytes)) throw new ToolError('Generated output is download-only; indexing, text extraction and in-app previews are disabled.', 'safe_ops_quarantined')
  }
  assertDownload(abs: string, headers: Headers) {
    if (!this.hasFile(abs)) return
    if (fetchedByPage(headers)) throw new ToolError('Generated output is download-only.', 'safe_ops_quarantined')
  }
}

/** A request the browser says a page made (fetch, an <img>, a frame) rather than a download the person started: what a
 * download-only file is never sent to (Fetch Metadata; a client without the headers is not a page). */
export function fetchedByPage(headers: Headers): boolean {
  const mode = headers.get('sec-fetch-mode'), dest = headers.get('sec-fetch-dest')
  return (!!mode && mode !== 'navigate') || (!!dest && dest !== 'document' && dest !== 'empty')
}
