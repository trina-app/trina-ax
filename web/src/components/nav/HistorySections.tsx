// My sections in the Trina history (docs/decisions/20261122-trina-history-sections.md): the Chats sidebar's sections
// (nav/SidebarSections.tsx, list folders of kind 'chats') over my AI chats. One block, drawn by every surface of the
// history: the computer's Trina panel at rest (panels/TrinaList.tsx), the panel's filtered list and the phone's ☰ drawer
// (nav/HistoryList.tsx). A chat shows in one place: pinned › its section › 트리나 기록.
//   - rows: the chats my list has loaded with that folderId (the Trina list's read brings each section's first rows,
//     GET /api/chats/groups `folders[].top`; "더 보기" reads GET /api/chats?folderId=), filtered and sorted as the
//     surface's view says (`filter`, `sort`);
//   - each section folds (kept in the account's folds, `folder:<id>`); folded, it keeps the chat on screen drawn and
//     shows its strongest session marker;
//   - a filter on (`filtered`): an empty section is not drawn; at rest an empty one says how to fill it;
//   - a mouse may drag a chat onto a section; its "⋯" has Add chats · Rename · Move up · Move down · Delete section.
import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { Chat, NavFolder } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import type { MarkerView } from '../../lib/sessionMarkers'
import { strongestMark } from '../../lib/historyGroups'
import { readChatGroups, useChatGroups } from '../../store/chatGroups'
import { useChats } from '../../store/chats'
import { cardChats, reasonText, useSessionMarkers } from '../../store/sessionMarkers'
import { isUnused, SessionMarker } from '../chat/ChatState'
import { PanelSection, panelRowBox } from '../panels/PanelFrame'
import { DROP_OVER } from './NavFolders'
import { SectionEmpty, SectionMenu, useSectionDrop, useSections } from './SidebarSections'

/** how old the Trina list's read may be when a surface without it (the drawer, the filtered list) shows the sections */
const GROUPS_MIN_AGE_MS = 60_000

/** My sections of the Trina history and the chats of my list in each, `filter`ed and in `sort`'s order; `sectioned`:
 * the chats that show in a section (so the rest of the list leaves them out). Pinned chats stay under 고정. */
export function useSectionRows(o: { filter?: (c: Chat) => boolean; sort?: (a: Chat, b: Chat) => number; on?: boolean } = {}) {
  const on = o.on ?? true
  const sections = useSections('chats', on)
  const chats = useChats((s) => s.chats)
  const groups = useChatGroups((s) => s.groups)
  // each section's first rows come with the Trina list's read: in the chats store, so every surface draws them
  useEffect(() => {
    if (on) void readChatGroups({ minAgeMs: GROUPS_MIN_AGE_MS })
  }, [on])
  useEffect(() => {
    if (!groups) return
    const st = useChats.getState()
    const have = new Set(st.chats.map((c) => c.id))
    for (const c of groups.folders.flatMap((f) => f.top)) if (!have.has(c.id) && !c.deletedAt) st.upsertChat(c)
  }, [groups])
  return useMemo(() => {
    const ids = new Set(sections.map((f) => f.id))
    const sectioned = new Set<string>()
    const rows = new Map<string, Chat[]>(sections.map((f) => [f.id, []]))
    for (const c of chats) {
      if (!c.folderId || !ids.has(c.folderId) || c.pinnedAt || c.deletedAt || isUnused(c)) continue
      sectioned.add(c.id)
      if (!o.filter || o.filter(c)) rows.get(c.folderId)!.push(c)
    }
    const sort = o.sort ?? ((a: Chat, b: Chat) => b.updatedAt.localeCompare(a.updatedAt))
    for (const list of rows.values()) list.sort(sort)
    return { sections, rows, sectioned }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, chats, o.filter, o.sort])
}
export type SectionRows = ReturnType<typeof useSectionRows>

/** The sections block: each of my sections as a top-level header with its chats. `filtered`: a filter is on (an empty
 * section is not drawn, and the server's count is not the shown one). `row`: the surface's chat row. */
export function HistorySections({ state, row, filtered = false, className }: { state: SectionRows; row: (c: Chat) => ReactNode; filtered?: boolean; className?: string }) {
  const shown = filtered ? state.sections.filter((f) => (state.rows.get(f.id) ?? []).length > 0) : state.sections
  if (!shown.length) return null
  return (
    <div className={clsx('mb-4', className)} data-testid="history-sections">
      {shown.map((f) => (
        <HistorySection key={f.id} section={f} rows={state.rows.get(f.id) ?? []} row={row} filtered={filtered} />
      ))}
    </div>
  )
}

function HistorySection({ section, rows, row, filtered }: { section: NavFolder; rows: Chat[]; row: (c: Chat) => ReactNode; filtered: boolean }) {
  const t = useT()
  const drop = useSectionDrop(section, 'chats')
  const head = useChatGroups((s) => s.groups?.folders.find((f) => f.id === section.id))
  // the server's count of what I can open in it (pages not read yet too); a filter shows its own
  const count = filtered ? rows.length : Math.max(head?.count ?? 0, rows.length)
  // the marks as this window sees them (session markers), for a folded section's one marker
  const requests = useChats((s) => s.requests)
  const cards = useMemo(() => cardChats(requests), [requests])
  const here = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  const view = (c: Chat): MarkerView => ({ card: cards.has(c.id), here: c.id === here })
  const open = /^\/c\/([^/]+)/.exec(useLocation().pathname)?.[1] ?? null
  const openRow = rows.find((c) => c.id === open)
  // its strongest marker: its rows and the marked chats the server named that no page has brought yet
  const marked = useMemo(() => [...rows, ...((head?.marked ?? []).filter((m) => !rows.some((c) => c.id === m.id)) as Chat[])], [rows, head?.marked])
  const mark = strongestMark(marked, view)
  const [more, setMore] = useState<{ cursor: string | null; busy: boolean; done: boolean }>({ cursor: null, busy: false, done: false })
  const left = !filtered && !more.done && count > rows.length
  const readMore = async () => {
    setMore((m) => ({ ...m, busy: true }))
    try {
      const page = await api.call(API.listChats, { query: { folderId: section.id, ...(more.cursor ? { cursor: more.cursor } : {}) } })
      for (const c of page.items) useChats.getState().upsertChat(c)
      setMore({ cursor: page.nextCursor, busy: false, done: !page.nextCursor })
    } catch {
      setMore((m) => ({ ...m, busy: false }))
    }
  }
  return (
    <PanelSection
      id={`trina-section-${section.id}`}
      foldKey="trina:section"
      foldId={`folder:${section.id}`}
      label={section.name}
      count={count}
      pill={mark ? <span data-testid="history-section-marker"><SessionMarker marker={mark.marker} label={reasonText(mark.marker.reason, t)} /></span> : undefined}
      keep={openRow ? <ul>{row(openRow)}</ul> : undefined}
      action={<SectionMenu section={section} buttonClassName="size-6" />}
      labelTestId="trina-label"
      className={clsx('has-[[aria-expanded=true]]:[content-visibility:visible]', drop.over && DROP_OVER)}
      {...drop.props}
      data-testid="history-section"
      data-section-id={section.id}
      data-drop={drop.over ? '' : undefined}
    >
      <ul>{rows.map(row)}</ul>
      {left && (
        <button type="button" className={clsx(panelRowBox, 'text-meta text-muted')} disabled={more.busy} onClick={() => void readMore()} data-testid="history-section-more">
          {more.busy ? t('common.loading') : t('sidebar.more')}
        </button>
      )}
      {!rows.length && !left && <SectionEmpty section={section} />}
    </PanelSection>
  )
}
