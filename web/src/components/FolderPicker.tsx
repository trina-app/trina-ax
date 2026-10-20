// Pick a folder of the team folder (only what the person can see). Used by "save to the team folder", move,
// projects and the admin folder rules.
import clsx from 'clsx'
import { ChevronRight, Folder, FolderPlus, Home, Lock } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FileEntry, TreeResponse } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { crumbs, joinPath, nameProblem } from '../lib/paths'
import { useLocale, useT } from '../i18n'
import { Button, ErrorNote, Modal, Skeleton, promptDialog } from './ui'

export default function FolderPicker({
  open,
  title,
  confirmLabel,
  initial = '',
  needWrite = true,
  allowCreate = true,
  onPick,
  onClose,
}: {
  open: boolean
  title: string
  confirmLabel: string
  initial?: string
  needWrite?: boolean
  allowCreate?: boolean
  onPick: (path: string) => void
  onClose: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const [path, setPath] = useState(initial)
  const [tree, setTree] = useState<TreeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rev, setRev] = useState(0)

  useEffect(() => {
    if (open) setPath(initial)
  }, [open, initial])

  useEffect(() => {
    if (!open) return
    let live = true
    setTree(null)
    setError(null)
    api.call(API.tree, { query: { path, limit: 200 } }).then(
      (r) => live && setTree(r),
      (e) => live && setError(errorText(e, locale, t('error.network'))),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path, rev])

  const folders = tree?.entries.filter((e: FileEntry) => e.type === 'folder') ?? []
  const canPick = !!tree && (!needWrite || tree.access === 'write')

  const mkdir = async () => {
    const name = await promptDialog({
      title: t('files.newFolder'),
      label: t('files.folderName'),
      confirm: t('common.create'),
      validate: (v) => (nameProblem(v) ? t(`files.name.${nameProblem(v)!}`) : null),
    })
    if (!name) return
    try {
      await api.call(API.mkdir, { body: { path: joinPath(path, name) } })
      setPath(joinPath(path, name))
      setRev((r) => r + 1)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={520}
      footer={
        <>
          {allowCreate && tree?.access === 'write' && (
            <Button variant="ghost" onClick={mkdir} className="mr-auto">
              <FolderPlus size={15} aria-hidden /> {t('files.newFolder')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!canPick} onClick={() => onPick(path)} data-testid="folder-pick">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <nav aria-label={t('files.breadcrumb')} className="mb-3 flex flex-wrap items-center gap-1 text-sm">
        <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover" onClick={() => setPath('')}>
          <Home size={14} aria-hidden /> {t('files.root')}
        </button>
        {crumbs(path).map((c) => (
          <span key={c.path} className="inline-flex items-center gap-1">
            <ChevronRight size={13} className="text-faint" aria-hidden />
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-hover" onClick={() => setPath(c.path)}>
              {c.name}
            </button>
          </span>
        ))}
      </nav>
      {error && <ErrorNote onRetry={() => setRev((r) => r + 1)}>{error}</ErrorNote>}
      {!tree && !error && <Skeleton lines={4} />}
      {tree && (
        <ul className="max-h-72 overflow-y-auto rounded-lg border border-line">
          {!folders.length && <li className="px-3 py-4 text-center text-sm text-faint">{t('files.noSubfolders')}</li>}
          {folders.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className={clsx('flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-sm last:border-0 hover:bg-hover')}
                onClick={() => setPath(f.path)}
              >
                <Folder size={15} className="text-accent-text" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                {f.access !== 'write' && (
                  <span className="inline-flex items-center gap-1 text-xs text-faint">
                    <Lock size={12} aria-hidden /> {t(f.access === 'read' ? 'files.readOnly' : 'files.noAccess')}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {tree && needWrite && tree.access !== 'write' && <p className="mt-2 text-xs text-warn">{t('files.pickNeedsWrite')}</p>}
    </Modal>
  )
}
