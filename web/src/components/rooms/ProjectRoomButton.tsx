// A team project's own chat room (docs/decisions/20261120-project-is-room.md D5), one way in from the project: the
// project page's title row (a phone: a full-width row under it), its row in the Projects list (a small chat icon with a
// dot while something is unread) and the header of the project's AI chats. The first open makes the room (POST
// /api/projects/:id/room), then /rooms/<id> opens. Only for a team project in projects/<name> that I read (not one I
// manage without being in it, not one in the trash); a personal or older project has no room.
import clsx from 'clsx'
import { ChevronRight, MessagesSquare } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Project, Room } from '@mycel/shared/api'
import { errorText } from '../../lib/api'
import { badgeText, roomCounts } from '../../lib/rooms'
import { isProjectsFolder } from '../../lib/projectFolders'
import { useLocale, useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { toast } from '../../store/ui'
import { CountPill } from '../CountPill'
import { Button, IconButton } from '../ui'

type RoomProject = Pick<Project, 'id' | 'folderPath'> & Partial<Pick<Project, 'inTrash' | 'member' | 'room'>>

/** Does this project have (or get) a chat room for me: a team project in projects/<name> I read, not in the trash. */
export const hasProjectRoom = (p: RoomProject | null | undefined): p is RoomProject =>
  !!p && isProjectsFolder(p.folderPath) && !p.inTrash && p.member !== false

/** The project's room in my list (its id, or the room whose project it is), else null */
const roomOf = (rooms: Room[], p: RoomProject | null | undefined): Room | null =>
  !p ? null : rooms.find((r) => (p.room && r.id === p.room.id) || (r.project?.room && r.project.id === p.id)) ?? null

/** The project's chat room: whether it shows, how many unread messages wait there (the room in my list, else what the
 * project said), and open (made the first time). */
export function useProjectRoom(p: RoomProject | null | undefined) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const room = useRooms((s) => roomOf(s.rooms, p))
  const [busy, setBusy] = useState(false)
  const on = hasProjectRoom(p)
  const unread = room ? room.unreadCount : (p?.room?.unread ?? 0)
  const quiet = !!room && roomCounts(room).quiet
  const open = async () => {
    if (!p || busy) return
    const known = room?.id
    if (known) return void navigate(`/rooms/${known}`)
    setBusy(true)
    try {
      const r = await useRooms.getState().openProjectRoom(p.id)
      navigate(`/rooms/${r.id}`)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(false)
    }
  }
  return { on, unread, quiet, busy, open }
}

/**
 * "Chat room" with its unread count. `look`: 'button' (the project page's title row, an AI chat's header on a
 * computer), 'row' (a phone's project page: a full-width row), 'icon' (a phone's chat bar: the icon, a dot when unread).
 */
export function ProjectRoomButton({ project, look = 'button', className, testId = 'project-room-open' }: { project: RoomProject | null | undefined; look?: 'button' | 'row' | 'icon'; className?: string; testId?: string }) {
  const t = useT()
  const r = useProjectRoom(project)
  if (!r.on) return null
  const label = r.unread > 0 ? `${t('projects.room.open')}, ${t('rooms.unread', { n: r.unread })}` : t('projects.room.open')
  const pill = r.unread > 0 && <CountPill text={badgeText(r.unread)} label={t('rooms.unread', { n: r.unread })} quiet={r.quiet} className="min-w-5 text-center tabular-nums" testId={`${testId}-unread`} />
  if (look === 'icon')
    return (
      <IconButton label={label} tip={t('projects.room.openTip')} onClick={() => void r.open()} disabled={r.busy} className={clsx('relative size-11 shrink-0', className)} data-testid={testId}>
        <MessagesSquare size={18} aria-hidden />
        {r.unread > 0 && <span className={clsx('absolute top-2 right-2 size-2 rounded-full', r.quiet ? 'bg-faint' : 'bg-accent')} aria-hidden data-testid={`${testId}-dot`} />}
      </IconButton>
    )
  if (look === 'row')
    return (
      <button type="button" onClick={() => void r.open()} disabled={r.busy} aria-label={label} className={clsx('flex min-h-12 w-full items-center gap-2.5 py-3 text-left text-sm', className)} data-testid={testId}>
        <MessagesSquare size={16} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 truncate font-medium">{t('projects.room.open')}</span>
        {pill}
        <ChevronRight size={16} className="ml-auto shrink-0 text-faint" aria-hidden />
      </button>
    )
  return (
    <Button size="sm" onClick={() => void r.open()} busy={r.busy} aria-label={label} title={t('projects.room.openTip')} className={clsx('shrink-0', className)} data-testid={testId}>
      {!r.busy && <MessagesSquare size={14} aria-hidden />} {t('projects.room.open')}
      {pill}
    </Button>
  )
}

/** The Projects list's row: a small chat icon at the row's end, with a dot while something is unread (a computer: on
 * hover and focus, always while unread; a phone: only while unread, the project page has the row). */
export function ProjectRowRoom({ project, className }: { project: RoomProject; className?: string }) {
  const t = useT()
  const r = useProjectRoom(project)
  if (!r.on) return null
  const label = r.unread > 0 ? `${t('projects.room.open')}, ${t('rooms.unread', { n: r.unread })}` : t('projects.room.open')
  return (
    <IconButton
      label={label}
      tip={t('projects.room.openTip')}
      compact
      onClick={() => void r.open()}
      className={clsx('relative hover:bg-surface', r.unread > 0 ? 'opacity-100' : 'max-md:hidden pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100 focus-visible:opacity-100', className)}
      data-testid="projects-panel-room"
    >
      <MessagesSquare size={14} aria-hidden />
      {r.unread > 0 && <span className={clsx('absolute top-0.5 right-0.5 size-1.5 rounded-full', r.quiet ? 'bg-faint' : 'bg-accent')} aria-hidden data-testid="projects-panel-room-dot" />}
    </IconButton>
  )
}
