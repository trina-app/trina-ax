// A private channel linked to a team project (docs/decisions/20261119-channel-project-link.md): the channel info's
// Project row (MembersDialog.tsx) with its Link to a project picker, and the project page's Link a channel picker
// (pages/Projects.tsx ProjectChannelBox). One project per channel and one channel per project: the pickers list only
// what may be linked (Project.canLinkChannel, Room.canLinkProject without a project); a race the server refuses says
// so without naming the other channel. Each link asks first: who sees what changes (S2).
import { Folder, Lock, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Project, Room } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { toast } from '../../store/ui'
import { isPrivateChannel } from '../../lib/rooms'
import { ListRow } from '../list/List'
import { Button, confirmDialog, inputCls, Modal, Skeleton, TextAction } from '../ui'
import { useRoomTitle } from './RoomIcon'

/** The confirm before a link (S2): what changes for whom. `members`: how many see the project (Project.audience). */
export async function confirmLink(t: ReturnType<typeof useT>, title: string, members: number | undefined): Promise<boolean> {
  return confirmDialog({
    title,
    body: (
      <span className="block space-y-2">
        <span className="block">{t('rooms.linkProject.confirmBody')}</span>
        {members !== undefined && members > 0 && <span className="block">{t('rooms.linkProject.confirmMembers', { n: members })}</span>}
      </span>
    ),
    confirm: t('rooms.linkProject.confirm'),
  })
}

/** The channel info's Project row: the linked project (its name opens it) with Unlink for who may, "Not linked" with
 * Link to a project, or nothing (not a private channel, or a link this viewer cannot see). */
export function RoomProjectRow({ room, onGo }: { room: Room; onGo?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [picking, setPicking] = useState(false)
  const project = room.project
  if (!isPrivateChannel(room) || (!project && !room.canLinkProject)) return null
  const unlink = async () => {
    if (!project) return
    const ok = await confirmDialog({ title: t('rooms.info.projectUnlinkTitle', { name: project.name }), body: t('rooms.info.projectUnlinkBody'), confirm: t('rooms.info.projectUnlink'), danger: true })
    if (!ok) return
    try {
      await useRooms.getState().unlinkProject(room.id)
      toast({ level: 'success', text: t('rooms.info.projectUnlinkedToast', { name: project.name }) })
    } catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) }
  }
  return (
    <div className="flex min-h-12 items-center gap-3 px-5 py-2 text-sm max-sm:px-4" data-testid="room-info-project">
      <span className="w-16 shrink-0 text-muted">{t('rooms.info.project')}</span>
      {project ? (
        <Link to={`/projects/${project.id}`} onClick={onGo} aria-label={t('rooms.info.projectOpen', { name: project.name })} className="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-ink hover:underline" data-testid="room-info-project-name">
          <Folder size={15} className="shrink-0 text-accent-text" aria-hidden />
          <span className="truncate">{project.name}</span>
        </Link>
      ) : (
        <span className="min-w-0 flex-1 truncate text-faint" data-testid="room-info-project-none">{t('rooms.info.projectNone')}</span>
      )}
      {project
        ? project.canSave && <TextAction tone="danger" className="shrink-0" onClick={() => void unlink()} data-testid="room-info-project-unlink">{t('rooms.info.projectUnlink')}</TextAction>
        : <TextAction className="shrink-0" onClick={() => setPicking(true)} data-testid="room-info-project-link">{t('rooms.info.projectLink')}</TextAction>}
      {picking && <LinkProjectDialog room={room} onClose={() => setPicking(false)} />}
    </div>
  )
}

/** A search box over a list, in one dialog (both pickers). */
function PickerShell({ title, search, q, setQ, children, testId }: { title: string; search: string; q: string; setQ: (s: string) => void; children: React.ReactNode; testId: string }) {
  return (
    <div data-testid={testId}>
      <label className="relative block">
        <span className="sr-only">{search}</span>
        <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
        <input autoFocus data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={search} aria-label={title} className={`${inputCls} pl-9`} data-testid="link-picker-search" />
      </label>
      <div className="-mx-5 mt-2 -mb-5 pb-2 max-sm:-mx-4">{children}</div>
    </div>
  )
}

const hit = (needle: string, s: string) => !needle || s.toLocaleLowerCase().includes(needle)

/** Link to a project, from the channel: my team projects that may get a channel (Project.canLinkChannel). */
export function LinkProjectDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api.call(API.listProjects).then((r) => live && setProjects(r.items.filter((p) => p.canLinkChannel)), () => live && setProjects([]))
    return () => { live = false }
  }, [])
  const needle = q.trim().toLocaleLowerCase()
  const shown = useMemo(() => (projects ?? []).filter((p) => hit(needle, p.name)), [projects, needle])
  const pick = async (p: Project) => {
    if (busy) return
    if (!(await confirmLink(t, t('rooms.linkProject.confirmTitle', { name: p.name }), p.audience))) return
    setBusy(true)
    try {
      await useRooms.getState().linkProject(room.id, p.id)
      toast({ level: 'success', text: t('rooms.info.projectLinkedToast', { name: p.name }) })
      onClose()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('rooms.info.projectLink')} width={420}>
      <PickerShell title={t('rooms.info.projectLink')} search={t('rooms.linkProject.search')} q={q} setQ={setQ} testId="link-project-picker">
        {!projects && <Skeleton lines={3} className="px-5 pt-2" />}
        {projects && !projects.length && (
          <div className="px-5 pt-2 text-sm text-muted max-sm:px-4" data-testid="link-project-empty">
            <p>{t('rooms.linkProject.empty')}</p>
            <Link to="/projects" onClick={onClose} className="mt-2 inline-block font-medium text-accent-text hover:underline">{t('rooms.linkProject.toProjects')}</Link>
          </div>
        )}
        {projects && !!projects.length && !shown.length && <p className="px-5 pt-2 text-sm text-muted max-sm:px-4">{t('rooms.linkProject.noMatch')}</p>}
        <ul className="px-2 max-sm:px-1">
          {shown.map((p) => (
            <ListRow key={p.id} onClick={() => void pick(p)} disabled={busy} icon={<Folder className="text-accent-text" />} name={p.name} nameTitle={p.name} testId="link-project-row" />
          ))}
        </ul>
      </PickerShell>
    </Modal>
  )
}

/** Link a channel, from the project page: my private channels that may be linked and have no project. */
export function LinkChannelDialog({ project, onClose, onCreate, onLinked }: { project: Project; onClose: () => void; onCreate: () => void; onLinked: () => void }) {
  const t = useT()
  const locale = useLocale()
  const title = useRoomTitle()
  const rooms = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  useEffect(() => { if (!useRooms.getState().loaded) void useRooms.getState().loadRooms().catch(() => {}) }, [])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const free = useMemo(() => rooms.filter((r) => isPrivateChannel(r) && r.canLinkProject && !r.project), [rooms])
  const needle = q.trim().toLocaleLowerCase()
  const shown = free.filter((r) => hit(needle, title(r)))
  const pick = async (r: Room) => {
    if (busy) return
    if (!(await confirmLink(t, t('projects.channel.linkConfirmTitle', { channel: title(r), project: project.name }), project.audience))) return
    setBusy(true)
    try {
      await useRooms.getState().linkProject(r.id, project.id, 'project')
      toast({ level: 'success', text: t('rooms.info.projectLinkedToast', { name: project.name }) })
      onLinked()
      onClose()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('projects.channel.linkTitle')} width={420}>
      <PickerShell title={t('projects.channel.linkTitle')} search={t('projects.channel.linkSearch')} q={q} setQ={setQ} testId="link-channel-picker">
        {!loaded && <Skeleton lines={3} className="px-5 pt-2" />}
        {loaded && !free.length && (
          <div className="px-5 pt-2 text-sm text-muted max-sm:px-4" data-testid="link-channel-empty">
            <p>{t('projects.channel.linkEmpty')}</p>
            <Button size="sm" className="mt-3" onClick={() => { onClose(); onCreate() }} data-testid="link-channel-create">{t('projects.channel.create')}</Button>
          </div>
        )}
        {loaded && !!free.length && !shown.length && <p className="px-5 pt-2 text-sm text-muted max-sm:px-4">{t('rooms.people.noMatch')}</p>}
        <ul className="px-2 max-sm:px-1">
          {shown.map((r) => (
            <ListRow key={r.id} onClick={() => void pick(r)} disabled={busy} icon={<Lock />} name={title(r)} nameTitle={title(r)} meta={t('rooms.members', { n: r.memberCount })} testId="link-channel-row" />
          ))}
        </ul>
      </PickerShell>
    </Modal>
  )
}
