// Files dragged onto the app: what a drag carries that a drop target takes (components/chat/ComposerFiles.tsx
// useFileDrop, components/FileDropZone.tsx), and the page-wide guard for the drops nothing took.
import { TEAM_FILE_DRAG_TYPE } from './teamAttach'

/** What a drag brings that a box can take: files from this computer, or a team file of the app. */
export type DropKind = 'files' | 'team'

/** A drag that started on this page (a picture or a link in a message, a picture in a box): Chromium, and so the
 * desktop app, puts a dragged picture in as a file ("Files"), but it is not a file from this computer. From its
 * dragstart to its dragend (watched by guardFileDrops); a dragend that never reaches the window (its element was taken
 * out of the page) is made up for by the next pointer move or press, as none comes while a drag lasts. */
let pageDrag = false

/** What this drag carries that a target takes: files from this computer (the drag carries "Files" and did not start on
 * this page), or (`team`) a team file dragged from the file screen, a preview or a message. Text, a link, a picture or a
 * message dragged inside the app carries neither: null. */
export function dragKind(dt: DataTransfer | null | undefined, take: { files?: boolean; team?: boolean }): DropKind | null {
  const types = dt ? [...dt.types] : []
  if (take.team && types.includes(TEAM_FILE_DRAG_TYPE)) return 'team'
  if (take.files && !pageDrag && types.includes('Files')) return 'files'
  return null
}

/** The page-wide guard (web/src/main.tsx): a file dropped where no drop target took it would be opened by the browser in
 * place of the app (the desktop app would hand its file:// address to the system). Only file drags from this computer,
 * and only those no target took (a target calls preventDefault): text, links and the app's own drags keep the browser's
 * way. It also notes the drags that start on the page (pageDrag). */
export function guardFileDrops(win: Pick<Window, 'addEventListener'>) {
  win.addEventListener('dragstart', () => { pageDrag = true }, true)
  const ended = () => { pageDrag = false }
  for (const type of ['dragend', 'pointermove', 'pointerdown'] as const) win.addEventListener(type, ended, true)
  const stop = (e: Event) => {
    const dt = (e as Event & { dataTransfer?: DataTransfer | null }).dataTransfer
    if (e.defaultPrevented || !dragKind(dt, { files: true })) return
    e.preventDefault()
    if (dt) dt.dropEffect = 'none'
  }
  win.addEventListener('dragover', stop)
  win.addEventListener('drop', stop)
}
