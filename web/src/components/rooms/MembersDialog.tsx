// The room's info, opened from its title (docs/DECISIONS.md "그룹 대화와 방 이름"): its name (a tap edits it inline,
// for those who may: Room.canRename; the room's "⋯" has 이름 바꾸기 too), "초대하기" (a group chat: into it; a DM: a new
// group chat with the other person ticked), and who is in it (GET /api/rooms/:id/members: names only, never anyone's
// read position; photo and title from the people directory; the manager marked, and "…" › 내보내기 on a row for the
// manager and owners or admins in it). 대화방 나가기 is in the room's "⋯" only (RoomMenu.tsx), not here a second time.
// The lists' rows (components/list/List.tsx ListRow, a list of people's face box), no boxes. A bottom sheet on phones (Modal).
// A project's own chat room (Room.project.room; docs/decisions/20261120-project-is-room.md D5): one line says whose room
// it is, then Manage people (the project's members dialog, for whoever may change them), Mute and Leave project in place
// of the name, 초대하기 and 내보내기: its people are the project's.
// Each picture carries the person's online dot, mine too (components/Presence.tsx; docs/DECISIONS.md "접속 상태").
import { Bell, BellOff, LogOut, Pencil, Plus, UserMinus, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ROOM_NAME_MAX, type Project, type Room, type RoomMember } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { usePeople } from '../../store/people'
import { markLeaving, useRooms } from '../../store/rooms'
import { useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { PresenceFace, PresenceText } from '../Presence'
import { StatusEmoji } from '../StatusMessage'
import { Button, confirmDialog, inputCls, Modal, Skeleton } from '../ui'
import { MenuButton } from './MenuButton'
import { ListRow } from '../list/List'
import { useNameFallback, useRoomTitle } from './RoomIcon'
import { GuestTagFor, isGuestNow } from '../GuestTag'
import { isGuestMe } from '../../lib/guests'
import { isPrivateChannel } from '../../lib/rooms'
import { PersonButton } from '../PersonCard'
import { ProjectMembersDialog } from '../ProjectMembersDialog'
import { useLeaveProject } from '../LeaveProject'
import { useProjects } from '../../store/projects'
import { roomNotify } from './RoomNotifyMenu'
import { isProjectRoom, projectRoomOf } from '../../lib/rooms'

export function MembersDialog({ open, onClose, room, members, meId, onInvite }: { open: boolean; onClose: () => void; room: Room | null; members: RoomMember[] | undefined; meId: string | null; onInvite: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const byId = usePeople((s) => s.byId)
  const sorted = members ? [...members].sort((a, b) => Number(b.user.id === meId) - Number(a.user.id === meId) || Number(b.user.id === room?.managerId) - Number(a.user.id === room?.managerId) || a.user.name.localeCompare(b.user.name)) : null
  const group = room?.kind === 'group'
  const locked = !!room && isPrivateChannel(room)
  // a project's chat room: its people are the project's (managed there)
  const projectRoom = !!room && isProjectRoom(room)
  // the manager, and an owner or admin who is in it, take someone out (never themselves: they leave)
  const mayRemove = group && !projectRoom && !!meId && (room?.managerId === meId || me?.user.role === 'owner' || me?.user.role === 'admin')
  const remove = async (id: string, name: string) => {
    if (!room) return
    const ok = await confirmDialog({ title: t('rooms.info.removeTitle', { name }), body: t(isGuestNow(id) ? (locked ? 'rooms.info.removeBodyGuestPrivate' : 'rooms.info.removeBodyGuest') : 'rooms.info.removeBody'), confirm: t('rooms.info.remove'), danger: true })
    if (!ok) return
    await useRooms.getState().removeMember(room.id, id).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
  }
  return (
    <Modal open={open} onClose={onClose} title={sorted ? `${t('rooms.membersTitle')} · ${sorted.length}` : t('rooms.membersTitle')} width={400}>
      <div className="-mx-5 -my-5 divide-y divide-line max-sm:-mx-4" data-testid="room-info">
        {room?.canRename && <NameRow room={room} />}
        {room && projectRoom && <ProjectRoomInfo room={room} project={projectRoomOf(room)} onGo={onClose} />}
        {/* the lists' rows (components/list/List.tsx, a list of people: the face box), inset so the words line up
            with the dialog's 20px (16px on a phone) */}
        {(group || room?.kind === 'dm') && !projectRoom && !isGuestMe(me) && (
          <ul className="px-2 py-1 max-sm:px-1">
            <ListRow onClick={onInvite} face icon={<Plus />} name={<span className="text-ink">{t(locked ? 'rooms.info.invitePrivate' : 'rooms.info.addPeople')}</span>} testId="room-invite" />
          </ul>
        )}
        {!sorted ? (
          <div className="px-5 py-4 max-sm:px-4">
            <Skeleton lines={4} />
          </div>
        ) : (
          <ul className="px-2 py-1 max-sm:px-1 [--presence-bg:var(--c-surface)]" data-testid="room-members">
            {sorted.map(({ user }) => {
              const p = byId[user.id]
              const name = p?.name ?? user.name
              return (
                <ListRow
                  key={user.id}
                  face
                  icon={<PresenceFace user={{ ...user, name, avatarVersion: p?.avatarVersion }} size="fill" />}
                  testId="room-member"
                  // (the card's button reaches over the row; the row's own "…" stays above it)
                  li={p ? { className: 'relative rounded-lg hover:bg-hover hover:[--presence-bg:var(--c-hover)] has-[[aria-expanded=true]]:bg-hover' } : undefined}
                  name={
                    // the name is cut first; the status, "· 나" and "· 매니저" always show
                    <span className="flex min-w-0 items-baseline gap-1">
                      {/* the whole row opens the person's card (components/PersonCard.tsx): Message closes this dialog */}
                      <PersonButton user={user} look="row" boxClassName="min-w-0" onGo={onClose} testId="room-member-person"><span data-member-name>{name}</span></PersonButton>
                      <GuestTagFor userId={user.id} />
                      <StatusEmoji userId={user.id} tap className="relative shrink-0 self-center" />
                      <PresenceText userId={user.id} offline />
                      {user.id === meId && <span className="shrink-0 text-meta text-faint">· {t('rooms.you')}</span>}
                      {group && user.id === room?.managerId && <span className="shrink-0 text-meta text-faint" data-testid="room-manager">· {t('rooms.info.manager')}</span>}
                    </span>
                  }
                  meta={p?.title || undefined}
                  end={
                    mayRemove && user.id !== meId && (
                      <MenuButton
                        label={t('rooms.info.memberMenu', { name })}
                        testId="room-member-menu"
                        className="self-center"
                        // computers: on hover or focus, like a message's "…" (one per row would repeat down the list);
                        // touch screens: always there
                        buttonClassName="pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                        items={[{ label: t('rooms.info.remove'), icon: <UserMinus size={14} aria-hidden />, danger: true, onSelect: () => void remove(user.id, name), testId: 'room-member-remove' }]}
                      />
                    )
                  }
                />
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}

/** The room's name, a tap away from editing it: Enter or 저장 saves, Esc or 취소 puts it back. Empty goes back to the
 * server's name (a team room's group, the everyone room's word). A group room never saves an empty name: a group DM
 * named here turns into a private channel, and a private channel stays one
 * (docs/decisions/20261117-named-groups-private-channels.md). */
function NameRow({ room }: { room: Room }) {
  const t = useT()
  const title = useRoomTitle()(room)
  const fallback = useNameFallback()(room)
  const [draft, setDraft] = useState<string | null>(null)
  const group = room.kind === 'group'
  const locked = isPrivateChannel(room)
  // the new name shows at once; a failure puts the old one back with its own toast (store/rooms.ts rename) and opens
  // the field again with the name typed (unless it was opened again meanwhile)
  const save = () => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    if (next === (room.name ?? '') || (group && !next)) return
    void useRooms.getState().rename(room.id, next || null).then((ok) => { if (!ok) setDraft((d) => d ?? next) })
  }
  if (draft === null)
    return (
      <button type="button" onClick={() => setDraft(room.name ?? '')} className="group flex w-full items-center gap-2 px-5 py-3 text-left hover:bg-hover max-sm:px-4" data-testid="room-name" aria-label={`${t(group && !locked ? 'rooms.menu.makePrivate' : 'chat.rename')}: ${title}`}>
        <span className="min-w-0 flex-1 truncate text-base font-medium text-ink">{title}</span>
        <Pencil size={14} className="shrink-0 text-faint group-hover:text-ink" aria-hidden />
      </button>
    )
  return (
    <form
      className="px-5 py-3 max-sm:px-4"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <label className="block">
        <span className="sr-only">{t(group ? 'rooms.info.nameLabelPrivate' : 'rooms.info.nameLabelChannel')}</span>
        <input
          autoFocus
          value={draft}
          maxLength={ROOM_NAME_MAX}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setDraft(null)
            }
          }}
          placeholder={group ? t('rooms.info.nameLabelPrivate') : fallback}
          className={inputCls}
          data-testid="room-name-input"
        />
      </label>
      <div className="mt-2 flex items-center gap-2">
        <p className="mr-auto text-xs text-muted">{group ? (locked ? '' : t('rooms.menu.makePrivateBody')) : t('rooms.info.nameHintTeam')}</p>
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={group && !draft.trim()} data-testid="room-name-save">
          {t('common.save')}
        </Button>
      </div>
    </form>
  )
}

/** A project's chat room: whose room it is (the project's name opens its page), then Manage people for whoever may
 * change the project's members, Mute (the quiet way out) and Leave project (the full one; Room.project.leave, off for
 * the last person). Who may change the members is the project's own (read when the info opens). A member who cannot open
 * the project now (no Room.project) reads the line without its name, and Mute. */
function ProjectRoomInfo({ room, project: rp, onGo }: { room: Room; project: NonNullable<Room['project']> | null; onGo: () => void }) {
  const t = useT()
  const navigate = useNavigate()
  const [p, setP] = useState<Project | null>(() => (rp ? useProjects.getState().byId[rp.id] ?? null : null))
  const [managing, setManaging] = useState(false)
  const leave = useLeaveProject()
  useEffect(() => {
    if (!rp) return
    let live = true
    api.call(API.getProject, { params: { id: rp.id } }).then((x) => live && setP(x), () => {})
    return () => { live = false }
  }, [rp?.id])
  const muted = roomNotify(room).level === 'off'
  const parts = t('rooms.project.info', { name: '\u0000' }).split('\u0000')
  const leaveIt = async () => {
    if (!rp) return
    // the room's own "removed" that follows is no news here
    markLeaving(room.id)
    if (await leave({ id: rp.id, name: rp.name } as Project)) { onGo(); navigate('/rooms', { replace: true }) }
  }
  return (
    <div data-testid="room-info-project">
      <p className="px-5 py-3 text-sm break-words text-muted max-sm:px-4" data-testid="room-info-project-line">
        {!rp ? t('rooms.project.infoUnnamed') : parts.length === 2 ? <>{parts[0]}<Link to={`/projects/${rp.id}`} onClick={onGo} className="font-medium text-ink hover:underline" data-testid="room-info-project-name">{rp.name}</Link>{parts[1]}</> : t('rooms.project.info', { name: rp.name })}
        {rp?.sameAsGroup && <SameAsGroupLine project={rp} onGo={onGo} className="mt-2 block" testId="room-info-same-as-group" />}
      </p>
      <ul className="px-2 pb-1 max-sm:px-1">
        {p?.membersEditable && <ListRow onClick={() => setManaging(true)} face icon={<Users />} name={<span className="text-ink">{t('rooms.project.manage')}</span>} testId="room-info-manage" />}
        <ListRow
          onClick={() => void useRooms.getState().setNotifyLevel(room.id, muted ? null : 'off')}
          face
          icon={muted ? <Bell /> : <BellOff />}
          name={<span className="text-ink">{t(muted ? 'rooms.project.unmute' : 'rooms.project.mute')}</span>}
          testId="room-info-mute"
        />
        {rp?.leave && (
          <ListRow
            onClick={rp.leave === 'last' ? undefined : () => void leaveIt()}
            disabled={rp.leave === 'last'}
            face
            icon={<LogOut className="text-danger" />}
            name={<span className={rp.leave === 'last' ? 'text-faint' : 'text-danger'}>{t('projects.leave')}</span>}
            meta={rp.leave === 'last' ? t('projects.leaveLast') : undefined}
            metaWrap
            testId="room-info-leave"
          />
        )}
      </ul>
      {managing && p && <ProjectMembersDialog project={p} onClose={() => setManaging(false)} onSaved={(x) => { setP(x); useProjects.getState().put(x) }} />}
    </div>
  )
}

/** A project's chat room whose people are exactly a department's (Room.project.sameAsGroup, told only to people in that
 * department's room): "Same people as #{group}. Keep {project} talk here.", #{group} a link to the department's room. In
 * the room's start and its info; no banner, nothing to dismiss (docs/decisions/20261121-sidebar-projects-group.md). */
export function SameAsGroupLine({ project, onGo, className, testId = 'room-same-as-group' }: { project: Pick<NonNullable<Room['project']>, 'name' | 'sameAsGroup'>; onGo?: () => void; className?: string; testId?: string }) {
  const t = useT()
  const g = project.sameAsGroup
  if (!g) return null
  const tag = `#${g.name}`
  const text = t('rooms.project.sameAsGroup', { group: tag, project: project.name })
  const at = text.indexOf(tag)
  const link = <Link to={`/rooms/${g.roomId}`} onClick={onGo} className="font-medium text-ink hover:underline" data-testid={`${testId}-link`}>{tag}</Link>
  return (
    <span className={className} data-testid={testId}>
      {at < 0 ? text : <>{text.slice(0, at)}{link}{text.slice(at + tag.length)}</>}
    </span>
  )
}
