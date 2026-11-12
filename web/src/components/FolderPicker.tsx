// Pick a folder of the team folder (only what the person can see). Used by "save to the team folder", move,
// projects and the admin folder rules. For a move (`suggestFor`: the paths being moved) "Suggested" and "Recent" come
// first (docs/DECISIONS.md "Move picker: suggested and recent folders"): a row picks that folder, ✕ stops suggesting it.
import clsx from 'clsx'
import { ChevronRight, Clock, Folder, FolderPlus, Home, Lock, Signpost, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MOVE_SUGGEST_FILES, type FileEntry, type MoveSuggestions, type TreeResponse } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { topFoldersFirst, useFolderWords } from '../lib/folderLabels'
import { crumbs, joinPath, nameProblem } from '../lib/paths'
import { useLocale, useT } from '../i18n'
import { Button, ErrorNote, IconButton, Modal, Skeleton, promptDialog } from './ui'

export default function FolderPicker({
  open,
  title,
  confirmLabel,
  initial = '',
  needWrite = true,
  allowCreate = true,
  selectableRoot,
  suggestFor,
  onPick,
  onClose,
}: {
  open: boolean
  title: string
  confirmLabel: string
  initial?: string
  needWrite?: boolean
  allowCreate?: boolean
  /** Optional selection boundary; ancestors stay browsable. The server still authorizes the chosen path. */
  selectableRoot?: string
  /** a move: the paths being moved, for the server's suggested and recent folders on top */
  suggestFor?: readonly string[]
  onPick: (path: string) => void
  onClose: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const words = useFolderWords()
  const [path, setPath] = useState(initial)
  const [tree, setTree] = useState<TreeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rev, setRev] = useState(0)
  const [hints, setHints] = useState<MoveSuggestions | null>(null)
  const moving = suggestFor?.slice(0, MOVE_SUGGEST_FILES) ?? []
  const movingKey = moving.join('\u0000')

  // the suggested and recent folders, once per opening (no AI: names against the folders the person can write)
  useEffect(() => {
    setHints(null)
    if (!open || !movingKey) return
    let live = true
    api.call(API.moveSuggestions, { body: { paths: movingKey.split('\u0000') } }).then(
      (r) => live && setHints(r),
      () => undefined, // no hints: the picker works as before
    )
    return () => {
      live = false
    }
  }, [open, movingKey])

  // after ✕ the focus goes on, never to the page: the next suggestion, else "All folders", else the path above the list
  const hintsRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const [refocus, setRefocus] = useState(0)
  useEffect(() => {
    if (!refocus) return
    const next = hintsRef.current?.querySelector<HTMLElement>('[data-testid="move-suggested"] [data-testid="move-hint"]') ?? hintsRef.current?.querySelector<HTMLElement>('[data-testid="all-folders"]') ?? navRef.current
    next?.focus()
  }, [refocus])
  const dismiss = (folder: string) => {
    setHints((h) => h && { ...h, suggested: h.suggested.filter((s) => s.path !== folder) })
    setRefocus((n) => n + 1)
    api.call(API.dismissMoveSuggestion, { body: { paths: moving, folder } }).catch(() => undefined)
  }

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

  // at the team root 전사 공유, 부서, 프로젝트, 팀 스킬, 개인 first, as on the file screen
  const folders = topFoldersFirst(tree?.entries.filter((e: FileEntry) => e.type === 'folder') ?? [], path)
  const inRoot = !selectableRoot || path === selectableRoot || path.startsWith(selectableRoot + '/')
  const canPick = !!tree && tree.access !== 'none' && (!needWrite || tree.access === 'write') && inRoot

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
      {hints && (hints.suggested.length > 0 || hints.recent.length > 0) && (
        <div ref={hintsRef} className="mb-3 space-y-3" data-testid="move-hints">
          {hints.suggested.length > 0 && (
            <HintRows label={t('files.suggestedFolders')} testId="move-suggested" icon={<Folder size={15} className="text-accent-text" aria-hidden />}
              items={hints.suggested.map((s) => s.path)} current={path} pathLabel={(p) => words.path(p, ' › ')}
              onPick={setPath} dismissLabel={(p) => t('files.dismissSuggestion', { folder: words.path(p, ' › ') })} onDismiss={dismiss} />
          )}
          {hints.recent.length > 0 && (
            <HintRows label={t('files.recentFolders')} testId="move-recent" icon={<Clock size={15} className="text-faint" aria-hidden />}
              items={hints.recent.map((s) => s.path)} current={path} pathLabel={(p) => words.path(p, ' › ')} onPick={setPath} />
          )}
          <h3 tabIndex={-1} className="text-xs font-medium text-faint focus:outline-none" data-testid="all-folders">{t('files.allFolders')}</h3>
        </div>
      )}
      <nav ref={navRef} tabIndex={-1} aria-label={t('files.breadcrumb')} className="mb-3 flex flex-wrap items-center gap-1 text-sm focus:outline-none">
        <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover" onClick={() => setPath('')}>
          <Home size={14} aria-hidden /> {t('files.root')}
        </button>
        {crumbs(path).map((c) => (
          <span key={c.path} className="inline-flex items-center gap-1">
            <ChevronRight size={13} className="text-faint" aria-hidden />
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-hover" onClick={() => setPath(c.path)}>
              {words.name(c.path, c.name)}
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
                className={clsx('flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-sm last:border-0 hover:bg-hover focus-visible:-outline-offset-2')}
                onClick={() => setPath(f.path)}
              >
                <Folder size={15} className="text-accent-text" aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={f.name}>{words.name(f.path, f.name)}</span>
                {/* a folder listed with no access of its own is one you pass through to folders inside that are open to
                    you (a project, a group): said as on the Files screen, not "No access" (QA TC-157) */}
                {f.access === 'read' && (
                  <span className="inline-flex items-center gap-1 text-xs text-faint">
                    <Lock size={12} aria-hidden /> {t('files.readOnly')}
                  </span>
                )}
                {f.access !== 'write' && f.access !== 'read' && (
                  <span className="inline-flex items-center gap-1 text-xs text-faint" title={t('files.navigationOnly')} data-testid="picker-pass-through">
                    <Signpost size={12} aria-hidden /> {t('files.passThroughShort')}
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

/** "Suggested" or "Recent": a row picks the folder (the picker opens it, "Move here" moves); ✕ only for suggestions. */
function HintRows({ label, testId, icon, items, current, pathLabel, onPick, dismissLabel, onDismiss }: {
  label: string
  testId: string
  icon: ReactNode
  items: string[]
  current: string
  pathLabel: (p: string) => string
  onPick: (p: string) => void
  dismissLabel?: (p: string) => string
  onDismiss?: (p: string) => void
}) {
  return (
    <section aria-label={label} data-testid={testId}>
      <h3 className="mb-1 text-xs font-medium text-faint">{label}</h3>
      <ul className="rounded-lg border border-line">
        {items.map((p) => (
          <li key={p} className={clsx('flex items-center border-b border-line last:border-0', current === p && 'bg-accent-soft')}>
            <button
              type="button"
              aria-pressed={current === p}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-hover focus-visible:-outline-offset-2 max-md:min-h-11"
              onClick={() => onPick(p)}
              data-testid="move-hint"
            >
              {icon}
              <span className="min-w-0 flex-1 truncate" title={pathLabel(p)}>{pathLabel(p)}</span>
            </button>
            {onDismiss && dismissLabel && (
              <IconButton label={dismissLabel(p)} className="mr-1 shrink-0" onClick={() => onDismiss(p)} data-testid="move-hint-dismiss">
                <X size={14} aria-hidden />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
