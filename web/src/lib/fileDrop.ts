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

/** Files a drop marked as plain files (their entry said so): never taken for a folder by withoutFolders. */
const plainFiles = new WeakSet<File>()

/** The files a drop carries and how many folders were in it (TC-4483). A folder is no attachment: the browser hands it
 * over as a File with no bytes to read, and its upload failed as if the connection were lost. Each item's entry says
 * which it is (DataTransferItem.webkitGetAsEntry, every current browser and the desktop app); read in the drop event
 * itself (the items are empty after it). Where there are no entries, all of `dt.files` comes back, and withoutFolders
 * tells the folders by their missing bytes. */
export function filesOfDrop(dt: Pick<DataTransfer, 'files'> & { items?: DataTransferItemList | null }): { files: File[]; folders: number } {
  const all = Array.from(dt.files ?? [])
  const items = Array.from(dt.items ?? []).filter((it) => it.kind === 'file')
  if (!items.length || !items.every((it) => typeof it.webkitGetAsEntry === 'function')) return { files: all, folders: 0 }
  const files: File[] = []
  let folders = 0
  for (const it of items) {
    const entry = it.webkitGetAsEntry()
    if (entry?.isDirectory) { folders++; continue }
    const file = it.getAsFile()
    if (!file) continue
    if (entry?.isFile) plainFiles.add(file)
    files.push(file)
  }
  return { files, folders }
}

/** A File that may be a folder: no bytes, no type, not marked a plain file by its drop's entry (a folder from a browser
 * without entries, or one that came another way, as a file input). Reading it settles it: an empty file reads, a folder
 * does not. */
async function isFolder(file: File): Promise<boolean> {
  if (plainFiles.has(file) || file.size !== 0 || file.type !== '') return false
  try {
    await file.arrayBuffer()
    return false
  } catch {
    return true
  }
}

/** `files` without the folders among them (see isFolder), and how many there were: what a message box takes from a drop,
 * a pick or a paste. */
export async function withoutFolders(files: readonly File[]): Promise<{ files: File[]; folders: number }> {
  const folder = await Promise.all(files.map(isFolder))
  return { files: files.filter((_, i) => !folder[i]), folders: folder.filter(Boolean).length }
}
