// "Make it a project" (docs/decisions/20261121-make-project-from-room.md; plan docs/AGENTS/plan/
// 20261121-0619-structure-polish.md A): a group chat (a named private channel or an unnamed group chat) becomes a new
// team project. One dialog, nothing else to choose: the project's name (the conversation's name, or for an unnamed one
// the names its row shows: MakeProjectInfo.suggestedName), what happens (its N members become the project's people, its
// files move to {name} › Chat attachments, people added later see messages from now on, and they can open these files),
// the "-2" note when another project has the name, how many files stay in the conversation only, and a guest who holds
// another place blocks it (an admin gets a link to them in Admin, a member is told to ask an admin). The read
// (GET /api/rooms/:id/make-project) is asked again as the name is typed (its checks: the folder name, a name another
// project has, a name a project may not have) and after the server says the people changed (409 members_changed).
// A 1:1 DM gets "New project with {name}" instead: the same dialog with the two people, which makes a new team project
// (POST /api/projects team) and opens its chat room (POST /api/projects/:id/room); the DM stays as it is.
// Opened from a conversation's "⋯" (RoomMenu.tsx: its header, a row of the list, the phone's long-press sheet), so the
// dialog lives in a host mounted once (App.tsx), as Add conversations does: the menu that opened it may be gone.
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CHAT_FILES_FOLDER } from '@mycel/shared'
import { DEFAULT_LOCALE, type MakeProjectInfo, type UserRef } from '@mycel/shared/api'
import { create } from 'zustand'
import { api, API, ApiError, errorText } from '../../lib/api'
import { navigateTo } from '../../lib/nav'
import { useLocale, useT } from '../../i18n'
import { useProjects } from '../../store/projects'
import { useRooms } from '../../store/rooms'
import { isAdmin, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { guestAdminPath } from '../GuestInvite'
import { PROJECT_NAME_MAX } from '../NewProjectDialog'
import { Button, Field, Modal, Skeleton, inputCls } from '../ui'

/** What the host shows: a group chat to convert, or a DM's other person to make a new project with. */
type Ask = { kind: 'room'; roomId: string } | { kind: 'dm'; peer: UserRef }
const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }))
/** Open "Make it a project" for a group chat */
export const openMakeProject = (roomId: string) => useAsk.setState({ ask: { kind: 'room', roomId } })
/** Open "New project with {name}" for a 1:1 DM's other person */
export const openDmProject = (peer: UserRef) => useAsk.setState({ ask: { kind: 'dm', peer } })
const close = () => useAsk.setState({ ask: null })

/** Mounted once (App.tsx). */
export function MakeProjectHost() {
  const ask = useAsk((s) => s.ask)
  if (!ask) return null
  return ask.kind === 'room' ? <MakeProjectDialog key={ask.roomId} roomId={ask.roomId} onClose={close} /> : <DmProjectDialog key={ask.peer.id} peer={ask.peer} onClose={close} />
}

/** The reason of a 409 (ApiError params.reason), or its code. */
const conflictOf = (e: unknown): string | null => (e instanceof ApiError && e.status === 409 ? String(e.body.params?.reason ?? e.code) : null)

/** The Chat attachments folder's name in the team's language (the folder the server makes). */
function useChatFolder() {
  const team = useMe()?.team.defaultLocale
  return CHAT_FILES_FOLDER[team ?? DEFAULT_LOCALE]
}

export function MakeProjectDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const admin = isAdmin(me)
  const folder = useChatFolder()
  const [info, setInfo] = useState<MakeProjectInfo | null>(null)
  const [name, setName] = useState<string | null>(null)
  // the name the last read answered for (its folder name, nameTaken, nameError)
  const [checked, setChecked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const hintId = useId()
  // each read in turn: an older answer never replaces a newer one
  const life = useRef(0)
  const read = async (typed?: string) => {
    const n = ++life.current
    try {
      const x = await api.call(API.makeProjectInfo, { params: { id: roomId }, query: typed === undefined ? {} : { name: typed } })
      if (n !== life.current) return
      setInfo(x)
      setChecked(typed ?? x.suggestedName)
      // the first read fills the field with the suggestion
      setName((cur) => cur ?? x.suggestedName.slice(0, PROJECT_NAME_MAX))
    } catch (e) {
      if (n === life.current) setError(errorText(e, locale, t('error.network')))
    }
  }
  useEffect(() => void read(), [roomId])
  // the name's checks follow the field (a short pause after the last key)
  useEffect(() => {
    if (name === null || !info || name === checked) return
    const id = setTimeout(() => void read(name), 250)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])
  // the field gets the focus once it has its first value, selected (one keystroke replaces it)
  const filled = name !== null
  useEffect(() => {
    if (!filled) return
    input.current?.focus()
    input.current?.select?.()
  }, [filled])
  const typed = (name ?? '').normalize('NFC').trim()
  const blocked = info?.guestsBlocked ?? []
  // the checks shown only for what is in the field now (the next read follows the typing)
  const fresh = checked === name
  const nameError = fresh && typed ? info?.nameError : undefined
  const ready = !!info && !!typed && !nameError && !blocked.length
  const make = async () => {
    if (!ready || busy || !info) return
    setBusy(true)
    setError(null)
    try {
      const r = await useRooms.getState().makeProject(roomId, typed, info.membersHash)
      useProjects.getState().see(r.project)
      toast({ level: 'success', text: t('rooms.makeProject.made', { name: r.project.name }) })
      onClose()
    } catch (e) {
      const why = conflictOf(e)
      // someone joined or left since the read, or a guest took another place: read again, the person looks again
      if (why === 'members_changed' || why === 'guest_one_place') {
        setChanged(why === 'members_changed')
        await read(typed)
      } else setError(errorText(e, locale, t('error.network')))
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('rooms.makeProject.menu')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void make()} data-testid="make-project-confirm">
            {t('rooms.makeProject.confirm')}
          </Button>
        </>
      }
    >
      {!info && !error && <Skeleton lines={3} />}
      {info && (
        <form onSubmit={(e) => { e.preventDefault(); void make() }} className="space-y-3 text-sm break-keep" data-testid="make-project">
          {changed && <p role="status" className="font-medium text-ink" data-testid="make-project-changed">{t('rooms.makeProject.changed')}</p>}
          <Field label={t('rooms.makeProject.name')} error={nameError} hint={fresh && !nameError && info.nameTaken && typed ? t('rooms.makeProject.nameTaken', { name: typed, folder: info.folderName }) : undefined}>
            <input ref={input} className={inputCls} value={name ?? ''} onChange={(e) => setName(e.target.value)} maxLength={PROJECT_NAME_MAX} aria-describedby={hintId} data-testid="make-project-name" />
          </Field>
          <div id={hintId} className="space-y-2 text-muted">
            <p data-testid="make-project-body">{t('rooms.makeProject.body', { n: info.members.length, name: typed || info.suggestedName, folder })}</p>
            <p data-testid="make-project-later">{t('rooms.makeProject.laterFiles')}</p>
            {info.filesStaying > 0 && <p data-testid="make-project-staying">{t('rooms.makeProject.staying', { n: info.filesStaying })}</p>}
          </div>
          {blocked.map((g) => (
            <p key={g.id} className="text-ink" data-testid="make-project-guest">
              {t(admin ? 'rooms.makeProject.guestFirst' : 'rooms.makeProject.guestAsk', { guest: g.name })}
              {admin && (
                <>
                  {' '}
                  <Link to={guestAdminPath(g.id)} onClick={onClose} className="font-medium text-accent-text underline-offset-2 hover:underline" data-testid="make-project-guest-link">
                    {t('rooms.makeProject.guestOpen')}
                  </Link>
                </>
              )}
            </p>
          ))}
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger" data-testid="make-project-error">
          {error}
        </p>
      )}
    </Modal>
  )
}

/** "New project with {name}" from a 1:1: a new team project of the two of us, then its chat room opens. */
export function DmProjectDialog({ peer, onClose }: { peer: UserRef; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [name, setName] = useState(peer.name.slice(0, PROJECT_NAME_MAX))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hintId = useId()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select?.()
  }, [])
  const typed = name.normalize('NFC').trim()
  const make = async () => {
    if (!typed || busy) return
    setBusy(true)
    setError(null)
    try {
      const p = await api.call(API.createProject, { body: { name: typed, scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: peer.id }] } })
      useProjects.getState().see(p)
      const room = await useRooms.getState().openProjectRoom(p.id)
      toast({ level: 'success', text: t('rooms.makeProject.made', { name: p.name }) })
      onClose()
      navigateTo(`/rooms/${room.id}`)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('rooms.makeProject.dmMenu', { name: peer.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!typed} onClick={() => void make()} data-testid="make-project-confirm">
            {t('rooms.makeProject.confirm')}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void make() }} className="space-y-3 text-sm break-keep" data-testid="make-project">
        <Field label={t('rooms.makeProject.name')}>
          <input ref={input} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={PROJECT_NAME_MAX} aria-describedby={hintId} data-testid="make-project-name" />
        </Field>
        <p id={hintId} className="text-muted" data-testid="make-project-body">{t('rooms.makeProject.dmBody', { name: peer.name })}</p>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger" data-testid="make-project-error">
          {error}
        </p>
      )}
    </Modal>
  )
}
