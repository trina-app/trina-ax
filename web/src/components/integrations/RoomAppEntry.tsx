// Connectors' "Add to a conversation" (docs/decisions/20261116-connector-card-room-apps.md, QA TC-3515): under
// the row of a listed service that also has a conversation app (shared ROOM_APP_FOR_CATALOG: Sentry, Notion, Stripe,
// Atlassian's Jira), one text action. It opens a picker of the conversations where this person may add apps (the
// server's rule, Room.canManageApps: store/roomApps.ts mayManageApps); picking one opens that conversation with the
// service's Add an app guide (?apps=add:<service>, pages/Room.tsx). Nothing is added until the guide's Copy, as from
// the conversation's own menu. With no such conversation it says, in one line, how to start one.
import { useEffect, useState } from 'react'
import { roomAppForCatalog, type Room } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { mayManageApps } from '../../store/roomApps'
import { useMe } from '../../store/session'
import { ListRow } from '../list/List'
import { RoomIcon, useRoomTitle } from '../rooms/RoomIcon'
import { Modal, Skeleton, TextAction } from '../ui'

/** The line under a connector's row, or nothing for a service without a conversation app (or a guest, who adds none). */
export function RoomAppEntry({ catalogId }: { catalogId: string | null | undefined }) {
  const t = useT()
  const me = useMe()
  const service = catalogId ? roomAppForCatalog(catalogId) : null
  const [open, setOpen] = useState(false)
  const [none, setNone] = useState(false)
  const rooms = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  // the rooms are the conversation list's (store/rooms.ts); read when they never loaded
  useEffect(() => { if ((open || none) && !loaded) void useRooms.getState().loadRooms() }, [open, none, loaded])
  if (!service || !me || me.user.role === 'guest') return null
  const app = t(`roomApps.kind.${service}`)
  const mine = rooms.filter((r) => !r.hidden && !r.gone && mayManageApps(r, me))
  const press = () => {
    if (loaded && !mine.length) setNone(true)
    else setOpen(true)
  }
  // the dialog was asked for before the list came in, and there is nothing to pick: the line instead
  const empty = open && loaded && !mine.length
  return (
    <div className="-mt-1.5 pb-2 pl-13 text-xs" data-testid="connector-room-app" data-service={service}>
      <TextAction onClick={press} aria-label={`${t('connectors.roomApp')}: ${app}`} data-testid="connector-room-app-open">{t('connectors.roomApp')}</TextAction>
      {(none || empty) && <p role="status" className="mt-0.5 text-muted" data-testid="connector-room-app-none">{t('connectors.roomAppNone')}</p>}
      {open && !empty && <RoomPicker service={service} app={app} rooms={loaded ? mine : null} onClose={() => setOpen(false)} />}
    </div>
  )
}

function RoomPicker({ service, app, rooms, onClose }: { service: string; app: string; rooms: Room[] | null; onClose: () => void }) {
  const t = useT()
  const title = useRoomTitle()
  return (
    <Modal open onClose={onClose} title={t('connectors.roomAppTitle')} width={440}>
      <div data-testid="room-app-picker">
        <p className="text-sm text-muted">{t('connectors.roomAppLead', { app })}</p>
        {!rooms ? <Skeleton lines={3} /> : (
          <ul className="-mx-3 mt-3" data-testid="room-app-picker-list">
            {rooms.map((r) => (
              <ListRow
                key={r.id}
                to={`/rooms/${r.id}?apps=add:${service}`}
                lead={<RoomIcon room={r} size={28} tile />}
                name={r.kind === 'dm' ? t('composer.roomDm', { name: title(r) }) : title(r)}
                meta={r.kind === 'dm' ? undefined : t('rooms.members', { n: r.memberCount })}
                testId="room-app-picker-room"
                link={{ 'data-room-id': r.id, 'data-kind': r.kind }}
              />
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
