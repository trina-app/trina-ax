// Who is in a room (GET /api/rooms/:id/members: names only, never anyone's read position), with their photo and title
// from the people directory. A bottom sheet on phones (Modal).
import type { RoomMember } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { usePeople } from '../../store/people'
import { Avatar } from '../Avatar'
import { Modal, Skeleton } from '../ui'

export function MembersDialog({ open, onClose, members, meId }: { open: boolean; onClose: () => void; members: RoomMember[] | undefined; meId: string | null }) {
  const t = useT()
  const byId = usePeople((s) => s.byId)
  const sorted = members ? [...members].sort((a, b) => Number(b.user.id === meId) - Number(a.user.id === meId) || a.user.name.localeCompare(b.user.name)) : null
  return (
    <Modal open={open} onClose={onClose} title={sorted ? `${t('rooms.membersTitle')} · ${sorted.length}` : t('rooms.membersTitle')} width={400}>
      {!sorted ? (
        <Skeleton lines={4} />
      ) : (
        <ul className="-mx-5 -my-5 divide-y divide-line" data-testid="room-members">
          {sorted.map(({ user }) => {
            const p = byId[user.id]
            return (
              <li key={user.id} className="flex items-center gap-3 px-5 py-2.5">
                <Avatar user={{ ...user, avatarVersion: p?.avatarVersion }} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {user.name}
                    {user.id === meId && <span className="font-normal text-faint"> · {t('rooms.you')}</span>}
                  </span>
                  {p?.title && <span className="block truncate text-xs text-muted">{p.title}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
