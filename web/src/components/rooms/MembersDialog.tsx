// The room's info, opened from its title (docs/DECISIONS.md "그룹 대화와 방 이름"): its name (a tap edits it inline,
// for those who may: Room.canRename), "초대하기" (a group chat: into it; a DM: a new group chat with the other person
// ticked), who is in it (GET /api/rooms/:id/members: names only, never anyone's read position; photo and title from
// the people directory; the manager marked, and "…" › 내보내기 on a row for the manager and owners or admins in it), and
// last "대화방 나가기" (a group chat, after a confirm). Rows and hairlines, no boxes. A bottom sheet on phones (Modal).
import clsx from 'clsx'
import { Pencil, Plus, UserMinus } from 'lucide-react'
import { useState } from 'react'
import { ROOM_NAME_MAX, type Room, type RoomMember } from '@mycel/shared/api'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { usePeople } from '../../store/people'
import { useRooms } from '../../store/rooms'
import { useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { Avatar } from '../Avatar'
import { Button, confirmDialog, inputCls, Modal, Skeleton } from '../ui'
import { MenuButton } from './MenuButton'
import { useRoomTitle } from './RoomIcon'

export function MembersDialog({ open, onClose, room, members, meId, onInvite }: { open: boolean; onClose: () => void; room: Room | null; members: RoomMember[] | undefined; meId: string | null; onInvite: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const byId = usePeople((s) => s.byId)
  const sorted = members ? [...members].sort((a, b) => Number(b.user.id === meId) - Number(a.user.id === meId) || Number(b.user.id === room?.managerId) - Number(a.user.id === room?.managerId) || a.user.name.localeCompare(b.user.name)) : null
  const group = room?.kind === 'group'
  // the manager, and an owner or admin who is in it, take someone out (never themselves: they leave)
  const mayRemove = group && !!meId && (room?.managerId === meId || me?.user.role === 'owner' || me?.user.role === 'admin')
  const remove = async (id: string, name: string) => {
    if (!room) return
    const ok = await confirmDialog({ title: t('rooms.info.removeTitle', { name }), body: t('rooms.info.removeBody'), confirm: t('rooms.info.remove'), danger: true })
    if (!ok) return
    await useRooms.getState().removeMember(room.id, id).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
  }
  const leave = async () => {
    if (!room) return
    const ok = await confirmDialog({ title: t('rooms.info.leaveTitle'), body: t('rooms.info.leaveBody'), confirm: t('rooms.info.leave'), danger: true })
    if (!ok) return
    try {
      await useRooms.getState().leave(room.id)
      onClose()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const row = 'flex w-full items-center gap-3 px-5 py-2.5 text-left max-sm:px-4'
  return (
    <Modal open={open} onClose={onClose} title={sorted ? `${t('rooms.membersTitle')} · ${sorted.length}` : t('rooms.membersTitle')} width={400}>
      <div className="-mx-5 -my-5 divide-y divide-line max-sm:-mx-4" data-testid="room-info">
        {room?.canRename && <NameRow room={room} />}
        {(group || room?.kind === 'dm') && (
          <button type="button" onClick={onInvite} className={clsx(row, 'text-sm font-medium text-ink hover:bg-hover')} data-testid="room-invite">
            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-hover text-muted">
              <Plus size={16} />
            </span>
            {t('rooms.info.invite')}
          </button>
        )}
        {!sorted ? (
          <div className="px-5 py-4 max-sm:px-4">
            <Skeleton lines={4} />
          </div>
        ) : (
          <ul className="divide-y divide-line" data-testid="room-members">
            {sorted.map(({ user }) => {
              const p = byId[user.id]
              const name = p?.name ?? user.name
              return (
                <li key={user.id} className={clsx(row, 'group')} data-testid="room-member">
                  <Avatar user={{ ...user, name, avatarVersion: p?.avatarVersion }} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-1 text-sm">
                      <span className="truncate font-medium text-ink">{name}</span>
                      {user.id === meId && <span className="shrink-0 text-faint">· {t('rooms.you')}</span>}
                      {group && user.id === room?.managerId && <span className="shrink-0 text-faint" data-testid="room-manager">· {t('rooms.info.manager')}</span>}
                    </span>
                    {p?.title && <span className="block truncate text-xs text-muted">{p.title}</span>}
                  </span>
                  {mayRemove && user.id !== meId && (
                    <MenuButton
                      label={t('rooms.info.memberMenu', { name })}
                      testId="room-member-menu"
                      // computers: on hover or focus, like a message's "…" (one per row would repeat down the list);
                      // touch screens: always there
                      buttonClassName="pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                      items={[{ label: t('rooms.info.remove'), icon: <UserMinus size={14} aria-hidden />, danger: true, onSelect: () => void remove(user.id, name), testId: 'room-member-remove' }]}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {group && (
          <button type="button" onClick={() => void leave()} className={clsx(row, 'py-3 text-sm font-medium text-danger hover:bg-hover')} data-testid="room-leave">
            {t('rooms.info.leave')}
          </button>
        )}
      </div>
    </Modal>
  )
}

/** The room's name, a tap away from editing it: Enter or 저장 saves, Esc or 취소 puts it back. Empty goes back to the
 * server's name (a team room's group, the everyone room's word, a group chat's members). */
function NameRow({ room }: { room: Room }) {
  const t = useT()
  const locale = useLocale()
  const titleOf = useRoomTitle()
  const title = titleOf(room)
  const me = useMe()
  // what an empty name shows: the members' names, the everyone room's word, the group's name
  const fallback = room.kind === 'team' ? (me?.groups.find((g) => g.id === room.groupId)?.name ?? '') : titleOf({ ...room, name: null })
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (draft === null || busy) return
    const next = draft.trim()
    if (next === (room.name ?? '')) return setDraft(null)
    setBusy(true)
    try {
      await useRooms.getState().rename(room.id, next || null)
      setDraft(null)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(false)
    }
  }
  if (draft === null)
    return (
      <button type="button" onClick={() => setDraft(room.name ?? '')} className="group flex w-full items-center gap-2 px-5 py-3 text-left hover:bg-hover max-sm:px-4" data-testid="room-name" aria-label={`${t('rooms.info.rename')}: ${title}`}>
        <span className="min-w-0 flex-1 truncate text-base font-medium text-ink">{title}</span>
        <Pencil size={14} className="shrink-0 text-faint group-hover:text-ink" aria-hidden />
      </button>
    )
  return (
    <form
      className="px-5 py-3 max-sm:px-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="block">
        <span className="sr-only">{t('rooms.info.nameLabel')}</span>
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
          placeholder={fallback}
          className={inputCls}
          data-testid="room-name-input"
        />
      </label>
      <div className="mt-2 flex items-center gap-2">
        <p className="mr-auto text-xs text-muted">{room.kind === 'group' ? t('rooms.info.nameHintGroup') : t('rooms.info.nameHintTeam')}</p>
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" type="submit" busy={busy} data-testid="room-name-save">
          {t('common.save')}
        </Button>
      </div>
    </form>
  )
}
