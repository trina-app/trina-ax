// A text with the rooms it names by id read as their names (lib/roomNames.ts, docs/DECISIONS.md "A scheduled task's
// instruction names rooms by their names"): a scheduled task's instruction on the Scheduled pages, and a question in a
// chat (a run's question is its instruction). Only the rooms the viewer is in now are named (the app's room list,
// store/rooms.ts, which the server fills with their own rooms); any other reads "a conversation you're not in".
import { Fragment } from 'react'
import { useT } from '../i18n'
import { mentionsRoomId, roomNameParts } from '../lib/roomNames'
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
  const rooms = useRooms((s) => s.rooms)
  const known = useRooms((s) => s.loaded && !s.failed)
  const title = useRoomTitle()
  const byId = new Map(rooms.map((r) => [r.id, r]))
  const seen = known ? (id: string) => { const r = byId.get(id); return r ? { name: title(r), dm: r.kind === 'dm' } : null } : undefined
  return (
    <>
      {roomNameParts(text, seen, { tokenTitles }).map((p, i) => {
        if ('text' in p) return <Fragment key={i}>{p.text}</Fragment>
        const { name, dm } = p.room
        // a token the person picked, in a chat message: as before (its title)
        if (p.room.picked && name) return <RoomRefChip key={i} title={name} />
        if (name === undefined) return <span key={i} className={CHIP} data-testid="room-name" data-room="unknown">#…</span>
        if (name === null) return <span key={i} className="text-muted" data-testid="room-name" data-room="out">{t('rooms.roomNotIn')}</span>
        return <span key={i} className={CHIP} title={t('composer.roomChip', { name })} data-testid="room-name" data-room="in">{dm ? name : `#${name}`}</span>
      })}
    </>
  )
}
