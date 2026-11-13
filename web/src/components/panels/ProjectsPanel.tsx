// 프로젝트's list (docs/DECISIONS.md "Projects: a place of their own"; the owner, 2026-11-13: "프로젝트를 그냥 따로 하나의
// 큰 탭으로"): beside the rail on a computer (ProjectsPanel) and as the phone's 프로젝트 tab (pages/Projects.tsx shows
// ProjectsList at /projects on a phone). "+ 새 프로젝트" on top (the name-only dialog, NewProjectDialog.tsx), then two sections: 팀
// 프로젝트 (others see it too) and 내 프로젝트 (only I do: onlyMine below). Each project
// is one plain row: its name and, small and grey under it, who sees it ("멤버 4명", "나만"), when my latest chat there
// was active and how many chats of my list it holds ("2시간 전 · 대화 5개"; "대화 없음" for none); the most
// recently active first, the ones without a chat of mine after them, newest first. No chats in this list (a tree in a narrow column is a developer's pattern): a project's row opens its page
// on the right, which lists its chats, its instructions and its files, as ChatGPT's and Claude's projects do.
// The counts are the server's (GET /api/chats/groups projectActivity), never what this window happens to have loaded.
import clsx from 'clsx'
import { Lock, Plus, SquareKanban, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import type { Project } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { formatRelative } from '../../lib/format'
import { useRailHere } from '../../lib/rail'
import { useChats } from '../../store/chats'
import { accessChanged, reloadAsked } from '../../store/live'
import { isAdmin, useMe } from '../../store/session'
import { readManagedList, readProjectList, useProjects } from '../../store/projects'
import { NewProjectDialog } from '../NewProjectDialog'
import { whoSeesProject } from '../projectWho'
import { ListIcon, ListRow } from '../list/List'
import { PanelFrame, PanelSection, panelRow } from './PanelFrame'
import { useGroupsRead } from './TrinaList'

export function ProjectsPanel() {
  const t = useT()
  return (
    <PanelFrame title={t('projects.title')} testId="projects-panel" top={<NewProjectRow />}>
      <ProjectsList />
    </PanelFrame>
  )
}

/** "+ 새 프로젝트": the name-only dialog (NewProjectDialog.tsx); made, the new project's page opens */
export function NewProjectRow({ phone = false }: { phone?: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={clsx(panelRow, 'font-medium', phone && 'min-h-row-min! pointer-coarse:min-h-row-min!')} data-testid="projects-panel-new">
        <ListIcon><Plus /></ListIcon> <span className="truncate">{t('projects.new')}</span>
      </button>
      {open && <NewProjectDialog onClose={() => setOpen(false)} onMade={(p) => { setOpen(false); navigate(`/projects/${p.id}`) }} />}
    </>
  )
}

/** The projects I see, the most recently active first (see the top of this file). `phone`: rows a thumb can hit. */
export function ProjectsList({ phone = false }: { phone?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const { groups } = useGroupsRead()
  const byId = useProjects((s) => s.byId)
  const listed = useProjects((s) => s.listed)
  useEffect(() => void readProjectList({ minAgeMs: 30_000 }).catch(() => {}), [])
  // a phone (no Projects page beside it): the owner and admins also find the team projects they manage without being
  // members (GET /api/projects?manage=1: their name and members only), under 팀 프로젝트, as the phone's list had them. A
  // computer's panel leaves them out: they are not the person's own, and the Projects page (/projects) lists them
  // (the Projects page's list, store/projects.ts managed: as last read at once, read again behind it)
  const admin = isAdmin(useMe()) && phone
  const managedList = useProjects((s) => s.managed)
  const managed = useMemo(() => (admin ? (managedList ?? []).filter((p) => p.member === false) : []), [admin, managedList])
  useEffect(() => {
    if (!admin) return
    const read = (fresh = false) => void readManagedList({ fresh }).catch(() => {})
    read()
    const again = () => read(true)
    const offs = [accessChanged.on(again), reloadAsked.on(again)]
    return () => offs.forEach((off) => off())
  }, [admin])
  const activity = useMemo(() => new Map((groups?.projectActivity ?? []).map((a) => [a.projectId, a])), [groups])
  const projects = useMemo(() => {
    const seen = [...Object.values(byId).filter((p) => listed?.has(p.id)), ...managed.filter((p) => !listed?.has(p.id))]
    const at = (p: Project) => activity.get(p.id)?.lastActivityAt ?? ''
    return seen.sort((a, b) => at(b).localeCompare(at(a)) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }, [byId, listed, activity, managed])

  // the project on screen: its page (and its files), or the chat of it opened from here (프로젝트 still lit)
  const { pathname } = useLocation()
  const place = useRailHere()
  const chatId = matchPath('/c/:chatId', pathname)?.params.chatId
  const chatProject = useChats((s) => (chatId && place === 'projects' ? s.chats.find((c) => c.id === chatId)?.projectId ?? s.others[chatId]?.projectId ?? null : null))
  const lit = matchPath('/projects/:projectId/*', pathname)?.params.projectId ?? chatProject

  if (!listed) return <div className="mx-auto mt-4 size-4 animate-spin rounded-full border-2 border-line border-t-faint" role="status" aria-label={t('common.loading')} />
  if (!projects.length) return <p className="px-3 py-2 text-sm text-faint" data-testid="projects-panel-empty">{t('projects.empty')}</p>
  const team = projects.filter((p) => !onlyMine(p))
  const mine = projects.filter(onlyMine)
  const rows = (list: Project[]) => (
    <ul>
      {list.map((p) => {
        const a = activity.get(p.id)
        // "나만" for mine; "멤버 N명" (its page's words) for a team one
        const who = onlyMine(p) ? t('projects.meta.me') : whoSeesProject(t, p, 'projects.whoMembers')
        const meta = [who, ...(a ? [formatRelative(a.lastActivityAt, locale), t('projectsPanel.chats', { n: a.count })] : [t('projectsPanel.noChats')])].filter(Boolean).join(' · ')
        const on = lit === p.id
        return <ListRow key={p.id} to={`/projects/${p.id}`} selected={on} icon={<SquareKanban />} name={p.name} nameTitle={p.name} meta={meta} testId="projects-panel-row" nameTestId="projects-panel-name" metaTestId="projects-panel-meta" />
      })}
    </ul>
  )
  return (
    <div data-testid="projects-list">
      {team.length > 0 && (
        <PanelSection id="projects-team" foldKey="projects:team" label={t('projectsPanel.team')} icon={<Users size={14} className="text-muted" aria-hidden />} count={team.length} labelTestId="projects-panel-label" data-testid="projects-team">
          {rows(team)}
        </PanelSection>
      )}
      {mine.length > 0 && (
        <PanelSection id="projects-mine" foldKey="projects:mine" label={t('projectsPanel.mine')} icon={<Lock size={14} className="text-muted" aria-hidden />} count={mine.length} labelTestId="projects-panel-label" data-testid="projects-mine">
          {rows(mine)}
        </PanelSection>
      )}
    </div>
  )
}

/** 내 프로젝트: a project only I see: a personal one (in my own folder), or a team project nobody else sees by its rules
 * (just me, or me and the admins by their role: Project.alone); never one I only manage. Everything else is 팀
 * 프로젝트. A server without the count: by its folder. */
export const onlyMine = (p: Project) =>
  p.folderPath.startsWith('users/') || (p.member !== false && p.audience !== undefined && (p.audience <= 1 || !!p.alone))
