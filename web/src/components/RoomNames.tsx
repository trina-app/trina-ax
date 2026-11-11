// A text with the rooms it names by id read as their names (lib/roomNames.ts, docs/DECISIONS.md "A scheduled task's
// instruction names rooms by their names"): a scheduled task's instruction on the Scheduled pages, and a question in a
// chat (a run's question is its instruction). Only the rooms the viewer is in now are named (the app's room list,
// store/rooms.ts, which the server fills with their own rooms); any other reads "a conversation you're not in". A copy
// of a selection gives the ids as written (copyRoomIds), not the names.
import { Fragment, useMemo, type ClipboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useT } from '../i18n'
import { mentionsRoomId, roomIdMatches, roomNameParts } from '../lib/roomNames'
import { useRooms } from '../store/rooms'
import { RoomRefChip } from './chat/RoomRefMenu'
import { useRoomTitle } from './rooms/RoomIcon'

const CHIP = 'rounded-[4px] bg-accent-soft text-accent-text shadow-[0_0_0_2px_var(--c-accent-soft)] [overflow-wrap:anywhere]'

/** `tokenTitles`: a "#" token the person picked shows the title it was picked by, as in any chat message (WithRoomRefs);
 * off (an instruction the AI wrote), a token is named like an id: only for a viewer in the room. A text without an id
 * is drawn as it is, without reading the room list (every chat bubble comes here). */
export function WithRoomNames({ text, tokenTitles = false }: { text: string; tokenTitles?: boolean }) {
  return mentionsRoomId(text) ? <Named text={text} tokenTitles={tokenTitles} /> : <>{text}</>
}

function Named({ text, tokenTitles }: { text: string; tokenTitles: boolean }) {
  const t = useT()
  const matches = useMemo(() => roomIdMatches(text), [text])
  const ids = useMemo(() => [...new Set(matches.map((m) => m.id))], [matches])
  // only the rooms this text names: a message in any other room (a new rooms list each time) draws nothing again here
  const named = useRooms(useShallow((s) => ids.map((id) => s.rooms.find((r) => r.id === id) ?? null)))
  const known = useRooms((s) => s.loaded && !s.failed)
  const title = useRoomTitle()
  const parts = useMemo(() => {
    const byId = new Map(named.flatMap((r) => (r ? [[r.id, r] as const] : [])))
    const seen = known ? (id: string) => { const r = byId.get(id); return r ? { name: title(r), dm: r.kind === 'dm' } : null } : undefined
    return roomNameParts(text, seen, { tokenTitles }, matches)
  }, [text, matches, named, known, title, tokenTitles])
  return (
    <>
      {parts.map((p, i) => {
        if ('text' in p) return <Fragment key={i}>{p.text}</Fragment>
        const { name, dm, raw } = p.room
        // a token the person picked, in a chat message: as before (its title)
        if (p.room.picked && name) return <RoomRefChip key={i} title={name} />
        if (name === undefined) return <span key={i} className={CHIP} data-testid="room-name" data-room="unknown" data-raw={raw}>#…</span>
        if (name === null) return <span key={i} className="text-muted" data-testid="room-name" data-room="out" data-raw={raw}>{t('rooms.roomNotIn')}</span>
        return <span key={i} className={CHIP} title={t('composer.roomChip', { name })} data-testid="room-name" data-room="in" data-raw={raw}>{dm ? name : `#${name}`}</span>
      })}
    </>
  )
}

/** onCopy of a box that shows WithRoomNames: the selection with each room as it is written (data-raw: the id, never a
 * name the viewer was not shown), so a copied instruction still names the room a run reads. A selection with no room
 * in it, or one that goes past this box (several messages: their layout is the browser's), is copied as the browser
 * does. */
export function copyRoomIds(e: ClipboardEvent<HTMLElement>) {
  const sel = typeof window === 'undefined' ? null : window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return
  const ranges = Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i))
  if (ranges.some((r) => !e.currentTarget.contains(r.commonAncestorContainer))) return
  const box = document.createElement('div')
  for (const r of ranges) box.appendChild(r.cloneContents())
  const rooms = box.querySelectorAll('[data-raw]')
  if (!rooms.length) return
  for (const el of rooms) el.replaceWith(document.createTextNode(el.getAttribute('data-raw') ?? ''))
  e.clipboardData.setData('text/plain', box.textContent ?? '')
  e.preventDefault()
}
