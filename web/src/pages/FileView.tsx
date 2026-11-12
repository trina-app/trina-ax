// /files/view?path=… — the link the AI's share_file / make_file tools hand out (shared/src/api/files.ts
// fileShareUrl), also with a place (&page=12, &sheet=…, &slide=3: the AI's links to its sources). A file opens in the
// preview panel on the files screen of its folder, at that place; a folder opens the files screen there. The server checks the viewer's own access again for everything the screen loads.
import { useEffect } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { fileViewTarget } from '../lib/markdown'
import { openTeamFile } from '../lib/sidePanel'

/** the panel opening once this redirect is gone (see below) */
let opening: ReturnType<typeof setTimeout> | null = null

export default function FileView() {
  const [params] = useSearchParams()
  const target = fileViewTarget(params.get('path') ?? '', params)
  const at = target.kind === 'file' ? target.at : undefined
  const atKey = at ? JSON.stringify(at) : ''
  // The file opens when the files screen is in place, not with the redirect (QA TC-228). The router moves to the new
  // address in a transition and the panel store at once, so a panel opened here was drawn on this page's address
  // first; on a phone it held its Back entry there (components/Layout.tsx useBackCloses), let go of it when the new
  // address came, and that late Back closed the panel: the link showed only the folder. This page goes away when the
  // new address is drawn, so the panel opens then. React's StrictMode (development) unmounts and mounts once more: the
  // second mount takes the early opening back.
  useEffect(() => {
    if (opening !== null) {
      clearTimeout(opening)
      opening = null
    }
    if (target.kind !== 'file') return
    const path = target.path
    return () => {
      opening = setTimeout(() => {
        opening = null
        openTeamFile(path, at)
      }, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind, target.path, atKey])
  const folder = target.kind === 'file' ? target.folder : target.path
  return <Navigate to={folder ? `/files?path=${encodeURIComponent(folder)}` : '/files'} replace />
}
