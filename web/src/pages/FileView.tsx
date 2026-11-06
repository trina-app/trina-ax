// /files/view?path=… — the link the AI's share_file / make_file tools hand out (shared/src/api/files.ts
// fileShareUrl), also with a place (&page=12, &sheet=…, &slide=3: the AI's links to its sources). A file opens in the
// preview panel on the files screen of its folder, at that place; a folder opens the files screen there. The server checks the viewer's own access again for everything the screen loads.
import { useEffect } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { fileViewTarget } from '../lib/markdown'
import { openTeamFile } from '../lib/sidePanel'

export default function FileView() {
  const [params] = useSearchParams()
  const target = fileViewTarget(params.get('path') ?? '', params)
  const at = target.kind === 'file' ? target.at : undefined
  const atKey = at ? JSON.stringify(at) : ''
  useEffect(() => {
    if (target.kind === 'file') openTeamFile(target.path, at)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind, target.path, atKey])
  const folder = target.kind === 'file' ? target.folder : target.path
  return <Navigate to={folder ? `/files?path=${encodeURIComponent(folder)}` : '/files'} replace />
}
