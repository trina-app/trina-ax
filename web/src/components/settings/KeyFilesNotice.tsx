// The files under the notice "N files the AI made for you have a saved key of a connected service in them"
// (files.stored_key; server/src/integrations/connections/file-scan.ts, QA TC-3082): each by its name and its place in
// the Files sidebar's words, a link that opens it. Only the files the person may open now come from the server.
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { InboxNotification } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useFolderWords } from '../../lib/folderLabels'
import { placeWords, type PlaceWords } from '../../lib/trashList'
import { baseName, parentPath } from '../../lib/paths'
import { useMeStrict } from '../../store/session'
import { useProjects } from '../../store/projects'
import { FileKindIcon } from '../chat/TeamFilePicker'

export const keyFileHref = (path: string) => `/files/view?path=${encodeURIComponent(path)}`

export function KeyFilesNoticeExtras({ item, onRead }: { item: InboxNotification; onRead: () => void }) {
  const t = useT()
  const words = useFolderWords()
  const me = useMeStrict().user.id
  const byId = useProjects((s) => s.byId)
  const place: PlaceWords = useMemo(() => ({
    words, me, projects: Object.values(byId).flatMap((p) => (p.folderPath ? [{ name: p.name, folderPath: p.folderPath }] : [])),
    root: t('files.root'), myProjects: t('projectsPanel.mine'), personal: words.name('users', 'users'),
  }), [words, me, byId, t])
  const k = item.keyFiles
  if (!k || !k.files.length) return null
  const more = k.n - k.files.length
  return (
    <div className="mt-1 min-w-0" data-testid="notification-key-files">
      <ul aria-label={t('notifications.keyFiles.list')} className="max-h-60 overflow-auto">
        {k.files.map((f) => (
          <li key={f.path}>
            <Link to={keyFileHref(f.path)} onClick={onRead} className="-mx-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-hover max-md:py-2.5" data-testid="notification-key-file">
              <FileKindIcon name={f.path} size={15} />
              <bdi className="min-w-0 truncate text-ink">{baseName(f.path)}</bdi>
              <bdi className="min-w-0 shrink-[2] truncate text-xs text-muted">{placeWords(parentPath(f.path), place)}</bdi>
            </Link>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="mt-1 text-xs text-muted" data-testid="notification-key-files-more">{t('notifications.keyFiles.more', { n: more })}</p>}
    </div>
  )
}
