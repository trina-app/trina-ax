// 트리나's list in the rail's panel (docs/DECISIONS.md "The Trina list: pinned, folders, projects, other chats"; the
// navigation plan docs/AGENTS/plan/20261112-1839-nav-rail.md §2.3, phase P2; only while the server's `navRail` switch
// is on). In this order:
//   고정 (my pinned chats) · 폴더 · 나만 보여요 (my list folders, read-only here: making and filling them is phase P4b) ·
//   프로젝트 (the projects with my activity in the last 14 days, at most 8) · 모든 프로젝트 (N) and + 새 프로젝트 ·
//   기타 기록 (my other chats; "기록" when no project group shows above it, so a person who never uses projects does not
//   read their whole history as "other").
// The heads (each group's count, first three rows and marks) come from the server in one read (store/chatGroups.ts),
// never from the chat pages this window happens to have loaded. The rows are drawn with the chats store's copy when it
// has one (its marks are live). A group's "N개 더 보기" opens it in place and pages through GET /api/chats; a project's
// name opens the project, its own icon is not a folder's (a project is not one of my folders), and its + is "Ask Trina
// in <project>". A project group with no activity of mine for 7 days starts folded; a fold the person chose wins after
// that (remembered per person in this browser). A folded group keeps the strongest mark of all its chats.
import clsx from 'clsx'
import { ChevronDown, Folder, Pin, Plus, SquareKanban } from 'lucide-react'
import { Fragment, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import type { Chat, ChatMark } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { markerOf, type Marker } from '../../lib/sessionMarkers'
import { aiName } from '../../lib/tabs'
import { chatGroupsChanged, readChatGroups, useChatGroups } from '../../store/chatGroups'
import { useChats } from '../../store/chats'
import { accessChanged, chatChanged, navFoldersChanged, reloadAsked } from '../../store/live'
import { useMeStrict } from '../../store/session'
import { cardChats, reasonText, useSessionMarkers } from '../../store/sessionMarkers'
import { MoveToProjectDialog } from '../chat/ChatProject'
import { SessionMarker } from '../chat/ChatState'
import { LoadError } from '../LoadError'
import { Tooltip } from '../Tooltip'
import { ChatItem, type ChatPeek } from '../nav/ChatItem'
import { panelRow } from './PanelFrame'

/** how long a window coming back to the front waits before the groups are read again */
const REFOCUS_READ_MS = 60_000
/** at most this many chosen folds are remembered (the latest first) */
const FOLDS_MAX = 200
const PAGE = 50

type Fold = 'open' | 'folded'
const foldKey = (userId: string) => `mycel.trina.groupFolds.${userId}`
function readFolds(key: string): Record<string, Fold> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, Fold] => e[1] === 'open' || e[1] === 'folded'))
  } catch {
    return {}
  }
}

/** The person's chosen folds in this browser (a private window may refuse: it just forgets). */
function useFolds() {
  const key = foldKey(useMeStrict().user.id)
  const [state, setState] = useState(() => ({ key, folds: readFolds(key) }))
  const folds = state.key === key ? state.folds : readFolds(key)
  const set = useCallback(
    (group: string, v: Fold) => {
      const next = { ...readFolds(key) }
      delete next[group]
      next[group] = v
      const kept = Object.fromEntries(Object.entries(next).slice(-FOLDS_MAX))
      try {
        localStorage.setItem(key, JSON.stringify(kept))
      } catch {
        /* not kept */
      }
      setState({ key, folds: kept })
    },
    [key],
  )
  return { folds, set }
}

/** Keep the groups read: on first show, after a change of my chats or folders, a reload the server asked for, a change
 * of access, and the window back in front after a minute. */
function useGroupsRead() {
  const groups = useChatGroups((s) => s.groups)
  const error = useChatGroups((s) => s.error)
  useEffect(() => {
    void readChatGroups({ minAgeMs: 5_000 })
    const offs = [chatChanged.on(chatGroupsChanged), navFoldersChanged.on((k) => k === 'chats' && chatGroupsChanged()), reloadAsked.on(() => void readChatGroups()), accessChanged.on(chatGroupsChanged)]
    const again = () => document.visibilityState !== 'hidden' && void readChatGroups({ minAgeMs: REFOCUS_READ_MS })
    window.addEventListener('focus', again)
    return () => {
      for (const off of offs) off()
      window.removeEventListener('focus', again)
    }
  }, [])
  return { groups, error }
}

/** a group's rows opened past its first three, paged through GET /api/chats */
interface Opened { items: Chat[]; cursor: string | null; loading: boolean }

export function TrinaList({ peek }: { peek: ChatPeek }) {
  const t = useT()
  const { groups, error } = useGroupsRead()
  // the chats store: the rows' live copies (marks), and the session marker count elsewhere reads it too
  const chats = useChats((s) => s.chats)
  const others = useChats((s) => s.others)
  const loaded = useChats((s) => s.chatsLoaded)
  const loadChats = useChats((s) => s.loadChats)
  useEffect(() => {
    if (!loaded) void loadChats(true).catch(() => {})
  }, [loaded, loadChats])
  const byId = useMemo(() => new Map([...Object.values(others), ...chats].map((c) => [c.id, c])), [chats, others])
  const live = useCallback((c: Chat) => byId.get(c.id) ?? c, [byId])
  const requests = useChats((s) => s.requests)
  const cards = useMemo(() => cardChats(requests), [requests])
  const here = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  const markOf = useCallback((m: ChatMark): Marker | null => markerOf(byId.get(m.id) ?? m, { card: cards.has(m.id), here: m.id === here }), [byId, cards, here])
  const { folds, set: setFold } = useFolds()
  const [opened, setOpened] = useState<Record<string, Opened>>({})
  const [otherMore, setOtherMore] = useState<Opened | null>(null)
  const [moving, setMoving] = useState<Chat | null>(null)
  const openChat = /^\/c\/([^/]+)/.exec(useLocation().pathname)?.[1] ?? null

  const openMore = async (key: string, query: Record<string, string>, keep: (c: Chat) => boolean) => {
    const was = opened[key]
    setOpened((s) => ({ ...s, [key]: { items: was?.items ?? [], cursor: was?.cursor ?? null, loading: true } }))
    try {
      const r = await api.call(API.listChats, { query: { ...query, limit: String(PAGE), ...(was?.cursor ? { cursor: was.cursor } : {}) } })
      setOpened((s) => ({ ...s, [key]: { items: [...(s[key]?.items ?? []), ...r.items.filter((c) => !c.pinnedAt && keep(c))], cursor: r.nextCursor, loading: false } }))
    } catch {
      setOpened((s) => ({ ...s, [key]: { items: s[key]?.items ?? [], cursor: s[key]?.cursor ?? null, loading: false } }))
    }
  }
  const fold = (key: string, folded: boolean) => {
    setFold(key, folded ? 'open' : 'folded')
    // folding closes what "N more" opened
    if (!folded) setOpened((s) => {
      if (!(key in s)) return s
      const next = { ...s }
      delete next[key]
      return next
    })
  }
  const row = (c: Chat) => <ChatItem key={c.id} chat={live(c)} onNavigate={noop} peek={peek} onMove={setMoving} />

  if (!groups) {
    if (error) return <LoadError error={error} onRetry={() => void readChatGroups()} what="chats" minor className="mx-1 mt-2" />
    return <div className="mx-auto mt-4 size-4 animate-spin rounded-full border-2 border-line border-t-faint" role="status" aria-label={t('common.loading')} />
  }

  const projectsShown = groups.projects.length > 0
  const allProjects = groups.projects.length + groups.projectsMore
  const placed = new Set([...groups.pinned, ...groups.folders.flatMap((f) => f.top), ...groups.projects.flatMap((p) => p.top)].map((c) => c.id))
  const otherRows = dedupe([...groups.other.items, ...(otherMore?.items ?? []).filter((c) => !placed.has(c.id))])
  const otherCursor = otherMore ? otherMore.cursor : groups.other.nextCursor
  const empty = !groups.pinned.length && !groups.folders.some((f) => f.count) && !projectsShown && !otherRows.length

  // the chat on screen stays in sight in its group past the first three, as it did in the old list
  const onScreen = openChat ? byId.get(openChat) ?? null : null
  const withOpen = (rows: Chat[], belongs: boolean) => (onScreen && belongs && !onScreen.pinnedAt && !rows.some((c) => c.id === onScreen.id) ? [...rows, onScreen] : rows)

  return (
    <div data-testid="trina-list">
      {empty && <p className="px-3 py-2 text-sm text-faint">{t('sidebar.noChats')}</p>}

      {groups.pinned.length > 0 && (
        <section aria-labelledby="trina-pinned" data-testid="trina-pinned">
          <Label id="trina-pinned" icon={<Pin size={12} aria-hidden />}>{t('chat.pinned')}</Label>
          <ul>{groups.pinned.map(row)}</ul>
        </section>
      )}

      {groups.folders.length > 0 && (
        <section aria-labelledby="trina-folders" data-testid="trina-folders">
          <Label id="trina-folders" icon={<Folder size={12} aria-hidden />}>
            {t('trinaList.folders')} <span className="font-normal">· {t('trinaList.onlyYou')}</span>
          </Label>
          {groups.folders.map((f) => {
            const key = `folder:${f.id}`
            return (
              <Group
                key={f.id}
                kind="folder"
                name={f.name}
                icon={<Folder size={12} className="shrink-0" aria-hidden />}
                head={f}
                folded={folds[key] === 'folded'}
                onFold={(v) => fold(key, v)}
                opened={opened[key]}
                onMore={() => void openMore(key, { folderId: f.id }, () => true)}
                rows={withOpen(f.top, onScreen?.folderId === f.id)}
                row={row}
                markOf={markOf}
                empty={t('trinaList.emptyFolder')}
              />
            )
          })}
        </section>
      )}

      {projectsShown && (
        <section aria-labelledby="trina-projects" data-testid="trina-projects">
          <Label
            id="trina-projects"
            icon={<SquareKanban size={12} aria-hidden />}
            action={
              <Tooltip label={t('projects.new')}>
                <Link to="/projects?new=1" aria-label={t('projects.new')} className="flex size-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-ink" data-testid="trina-project-new">
                  <Plus size={14} aria-hidden />
                </Link>
              </Tooltip>
            }
          >
            {t('sidebar.projects')}
          </Label>
          {groups.projects.map((p) => {
            const key = `project:${p.projectId}`
            const chosen = folds[key]
            return (
              <Group
                key={p.projectId}
                kind="project"
                projectId={p.projectId}
                name={p.name}
                icon={<SquareKanban size={12} className="shrink-0" aria-hidden />}
                head={p}
                folded={chosen ? chosen === 'folded' : p.folded}
                onFold={(v) => fold(key, v)}
                opened={opened[key]}
                // my list's chats of the project: mine, and the shared ones I wrote in (not every shared chat of it)
                onMore={() => void openMore(key, { projectId: p.projectId }, (c) => !c.shared || c.shared.mine)}
                rows={withOpen(p.top, onScreen?.projectId === p.projectId && !onScreen.folderId)}
                row={row}
                markOf={markOf}
              />
            )
          })}
        </section>
      )}
      <div className={clsx(projectsShown ? 'mt-1' : 'mt-3')} data-testid="trina-project-rows">
        {allProjects > 0 && (
          <Link to="/projects" className={clsx(panelRow, 'h-8 text-muted')} data-testid="trina-all-projects">
            <SquareKanban size={16} className="text-faint" aria-hidden /> <span className="truncate">{t('trinaList.allProjects')}</span>
            <span className="ml-auto text-xs text-faint tabular-nums">{allProjects}</span>
          </Link>
        )}
        {!projectsShown && (
          <Link to="/projects?new=1" className={clsx(panelRow, 'h-8 text-muted')} data-testid="trina-new-project">
            <Plus size={16} className="text-faint" aria-hidden /> <span className="truncate">{t('projects.new')}</span>
          </Link>
        )}
      </div>

      {otherRows.length > 0 && (
        <section aria-labelledby="trina-other" data-testid="trina-other">
          <Label id="trina-other">{projectsShown ? t('history.other') : t('trinaList.history')}</Label>
          <ul>{otherRows.map(row)}</ul>
          {otherCursor && (
            <button
              type="button"
              className="flex h-8 w-full items-center rounded-lg px-3 text-left text-xs text-muted hover:bg-hover"
              disabled={otherMore?.loading}
              onClick={async () => {
                setOtherMore((s) => ({ items: s?.items ?? [], cursor: otherCursor, loading: true }))
                try {
                  const r = await api.call(API.listChats, { query: { other: '1', limit: String(PAGE), cursor: otherCursor } })
                  setOtherMore((s) => ({ items: [...(s?.items ?? []), ...r.items], cursor: r.nextCursor, loading: false }))
                } catch {
                  setOtherMore((s) => (s ? { ...s, loading: false } : null))
                }
              }}
              data-testid="trina-other-more"
            >
              {otherMore?.loading ? t('common.loading') : t('sidebar.more')}
            </button>
          )}
        </section>
      )}

      {moving && <MoveToProjectDialog chat={moving} onClose={() => setMoving(null)} onMoved={(c) => { useChats.getState().upsertChat(c); chatGroupsChanged() }} />}
    </div>
  )
}

const noop = () => {}
const dedupe = (list: Chat[]) => {
  const seen = new Set<string>()
  return list.filter((c) => !seen.has(c.id) && !!seen.add(c.id))
}

/** A section's small grey label (고정, 폴더 · 나만 보여요, 프로젝트, 기타 기록). */
function Label({ id, icon, action, children }: { id: string; icon?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-1 pt-3 pr-1 pl-3 first:pt-0" data-testid="trina-label">
      <h3 id={id} className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-semibold text-faint">
        {icon}
        <span className="truncate">{children}</span>
      </h3>
      {action}
    </div>
  )
}

/** The strongest of these marks: "?" first, then the new-answer dot, then the ring (a folded group never hides a chat
 * that waits). */
function strongest(marks: readonly ChatMark[], markOf: (m: ChatMark) => Marker | null): Marker | null {
  const rank = (m: Marker) => (m.kind === 'ask' ? 3 : m.kind === 'new' ? 2 : 1)
  let best: Marker | null = null
  for (const m of marks) {
    const k = markOf(m)
    if (k && (!best || rank(k) > rank(best))) best = k
  }
  return best
}

/** One folder's or project's group: its header (the name, its icon, ▾; a project's name opens the project and its +
 * asks Trina there), its rows, and "N개 더 보기" for the rest (the mark of what it holds back). */
function Group(props: {
  kind: 'folder' | 'project'
  projectId?: string
  name: string
  icon: ReactNode
  head: { count: number; top: Chat[]; marked: ChatMark[] }
  folded: boolean
  onFold: (folded: boolean) => void
  opened: Opened | undefined
  onMore: () => void
  rows: Chat[]
  row: (c: Chat) => ReactNode
  markOf: (m: ChatMark) => Marker | null
  empty?: string
}) {
  const { kind, projectId, name, icon, head, folded, opened, rows: firstRows, row, markOf } = props
  const t = useT()
  const navigate = useNavigate()
  const listId = useId()
  const rows = opened ? dedupe([...firstRows, ...opened.items]) : firstRows
  const shownIds = new Set(rows.map((c) => c.id))
  // everything of the group that marks: its first rows and the marks the server sent for the rest
  const marks: ChatMark[] = [...head.top, ...head.marked.filter((m) => !head.top.some((c) => c.id === m.id))]
  const headMark = folded ? strongest(marks, markOf) : null
  const hiddenCount = opened && !opened.cursor ? 0 : Math.max(0, head.count - rows.length)
  const moreMark = !folded && hiddenCount > 0 ? strongest(head.marked.filter((m) => !shownIds.has(m.id)), markOf) : null
  const canAsk = kind === 'project'
  return (
    <div className="mt-1" data-testid="trina-group" data-kind={kind} data-folded={folded ? '' : undefined}>
      <div className={clsx('group/head relative flex h-7 items-center gap-1 pr-9 pl-3 text-xs font-medium text-faint', canAsk && headMark && 'pointer-coarse:pr-16')} data-testid="trina-group-head">
        <h4 className="flex h-full min-w-0 items-center gap-1">
          {icon}
          {projectId ? (
            <Link to={`/projects/${projectId}`} className="flex h-full min-w-0 items-center rounded hover:text-ink" title={name} data-testid="trina-group-name">
              <span className="truncate">{name}</span>
            </Link>
          ) : (
            <span className="truncate" title={name} data-testid="trina-group-name">{name}</span>
          )}
        </h4>
        {/* no-tooltip: a disclosure's ▾ (aria-expanded), as on the history's group headers */}
        <button type="button" aria-expanded={!folded} aria-controls={listId} aria-label={t('history.group.chats', { name })} onClick={() => props.onFold(folded)} className="touch-hit -ml-0.5 flex size-6 shrink-0 items-center justify-center rounded hover:bg-hover hover:text-ink" data-testid="trina-group-fold">
          <ChevronDown size={12} className={clsx('transition-transform motion-reduce:transition-none', folded && '-rotate-90')} aria-hidden />
        </button>
        {headMark && (
          <span className={clsx('pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 items-center', canAsk && 'group-hover/head:opacity-0 group-has-[:focus-visible]/head:opacity-0 pointer-coarse:right-9')} data-testid="trina-group-mark">
            <SessionMarker marker={headMark} label={reasonText(headMark.reason, t)} />
          </span>
        )}
        {canAsk && (
          <Tooltip label={t('history.group.newChat', { name, ai: aiName(t) })}>
            <button
              type="button"
              aria-label={t('history.group.newChat', { name, ai: aiName(t) })}
              onClick={() => navigate(`/projects/${projectId}`, { state: { newChat: true } })}
              className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-faint opacity-0 group-hover/head:opacity-100 group-has-[:focus-visible]/head:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100 pointer-coarse:opacity-100"
              data-testid="trina-group-ask"
            >
              <Plus size={14} aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>
      <ul id={listId} hidden={folded} data-testid="trina-group-rows">
        {!folded && rows.map((c) => <Fragment key={c.id}>{row(c)}</Fragment>)}
        {!folded && head.count === 0 && props.empty && <li className="px-3 py-1.5 text-xs text-faint" data-testid="trina-group-empty">{props.empty}</li>}
        {!folded && hiddenCount > 0 && (
          <li>
            <button type="button" onClick={props.onMore} disabled={opened?.loading} className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-xs text-muted hover:bg-hover" data-testid="trina-group-more">
              <span className="truncate">{opened?.loading ? t('common.loading') : t('history.group.more', { n: hiddenCount })}</span>
              {moreMark && (
                <span className="ml-auto flex shrink-0 items-center" data-testid="trina-group-more-mark">
                  <SessionMarker marker={moreMark} label={reasonText(moreMark.reason, t)} />
                </span>
              )}
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}
