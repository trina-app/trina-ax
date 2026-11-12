// Trina history grouped by project (docs/DECISIONS.md "Trina history by project"; the grouping itself is
// lib/historyGroups.ts), like the Claude Code desktop app's sidebar: a small grey header per project (its name, which
// opens the project's page, a folder icon, and ▾, which folds the group), its chats under it newest first, and the
// chats in no project last under "Other chats". One list for every place that shows the history: stacked under the
// rooms (the computer's sidebar: a few projects and rows, the rest one press away) or as a whole panel (the phone's
// drawer, "Show all": every project, every row); the caps are the caller's.
//
// - A folded group is remembered per person in this browser. Its header keeps the strongest mark of its chats ("?",
//   then the dot, then the ring), so a folded group never hides a chat that waits; a group's "N more" carries the mark
//   of the rows it holds back.
// - + on a project's header (on hover and keyboard focus; always on a touch screen) opens the project's page with its
//   "New chat in this project" box ready, the same as starting there.
// - Only a project the project list says the person sees now has a header; the chats of any other (no read access any
//   more: the chat page names no project for them either) are with the other chats. A project the chat header found
//   gone (store/projects.ts `drop`) leaves at once.
import clsx from 'clsx'
import { ChevronDown, FolderKanban, Plus } from 'lucide-react'
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Chat, Project } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { capGroups, groupByProject, hasProjects, strongestMark, type Caps, type ShownGroup } from '../../lib/historyGroups'
import type { MarkerView } from '../../lib/sessionMarkers'
import { useT } from '../../i18n'
import { useChats } from '../../store/chats'
import { useProjects } from '../../store/projects'
import { useMeStrict } from '../../store/session'
import { cardChats, reasonText, useSessionMarkers } from '../../store/sessionMarkers'
import { SessionMarker } from '../chat/ChatState'
import { Tooltip } from '../Tooltip'

/**
 * The projects the person sees now, for the headers: one read of the project list when some chat is in a project,
 * again when the window comes back to the front (access may have changed on another device) and once more for a
 * project no read had (a project made or a chat moved in elsewhere). A project is seen while the latest read listed it
 * and the store still has it; its name is the store's, so a rename saved in this window shows at once.
 */
export function useSeenProjects(chats: readonly Chat[]) {
  const byId = useProjects((s) => s.byId)
  const [listed, setListed] = useState<ReadonlySet<string> | null>(null)
  const reads = useRef(0)
  const askedFor = useRef(new Set<string>())
  const ids = useMemo(() => [...new Set(chats.flatMap((c) => (c.projectId ? [c.projectId] : [])))].sort().join(' '), [chats])
  const needed = ids !== ''
  const read = useCallback(() => {
    const mine = ++reads.current
    api.call(API.listProjects).then(
      (r) => {
        useProjects.getState().put(...r.items)
        if (mine === reads.current) setListed(new Set(r.items.map((p) => p.id)))
      },
      // nothing known: every chat is with the other chats (no name is ever guessed)
      () => mine === reads.current && setListed((s) => s ?? new Set()),
    )
  }, [])
  useEffect(() => {
    if (needed && reads.current === 0) read()
  }, [needed, read])
  useEffect(() => {
    if (!listed || !ids) return
    const unknown = ids.split(' ').filter((id) => !listed.has(id) && !askedFor.current.has(id))
    if (!unknown.length) return
    for (const id of unknown) askedFor.current.add(id)
    read()
  }, [ids, listed, read])
  useEffect(() => {
    if (!needed || typeof window === 'undefined' || !window.addEventListener) return
    const again = () => document.visibilityState !== 'hidden' && read()
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [needed, read])
  const sees = useCallback((id: string) => !!listed?.has(id) && !!byId[id], [listed, byId])
  /** a project the person was just shown (the move dialog read the list a moment ago): seen at once */
  const add = useCallback((p: Project) => {
    useProjects.getState().put(p)
    setListed((s) => new Set([...(s ?? []), p.id]))
  }, [])
  return { ready: !needed || listed !== null, sees, project: (id: string): Project | undefined => (sees(id) ? byId[id] : undefined), add }
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
  const [folded, setFolded] = useState(() => readFolded(key))
  const toggle = useCallback(
    (group: string) =>
      setFolded((s) => {
        const next = new Set(s)
        if (next.has(group)) next.delete(group)
        else next.add(group)
        try {
          localStorage.setItem(key, JSON.stringify([...next].slice(-FOLDED_MAX)))
        } catch {
          /* not kept */
        }
        return next
      }),
    [key],
  )
  return { folded: folded as ReadonlySet<string>, toggle }
}

export type HistoryGroupsState = ReturnType<typeof useHistoryGroups>

/**
 * The history's chats (pins left out by the caller, in its order) grouped by project and capped. `grouped` is false
 * when no chat is in a project the person sees: the caller shows its plain list then, without headers.
 */
export function useHistoryGroups(chats: readonly Chat[], caps: Omit<Caps, 'opened'>) {
  const projects = useSeenProjects(chats)
  const { folded, toggle } = useFoldedGroups()
  // groups opened in place by "N more" (this visit only); folding a group closes it again
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const requests = useChats((s) => s.requests)
  const cards = useMemo(() => cardChats(requests), [requests])
  const here = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  const view = useCallback((c: Chat): MarkerView => ({ card: cards.has(c.id), here: c.id === here }), [cards, here])
  const groups = useMemo(() => groupByProject(chats, projects.sees), [chats, projects.sees])
  const { shown, behind } = useMemo(() => capGroups(groups, { ...caps, opened }), [groups, caps.projects, caps.rows, caps.open, opened]) // eslint-disable-line react-hooks/exhaustive-deps
  const fold = useCallback(
    (key: string) => {
      toggle(key)
      setOpened((s) => {
        if (!s.has(key)) return s
        const next = new Set(s)
        next.delete(key)
        return next
      })
    },
    [toggle],
  )
  const openMore = useCallback((key: string) => setOpened((s) => new Set([...s, key])), [])
  return { ready: projects.ready, grouped: hasProjects(groups), shown, behind, view, projects, folded, fold, openMore }
}

/** The groups in sight, each with its header, its rows (`row`: the caller's row, the same as a plain list's) and its
 * "N more". `onNavigate`: the drawer closes when a header leads to a project. */
export function HistoryGroups({ state, row, onNavigate }: { state: HistoryGroupsState; row: (c: Chat) => ReactNode; onNavigate: () => void }) {
  return (
    <div data-testid="history-groups">
      {state.shown.map((g) => (
        <Group key={g.key} group={g} state={state} row={row} onNavigate={onNavigate} />
      ))}
    </div>
  )
}

function Group({ group, state, row, onNavigate }: { group: ShownGroup; state: HistoryGroupsState; row: (c: Chat) => ReactNode; onNavigate: () => void }) {
  const t = useT()
  const navigate = useNavigate()
  const listId = useId()
  const folded = state.folded.has(group.key)
  const project = group.projectId ? state.projects.project(group.projectId) : undefined
  const name = project?.name ?? ''
  // a folded group: the strongest mark of all its chats on the header; open, its "N more" the mark of the rows it holds
  const headMark = folded ? strongestMark(group.chats, state.view) : null
  const moreMark = !folded && group.hidden.length ? strongestMark(group.hidden, state.view) : null
  // a chat can start in the project from its page: not when its folder is in the trash or the person only manages it
  const canStart = !!project && !project.inTrash && project.member !== false
  const fold = () => state.fold(group.key)
  return (
    <div className="mt-2 first:mt-0" data-testid="history-group" data-group={group.projectId ? 'project' : 'other'} data-folded={folded ? '' : undefined}>
      {/* the heading is the group's name only (the link, or the other chats' fold), so a screen reader's list of
          headings reads the projects; the icon and ▾ follow it */}
      <div className="group/head relative flex h-7 items-center gap-1 pr-9 pl-3 text-xs font-medium text-faint max-md:h-10 max-md:pr-11" data-testid="history-group-head">
        {group.projectId ? (
          <>
            <h3 className="min-w-0 truncate">
              <Link to={`/projects/${group.projectId}`} onClick={onNavigate} className="rounded hover:text-ink" data-testid="history-group-name">
                {name}
              </Link>
            </h3>
            <FolderKanban size={12} className="shrink-0" aria-hidden />
            {/* no-tooltip: a disclosure's ▾ (aria-expanded), as on the section titles above */}
            <button type="button" aria-expanded={!folded} aria-controls={listId} aria-label={t('history.group.chats', { name })} onClick={fold} className="touch-hit -ml-1 flex size-6 shrink-0 items-center justify-center rounded hover:bg-hover hover:text-ink" data-testid="history-group-fold">
              <ChevronDown size={12} className={clsx('transition-transform motion-reduce:transition-none', folded && '-rotate-90')} aria-hidden />
            </button>
          </>
        ) : (
          <h3 className="min-w-0">
            <button type="button" aria-expanded={!folded} aria-controls={listId} onClick={fold} className="touch-hit flex max-w-full items-center gap-1 rounded hover:text-ink" data-testid="history-group-fold">
              <span className="truncate">{t('history.other')}</span>
              <ChevronDown size={12} className={clsx('shrink-0 transition-transform motion-reduce:transition-none', folded && '-rotate-90')} aria-hidden />
            </button>
          </h3>
        )}
        {headMark && (
          // in the rows' marker spot; on a computer it gives way to + on hover and keyboard focus (not the focus a click on
          // ▾ leaves, or folding would hide the mark it just showed), on a phone it sits left of it
          <span className={clsx('pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 items-center max-md:right-11', canStart && 'md:group-hover/head:opacity-0 md:group-has-[:focus-visible]/head:opacity-0')} data-testid="history-group-mark">
            <SessionMarker marker={headMark.marker} label={reasonText(headMark.marker.reason, t)} />
          </span>
        )}
        {canStart && (
          <Tooltip label={t('history.group.newChat', { name })}>
            <button
              type="button"
              aria-label={t('history.group.newChat', { name })}
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
        {!folded && group.rows.map((c) => <Fragment key={c.id}>{row(c)}</Fragment>)}
        {!folded && group.hidden.length > 0 && (
          <li>
            <button type="button" onClick={() => state.openMore(group.key)} className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-xs text-muted hover:bg-hover max-md:h-11" data-testid="history-group-more">
              <span className="truncate">{t('history.group.more', { n: group.hidden.length })}</span>
              {moreMark && (
                <span className="ml-auto flex shrink-0 items-center" data-testid="history-group-more-mark">
                  <SessionMarker marker={moreMark.marker} label={reasonText(moreMark.marker.reason, t)} />
                </span>
              )}
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}

