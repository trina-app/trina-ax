// /files/view?path=… — the link the AI's share_file / make_file tools hand out (shared/src/api/files.ts
// fileShareUrl). A file opens in the preview panel on the files screen of its folder; a folder opens the files screen
// there. The server checks the viewer's own access again for everything the screen loads.
import { useEffect } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { fileViewTarget } from '../lib/markdown'
import { openTeamFile } from '../lib/sidePanel'

export default function FileView() {
  const [params] = useSearchParams()
  const target = fileViewTarget(params.get('path') ?? '')
  useEffect(() => {
    if (target.kind === 'file') openTeamFile(target.path)
  }, [target.kind, target.path])
  const folder = target.kind === 'file' ? target.folder : target.path
  return <Navigate to={folder ? `/files?path=${encodeURIComponent(folder)}` : '/files'} replace />
}
