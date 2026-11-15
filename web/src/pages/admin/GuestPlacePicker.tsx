// Admin › Members › "Invite to team" › Guest (docs/DECISIONS.md "Guests from Admin › Invite to team"): the ONE place a
// guest joins, picked before the guest invite form (components/GuestInvite.tsx GuestInviteDialog). Only the places POST
// /api/guest-invites accepts from the owner or an admin (server/src/auth/guest-invites.ts inviteMakerOk), and only the
// places a room's or a project's own "Invite a guest" row is offered in:
//   - group chats I am in (the rooms list holds only rooms I am in, not archived; a group chat is its people's
//     conversation, so an admin who is not in it cannot let a guest in);
//   - team projects whose members I may change (Project.membersEditable on the manage=1 list, not in the trash): the
//     projects whose members dialog shows "Invite a guest".
// A search box once there are more than a few; group chats first, then projects; a row picks the place.
import { FolderKanban, MessagesSquare } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocale, useT } from '../../i18n'
import { ListRow } from '../../components/list/List'
import { useRoomTitle } from '../../components/rooms/RoomIcon'
import type { InvitePlace } from '../../components/GuestInvite'
import { ErrorNote, Skeleton } from '../../components/ui'
import { readManagedList, useProjects } from '../../store/projects'
import { useRooms } from '../../store/rooms'
import { matches, SearchBox } from './common'

/** more places than this: a search box above them */
const SEARCH_FROM = 6

export function GuestPlacePicker({ onPick }: { onPick: (place: InvitePlace) => void }) {
  const t = useT()
  const locale = useLocale()
  const roomTitle = useRoomTitle()
  const rooms = useRooms((s) => s.rooms)
  const roomsLoaded = useRooms((s) => s.loaded)
  const managed = useProjects((s) => s.managed)
  const roomsFailed = useRooms((s) => !!s.failed)
  const [projectsFailed, setProjectsFailed] = useState(false)
  const failed = projectsFailed || (roomsLoaded && roomsFailed)
  const [q, setQ] = useState('')
  useEffect(() => {
    read()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // the rooms (when not read yet) and the projects; either failing says so, with Try again
  function read() {
    setProjectsFailed(false)
    const st = useRooms.getState()
    if (!st.loaded || st.failed) void st.loadRooms()
    readManagedList({ fresh: true }).catch(() => setProjectsFailed(true))
  }
  const groupChats = useMemo(() => rooms.filter((r) => r.kind === 'group').map((r) => ({ id: r.id, name: roomTitle(r), count: r.memberCount })), [rooms, roomTitle])
  // no count for a project: who sees it (Project.audience) is not who is in it, as a group chat's count is
  const projects = useMemo(() => (managed ?? []).filter((p) => p.membersEditable && !p.inTrash).map((p) => ({ id: p.id, name: p.name })), [managed])
  const needle = q.trim().toLocaleLowerCase(locale)
  const shownRooms = groupChats.filter((r) => matches(needle, locale, r.name))
  const shownProjects = projects.filter((p) => matches(needle, locale, p.name))
  const loading = !failed && (!roomsLoaded || managed === null)
  const total = groupChats.length + projects.length
  const label = 'px-3 pt-3 pb-1 text-xs font-medium text-faint'
  return (
    <div className="space-y-3" data-testid="guest-place-picker">
      <p className="text-sm font-medium text-ink">{t('guest.invite.pickPlace')}</p>
      {total > SEARCH_FROM && <SearchBox value={q} onChange={setQ} label={t('guest.invite.searchPlaces')} testId="guest-place-search" className="w-full" />}
      {failed && <ErrorNote onRetry={read}>{t('error.network')}</ErrorNote>}
      {loading && !total ? <Skeleton lines={3} /> : failed && !total ? null : !total ? (
        <p className="text-sm leading-6 break-keep text-muted" data-testid="guest-place-none">{t('guest.invite.noPlaces')}</p>
      ) : !shownRooms.length && !shownProjects.length ? (
        <p className="text-sm text-muted" data-testid="guest-place-no-match">{t('guest.invite.noPlaceMatch')}</p>
      ) : (
        <div className="-mx-3">
          {shownRooms.length > 0 && (
            <>
              <p className={label}>{t('guest.invite.groupChats')}</p>
              <ul data-testid="guest-place-rooms">
                {shownRooms.map((r) => (
                  <ListRow key={r.id} face icon={<MessagesSquare />} name={r.name} meta={t('rooms.picker.groupCount', { n: r.count })} onClick={() => onPick({ kind: 'room', id: r.id, name: r.name })} testId="guest-place-room" />
                ))}
              </ul>
            </>
          )}
          {shownProjects.length > 0 && (
            <>
              <p className={label}>{t('projects.title')}</p>
              <ul data-testid="guest-place-projects">
                {shownProjects.map((p) => (
                  <ListRow key={p.id} face icon={<FolderKanban />} name={p.name} onClick={() => onPick({ kind: 'project', id: p.id, name: p.name })} testId="guest-place-project" />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
