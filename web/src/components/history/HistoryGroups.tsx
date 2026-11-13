// Trina history grouped by project (docs/DECISIONS.md "Trina history by project"; the grouping itself is
// lib/historyGroups.ts), like the Claude Code desktop app's sidebar: a small grey header per project (its name, which
// opens the project's page, a folder icon, and ▾, which folds the group), its chats under it newest first, and the
// chats in no project last under "Other chats". The Trina panel's history while it is filtered (nav/HistoryList.tsx):
// every project, every row.
//
// - A folded group is remembered per person in this browser. Its header keeps the strongest mark of its chats ("?",
//   then the dot, then the ring), so a folded group never hides a chat that waits.
// - + on a project's header (on hover and keyboard focus; always on a touch screen) opens the project's page with its
//   "New chat in this project" box ready, the same as starting there. Its words are "Ask Trina in <project>" (the
//   AI action's one name everywhere: docs/AGENTS/plan/20261112-1839-nav-rail.md §2.0), never "new chat".
// - Only a project the project list says the person sees now has a header; the chats of any other (no read access any
//   more: the chat page names no project for them either) are with the other chats. A project the chat header found
//   gone (store/projects.ts `drop`) leaves at once.
import clsx from 'clsx'
import { ChevronDown, FolderKanban, Plus } from 'lucide-react'
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Chat, Project } from '@mycel/shared/api'
import { groupByProject, hasProjects, strongestMark, type HistoryGroup } from '../../lib/historyGroups'
import type { MarkerView } from '../../lib/sessionMarkers'
import { useT } from '../../i18n'
import { aiName } from '../../lib/tabs'
import { useChats } from '../../store/chats'
import { readForUnknown, readProjectList, useProjects } from '../../store/projects'
import { useMeStrict } from '../../store/session'
import { cardChats, reasonText, useSessionMarkers } from '../../store/sessionMarkers'
import { SessionMarker } from '../chat/ChatState'
import { Tooltip } from '../Tooltip'

/** how long a window coming back to the front waits before the project list is read again */
const REFOCUS_READ_MS = 60_000
/** a first read that is slow (or never answers: api.call has no timeout): the plain list shows meanwhile */
const FIRST_READ_WAIT_MS = 1_500

/** Is a project one the person sees now: the latest list read named it and the chat header did not find it gone since. */
export function useSeesProject() {
  const byId = useProjects((s) => s.byId)
  const listed = useProjects((s) => s.listed)
  return useCallback((id: string) => !!listed?.has(id) && !!byId[id], [listed, byId])
}

/**
 * The projects the person sees now, for the headers (store/projects.ts: one read for every list in this window): read
 * when some chat is in a project and no read was made yet, again when the window comes back to the front (access may
 * have changed on another device; at most once a minute) and once more for a project no read had (a project made or a
 * chat moved in elsewhere). The name is the store's, so a rename saved in this window shows at once. `ready` is false
 * only while a first read is on its way, at most a moment: then the list shows without project headers until it ends.
 */
export function useSeenProjects(chats: readonly Chat[]) {
  const byId = useProjects((s) => s.byId)
  const listed = useProjects((s) => s.listed)
  const sees = useSeesProject()
  const ids = useMemo(() => [...new Set(chats.flatMap((c) => (c.projectId ? [c.projectId] : [])))].sort().join(' '), [chats])
  const needed = ids !== ''
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    if (!needed || listed) return
    // the first read answers for the projects the chats name now (a later one is readForUnknown's)
    void readProjectList({ covers: ids.split(' ') })
    const t = setTimeout(() => setWaited(true), FIRST_READ_WAIT_MS)
    return () => clearTimeout(t)
  }, [needed, listed]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ids) readForUnknown(ids.split(' '))
  }, [ids, listed])
  useEffect(() => {
    if (!needed || typeof window === 'undefined' || !window.addEventListener) return
    const again = () => document.visibilityState !== 'hidden' && void readProjectList({ minAgeMs: REFOCUS_READ_MS, covers: ids.split(' ') })
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [needed, ids])
  return {
    ready: !needed || listed !== null || waited,
    sees,
    project: (id: string): Project | undefined => (sees(id) ? byId[id] : undefined),
    /** a project the person was just shown in a fresh list (the move dialog read it a moment ago): seen at once */
    add: (p: Project) => useProjects.getState().see(p),
  }
}

const FOLDED = (userId: string) => `mycel.sidebar.historyFolded.${userId}`
/** at most this many folded groups are remembered (the latest folded first): old projects' keys do not pile up */
const FOLDED_MAX = 200
const readFolded = (key: string): Set<string> => {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** The groups this person folded, in this browser (a private window may refuse: it just forgets). */
export function useFoldedGroups() {
  const key = FOLDED(useMeStrict().user.id)
  const [state, setState] = useState(() => ({ key, folded: readFolded(key) }))
  // another person signed in without the list going away: their own folds
  const folded = state.key === key ? state.folded : readFolded(key)
  const current = useRef(folded)
  current.current = folded
  const toggle = useCallback(
    (group: string) => {
      const next = new Set(current.current)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      try {
        localStorage.setItem(key, JSON.stringify([...next].slice(-FOLDED_MAX)))
      } catch {
        /* not kept */
      }
      setState({ key, folded: next })
    },
    [key],
  )
  return { folded: folded as ReadonlySet<string>, toggle }
}

export type HistoryGroupsState = ReturnType<typeof useHistoryGroups>

/**
 * The history's chats (pins left out by the caller, in its order) grouped by project. `grouped` is false when no chat
 * is in a project the person sees: the caller shows its plain list then, without headers.
 */
export function useHistoryGroups(chats: readonly Chat[]) {
  const projects = useSeenProjects(chats)
  const { folded, toggle: fold } = useFoldedGroups()
  const requests = useChats((s) => s.requests)
  const cards = useMemo(() => cardChats(requests), [requests])
  const here = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  const view = useCallback((c: Chat): MarkerView => ({ card: cards.has(c.id), here: c.id === here }), [cards, here])
  const groups = useMemo(() => groupByProject(chats, projects.sees), [chats, projects.sees])
  return { ready: projects.ready, grouped: hasProjects(groups), shown: groups, view, projects, folded, fold }
}

/** The groups, each with its header and its rows (`row`: the caller's row, the same as a plain list's). `onNavigate`:
 * called when a header leads to a project. */
export function HistoryGroups({ state, row, onNavigate }: { state: HistoryGroupsState; row: (c: Chat) => ReactNode; onNavigate: () => void }) {
  return (
    <div data-testid="history-groups">
      {state.shown.map((g) => (
        <Group key={g.key} group={g} state={state} row={row} onNavigate={onNavigate} />
      ))}
    </div>
  )
}

function Group({ group, state, row, onNavigate }: { group: HistoryGroup; state: HistoryGroupsState; row: (c: Chat) => ReactNode; onNavigate: () => void }) {
  const t = useT()
  const navigate = useNavigate()
  const listId = useId()
  const folded = state.folded.has(group.key)
  const project = group.projectId ? state.projects.project(group.projectId) : undefined
  const name = project?.name ?? ''
  // a folded group: the strongest mark of all its chats on the header
  const headMark = folded ? strongestMark(group.chats, state.view) : null
  // a chat can start in the project from its page: not when its folder is in the trash or the person only manages it
  const canStart = !!project && !project.inTrash && project.member !== false
  const fold = () => state.fold(group.key)
  return (
    <div className="mt-2 first:mt-0" data-testid="history-group" data-group={group.projectId ? 'project' : 'other'} data-folded={folded ? '' : undefined}>
      {/* the heading is the group's name only (the link, or the other chats' fold), so a screen reader's list of
          headings reads the projects; the icon and ▾ follow it */}
      <div className={clsx('group/head relative flex h-7 items-center gap-1 pr-9 pl-3 text-xs font-medium text-faint max-md:h-11 max-md:pr-11', canStart && headMark && 'md:pointer-coarse:pr-16 max-md:pr-17')} data-testid="history-group-head">
        {group.projectId ? (
          <>
            {/* the name's link is as tall as the header: 28 px, 44 px on a phone */}
            <h3 className="flex h-full min-w-0">
              <Link to={`/projects/${group.projectId}`} onClick={onNavigate} className="flex h-full min-w-0 items-center rounded hover:text-ink" data-testid="history-group-name">
                <span className="truncate">{name}</span>
              </Link>
            </h3>
            <FolderKanban size={12} className="shrink-0" aria-hidden />
            {/* no-tooltip: a disclosure's ▾ (aria-expanded), as on the section titles above */}
            <button type="button" aria-expanded={!folded} aria-controls={listId} aria-label={t('history.group.chats', { name })} onClick={fold} className="touch-hit -ml-1 flex size-6 shrink-0 items-center justify-center rounded hover:bg-hover hover:text-ink" data-testid="history-group-fold">
              <ChevronDown size={12} className={clsx('transition-transform motion-reduce:transition-none', folded && '-rotate-90')} aria-hidden />
            </button>
          </>
        ) : (
          <h3 className="flex h-full min-w-0">
            <button type="button" aria-expanded={!folded} aria-controls={listId} onClick={fold} className="flex h-full max-w-full items-center gap-1 rounded hover:text-ink" data-testid="history-group-fold">
              <span className="truncate">{t('history.other')}</span>
              <ChevronDown size={12} className={clsx('shrink-0 transition-transform motion-reduce:transition-none', folded && '-rotate-90')} aria-hidden />
            </button>
          </h3>
        )}
        {headMark && (
          // in the rows' marker spot; on a computer it gives way to + on hover and keyboard focus (not the focus a click on
          // ▾ leaves, or folding would hide the mark it just showed); where + always shows (a phone, a touch screen) it
          // sits left of it
          <span className={clsx('pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 items-center max-md:right-11', canStart && 'md:group-hover/head:opacity-0 md:group-has-[:focus-visible]/head:opacity-0 md:pointer-coarse:right-9')} data-testid="history-group-mark">
            <SessionMarker marker={headMark.marker} label={reasonText(headMark.marker.reason, t)} />
          </span>
        )}
        {canStart && (
          <Tooltip label={t('history.group.newChat', { name, ai: aiName(t) })}>
            <button
              type="button"
              aria-label={t('history.group.newChat', { name, ai: aiName(t) })}
              onClick={() => {
                onNavigate()
                navigate(`/projects/${group.projectId}`, { state: { newChat: true } })
              }}
              className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-faint opacity-0 group-hover/head:opacity-100 group-has-[:focus-visible]/head:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100 pointer-coarse:opacity-100 max-md:right-0 max-md:size-11 max-md:opacity-100"
              data-testid="history-group-new"
            >
              <Plus size={14} aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>
      <ul id={listId} hidden={folded} data-testid="history-group-rows">
        {!folded && group.chats.map((c) => <Fragment key={c.id}>{row(c)}</Fragment>)}
      </ul>
    </div>
  )
}

