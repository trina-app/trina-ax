// 파일's list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1, phase P3), like
// Slack's Files: the places on the left, the folder or the file on the right (pages/Files.tsx).
// 최근 파일 (pages/RecentFiles.tsx), 팀 폴더 (the team folder's top folders I can see, in the order the Files screen
// shows them: 전사 공유, 부서, 팀 스킬, then the others), 프로젝트 폴더 (the projects I can see, by name), then 내 파일 (my
// own folder; "내 폴더" before, decision Q4) and 휴지통. The owner's setup row is on top while it shows. The row of the
// place on screen is marked: the deepest place the open folder is in.
// The same places are the root of a phone's 파일 tab with the new navigation (PhoneFilesHome below; docs/DECISIONS.md
// "Phone tabs: 트리나 · 대화 · 파일 · 나"): its bar says 파일, with 🔍 for files; a place opens on its own screen.
import clsx from 'clsx'
import { ChevronRight, Clock, Folder, Search, SquareKanban, Trash2, User } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { FileEntry } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { api, API } from '../../lib/api'
import { topFoldersFirst, useFolderWords } from '../../lib/folderLabels'
import { isInside } from '../../lib/paths'
import { filesChanged } from '../../store/live'
import { readProjectList, useProjects } from '../../store/projects'
import { useMe } from '../../store/session'
import { useUi } from '../../store/ui'
import { TEAM_TOP_ON_PHONE } from '../../lib/newChat'
import { SetupRow } from '../onboarding/SetupRow'
import { PhonePageBar } from '../phone/PhonePageBar'
import { IconButton } from '../ui'
import { PanelFrame, PanelLabel, panelRow } from './PanelFrame'

/** the team folder's top on a phone with the new tabs, where /files is these places (pages/Files.tsx, lib/screens.ts) */
export const TEAM_ROOT_ON_PHONE = TEAM_TOP_ON_PHONE

/** the top folders shown in their own sections instead (프로젝트 폴더, 내 파일) */
const APART = new Set(['projects', 'users'])

type Place = { key: string; to: string; label: string; icon: typeof Folder; path?: string; testId: string }

export function FilesPanel() {
  const t = useT()
  return (
    <PanelFrame title={t('sidebar.files')} testId="files-panel" top={<SetupRow />}>
      <FilesPlaces />
    </PanelFrame>
  )
}

/** A phone's 파일 tab at its root (pages/Files.tsx at /files with the new navigation's tabs). */
export function PhoneFilesHome() {
  const t = useT()
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  return (
    <div className="flex h-full flex-col" data-testid="phone-files-home">
      <PhonePageBar
        title={t('sidebar.files')}
        heading
        backTestId="files-back"
        titleTestId="files-title"
        action={
          <IconButton label={t('sidebar.search')} onClick={() => setSearchOpen(true)} className="size-11 shrink-0" data-testid="topbar-search">
            <Search size={20} />
          </IconButton>
        }
      />
      <nav aria-label={t('sidebar.files')} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-6" data-testid="files-panel">
        <SetupRow />
        <FilesPlaces phone />
      </nav>
    </div>
  )
}

/** 파일's places (see the top of this file); `phone`: rows a thumb can hit (44 px). */
function FilesPlaces({ phone = false }: { phone?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const words = useFolderWords()
  const me = useMe()?.user.id ?? null
  const [top, setTop] = useState<FileEntry[] | null>(null)
  useEffect(() => {
    let live = true
    const load = () =>
      void api.call(API.tree, { query: { path: '' } }).then(
        (r) => live && setTop([...topFoldersFirst(r.entries, '')].filter((e) => e.type === 'folder' && !APART.has(e.path))),
        // not read (offline, a server hiccup): the rows it had stay; none yet, the label still opens the team folder
        () => live && setTop((v) => v ?? []),
      )
    load()
    const off = filesChanged.on(load)
    return () => {
      live = false
      off()
    }
  }, [])
  const byId = useProjects((s) => s.byId)
  const listed = useProjects((s) => s.listed)
  useEffect(() => void readProjectList({ minAgeMs: 30_000 }).catch(() => {}), [])
  const projects = useMemo(() => {
    const collator = new Intl.Collator(locale, { numeric: true })
    return Object.values(byId)
      .filter((p) => !listed || listed.has(p.id))
      .sort((a, b) => collator.compare(a.name, b.name))
  }, [byId, listed, locale])

  const own = me ? `users/${me}` : null
  const team: Place[] = (top ?? []).map((e) => ({ key: e.path, to: `/files?path=${encodeURIComponent(e.path)}`, label: words.name(e.path, e.name), icon: Folder, path: e.path, testId: 'files-panel-team' }))
  const projectRows: Place[] = projects.map((p) => ({ key: p.id, to: `/files?path=${encodeURIComponent(p.folderPath)}`, label: p.name, icon: SquareKanban, path: p.folderPath, testId: 'files-panel-project' }))
  const mine: Place | null = own ? { key: 'mine', to: `/files?path=${encodeURIComponent(own)}`, label: words.name(own, own), icon: User, path: own, testId: 'files-panel-mine' } : null

  // which row is the place on screen: 최근 파일, 휴지통, or the deepest folder row the open folder (or file) is in
  const { pathname, search } = useLocation()
  const q = new URLSearchParams(search)
  const view = pathname === '/files' ? q.get('view') : null
  const at = view ? null : (q.get('path') ?? '')
  const folderRows = [...team, ...projectRows, ...(mine ? [mine] : [])]
  const lit =
    view === 'recent' ? 'recent' : view === 'trash' ? 'trash' : at !== null ? (folderRows.filter((r) => r.path && isInside(at, r.path) && at !== '').sort((a, b) => b.path!.length - a.path!.length)[0]?.key ?? null) : null

  const row = (p: Place) => (
    <li key={p.key}>
      <Link to={p.to} aria-current={lit === p.key ? 'page' : undefined} className={clsx(panelRow, phone && 'h-11', lit === p.key && 'bg-hover font-medium')} data-testid={p.testId}>
        <p.icon size={16} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={p.label}>
          {p.label}
        </span>
      </Link>
    </li>
  )
  return (
    <>
      <ul>{row({ key: 'recent', to: '/files?view=recent', label: t('filesPanel.recent'), icon: Clock, testId: 'files-panel-recent' })}</ul>
      {top !== null && (
        <section aria-labelledby="files-panel-team">
          {/* the label opens the team folder's top (files kept loose there, every top folder); a phone has no hover to
              show it, so there it is a whole-width row with a ›, and the places are the computer's, no extra row */}
          <PanelLabel id="files-panel-team" testId="files-panel-label">
            <Link to={phone ? TEAM_ROOT_ON_PHONE : '/files'} className={clsx('rounded hover:text-ink', phone ? 'flex min-h-11 w-full items-center gap-0.5' : 'hover:underline')} data-testid="files-panel-root">
              {t('filesPanel.team')}
              {phone && <ChevronRight size={14} aria-hidden />}
            </Link>
          </PanelLabel>
          <ul>{team.map(row)}</ul>
        </section>
      )}
      {projectRows.length > 0 && (
        <section aria-labelledby="files-panel-projects">
          <PanelLabel id="files-panel-projects" testId="files-panel-label">
            {t('filesPanel.projects')}
          </PanelLabel>
          <ul>{projectRows.map(row)}</ul>
        </section>
      )}
      <ul className="mt-3 border-t border-line pt-2">
        {mine && row(mine)}
        {row({ key: 'trash', to: '/files?view=trash', label: t('files.trash'), icon: Trash2, testId: 'files-panel-trash' })}
      </ul>
    </>
  )
}
