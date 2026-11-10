// Files dragged onto the app: what a drag carries that a drop target takes (components/chat/ComposerFiles.tsx
// useFileDrop, components/FileDropZone.tsx), and the page-wide guard for the drops nothing took.
import { TEAM_FILE_DRAG_TYPE } from './teamAttach'

/** What a drag brings that a box can take: files from this computer, or a team file of the app. */
export type DropKind = 'files' | 'team'

/** What this drag carries that a target takes: files from this computer (the drag carries "Files"), or (`team`) a team
 * file dragged from the file screen, a preview or a message. Text, a link or a message dragged inside the app carries
 * neither: null. */
export function dragKind(dt: DataTransfer | null | undefined, take: { files?: boolean; team?: boolean }): DropKind | null {
  const types = dt ? [...dt.types] : []
  if (take.team && types.includes(TEAM_FILE_DRAG_TYPE)) return 'team'
  if (take.files && types.includes('Files')) return 'files'
  return null
}

/** The page-wide guard (web/src/main.tsx): a file dropped where no drop target took it would be opened by the browser in
 * place of the app (the desktop app would hand its file:// address to the system). Only file drags, and only those no
 * target took (a target calls preventDefault): text, links and the app's own drags keep the browser's way. */
export function guardFileDrops(win: Pick<Window, 'addEventListener'>) {
  const stop = (e: Event) => {
    const dt = (e as Event & { dataTransfer?: DataTransfer | null }).dataTransfer
    if (e.defaultPrevented || !dragKind(dt, { files: true })) return
    e.preventDefault()
    if (dt) dt.dropEffect = 'none'
  }
  win.addEventListener('dragover', stop)
  win.addEventListener('drop', stop)
}
