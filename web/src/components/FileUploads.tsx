// The files going up from the file screen, one row each. A component of its own, so that a progress report redraws these
// rows and not the page with its file list (lib/fileUploads.ts holds them; a whole folder: FolderUploads.tsx). Phones:
// two or more finished ones fold into one line ("3개 올렸어요"), so the list there is what still needs an eye (QA TC-258).
import { Loader2, X } from 'lucide-react'
import { dropFileUpload, useFileUploads } from '../lib/fileUploads'
import { formatSize } from '../lib/format'
import { useFolderWords } from '../lib/folderLabels'
import { baseName } from '../lib/paths'
import { uploadBar } from '../lib/upload'
import { useLocale, useT } from '../i18n'
import { Button, IconButton, useMediaQuery } from './ui'
import { UploadLabel } from './UploadLabel'

export default function FileUploads({ here }: { here: string }) {
  const t = useT()
  const locale = useLocale()
  const words = useFolderWords()
  const items = useFileUploads((s) => s.items)
  const phone = useMediaQuery('(max-width: 767.98px)')
  if (!items.length) return null
  const done = items.filter((u) => u.status === 'done')
  const fold = phone && done.length >= 2
  return (
    <ul className="mx-4 mb-2 space-y-1 rounded-xl border border-line bg-surface p-2 sm:mx-6" aria-label={t('files.uploads')} data-testid="upload-list">
      {fold && (
        <li className="flex items-center gap-2 text-xs" data-status="done" data-testid="upload-done-summary">
          <span className="text-ok" aria-hidden>✓</span>
          <span role="status" className="min-w-0 flex-1 truncate">{t('files.uploadedCount', { n: done.length })}</span>
          <IconButton label={t('common.close')} onClick={() => done.forEach((u) => dropFileUpload(u.id))}>
            <X size={13} />
          </IconButton>
        </li>
      )}
      {(fold ? items.filter((u) => u.status !== 'done') : items).map((u) => {
        // the bar follows the label: empty while hashing, full while the server finishes, kept while it waits for the
        // connection
        const pct = uploadBar(u.progress)
        return (
          <li key={u.id} className="flex items-center gap-2 text-xs" data-status={u.status}>
            {u.status === 'uploading' ? <Loader2 size={13} className="shrink-0 animate-spin text-accent-text" aria-hidden /> : u.status === 'done' ? <span className="text-ok" aria-hidden>✓</span> : <span className="text-danger" aria-hidden>!</span>}
            <span className="min-w-0 flex-1 truncate">
              {/* dropped on a folder row: where it goes */}
              {u.folder !== here && <span className="text-faint">{words.name(u.folder, baseName(u.folder)) || t('files.root')}/</span>}
              {u.name}
            </span>
            {/* both stay through the whole upload, so a screen reader hears each change */}
            <span className="flex max-w-[50%] min-w-0 shrink-0 items-center">
              <span role="status" className="shrink-0 text-faint">
                {u.status === 'uploading' && (
                  <>
                    <UploadLabel progress={u.progress} busy={t('files.uploadingName', { name: u.name })} />
                    {u.progress && ` · ${formatSize(u.progress.total, locale)}`}
                  </>
                )}
                {u.status === 'done' && <span className="sr-only">{t('files.uploadedName', { name: u.name })}</span>}
              </span>
              <span role="alert" className="min-w-0 truncate text-danger">
                {u.status === 'failed' && (
                  <>
                    <span className="sr-only">{u.name}: </span>
                    {u.error}
                  </>
                )}
              </span>
            </span>
            {u.status === 'uploading' && (
              <div className="h-1 w-20 shrink-0 overflow-hidden rounded bg-subtle" aria-hidden>
                <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            )}
            {u.status === 'failed' && u.retry && (
              <Button size="sm" onClick={u.retry} data-testid="file-upload-retry">
                {t('common.retry')}
              </Button>
            )}
            <IconButton label={u.status === 'uploading' ? t('common.cancel') : t('common.close')} onClick={() => (u.status === 'uploading' ? u.abort.abort() : dropFileUpload(u.id))}>
              <X size={13} />
            </IconButton>
          </li>
        )
      })}
    </ul>
  )
}
