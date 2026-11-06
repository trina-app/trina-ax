// "#" in the AI chat's message box (lib/roomRefs.ts, docs/DECISIONS.md "내 AI 채팅에서 대화방 읽기"): typing "#" lists the
// rooms I am in now (group chats, team rooms, the everyone room, 1:1 chats as "<name> · 1:1"), filtered as I type;
// arrow keys move, Enter or Tab picks, Esc closes, a tap picks on a phone. Picking writes "#<title> " as one token: it
// shows like a mention in a room's box (accent text on a soft accent ground, drawn by a layer behind the native text
// box, so Korean input, selection and spell check stay the box's own), Backspace takes it whole and the caret never
// stops inside it. What is sent carries the room's id (toWire). Never in a room's own message box.
import clsx from 'clsx'
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { PRODUCT_NAMED_AFTER_AI, roomRefParts, roomRefTitle, type Room } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { deleteToken, insertRoomRef, keepPicked, matchRooms, roomMenuWanted, roomRefAt, tokenRanges, toWire, type PickedRoom, type TokenRange } from '../../lib/roomRefs'
import { useRooms } from '../../store/rooms'
import { RoomIcon, useRoomTitle } from '../rooms/RoomIcon'
import { scrollToShow } from './SkillMenu'

/** `enabled`: the "#" list opens at all (false where the AI cannot read rooms: a confidential chat; tokens already in
 * the text still show and are sent) */
export function useRoomRefMenu({ text, setText, input, initial = [], enabled = true }: { text: string; setText: (s: string) => void; input: RefObject<HTMLTextAreaElement | null>; initial?: PickedRoom[]; enabled?: boolean }) {
  const t = useT()
  const id = useId()
  const title = useRoomTitle()
  const rooms = useRooms((s) => s.rooms)
  const loadRooms = useRooms((s) => s.loadRooms)
  const [caret, setCaret] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const [picked, setPicked] = useState<PickedRoom[]>(initial)
  const listRef = useRef<HTMLUListElement>(null)
  /** the caret before the latest move: a caret that lands inside a token goes on past it the way it was moving */
  const lastCaret = useRef<number | null>(null)
  const at = useMemo(() => (caret === null ? null : roomRefAt(text, caret)), [text, caret])
  const wanted = roomMenuWanted({ enabled, at, closedFor, text })
  // the rooms are the sidebar's list; read once when "#" is typed before it ever loaded (a phone opens no sidebar)
  useEffect(() => { if (wanted && !rooms.length) void loadRooms().catch(() => {}) }, [wanted, rooms.length, loadRooms])
  const label = (r: Room) => (r.kind === 'dm' ? t('composer.roomDm', { name: title(r) }) : title(r))
  const hits = useMemo(() => (wanted ? matchRooms(rooms, at!.query, title, 50) : []), [wanted, rooms, at, title])
  const open = hits.length > 0
  const ranges = useMemo(() => tokenRanges(text, picked), [text, picked])
  useEffect(() => setActive(0), [at?.start, at?.query])
  useEffect(() => {
    const list = listRef.current
    const row = list?.children[active] as HTMLElement | undefined
    if (list && row) list.scrollTop = scrollToShow({ top: row.offsetTop, height: row.offsetHeight }, { scrollTop: list.scrollTop, height: list.clientHeight })
  }, [active, hits])

  const place = (pos: number) => requestAnimationFrame(() => {
    input.current?.focus()
    input.current?.setSelectionRange(pos, pos)
  })
  /** where the caret is now (after typing, a click, the arrow keys); one inside a token goes past it */
  const track = () => {
    const el = input.current
    if (!el) return
    const pos = el.selectionStart
    if (el.selectionStart === el.selectionEnd) {
      const r = ranges.find((x) => pos > x.start && pos < x.end)
      if (r) {
        const to = lastCaret.current !== null && lastCaret.current > pos ? r.start : r.end
        el.setSelectionRange(to, to)
        lastCaret.current = to
        setCaret(to)
        return
      }
    }
    lastCaret.current = pos
    setCaret(pos)
  }

  const pick = (r: Room) => {
    if (!at || caret === null) return
    // the title as the token holds it (no brackets, one line, at most 80 characters): what the box shows after "#"
    const name = roomRefTitle(title(r))
    const next = insertRoomRef(text, at.start, caret, name)
    setText(next.text)
    // one room per title: the latest pick wins (two rooms of one name would look the same in the box), and rooms whose
    // token is no longer in the text are forgotten
    setPicked((p) => keepPicked([...p.filter((x) => x.title !== name), { id: r.id, title: name }], next.text))
    setCaret(next.caret)
    lastCaret.current = next.caret
    place(next.caret)
  }

  /** the key was for the list or a token (true: the box must not act on it, e.g. not send) */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return false
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const el = e.currentTarget
      const cut = deleteToken(text, el.selectionStart, el.selectionEnd, e.key, ranges)
      if (cut) {
        e.preventDefault()
        setText(cut.text)
        setCaret(cut.caret)
        lastCaret.current = cut.caret
        place(cut.caret)
        return true
      }
    }
    if (!open) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length)
      return true
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault()
      pick(hits[active] ?? hits[0]!)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setClosedFor(text)
      return true
    }
    return false
  }

  const optionId = (i: number) => `${id}-opt-${i}`
  const inputProps = {
    'aria-controls': open ? `${id}-list` : undefined,
    'aria-activedescendant': open ? optionId(active) : undefined,
    'aria-autocomplete': 'list' as const,
    onSelect: track,
    onClick: track,
    onKeyUp: track,
  }

  const list = open ? (
    <div className="px-3 pt-3" data-testid="room-ref-menu">
      <div className="mb-1 flex items-center justify-between gap-3 px-2 text-xs text-faint">
        <span className="font-medium text-muted">{t('composer.roomMenu')}</span>
        <span className="truncate max-sm:hidden">{t('composer.roomHint', { ai: PRODUCT_NAMED_AFTER_AI ? t('rooms.aiName') : 'AI' })}</span>
      </div>
      <ul ref={listRef} id={`${id}-list`} role="listbox" aria-label={t('composer.roomMenu')} className="relative max-h-[min(16rem,40dvh)] overflow-y-auto overscroll-contain">
        {hits.map((r, i) => (
          <li key={r.id} id={optionId(i)} role="option" aria-selected={i === active}>
            <button
              type="button"
              tabIndex={-1}
              // the focus stays in the message box
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r)}
              onMouseMove={() => i !== active && setActive(i)}
              className={clsx('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm max-md:min-h-11', i === active && 'bg-accent-soft')}
              data-testid="room-ref-option"
              data-room-id={r.id}
            >
              <RoomIcon room={r} size={22} tile />
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{label(r)}</span>
              {r.kind !== 'dm' && <span className="shrink-0 text-xs text-faint tabular-nums">{t('rooms.members', { n: r.memberCount })}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : null

  return {
    list,
    onKeyDown,
    inputProps,
    ranges,
    /** what is sent for this text: the tokens with their rooms' ids */
    wire: (s: string) => toWire(s, picked),
    reset: () => { setPicked([]); setClosedFor(null) },
    /** call from onChange: the caret moved with the typing */
    track,
  }
}

/** The tokens as the box shows them: a layer behind the text box with the same text, the tokens marked (the box's own
 * text is then transparent; its caret and a see-through selection stay). Same padding, size and wrapping as the box. */
export function TokenLayer({ text, ranges, className, scrollTop }: { text: string; ranges: TokenRange[]; className: string; scrollTop: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = scrollTop }, [scrollTop, text])
  const parts: { s: string; token: boolean }[] = []
  let at = 0
  for (const r of ranges) { if (r.start > at) parts.push({ s: text.slice(at, r.start), token: false }); parts.push({ s: text.slice(r.start, r.end), token: true }); at = r.end }
  parts.push({ s: text.slice(at), token: false })
  return (
    <div ref={ref} aria-hidden className={clsx('pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap text-ink [overflow-wrap:break-word] [scrollbar-gutter:stable]', className)} data-testid="room-ref-layer">
      {parts.map((p, i) => (p.token
        // no padding or weight of its own: the glyphs must stand exactly where the box's own (transparent) ones are
        ? <span key={i} className="rounded-[4px] bg-accent-soft text-accent-text shadow-[0_0_0_2px_var(--c-accent-soft)]" data-testid="room-ref-token">{p.s}</span>
        : <Fragment key={i}>{p.s}</Fragment>))}
      {/* a last empty line still takes its height */}
      {text.endsWith('\n') ? '​' : null}
    </div>
  )
}

/** A room a sent message names ("#마케팅"), in the message: the same look as the box's token. */
export function RoomRefChip({ title }: { title: string }) {
  const t = useT()
  return <span className="rounded-[4px] bg-accent-soft text-accent-text shadow-[0_0_0_2px_var(--c-accent-soft)] [overflow-wrap:anywhere]" title={t('composer.roomChip', { name: title })} data-testid="room-ref-chip">#{title}</span>
}

/** A sent text with its "#" room tokens as chips ("#마케팅"), the rest as it was typed. */
export function WithRoomRefs({ text }: { text: string }) {
  const parts = roomRefParts(text)
  if (parts.length === 1 && 'text' in parts[0]!) return <>{text}</>
  return <>{parts.map((p, i) => ('room' in p ? <RoomRefChip key={i} title={p.room.title} /> : <Fragment key={i}>{p.text}</Fragment>))}</>
}
