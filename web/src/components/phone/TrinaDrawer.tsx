// The phone 트리나 tab's drawer (below 768 px; ☰ in the top bar on Home, components/PhoneTopBar.tsx), as it was before
// the navigation redesign (the owner, 2026-11-13: "the phone 트리나 tab must be identical to how it was before"; docs/
// DECISIONS.md "Phones: Home like the AI apps, the history behind ☰"): the AI's name with the product's mark on top, then
// 검색, 예약 작업 and 팀 스킬, then "트리나 기록" (it folds; the filter and sort menu beside it; the whole history by
// date: 오늘, 어제 …, nav/HistoryList.tsx), and at the bottom my status and 삭제한 기록. It closes when a page opens and
// on Back (lib/backCloses.ts), on Esc, and with a tap beside it.
import clsx from 'clsx'
import { BookMarked, CalendarClock, ChevronDown, Search, Smile, Trash2, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { create } from 'zustand'
import { useT } from '../../i18n'
import { useOverlayEntry } from '../../lib/backCloses'
import { aiName } from '../../lib/tabs'
import { useUi } from '../../store/ui'
import { useChatPeek } from '../nav/ChatItem'
import { HistoryList, RecentsMenu, useRecentsView, viewWords } from '../nav/HistoryList'
import { SetupRow } from '../onboarding/SetupRow'
import { openStatusDialog, useMyStatusWords } from '../StatusMessage'
import { Tooltip } from '../Tooltip'

/** whether the drawer is open (☰ opens it) */
export const useTrinaDrawer = create<{ open: boolean; setOpen: (v: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }))

const OPEN_KEY = 'mycel.sidebar.recents'
const DRAWER_VIEW = { key: 'mycel.drawer.historyView', base: { group: 'date' as const } }
const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'closed'
  } catch {
    return true
  }
}

export function TrinaDrawer() {
  const t = useT()
  const open = useTrinaDrawer((s) => s.open)
  const setOpen = useTrinaDrawer((s) => s.setOpen)
  const { pathname } = useLocation()
  // a page opened from it (or anywhere) closes it
  useEffect(() => setOpen(false), [pathname, setOpen])
  useOverlayEntry(open, () => setOpen(false))
  // Esc closes it (a keyboard on a tablet)
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, setOpen])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label={t('sidebar.label')} data-drawer data-testid="trina-drawer">
      <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
      <div className="absolute inset-y-0 left-0 w-[84vw] max-w-xs bg-subtle pt-[var(--safe-top)] pb-[var(--safe-bottom)] shadow-xl">
        <DrawerBody close={() => setOpen(false)} />
      </div>
    </div>
  )
}

function DrawerBody({ close }: { close: () => void }) {
  const t = useT()
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const peek = useChatPeek()
  // by date by default, as the drawer was before the navigation redesign (Today, Yesterday …); its own choice, apart
  // from the computer's 트리나 panel
  const view = useRecentsView(DRAWER_VIEW)
  const listId = useId()
  const [recentsOpen, setRecentsOpen] = useState(readOpen)
  const toggle = () =>
    setRecentsOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? 'closed' : 'open')
      } catch {
        /* not kept */
      }
      return !v
    })
  const [scrolled, setScrolled] = useState(false)
  // the lists' row size and icon (components/list/List.tsx tokens): 17px words, 20px icons on a phone
  const nav = 'flex min-h-11 items-center gap-3 rounded-lg px-3 text-row text-ink hover:bg-hover [&>svg]:size-list-glyph [&>svg]:shrink-0 [&>svg]:text-muted'
  const active = ({ isActive }: { isActive: boolean }) => clsx(nav, isActive && 'bg-hover font-medium')
  const filtered = view.changed.length > 0
  return (
    <nav aria-label={t('sidebar.label')} className="flex h-full w-full flex-col bg-subtle">
      {/* the drawer is the AI's history: the AI's one name there, as on its tab, with the product's mark */}
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <Link to="/" onClick={close} className="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" aria-hidden className="size-5 shrink-0 rounded-md" data-testid="sidebar-logo-phone" />
          <span>{aiName(t)}</span>
        </Link>
      </div>
      <div className="space-y-0.5 px-2">
        {/* search takes the drawer's place (and its history entry): Back closes search and shows the page */}
        <button
          type="button"
          className={clsx(nav, 'w-full')}
          onClick={() => {
            close()
            setSearchOpen(true)
          }}
          data-testid="drawer-search"
        >
          <Search size={16} aria-hidden /> {t('sidebar.search')}
        </button>
        <NavLink to="/scheduled" className={active} onClick={close} data-testid="nav-scheduled">
          <CalendarClock size={16} aria-hidden /> {t('sidebar.scheduled')}
        </NavLink>
        <NavLink to="/skills" className={active} onClick={close} data-testid="nav-skills">
          <BookMarked size={16} aria-hidden /> {t('sidebar.skills')}
        </NavLink>
      </div>
      <div
        className={clsx('scroll-thin mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain border-t px-2 pb-2', scrolled ? 'border-line' : 'border-transparent')}
        onScroll={(e) => {
          peek.hide()
          setScrolled(e.currentTarget.scrollTop > 0)
        }}
        data-testid="sidebar-scroll"
      >
        <SetupRow onNavigate={close} />
        <div className="flex items-center gap-1 pt-2 pr-1 pl-3" data-testid="recents-head">
          <h2 className="shrink-0 text-sm font-semibold whitespace-nowrap text-ink">
            <button type="button" aria-expanded={recentsOpen} aria-controls={listId} onClick={toggle} className="flex items-center gap-1 rounded py-1 hover:text-muted" data-testid="recents-toggle">
              {t('sidebar.aiChats', { name: aiName(t) })}
              <ChevronDown size={14} className={clsx('text-faint transition-transform', !recentsOpen && '-rotate-90')} aria-hidden />
            </button>
          </h2>
          {filtered && (
            <span className="flex min-w-0 items-center gap-0.5 text-xs text-faint" data-testid="recents-filter-label">
              <span aria-hidden>·</span>
              <span className="truncate">{viewWords(view, t)}</span>
              <Tooltip label={t('sidebar.filter.clear')}>
                <button type="button" onClick={() => view.setView(view.base)} aria-label={t('sidebar.filter.clear')} className="shrink-0 rounded p-0.5 hover:bg-hover hover:text-ink" data-testid="recents-filter-clear">
                  <X size={11} aria-hidden />
                </button>
              </Tooltip>
            </span>
          )}
          <span className="ml-auto">
            <RecentsMenu view={view.view} onChange={view.setView} changed={filtered} />
          </span>
        </div>
        <div id={listId} hidden={!recentsOpen}>
          {recentsOpen && <HistoryList onNavigate={close} peek={peek} viewState={view} />}
        </div>
      </div>
      {peek.card}
      {/* my status (the computer's account menu has it) and 삭제한 기록, at the end of the history */}
      <div className="border-t border-line p-2">
        <StatusRow onOpen={close} />
        <NavLink to="/trash" className={active} onClick={close} data-testid="nav-trash">
          <Trash2 size={16} aria-hidden /> {t('sidebar.trash')}
        </NavLink>
      </div>
    </nav>
  )
}

function StatusRow({ onOpen }: { onOpen: () => void }) {
  const t = useT()
  const mine = useMyStatusWords()
  return (
    <button
      type="button"
      onClick={(e) => {
        onOpen()
        openStatusDialog(e.currentTarget)
      }}
      className="flex h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 text-left text-sm text-ink hover:bg-hover"
      data-testid="my-status-row"
    >
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center leading-none">
        {mine ? mine.emoji : <Smile size={16} className="text-muted" />}
      </span>
      <span className="truncate">{mine ? mine.words : t('status.set')}</span>
    </button>
  )
}
