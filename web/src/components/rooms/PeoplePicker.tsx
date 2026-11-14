// "새 대화": the team's people (GET /api/people) and groups with a search box; tick people (a group ticks its people
// now: a snapshot, the chat does not follow the group later, docs/DECISIONS.md "그룹 대화와 방 이름"). One person: our
// DM (POST /api/rooms, the existing one when there is one); two or more: a new group chat of me and them, with an
// optional name that shows only then. The same list invites people into a group chat (mode invite: the people in it
// are left out), and a DM's "초대하기" opens it with the other person ticked (a new group chat; the DM stays). A
// bottom sheet on phones (Modal), the action in its footer.
import clsx from 'clsx'
import { Check, Hash, Search } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ROOM_GROUP_MAX, ROOM_NAME_MAX } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { usePeople, usePeopleList } from '../../store/people'
import { useRooms } from '../../store/rooms'
import { useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { Avatar } from '../Avatar'
import { ListRow } from '../list/List'
import { Button, ErrorNote, inputCls, Modal, Skeleton } from '../ui'
import { elsewhereText, GuestInviteDialog, guestElsewhere, InviteGuestRow, MakeMemberButton, OnePlaceNote, onePlaceOf } from '../GuestInvite'
import { GuestTagFor } from '../GuestTag'
import { isGuestMe, personIsGuest } from '../../lib/guests'
import { isAdmin } from '../../store/session'
import { useRoomTitle } from './RoomIcon'

export type PickerMode = { kind: 'new'; preselect?: string[] } | { kind: 'invite'; roomId: string }

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
  // a guest picked here is in another place already (409 guest_one_place): said under their row (or over the list)
  const [onePlace, setOnePlace] = useState<{ guestId?: string } | null>(null)
  const mayInviteGuest = !!room && room.kind === 'group' && !isGuestMe(me)
  const roomTitle = useRoomTitle()

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
  // a group ticks the people of it that can be picked now; one with nobody left to pick is not listed
  const groupRows = useMemo(() => (groups ?? [])
    .map((g) => ({ ...g, ids: g.memberIds.filter((id) => active.has(id)) }))
    .filter((g) => g.ids.length > 0 && (!needle || g.name.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name)), [groups, active, needle])

  // a guest starts 1:1 chats only (a group chat would be a second place: the server refuses it)
  const max = inviting ? ROOM_GROUP_MAX - (room?.memberCount ?? 1) : isGuestMe(me) ? 1 : ROOM_GROUP_MAX - 1
  const over = picked.length > max
  const toggle = (id: string) => { setOnePlace(null); setPicked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])) }
  const allIn = (ids: string[]) => ids.every((id) => picked.includes(id))
  const toggleGroup = (ids: string[]) => setPicked((l) => (allIn(ids) ? l.filter((x) => !ids.includes(x)) : [...l, ...ids.filter((x) => !l.includes(x))]))

  const go = async () => {
    if (busy || !picked.length || over) return
    setBusy(true)
    try {
      if (inviting) {
        await useRooms.getState().invite(inviting, picked)
        onClose()
        return
      }
      const r = picked.length === 1 ? await useRooms.getState().openDm(picked[0]!) : await useRooms.getState().createGroup(picked, name)
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
  if (guestInvite && room) return <GuestInviteDialog place={{ kind: 'room', id: room.id, name: roomTitle(room) }} onClose={onClose} onCancel={() => setGuestInvite(false)} />

  const group = !inviting && picked.length >= 2
  const action = inviting ? t('rooms.picker.invite') : group ? t('rooms.picker.createGroup') : t('rooms.picker.start')
  const footer = (
    <>
      {group && (
        <label className="w-full">
          <span className="sr-only">{t('rooms.picker.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={ROOM_NAME_MAX} placeholder={t('rooms.picker.name')} className={inputCls} data-testid="picker-name" />
        </label>
      )}
      <p className={clsx('mr-auto text-sm', over ? 'text-danger' : 'text-muted')} role={over ? 'alert' : undefined} data-testid="picker-count">
        {over ? t('rooms.picker.tooMany', { max: ROOM_GROUP_MAX }) : picked.length > 0 ? t('rooms.picker.selected', { n: picked.length }) : ''}
      </p>
      <Button variant="primary" disabled={!picked.length || over} busy={busy} onClick={() => void go()} data-testid="picker-go">
        {action}
      </Button>
    </>
  )
  const label = 'px-5 pt-3 pb-1 text-xs font-medium text-faint max-sm:px-4'
  // the rows' words line up with the dialog's 20px (16px on a phone)
  const list = 'px-2 max-sm:px-1'
  return (
    <Modal open onClose={onClose} title={inviting ? t('rooms.picker.invite') : t('rooms.newChat')} width={420} footer={footer}>
      <div className="-mx-5 -mt-5 border-b border-line px-5 py-3 max-sm:-mx-4 max-sm:px-4">
        <label className="relative block">
          <span className="sr-only">{t('rooms.people.search')}</span>
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('rooms.people.search')} className={`${inputCls} pl-9`} data-testid="people-search" />
        </label>
      </div>
      {mayInviteGuest && (
        <ul className="-mx-5 border-b border-line px-2 py-1 max-sm:-mx-4 max-sm:px-1" data-testid="picker-guest">
          <InviteGuestRow place="room" onOpen={() => setGuestInvite(true)} />
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
              <p className={label}>{t('rooms.picker.groups')}</p>
              {/* the lists' rows (components/list/List.tsx): a list of people's face box, each row the label of its tick */}
              <ul className={list} data-testid="picker-groups">
                {groupRows.map((g) => (
                  <ListRow
                    key={g.id}
                    choice
                    face
                    icon={<Hash />}
                    name={g.name}
                    meta={t('rooms.picker.groupCount', { n: g.ids.length })}
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
                // a group chat's add list: a guest in another place already cannot be added (a guest is in one place
                // only): greyed out with where they are, no tick; the owner and admins get "Make team member"
                const away = inviting ? guestElsewhere(p, { kind: 'room', id: inviting }) : null
                if (away)
                  return (
                    <ListRow
                      key={p.id}
                      face
                      icon={<Avatar user={p} size="fill" />}
                      name={<span className="flex min-w-0 items-baseline gap-1.5 text-muted"><span className="truncate">{p.name}</span><GuestTagFor userId={p.id} /></span>}
                      meta={<span className="block whitespace-normal break-keep">{elsewhereText(t, away)}</span>}
                      actions={isAdmin(me) ? <MakeMemberButton guestId={p.id} /> : undefined}
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
