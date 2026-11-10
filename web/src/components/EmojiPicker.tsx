// The emoji picker (docs/DECISIONS.md "Any emoji as a reaction"): a search field over a grid of 8. Without a search: a
// first set of the caller's (the status dialog's 32), "Recently used" (reactions: this browser, per person,
// lib/emoji.ts), then every emoji under its group's heading. A search looks in the English names and keywords, and the
// Korean ones for a Korean speaker or a search in Hangul; an emoji pasted into it is offered as it is. The names load
// on first use (two lazy chunks, scripts/emoji-data.ts); until then the first sets show. Keyboard: Enter in the search
// picks the first match, ↓ goes into the grid, the arrows move there, Esc closes (EmojiPanel). Emoji and names are
// text only.
//
// EmojiPanel: the picker by a button on a computer (fixed to the window, placed like a menu, menuSpot), a bottom sheet
// on a phone or with no button to stand by (the app's Modal; the phone app's WebView alike).
import clsx from 'clsx'
import { Search } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocale, useT } from '../i18n'
import { EMOJI_GROUPS, hasHangul, loadEmoji, loadedEmoji, readRecent, searchEmoji, type Emoji } from '../lib/emoji'
import { useMe } from '../store/session'
import { menuSpot } from './rooms/MenuButton'
import { inputCls, Modal, useMediaQuery } from './ui'

/** The data for the picker: the Korean names too when `korean`; null while it loads, 'error' when it did not. */
function useEmojiData(korean: boolean): Emoji[] | null | 'error' {
  const [data, setData] = useState<Emoji[] | null | 'error'>(() => loadedEmoji(korean) ?? loadedEmoji(false) ?? null)
  useEffect(() => {
    let live = true
    // (the English list stays while the Korean names load)
    loadEmoji(korean).then((d) => live && setData(d), () => live && setData((d) => (Array.isArray(d) ? d : 'error')))
    return () => { live = false }
  }, [korean])
  return data
}

const CELL = 'flex aspect-square items-center justify-center rounded-lg text-[1.375rem] leading-none transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-accent'

export interface EmojiPickerProps {
  onPick: (emoji: string) => void
  /** a first set above the rest, under its own heading (the status dialog's 32) */
  first?: { label: string; emoji: readonly string[]; testId?: string; itemTestId?: string }
  /** "Recently used" (reactions) */
  recents?: boolean
  /** emoji marked as chosen (mine on the message, the status's own) */
  selected?: readonly string[]
  /** the search takes the keyboard when the picker opens */
  autoFocus?: boolean
  /** the grid's height */
  gridClassName?: string
  className?: string
}

export function EmojiPicker({ onPick, first, recents = false, selected = [], autoFocus = false, gridClassName = 'h-72', className }: EmojiPickerProps) {
  const t = useT()
  const locale = useLocale()
  const meId = useMe()?.user.id
  const [q, setQ] = useState('')
  const data = useEmojiData(locale === 'ko' || hasHangul(q))
  const list = Array.isArray(data) ? data : null
  const recent = useMemo(() => (recents && meId ? readRecent(meId) : []), [recents, meId])
  const byEmoji = useMemo(() => new Map((list ?? []).map((e) => [e.emoji, e])), [list])
  const groups = useMemo(() => EMOJI_GROUPS.map((g) => ({ ...g, items: (list ?? []).filter((e) => e.group === g.group).map((e) => e.emoji) })).filter((g) => g.items.length), [list])
  const searching = q.trim().length > 0
  const results = useMemo(() => (searching ? searchEmoji(list ?? [], q) : []), [searching, list, q])
  const grid = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (autoFocus) search.current?.focus({ preventScroll: true })
  }, [autoFocus])
  const nameOf = (e: string) => {
    const x = byEmoji.get(e)
    return x ? (locale === 'ko' && x.local) || x.name : undefined
  }
  const chosen = new Set(selected)
  const cells = (items: readonly string[], testId = 'emoji-pick') =>
    items.map((e) => (
      <button key={e} type="button" tabIndex={-1} onClick={() => onPick(e)} title={nameOf(e)} aria-pressed={chosen.has(e)} className={clsx(CELL, chosen.has(e) && 'bg-accent-soft')} data-testid={testId} data-emoji={e}>
        {e}
      </button>
    ))
  const section = (key: string, label: string, items: readonly string[], o: { testId?: string; itemTestId?: string; lazy?: boolean } = {}) => (
    <section key={key} aria-label={label} className={clsx(o.lazy && '[contain-intrinsic-size:auto_20rem] [content-visibility:auto]')} data-testid={o.testId}>
      <h3 className="sticky top-0 z-[1] bg-surface px-1 pt-1.5 pb-1 text-xs font-medium text-muted">{label}</h3>
      <div className="grid grid-cols-8">{cells(items, o.itemTestId)}</div>
    </section>
  )
  /** the grid's buttons, in order */
  const buttons = () => [...(grid.current?.querySelectorAll<HTMLButtonElement>('button[data-emoji]') ?? [])]
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const top = searching ? results[0] : undefined
      if (top) onPick(top)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      buttons()[0]?.focus()
    }
  }
  // arrows in the grid: left and right along it, up and down a row (by the column on screen, across the headings);
  // up from the first row back to the search
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = buttons()
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    let next: HTMLButtonElement | undefined
    if (e.key === 'ArrowRight') next = all[i + 1]
    else if (e.key === 'ArrowLeft') next = all[i - 1]
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const at = all[i]!.getBoundingClientRect()
      const down = e.key === 'ArrowDown'
      const row = down ? all.slice(i + 1).find((b) => b.getBoundingClientRect().top > at.top + 2) : all.slice(0, i).reverse().find((b) => b.getBoundingClientRect().top < at.top - 2)
      if (row) {
        const top = row.getBoundingClientRect().top
        const same = all.filter((b) => Math.abs(b.getBoundingClientRect().top - top) < 2)
        next = same.reduce((a, b) => (Math.abs(b.getBoundingClientRect().left - at.left) < Math.abs(a.getBoundingClientRect().left - at.left) ? b : a))
      } else if (!down) {
        e.preventDefault()
        search.current?.focus()
        return
      }
    } else return
    e.preventDefault()
    next?.focus()
    next?.scrollIntoView({ block: 'nearest' })
  }
  let body: ReactNode
  if (searching) {
    body = results.length ? (
      <div role="group" aria-label={t('emoji.results')} className="grid grid-cols-8 pt-1" data-testid="emoji-results">{cells(results)}</div>
    ) : (
      <p className="px-1 py-6 text-center text-sm text-muted" data-testid="emoji-none">{data === null ? t('common.loading') : t('emoji.none')}</p>
    )
  } else {
    body = (
      <>
        {first && section('first', first.label, first.emoji, { testId: first.testId, itemTestId: first.itemTestId })}
        {recent.length > 0 && section('recent', t('emoji.recent'), recent, { testId: 'emoji-recent' })}
        {groups.map((g) => <Fragment key={g.group}>{section(String(g.group), t(g.label), g.items, { lazy: true })}</Fragment>)}
        {data === null && <p className="px-1 py-4 text-center text-sm text-muted">{t('common.loading')}</p>}
        {data === 'error' && <p className="px-1 py-4 text-center text-sm text-muted" role="alert">{t('emoji.loadFailed')}</p>}
      </>
    )
  }
  return (
    <div className={clsx('flex min-h-0 flex-col', className)} data-testid="emoji-picker">
      <div className="relative shrink-0">
        <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
        <input
          ref={search}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder={t('emoji.search')}
          aria-label={t('emoji.search')}
          autoComplete="off"
          enterKeyHint="search"
          className={clsx(inputCls, 'pl-9')}
          data-testid="emoji-search"
        />
      </div>
      <div ref={grid} onKeyDown={onGridKey} className={clsx('scroll-thin mt-1.5 min-h-0 overflow-y-auto overscroll-contain', gridClassName)} data-testid="emoji-grid">
        {body}
      </div>
    </div>
  )
}

/** Width of the computer's popover: 8 cells of 36px, its padding and a thin scrollbar. */
const PANEL_W = 'w-[19.5rem]'

/** The picker in its own layer: by `anchor` on a computer (Esc or a click outside closes it, the keyboard goes back to
 * the button), a bottom sheet on a phone or without an anchor. `title`: what it is for ("Add reaction"). */
export function EmojiPanel({ anchor, title, onPick, onClose, selected, recents = true }: { anchor: HTMLElement | null; title: string; onPick: (emoji: string) => void; onClose: () => void; selected?: readonly string[]; recents?: boolean }) {
  const computer = useMediaQuery('(min-width: 48rem)')
  if (!computer || !anchor) {
    return (
      <Modal open onClose={onClose} title={title} width={420}>
        <div data-testid="emoji-sheet">
          <EmojiPicker onPick={onPick} selected={selected} recents={recents} gridClassName="h-[min(20rem,50dvh)]" />
        </div>
      </Modal>
    )
  }
  return <Popover anchor={anchor} title={title} onClose={onClose}><EmojiPicker onPick={onPick} selected={selected} recents={recents} autoFocus /></Popover>
}

function Popover({ anchor, title, onClose, children }: { anchor: HTMLElement; title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null)
  const place = () => {
    const b = box.current
    if (!b) return
    const a = anchor.getBoundingClientRect()
    // the button scrolled out of its list's sight: the picker goes with it
    if (!a.width && !a.height) return close.current()
    setSpot(menuSpot(a, b.getBoundingClientRect(), { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }))
  }
  useLayoutEffect(place, [anchor])
  useEffect(() => {
    const outside = (e: Event) => {
      const n = e.target as Node
      if (!box.current?.contains(n) && !anchor.contains(n)) close.current()
    }
    const moved = (e: Event) => !box.current?.contains(e.target as Node) && place()
    document.addEventListener('pointerdown', outside)
    document.addEventListener('scroll', moved, { capture: true, passive: true })
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('scroll', moved, { capture: true })
      window.removeEventListener('resize', place)
      // the keyboard back to the button it came from, when it was in the picker
      if (box.current?.contains(document.activeElement) || document.activeElement === document.body) anchor.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor])
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label={title}
      // in <body>: a press or a key here is not the message's (its long press, its hover row's keys)
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          close.current()
        }
      }}
      // (measured at 0,0 before it is placed: unseen, yet its search can take the keyboard already)
      style={spot ? { left: spot.x, top: spot.y } : { left: 0, top: 0, opacity: 0 }}
      className={clsx('fixed z-40 flex max-h-[calc(100dvh-1rem)] flex-col rounded-xl border border-line bg-surface p-2 shadow-lg', PANEL_W)}
      data-testid="emoji-popover"
    >
      {children}
    </div>,
    document.body,
  )
}
