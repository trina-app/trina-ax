// 파일's "Shared with me" (/files?view=shared, a row under 최근 파일 in components/panels/FilesPanel.tsx; file sharing P2,
// docs/decisions/20261116-files-shared-with-me.md): the files people shared with me that open for me now, newest first
// (GET /api/files/shared-with-me). Each row: the file's name, who shared it and when; never where it lives. A row opens
// its link page (/f/<id>, pages/FileLink.tsx), which then offers "‹ Shared with me" back here. On a phone the phone's
// bar, ‹ back to 파일 (as RecentFiles).
//
// The list as last read (store/fileLists.ts) shows at once and is read again behind it. It reads again on a share
// change anywhere (file_shares_changed), a new notice, an access or file change, a live connection that could not resume,
// and when the window comes back after 30 s. A page may come back empty while there is more (the server stops after a
// bounded amount of work): the store reads on by itself, and the empty line shows only once there is nothing more.
// A shared folder (folder sharing, docs/AGENTS/plan/20261116-1330-folder-share-web.md) is a row with a folder's mark; it
// opens its link page, which lists what is inside.
import { Folder } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fileLinkUrl } from '@mycel/shared/api'
import { useLocale, useT } from '../i18n'
import { errorText } from '../lib/api'
import { formatShortDate } from '../lib/format'
import { FILES_SHARED as SHARED_WITH_ME } from '../lib/nav'
import { useGoBack } from '../lib/back'
import { useBackLabel } from '../lib/backStack'
import { PhonePageBar } from '../components/phone/PhonePageBar'
import { ListRow } from '../components/list/List'
import { FileKindIcon } from '../components/chat/TeamFilePicker'
import { readMoreShared, readSharedWithMe, useFileLists } from '../store/fileLists'
import { accessChanged, fileSharesChanged, filesChanged, notificationsChanged, reloadAsked } from '../store/live'
import { Button, EmptyState, ErrorNote, Skeleton, useMediaQuery } from '../components/ui'

/** the window back after this long: read again */
const STALE_MS = 30_000

export default function SharedFiles() {
  const t = useT(), locale = useLocale()
  const list = useFileLists((s) => s.shared)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const phone = useMediaQuery('(max-width: 767.98px)')
  const back = useGoBack('/files')
  const backLabel = useBackLabel('/files', () => null)
  const readAt = useRef(0)
  const load = useCallback(async (fresh = false) => {
    try {
      await readSharedWithMe({ fresh })
      readAt.current = Date.now()
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])
  useEffect(() => {
    void load()
    const again = () => void load(true)
    const offs = [fileSharesChanged.on(again), notificationsChanged.on(again), filesChanged.on(again), accessChanged.on(again), reloadAsked.on(again)]
    // a window back after a while (a change missed while the computer slept): read again
    const returned = () => { if (document.visibilityState === 'visible' && Date.now() - readAt.current > STALE_MS) again() }
    window.addEventListener('focus', returned)
    document.addEventListener('visibilitychange', returned)
    return () => {
      offs.forEach((off) => off())
      window.removeEventListener('focus', returned)
      document.removeEventListener('visibilitychange', returned)
    }
  }, [load])
  const readMore = useCallback(async () => {
    setMore(true)
    try {
      await readMoreShared()
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setMore(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])
  // the end of the list in view: read on (a person scrolls; Load more stays for a keyboard and a failed read)
  const end = useRef<HTMLDivElement>(null)
  const next = list?.next ?? null
  const rows = list?.items.length ?? 0
  useEffect(() => {
    const el = end.current
    if (!el || !next || !rows || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) void readMore() })
    io.observe(el)
    return () => io.disconnect()
  }, [next, rows, readMore])

  const items = list?.items ?? null
  return (
    <div className="flex h-full flex-col" data-testid="shared-files">
      {phone ? (
        <PhonePageBar onBack={back} backLabel={backLabel} title={t('filesPanel.shared')} heading backTestId="files-back" titleTestId="files-title" />
      ) : (
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 sm:px-6">
          <h1 className="text-title font-semibold">{t('filesPanel.shared')}</h1>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2 sm:px-6">
        {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
        {!items && !error && <Skeleton lines={5} className="py-2" />}
        {items && !items.length && !next && (
          <div data-testid="shared-files-empty">
            <EmptyState title={t('filesPanel.sharedEmptyFolders')} />
          </div>
        )}
        {items && items.length > 0 && (
          <ul data-testid="shared-files-list">
            {items.map((f) => (
              <ListRow
                key={f.linkId}
                to={fileLinkUrl(f.linkId)}
                state={{ from: SHARED_WITH_ME }}
                icon={f.kind === 'folder' ? <Folder size={18} className="text-accent-text" aria-hidden /> : <FileKindIcon name={f.name} />}
                name={f.name}
                nameTitle={f.name}
                meta={t('filesPanel.sharedMeta', { name: f.sharedBy ?? t('filesPanel.formerMember'), date: formatShortDate(f.sharedAt, locale) })}
                scale="page"
                testId="shared-file"
                link={{ 'data-kind': f.kind ?? 'file' }}
                nameTestId="shared-file-name"
                metaTestId="shared-file-meta"
              />
            ))}
          </ul>
        )}
        {next && items && (
          <div ref={end} className="py-3">
            <Button className="w-full" busy={more} onClick={() => void readMore()} data-testid="shared-files-more">
              {t('common.loadMore')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
