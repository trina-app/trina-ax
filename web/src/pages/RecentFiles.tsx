// 파일's "최근 파일" on a computer (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1;
// /files?view=recent, from the list beside the rail: components/panels/FilesPanel.tsx): the files I can read that changed
// last, newest first (GET /api/files/recent, the attach picker's list), each with the folder it is in and when it
// changed. A row opens the file as a file link does (/files/view: its folder with the preview beside it). On a phone
// (a row of the 파일 tab's places) the phone's bar, ‹ back to 파일.
import { File as FileIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { FileEntry } from '@mycel/shared/api'
import { useLocale, useT } from '../i18n'
import { api, API, errorText } from '../lib/api'
import { useFolderWords } from '../lib/folderLabels'
import { formatDateTime } from '../lib/format'
import { useGoBack } from '../lib/back'
import { useBackLabel } from '../lib/backStack'
import { PhonePageBar } from '../components/phone/PhonePageBar'
import { parentPath } from '../lib/paths'
import { filesChanged } from '../store/live'
import { ErrorNote, Skeleton, useMediaQuery } from '../components/ui'

export default function RecentFiles() {
  const t = useT(), locale = useLocale()
  const words = useFolderWords()
  const [items, setItems] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const phone = useMediaQuery('(max-width: 767.98px)')
  const back = useGoBack('/files')
  const backLabel = useBackLabel('/files', () => null)
  const load = useCallback(async () => {
    try {
      const r = await api.call(API.recentFiles, { query: { limit: 50 } })
      setItems(r.items.filter((f) => f.type === 'file'))
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])
  useEffect(() => {
    void load()
    return filesChanged.on(() => void load())
  }, [load])
  return (
    <div className="flex h-full flex-col" data-testid="recent-files">
      {phone ? (
        <PhonePageBar onBack={back} backLabel={backLabel} title={t('filesPanel.recent')} heading backTestId="files-back" titleTestId="files-title" />
      ) : (
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 sm:px-6">
          <h1 className="text-lg font-semibold">{t('filesPanel.recent')}</h1>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-4">
        {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
        {!items && !error && <Skeleton lines={5} className="px-2" />}
        {items && !items.length && <p className="px-2 py-3 text-sm text-muted" data-testid="recent-files-empty">{t('filesPanel.recentEmpty')}</p>}
        {items && items.length > 0 && (
          <ul>
            {items.map((f) => {
              const folder = parentPath(f.path)
              return (
                <li key={f.path}>
                  <Link to={`/files/view?path=${encodeURIComponent(f.path)}`} className="flex min-h-11 items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover" data-testid="recent-file">
                    <FileIcon size={18} className="shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink" title={f.name}>
                        {f.name}
                      </span>
                      <span className="block truncate text-xs text-muted" data-testid="recent-file-where">
                        {words.crumbs(folder).map((c) => c.name).join(' › ') || t('files.root')}
                      </span>
                    </span>
                    <time dateTime={f.mtime} className="shrink-0 text-xs text-faint">
                      {formatDateTime(f.mtime, locale)}
                    </time>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
