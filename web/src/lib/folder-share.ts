// Folder sharing on the screens (docs/AGENTS/plan/20261116-1330-folder-share-web.md; always on, owner 2026-11-17): what
// the Files page says about one of the person's own folders (GET /api/files/shares, read again when shares change anywhere: file_shares_changed, or this window's
// own dialog).
import { useEffect, useState } from 'react'
import { offersFolderShare } from '@mycel/shared'
import type { FileShares } from '@mycel/shared/api'
import { api, API } from './api'
import { fileSharesChanged } from '../store/live'

export { offersFolderShare }

/** `path` is the person's own personal folder or inside it */
export const isOwnPath = (path: string, me: string) => path === `users/${me}` || path.startsWith(`users/${me}/`)

/** An own folder's sharing, as the Files page shows it: `shared` (people on it, or on a folder above it), the name of
 * the folder the files on screen are shared through (itself when it has people, else the nearest above), `paused`.
 * Null while it is read, and for a folder that is not offered. */
export interface OwnShare { shared: boolean; through: string | null; paused: boolean; people: FileShares['people'] }
export function useOwnFolderShare(path: string | null, me: string): OwnShare | null {
  const ask = path !== null && offersFolderShare(path, me)
  const [state, setState] = useState<OwnShare | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => fileSharesChanged.on(() => setTick((n) => n + 1)), [])
  useEffect(() => {
    if (!ask || path === null) return setState(null)
    let live = true
    api.call(API.fileShares, { query: { path } }).then((r) => {
      if (!live) return
      const own = r.people.length > 0
      const above = r.through?.[0]?.name ?? null
      setState({ shared: own || !!above, through: own ? path.slice(path.lastIndexOf('/') + 1) : above, paused: !!r.paused, people: r.people })
    }, () => live && setState(null))
    return () => { live = false }
  }, [ask, path, tick])
  return ask ? state : null
}
