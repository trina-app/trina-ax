// The Guest half of an invite dialog that starts with "Team member / Guest" (docs/DECISIONS.md "Guests from Admin ›
// Invite to team" and "Guests from Invite people"): Admin › Members › "Invite to team" (pages/admin/Members.tsx
// InviteDialog) and "Invite people" (components/TeamMenu.tsx TeamInviteDialog: the team menu, ⌘K, the phone's 나 tab)
// use these same parts, so the guest flow is one flow wherever it starts:
//   - InviteKindTabs: the two-choice switch at the top (Team member picked first);
//   - useGuestChoice: the plan's guest cap (read only once Guest is picked), the place picked, a refused Create link;
//   - GuestChoicePanel: one plain line, then the places (GuestPlacePicker), or the limit when the plan is full;
//   - GuestChoiceButtons: Cancel (Close when full) and, for the owner and admins, See plans;
//   - GuestChoiceForm: the rooms' and projects' guest invite form (GuestInviteDialog) for the place picked, whose Cancel
//     comes back to the places with Guest still picked;
//   - GuestInviteFlow: the same on its own, for "Invite a guest" in the "New conversation" list (no place yet).
// GuestPlacePicker lists the ONE place a guest joins, picked before the guest invite form. Only the places POST
// /api/guest-invites accepts from the caller (server/src/auth/guest-invites.ts inviteMakerOk), and only the places a
// room's or a project's own "Invite a guest" row is offered in:
//   - group chats I am in (the rooms list holds only rooms I am in, not archived; a group chat is its people's
//     conversation, so an admin who is not in it cannot let a guest in);
//   - team projects whose members I may change (Project.membersEditable on the manage=1 list, not in the trash): the
//     projects whose members dialog shows "Invite a guest" (the creator, the owner and admins);
//   - my own personal projects, when I may share them (as the project page's "Add people": the owner and admins, or
//     members when the team lets them): the invite form shares one first, then makes the link (docs/DECISIONS.md
//     "Guests into a personal project"). Such a row says "Only me".
// A search box once there are more than a few; private channels (group rooms with a name, a lock) first, then group
// chats (group DMs: no name, named after their people), then projects; a row picks the place. Both kinds of group room
// take a guest (server: rooms.kind 'group'), so the words say "private channel or group chat" where either can be meant.
import { FolderKanban, Lock, MessagesSquare } from 'lucide-react'
import { isPrivateChannel, projectRoomOf } from '../lib/rooms'
import { useEffect, useMemo, useState } from 'react'
import { useLocale, useT } from '../i18n'
import { ListRow } from './list/List'
import { useRoomTitle } from './rooms/RoomIcon'
import { GuestInviteDialog, GuestsFull, SeePlansLink, guestsFullOf, useGuestLimit, type GuestCap, type InvitePlace } from './GuestInvite'
import { Button, ErrorNote, Modal, Skeleton, TabPanel, Tabs } from './ui'
import { isAdmin, useMe } from '../store/session'
import { readManagedList, useProjects } from '../store/projects'
import { useRooms } from '../store/rooms'
import type { Project } from '@mycel/shared/api'
import { matches, SearchBox } from '../pages/admin/common'

export type InviteKind = 'member' | 'guest'

/** "Who are you inviting?": Team member (picked first) or Guest. `panels`: the TabPanels' ids (useId()). */
export function InviteKindTabs({ value, onChange, panels }: { value: InviteKind; onChange: (v: InviteKind) => void; panels: string }) {
  const t = useT()
  return (
    <div className="mb-4 flex" data-testid="invite-kind">
      <Tabs segmented value={value} onChange={onChange} label={t('members.inviteKind')} panels={panels}
        items={[{ id: 'member', label: t('members.inviteKindMember') }, { id: 'guest', label: t('members.inviteKindGuest') }]} />
    </div>
  )
}

type Cap = GuestCap

/** The Guest half's state. `picked`: Guest is the choice now (the cap is read the first time it is). */
export function useGuestChoice(picked: boolean) {
  // the guest cap: a full plan says so instead of the places
  const limit = useGuestLimit(picked)
  // or told by a refused Create link (the plan filled up meanwhile): the limit then, not the places again
  const [refusedFull, setRefusedFull] = useState<Cap | null>(null)
  const [place, setPlace] = useState<InvitePlace | null>(null)
  return {
    limit,
    full: refusedFull ?? guestsFullOf(limit),
    place,
    pick: setPlace,
    back: () => setPlace(null),
    refused: (cap: Cap) => {
      setRefusedFull(cap)
      setPlace(null)
    },
  }
}
export type GuestChoice = ReturnType<typeof useGuestChoice>

/** Guest picked: who a guest is in one line, then the one place they join, or the plan's limit. `admin`: the owner or an
 * admin (the limit's words and See plans are theirs; a member is told to ask an admin). */
export function GuestChoicePanel({ choice, panels, admin }: { choice: GuestChoice; panels: string | null; admin: boolean }) {
  const t = useT()
  return (
    <TabPanel base={panels} value="guest" className="space-y-4">
      <p className="text-sm leading-6 break-keep text-muted" data-testid="invite-guest-line">{t('members.inviteGuestLine')}</p>
      {choice.limit === undefined ? <Skeleton lines={3} /> : choice.full ? <GuestsFull n={choice.full.n} admin={admin} pending={choice.full.pending} /> : <GuestPlacePicker onPick={choice.pick} />}
    </TabPanel>
  )
}

/** The Guest half's buttons: Cancel, or Close (the one main button) when the plan is full; See plans beside it for the
 * owner and admins when the server names a plan page. */
export function GuestChoiceButtons({ choice, admin, onClose }: { choice: GuestChoice; admin: boolean; onClose: () => void }) {
  const t = useT()
  const plans = admin ? choice.full?.manageUrl : undefined
  return (
    <>
      <Button variant={choice.full && !plans ? 'primary' : 'ghost'} onClick={onClose} data-testid="invite-guest-close">{t(choice.full ? 'common.close' : 'common.cancel')}</Button>
      {plans && <SeePlansLink url={plans} />}
    </>
  )
}

/** The guest invite form for the place picked (null while none is): Cancel back to the places, Done (`onDone`) after
 * the link is made, and a Create link refused as full hands the limit back to the places' step. */
export function GuestChoiceForm({ choice, onDone }: { choice: GuestChoice; onDone: () => void }) {
  if (!choice.place) return null
  return <GuestInviteDialog place={choice.place} onClose={onDone} onCancel={choice.back} onFull={choice.refused} />
}

/** One of my personal projects that I may share (the project page's "Add people", pages/Projects.tsx: a folder in my
 * own users/<me>/, not my whole folder, the owner and admins or members when the team lets them make team projects):
 * a guest place once shared. */
export function mayShareForGuest(p: Pick<Project, 'folderPath'>, me: ReturnType<typeof useMe>): boolean {
  if (!me) return false
  const segs = p.folderPath.split('/')
  return segs[0] === 'users' && segs[1] === me.user.id && segs.length >= 3 && (isAdmin(me) || me.team.projectCreators === 'members')
}

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
  const groupChats = useMemo(() => rooms.filter((r) => r.kind === 'group' && !projectRoomOf(r)).map((r) => ({ id: r.id, name: roomTitle(r), count: r.memberCount, locked: isPrivateChannel(r) })), [rooms, roomTitle])
  // no count for a project: who sees it (Project.audience) is not who is in it, as a group chat's count is
  const me = useMe()
  const projects = useMemo(() => (managed ?? []).filter((p) => !p.inTrash && (p.membersEditable || mayShareForGuest(p, me))).map((p) => ({ id: p.id, name: p.name, personal: mayShareForGuest(p, me) })), [managed, me])
  const needle = q.trim().toLocaleLowerCase(locale)
  const shownRooms = groupChats.filter((r) => matches(needle, locale, r.name))
  const shownChannels = shownRooms.filter((r) => r.locked)
  const shownGroups = shownRooms.filter((r) => !r.locked)
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
          {shownChannels.length > 0 && (
            <>
              <p className={label}>{t('guest.invite.privateChannels')}</p>
              <ul data-testid="guest-place-channels">
                {shownChannels.map((r) => (
                  <ListRow key={r.id} face icon={<Lock />} name={r.name} meta={t('rooms.members', { n: r.count })} onClick={() => onPick({ kind: 'room', id: r.id, name: r.name, privateChannel: true })} testId="guest-place-room" />
                ))}
              </ul>
            </>
          )}
          {shownGroups.length > 0 && (
            <>
              <p className={label}>{t('guest.invite.groupChats')}</p>
              <ul data-testid="guest-place-rooms">
                {shownGroups.map((r) => (
                  <ListRow key={r.id} face icon={<MessagesSquare />} name={r.name} meta={t('rooms.members', { n: r.count })} onClick={() => onPick({ kind: 'room', id: r.id, name: r.name, privateChannel: false })} testId="guest-place-room" />
                ))}
              </ul>
            </>
          )}
          {shownProjects.length > 0 && (
            <>
              <p className={label}>{t('projects.title')}</p>
              <ul data-testid="guest-place-projects">
                {shownProjects.map((p) => (
                  <ListRow key={p.id} face icon={<FolderKanban />} name={p.name} meta={p.personal ? t('projects.members.onlyMe') : undefined} onClick={() => onPick({ kind: 'project', id: p.id, name: p.name, ...(p.personal ? { personal: true as const } : {}) })} testId="guest-place-project" />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** "Invite a guest" with no place yet (the "New conversation" list's first row, components/rooms/PeoplePicker.tsx; the
 * team link's invite step): the same Guest half on its own, titled as the rooms' and projects' guest form is: one line,
 * the one place they join (or the limit), then that form. `onCancel`: Cancel / Close / × here (back to where it was
 * opened); `onClose`: Done after the link is made (closes everything). */
export function GuestInviteFlow({ onClose, onCancel = onClose }: { onClose: () => void; onCancel?: () => void }) {
  const t = useT()
  const admin = isAdmin(useMe())
  const choice = useGuestChoice(true)
  if (choice.place) return <GuestChoiceForm choice={choice} onDone={onClose} />
  return (
    <Modal open onClose={onCancel} title={t('guest.invite.title')} width={480} footer={<GuestChoiceButtons choice={choice} admin={admin} onClose={onCancel} />}>
      <div data-testid="guest-invite-flow">
        <GuestChoicePanel choice={choice} panels={null} admin={admin} />
      </div>
    </Modal>
  )
}
