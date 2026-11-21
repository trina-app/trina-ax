// "새 대화": the team's people (GET /api/people) and the channels (a group's team room, listed under the Chats list's
// "Channels" word, with the channel's own member count as its header says it) with a search box; tick people (a group ticks its people
// now: a snapshot, the chat does not follow the group later, docs/DECISIONS.md "그룹 대화와 방 이름"). One person: our
// DM (POST /api/rooms, the existing one when there is one); two or more: a new group chat of me and them, with an
// optional name that shows only then. The same list invites people into a group chat (mode invite: the people in it
// are left out), and a DM's "초대하기" opens it with the other person ticked (a new group chat; the DM stays). A
// bottom sheet on phones (Modal), the action in its footer. Its first row is "Invite a guest" for everyone but a guest:
// in a group chat's add list for that chat, in "New conversation" it picks the group chat or project first
// (components/GuestInviteChoice.tsx GuestInviteFlow; docs/DECISIONS.md "Guests from Invite people").
// Create a channel has one more row under its name for whoever may make team projects: "Make it a project"
// (docs/decisions/20261121-create-channel-as-project.md). Ticked, the people picked get a new team project at once, made
// as "New project with" makes one (POST /api/projects scope team with them, then its room opened listed, ?listed=1),
// never a channel converted afterwards; the name follows the project rules (a reserved name, the "-2" hint when a team
// project I see has the folder), and guests the project rules (one in another project is greyed out; a private channel
// takes none).
import clsx from 'clsx'
import { Check, Hash, Search } from 'lucide-react'
import { Fragment, useEffect, useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ROOM_GROUP_MAX, ROOM_NAME_MAX } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { usePeople, usePeopleList } from '../../store/people'
import { navigateTo } from '../../lib/nav'
import { readProjectList, useProjects } from '../../store/projects'
import { useRooms } from '../../store/rooms'
import { mayMakeTeamProject, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { Avatar } from '../Avatar'
import { ListRow } from '../list/List'
import { Button, ErrorNote, inputCls, Modal, Skeleton } from '../ui'
import { elsewhereText, GuestInviteDialog, guestElsewhere, InviteGuestRow, MakeMemberButton, OnePlaceNote, onePlaceOf } from '../GuestInvite'
import { GuestInviteFlow } from '../GuestInviteChoice'
import { GuestTagFor } from '../GuestTag'
import { isGuestMe, personIsGuest } from '../../lib/guests'
import { isAdmin } from '../../store/session'
import { useFreeRoam } from '../../store/demo'
import { useRoomTitle } from './RoomIcon'
import { isPrivateChannel, isProjectRoom } from '../../lib/rooms'
import { projectNameProblem, steppedProjectFolder } from './MakeProjectDialog'

/** `new`: New message (no name: one person opens the DM, two or more the group DM of those people, made or reopened);
 * `channel`: Create a channel (a name is required: a private channel); `invite`: add people to a room
 * (docs/decisions/20261117-named-groups-private-channels.md). */
export type PickerMode = { kind: 'new'; preselect?: string[] } | { kind: 'channel' } | { kind: 'invite'; roomId: string }

export function PeoplePicker({ open, onClose, mode = { kind: 'new' } }: { open: boolean; onClose: () => void; mode?: PickerMode }) {
  if (!open) return null
  return <PeopleDialog onClose={onClose} mode={mode} />
}

interface PickGroup { id: string; name: string; memberIds: string[] }

/** The groups the caller can see in the app today: every group for the owner and admins (Admin › Groups), else the
 * groups they are in, with the people of each one's team room (its members are the group's active people). */
function usePickerGroups(): PickGroup[] | null {
  const me = useMe()
  const role = me?.user.role
  const mine = me?.groups
  // a member's groups are found by their team rooms: read again once the rooms list is there (the picker can open
  // before it, from /rooms?new=1)
  const teamRooms = useRooms((s) => s.rooms.filter((r) => r.kind === 'team').map((r) => `${r.groupId}:${r.id}`).sort().join(','))
  const [groups, setGroups] = useState<PickGroup[] | null>(null)
  useEffect(() => {
    let live = true
    const load = async (): Promise<PickGroup[]> => {
      if (role === 'owner' || role === 'admin') return (await api.call(API.listGroups)).items.map((g) => ({ id: g.id, name: g.name, memberIds: g.memberIds }))
      const rooms = useRooms.getState().rooms
      const out = await Promise.all((mine ?? []).map(async (g) => {
        const room = rooms.find((r) => r.kind === 'team' && r.groupId === g.id)
        if (!room) return null
        const m = await api.call(API.listRoomMembers, { params: { id: room.id } })
        return { id: g.id, name: g.name, memberIds: m.items.map((x) => x.user.id) }
      }))
      return out.filter((g): g is PickGroup => !!g)
    }
    load().then((g) => live && setGroups(g), () => live && setGroups([]))
    return () => {
      live = false
    }
  }, [role, mine, teamRooms])
  return groups
}

function PeopleDialog({ onClose, mode }: { onClose: () => void; mode: PickerMode }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const meId = me?.user.id
  const people = usePeopleList()
  const failed = usePeople((s) => s.failed)
  const groups = usePickerGroups()
  const navigate = useNavigate()
  const inviting = mode.kind === 'invite' ? mode.roomId : null
  const channel = mode.kind === 'channel'
  const room = useRooms((s) => (inviting ? s.rooms.find((r) => r.id === inviting) : undefined))
  const inRoom = useRooms((s) => (inviting ? s.members[inviting] : undefined))
  useEffect(() => {
    if (inviting) void useRooms.getState().loadMembers(inviting)
  }, [inviting])
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>(() => (mode.kind === 'new' ? (mode.preselect ?? []).filter((id) => id !== meId) : []))
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  // "Invite a guest" (components/GuestInvite.tsx): a group chat's add list only, for anyone in it but a guest; the
  // dialog takes this one's place
  const [guestInvite, setGuestInvite] = useState(false)
  // a guest picked here is in another group chat already (409 guest_one_place): said under their row (or over the list)
  const [onePlace, setOnePlace] = useState<{ guestId?: string } | null>(null)
  // a free-roam demo: no guest invites (server/src/demo/guard.ts refuses them)
  const freeRoam = useFreeRoam()
  const mayInviteGuest = !freeRoam && !!room && room.kind === 'group' && !isProjectRoom(room) && !isGuestMe(me)
  // "New conversation" (no room yet): the same row, which picks the group chat or project first (GuestInviteFlow)
  const mayInviteGuestAnywhere = !freeRoam && !inviting && !isGuestMe(me)
  const roomTitle = useRoomTitle()
  // Create a channel: "Make it a project" (off by default), for whoever may make team projects
  const mayProject = channel && !freeRoam && mayMakeTeamProject(me)
  const [asProject, setAsProject] = useState(false)
  const project = mayProject && asProject
  // the team projects I see, for the taken-name hint: read afresh each time it is ticked (one made a moment ago counts)
  useEffect(() => {
    if (project) void readProjectList().catch(() => {})
  }, [project])
  const projectsById = useProjects((s) => s.byId)
  const projectsListed = useProjects((s) => s.listed)
  const typedName = name.normalize('NFC').trim()
  const nameProblem = project && typedName ? projectNameProblem(typedName) : null
  // (a channel's name is at most ROOM_NAME_MAX, under a project's limit: only a reserved name is refused)
  const nameError = nameProblem === 'nameReserved' ? t('rooms.makeProject.nameReserved') : undefined
  const nameNoteId = useId()
  const steppedFolder = useMemo(
    () => (project && typedName && !nameProblem ? steppedProjectFolder(typedName, Object.values(projectsById).filter((p) => projectsListed?.has(p.id)).map((p) => p.folderPath)) : null),
    [project, typedName, nameProblem, projectsById, projectsListed],
  )

  // who may be picked: active people (the directory has no one else), never me, never someone already in the room
  const taken = useMemo(() => new Set([meId, ...(inRoom ?? []).map((m) => m.user.id)]), [meId, inRoom])
  const others = useMemo(() => (people ?? []).filter((p) => !taken.has(p.id)), [people, taken])
  const active = useMemo(() => new Set(others.map((p) => p.id)), [others])
  // only people the list shows can stay ticked: a DM's other person whose account is gone (or anyone no longer active)
  // is dropped from what the DM's 초대하기 ticked, instead of a count with nobody to see and a refusal on sending
  useEffect(() => {
    if (people) setPicked((l) => (l.every((id) => active.has(id)) ? l : l.filter((id) => active.has(id))))
  }, [people, active])
  const needle = q.trim().toLocaleLowerCase()
  const shown = useMemo(() => {
    const hit = (s: string | undefined) => !!s && s.toLocaleLowerCase().includes(needle)
    const list = needle ? others.filter((p) => hit(p.name) || hit(p.title)) : others
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  }, [others, needle])
  // a channel's count is the one its header shows (rooms.members: the team room's memberCount, me included); a group
  // whose channel is not in my list (an owner or admin outside it) counts its active people the same way (TC-3935)
  const teamRooms = useRooms((s) => s.rooms)
  const directory = useMemo(() => new Set((people ?? []).map((p) => p.id)), [people])
  // a group ticks the people of it that can be picked now; one with nobody left to pick is not listed
  const groupRows = useMemo(() => (groups ?? [])
    .map((g) => {
      const channel = teamRooms.find((r) => r.kind === 'team' && r.groupId === g.id)
      return {
        ...g,
        // the channel's name as the Chats list shows it (a renamed channel too)
        name: channel ? roomTitle(channel) : g.name,
        ids: g.memberIds.filter((id) => active.has(id)),
        count: channel?.memberCount ?? g.memberIds.filter((id) => id === meId || directory.has(id)).length,
      }
    })
    .filter((g) => g.ids.length > 0 && (!needle || g.name.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name)), [groups, active, needle, teamRooms, directory, meId, roomTitle])

  // a guest starts 1:1 chats only (a group chat would be a second place: the server refuses it)
  const max = inviting ? ROOM_GROUP_MAX - (room?.memberCount ?? 1) : isGuestMe(me) ? 1 : ROOM_GROUP_MAX - 1
  const over = picked.length > max
  // a new group with a guest in it (ticked first, then someone else): the guest's one place is elsewhere already (a
  // project instead: a guest whose project place is free may be picked; one in another project is greyed out below)
  const groupWithGuest = !inviting && !project && (channel || picked.length >= 2) && picked.some((id) => personIsGuest(people?.find((p) => p.id === id)))
  // ticked "Make it a project" with a guest picked who is in another project: not picked any more (the row greys out)
  useEffect(() => {
    if (!project || !people) return
    const away = (id: string) => { const p = people.find((x) => x.id === id); return !!p && !!guestElsewhere(p, { kind: 'project' }) }
    setPicked((l) => (l.some(away) ? l.filter((id) => !away(id)) : l))
  }, [project, people])
  const toggle = (id: string) => { setOnePlace(null); setPicked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])) }
  const allIn = (ids: string[]) => ids.every((id) => picked.includes(id))
  const toggleGroup = (ids: string[]) => setPicked((l) => (allIn(ids) ? l.filter((x) => !ids.includes(x)) : [...l, ...ids.filter((x) => !l.includes(x))]))

  const blocked = !picked.length || over || groupWithGuest || (channel && !name.trim()) || !!nameError
  const go = async () => {
    if (busy || blocked) return
    setBusy(true)
    try {
      if (project) {
        // as "New project with" makes one: the team project with the people picked, then its room, listed
        const p = await api.call(API.createProject, { body: { name: typedName, scope: 'team', instructions: '', participants: picked.map((id) => ({ subjectType: 'user' as const, subjectId: id })) } })
        useProjects.getState().see(p)
        toast({ level: 'success', text: t('rooms.makeProject.made', { name: p.name }) })
        onClose()
        // the project is made: its room opens, or, when that fails, the project page; never a second project
        try {
          const room = await useRooms.getState().openProjectRoom(p.id, true)
          navigateTo(`/rooms/${room.id}`)
        } catch {
          navigateTo(`/projects/${p.id}`)
        }
        return
      }
      if (inviting) {
        await useRooms.getState().invite(inviting, picked)
        onClose()
        return
      }
      const r = channel ? await useRooms.getState().createGroup(picked, name) : picked.length === 1 ? await useRooms.getState().openDm(picked[0]!) : await useRooms.getState().createGroup(picked, null)
      onClose()
      navigate(`/rooms/${r.id}`)
    } catch (e) {
      // a guest already in another room or project: the owner's words, "Make team member" for admins
      const guests = picked.filter((id) => personIsGuest(people?.find((p) => p.id === id)))
      const refused = onePlaceOf(e, guests.length === 1 ? guests[0] : undefined)
      if (refused) setOnePlace(refused)
      else toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(false)
    }
  }
  if (guestInvite && room) return <GuestInviteDialog place={{ kind: 'room', id: room.id, name: roomTitle(room), privateChannel: isPrivateChannel(room) }} onClose={onClose} onCancel={() => setGuestInvite(false)} />
  if (guestInvite && !inviting) return <GuestInviteFlow onClose={onClose} onCancel={() => setGuestInvite(false)} />

  const action = inviting ? t(room && isPrivateChannel(room) ? 'rooms.info.invitePrivate' : 'rooms.info.addPeople') : project ? t('rooms.picker.createProject') : channel ? t('rooms.picker.createPrivate') : t('rooms.picker.start')
  const footer = (
    <>
      <p className={clsx('mr-auto text-sm', over || groupWithGuest ? 'text-danger' : 'text-muted')} role={over || groupWithGuest ? 'alert' : undefined} data-testid="picker-count">
        {over ? t('rooms.picker.tooMany', { max: ROOM_GROUP_MAX }) : groupWithGuest ? t('guest.onePlaceShort') : picked.length > 0 ? t('rooms.picker.selected', { n: picked.length }) : ''}
      </p>
      <Button variant="primary" disabled={blocked} busy={busy} onClick={() => void go()} data-testid="picker-go">
        {action}
      </Button>
    </>
  )
  const label = 'px-5 pt-3 pb-1 text-xs font-medium text-faint max-sm:px-4'
  // the rows' words line up with the dialog's 20px (16px on a phone)
  const list = 'px-2 max-sm:px-1'
  return (
    <Modal open onClose={onClose} title={inviting ? action : channel ? t('rooms.section.newChannel') : t('rooms.newChat')} width={420} footer={footer}>
      <div className="-mx-5 -mt-5 border-b border-line px-5 py-3 max-sm:-mx-4 max-sm:px-4">
        {/* Create a channel: its name first, labelled and required (a group DM has none: New message), then the people */}
        {channel && (
          <div className="mb-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink">{t('rooms.info.nameLabelChannel')}</span>
              <input autoFocus data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={ROOM_NAME_MAX} required aria-required aria-invalid={nameError ? true : undefined} aria-describedby={nameError || steppedFolder ? nameNoteId : undefined} className={inputCls} data-testid="picker-name" />
            </label>
            {nameError ? (
              <p id={nameNoteId} role="alert" className="mt-1 text-xs text-danger" data-testid="picker-name-error">{nameError}</p>
            ) : steppedFolder ? (
              // the folder's name is never broken at its "-2" (a word joiner after each hyphen)
              <p id={nameNoteId} className="mt-1 text-xs break-keep text-faint" data-testid="picker-name-taken">{t('rooms.makeProject.nameTaken', { name: typedName, folder: steppedFolder.replace(/-/g, '-\u2060') })}</p>
            ) : null}
          </div>
        )}
        {/* "Make it a project": the people get a shared folder and Trina; off by default */}
        {mayProject && (
          <label className="mb-3 flex cursor-pointer items-start gap-2.5 text-sm" data-testid="picker-as-project">
            <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={asProject} disabled={busy} onChange={(e) => { setOnePlace(null); setAsProject(e.target.checked) }} data-testid="picker-as-project-tick" />
            <span className="min-w-0 flex-1 break-keep">
              <span className="block font-medium text-ink">{t('rooms.picker.asProject')}</span>
              <span className="block text-muted">{t('rooms.picker.asProjectHint')}</span>
            </span>
          </label>
        )}
        <label className="relative block">
          <span className="sr-only">{t('rooms.people.search')}</span>
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
          {/* New message (and Add people): the cursor starts here, not on the dialog's Close (the dialog focuses
              [data-autofocus] first); Create a channel starts on its name */}
          <input autoFocus={!channel} data-autofocus={channel ? undefined : true} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('rooms.people.search')} className={`${inputCls} pl-9`} data-testid="people-search" />
        </label>
      </div>
      {(mayInviteGuest || mayInviteGuestAnywhere) && (
        <ul className="-mx-5 border-b border-line px-2 py-1 max-sm:-mx-4 max-sm:px-1" data-testid="picker-guest">
          <InviteGuestRow place={mayInviteGuest ? 'room' : 'any'} privateRoom={!!room && isPrivateChannel(room)} onOpen={() => setGuestInvite(true)} />
        </ul>
      )}
      {onePlace && !(onePlace.guestId && people?.some((p) => p.id === onePlace.guestId)) && <OnePlaceNote admin={isAdmin(me)} className="pt-3" />}
      {!people && <Skeleton lines={4} className="pt-4" />}
      {people && failed && !others.length && (
        <div className="pt-4">
          <ErrorNote onRetry={() => void usePeople.getState().load(true)}>{t('error.network')}</ErrorNote>
        </div>
      )}
      {people && !failed && !others.length && <p className="pt-4 text-sm text-muted">{inviting ? t('rooms.picker.allIn') : t('rooms.people.none')}</p>}
      {people && !!others.length && !shown.length && !groupRows.length && <p className="pt-4 text-sm text-muted">{t('rooms.people.noMatch')}</p>}
      {(groupRows.length > 0 || shown.length > 0) && (
        <div className="-mx-5 -mb-5 pb-2 max-sm:-mx-4">
          {groupRows.length > 0 && (
            <>
              <p className={label}>{t('rooms.section.team')}</p>
              {/* the lists' rows (components/list/List.tsx): a list of people's face box, each row the label of its tick */}
              <ul className={list} data-testid="picker-groups">
                {groupRows.map((g) => (
                  <ListRow
                    key={g.id}
                    choice
                    face
                    icon={<Hash />}
                    name={g.name}
                    meta={t('rooms.members', { n: g.count })}
                    end={<Tick checked={allIn(g.ids)} disabled={busy} onChange={() => toggleGroup(g.ids)} />}
                    testId="picker-group"
                  />
                ))}
              </ul>
              {shown.length > 0 && <p className={label}>{t('rooms.picker.people')}</p>}
            </>
          )}
          {shown.length > 0 && (
            <ul className={list} data-testid="people-list">
              {shown.map((p) => {
                // a group chat's add list: a guest in another group chat already cannot be added (a guest is in one
                // group chat and one project at most): greyed out with where they are, no tick; the owner and admins
                // get "Make team member". A new chat: a guest can be in a 1:1 chat, and in a new group only while they
                // are in no group chat, so once someone else is picked
                // ("Make it a project" ticked: a guest in another project, picked or not, as a new project's people list)
                const away = inviting ? guestElsewhere(p, { kind: 'room', id: inviting }) : project ? guestElsewhere(p, { kind: 'project' }) : picked.length && !picked.includes(p.id) ? guestElsewhere(p, { kind: 'room' }) : null
                if (away)
                  return (
                    <ListRow
                      key={p.id}
                      face
                      icon={<Avatar user={p} size="fill" />}
                      name={<span className="flex min-w-0 items-baseline gap-1.5 text-muted"><span className="truncate">{p.name}</span><GuestTagFor userId={p.id} /></span>}
                      meta={<span className="block whitespace-normal break-keep">{elsewhereText(t, away)}</span>}
                      actions={isAdmin(me) ? <MakeMemberButton guest={p} /> : undefined}
                      li={{ 'data-testid': 'people-row-elsewhere' }}
                      testId="people-row"
                    />
                  )
                return (
                <Fragment key={p.id}>
                <ListRow
                  choice
                  face
                  icon={<Avatar user={p} size="fill" />}
                  name={<span className="flex min-w-0 items-baseline gap-1.5"><span className="truncate">{p.name}</span><GuestTagFor userId={p.id} /></span>}
                  meta={p.title || undefined}
                  end={<Tick checked={picked.includes(p.id)} disabled={busy} onChange={() => toggle(p.id)} />}
                  testId="people-row"
                />
                {/* this guest is in another place already: the refusal right under their row */}
                {onePlace?.guestId === p.id && <li className="list-none pr-3 pb-2 pl-[calc(0.75rem+var(--spacing-list-face)+0.75rem)]"><OnePlaceNote guestId={p.id} admin={isAdmin(me)} /></li>}
                </Fragment>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </Modal>
  )
}

/** A round tick at the end of a row: a real checkbox (keyboard, screen readers), drawn as a circle that fills with the
 * accent when ticked. */
function Tick({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <span className="relative flex size-6 shrink-0 items-center justify-center self-center">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} className="peer absolute inset-0 cursor-pointer opacity-0" data-testid="picker-tick" />
      <span aria-hidden className="flex size-5 items-center justify-center rounded-full border border-field-border text-transparent peer-checked:border-accent peer-checked:bg-accent peer-checked:text-accent-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
        <Check size={13} strokeWidth={3} />
      </span>
    </span>
  )
}
