// /f/batch/:id — the files of one Share press (QA TC-3510, docs/decisions/20261116-file-share-everyone.md): a notice of
// several files ("Mina shared 5 files with you") opens this list. GET /api/files/shared-batch/:id answers for someone
// that press told, with the files they can open now (each row opens its own link page, /f/<id>); nothing else about the
// press. None left: one line; a link that is not theirs: the file link page's "doesn't work" line.
import { File as FileIcon, Lock } from 'lucide-react'
import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { fileLinkUrl, type SharedBatchView } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { formatSize } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { ListRow } from '../components/list/List'
import { ErrorNote, Skeleton, pageColumn } from '../components/ui'

export default function FileBatch() {
  const { id = '' } = useParams()
  const t = useT()
  const locale = useLocale()
  const [view, setView] = useState<SharedBatchView | 'unknown' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const load = () => {
    setError(null)
    api.call(API.sharedBatch, { params: { id } }).then(setView, (e) => {
      if (isApiError(e, 'not_found') || isApiError(e, 'validation') || isApiError(e, 'forbidden')) setView('unknown')
      else setError(e)
    })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [id])

  if (error) return <Page><ErrorNote onRetry={load}>{errorText(error, locale, t('error.network'))}</ErrorNote></Page>
  if (!view) return <Page><Skeleton lines={4} className="w-full" /></Page>
  if (view === 'unknown' || !view.files.length)
    return (
      <Page>
        <div className="flex flex-col items-center gap-3 py-12 text-center" data-testid="file-batch-closed">
          <Lock size={28} className="text-faint" aria-hidden />
          <p className="text-sm break-keep text-muted">{view === 'unknown' ? t('fileLink.unknown') : t('fileBatch.none')}</p>
        </div>
      </Page>
    )
  const n = view.files.length
  return (
    <Page>
      <h1 className="text-title font-semibold break-keep text-ink" data-testid="file-batch-title">
        {view.by ? t('notifications.event.file.sharedMany', { by: view.by, n }) : t('notifications.event.file.sharedManyNoName', { n })}
      </h1>
      <ul className="mt-3" data-testid="file-batch-list">
        {view.files.map((f) => (
          <ListRow key={f.linkId} to={fileLinkUrl(f.linkId)} icon={<FileIcon size={16} aria-hidden />} name={f.name} meta={formatSize(f.size, locale)} scale="page" li={{ 'data-testid': 'file-batch-row' }} />
        ))}
      </ul>
    </Page>
  )
}

/** the page's column and gutter, as Activity's (a page list's rows reach out past it on a computer and keep the gutter
 * on a phone: ListRow scale 'page') */
function Page({ children }: { children: ReactNode }) {
  return (
    <div className={clsx(pageColumn, 'px-4 pt-5 pb-6 sm:px-6')} data-testid="file-batch-page">
      {children}
    </div>
  )
}
