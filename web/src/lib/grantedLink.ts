// A team path the folder does not let me open, but whose file was shared with me (a path link in a room message, after
// the sender's "Let them view"; docs/decisions/20261116-ai-share-who-can-open.md): its /f/<id> link id, asked from the
// server (GET /api/files/granted-link: null for a file I can read anyway, one I may not open and a missing one alike).
// Asked once when a locked link is drawn, and again when some file share changes (the content-free
// file_shares_changed), so the lock turns into a link without a reload. One request per path at a time.
import { useEffect, useState } from 'react'
import { api, API } from './api'
import { fileSharesChanged } from '../store/live'

const asking = new Map<string, Promise<string | null>>()
const ask = (path: string): Promise<string | null> => {
  let p = asking.get(path)
  if (!p) {
    p = api.call(API.grantedFileLink, { query: { path } }).then((r) => r.id, () => null).finally(() => asking.delete(path))
    asking.set(path, p)
  }
  return p
}

/** The link id of `path` when it opens for me through a share, else null (also while unknown). */
export function useGrantedLink(path: string | undefined): string | null {
  const [id, setId] = useState<string | null>(null)
  useEffect(() => {
    if (!path) return
    let live = true
    const read = () => { void ask(path).then((v) => { if (live) setId(v) }) }
    read()
    const off = fileSharesChanged.on(read)
    return () => { live = false; off() }
  }, [path])
  return path ? id : null
}
