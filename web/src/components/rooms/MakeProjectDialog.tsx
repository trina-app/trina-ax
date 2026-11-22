// "Make it a project" (docs/decisions/20261121-make-project-from-room.md; plan docs/AGENTS/plan/
// 20261121-0619-structure-polish.md A): a group chat (a named private channel or an unnamed group chat) becomes a new
// team project. One dialog, nothing else to choose: the project's name (the conversation's name, or for an unnamed one
// "New project", selected: MakeProjectInfo.suggestedName; an emptied field says "Enter a project name."), what happens
// (its N members become the project's people, its files move to {folder name} › Chat attachments, the "-2" one when
// another project has the name, people added later see messages from now on, and they can open these files), the "-2"
// note when another project has the name, how many files stay in the conversation only, and a guest who holds
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
import { isFileListName, type MakeProjectInfo, type UserRef } from '@mycel/shared/api'
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
/** 409 already_project: someone made the conversation a project a moment ago; their project's id when I read it */
const alreadyOf = (e: unknown): { projectId: string | null } | null =>
  conflictOf(e) === 'already_project' && e instanceof ApiError ? { projectId: typeof e.body.params?.projectId === 'string' ? e.body.params.projectId : null } : null

/** A name as the server checks it (NFC, trimmed). */
const clean = (name: string) => name.normalize('NFC').trim()

/** Why a name cannot be a new project's, as the server's make-project read says it (server/src/rooms/make-project.ts
 * nameError), for the DM dialog, which has no read: too long, or an AI instructions file's or the file list's name.
 * An empty name turns the button off and says "Enter a project name." in the dialog, as in the convert dialog. */
export function projectNameProblem(name: string): 'nameLong' | 'nameReserved' | null {
  const n = clean(name)
  if ([...n].length > PROJECT_NAME_MAX) return 'nameLong'
  if (/^(CLAUDE|AGENTS|GEMINI|SKILL)\.md$/i.test(n) || isFileListName(n)) return 'nameReserved'
  return null
}

/** A name as the server compares folder names (server/src/policy/names.ts foldKey). */
const foldKey = (s: string) => s.normalize('NFKC').toLowerCase().normalize('NFKC')

/** The folder a new team project called `name` gets when a project the person sees has projects/<name> already: the
 * "-2" one, stepped as the server steps it (server/src/chat/projects.ts projectFolderName), over `folders` (the
 * projects/ folders of the team projects the person sees); null when none of them has it. A folder of a project they
 * cannot see may step it too, unsaid, as the make-project read keeps it (server/src/rooms/make-project.ts). */
export function steppedProjectFolder(name: string, folders: readonly string[]): string | null {
  const base = clean(name)
  if (!base) return null
  const used = new Set(folders.map((p) => p.split('/')).filter((s) => s.length === 2 && foldKey(s[0]!) === 'projects').map((s) => foldKey(s[1]!)))
  if (!used.has(foldKey(base))) return null
  let out = base
  for (let i = 2; used.has(foldKey(out)); i++) out = `${base}-${i}`
  return out
}

/** The Chat attachments folder's name in my language (the server makes it in the team's; the screen shows it in mine
 * everywhere: chatFilesWord). */
function useChatFolder() {
  return CHAT_FILES_FOLDER[useLocale()] ?? CHAT_FILES_FOLDER.en
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
  // 409 not_convertible: it is not a group chat any more (archived, made a project elsewhere): nothing to make
  const [gone, setGone] = useState(false)
  // 409 already_project: another person just made it a project (TC-6731): said so, with a link to the project
  const [already, setAlready] = useState<{ projectId: string | null } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const hintId = useId()
  // each read in turn: an older answer never replaces a newer one
  const life = useRef(0)
  const read = async (typed?: string): Promise<MakeProjectInfo | null> => {
    const n = ++life.current
    try {
      const x = await api.call(API.makeProjectInfo, { params: { id: roomId }, query: typed === undefined ? {} : { name: typed } })
      if (n !== life.current) return null
      setInfo(x)
      // an earlier error (a 429, a dropped connection) is over
      setError(null)
      setChecked(clean(typed ?? x.suggestedName))
      // the first read fills the field with the suggestion
      setName((cur) => cur ?? x.suggestedName.slice(0, PROJECT_NAME_MAX))
      return x
    } catch (e) {
      if (n !== life.current) return null
      if (conflictOf(e) === 'not_convertible') setGone(true)
      const a = alreadyOf(e)
      if (a) { setAlready(a); setGone(true); return null }
      setError(errorText(e, locale, t('error.network')))
      return null
    }
  }
  useEffect(() => void read(), [roomId])
  // the name's checks follow the field (a short pause after the last key)
  useEffect(() => {
    if (name === null || !info || clean(name) === checked) return
    const id = setTimeout(() => void read(clean(name)), 250)
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
  const typed = clean(name ?? '')
  const blocked = info?.guestsBlocked ?? []
  // the checks shown only for what is in the field now (the next read follows the typing)
  // (against the trimmed field: a re-read after a 409 answers for the trimmed name)
  const fresh = checked === typed
  // an emptied field says why the button is off (QA TC-6954); the server's checks for anything typed
  const nameError = name !== null && !typed ? t('rooms.makeProject.nameEmpty') : fresh && typed ? info?.nameError : undefined
  const ready = !!info && !!typed && !nameError && !blocked.length && !gone
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
        const x = await read(typed)
        // a guest took another place, yet the read shows no one blocked (it changed again): the server's words
        if (why === 'guest_one_place' && x && !x.guestsBlocked.length) setError(errorText(e, locale, t('error.network')))
      } else {
        if (why === 'not_convertible') setGone(true)
        const a = alreadyOf(e)
        if (a) { setAlready(a); setGone(true) } else setError(errorText(e, locale, t('error.network')))
      }
      setBusy(false)
    }
  }
  const stay = info ? stayCounts(info) : { unseen: 0, copies: 0, other: 0 }
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
            {/* the folder the project gets: the "-2" one the hint names when another project has the name (QA TC-6953) */}
            <p data-testid="make-project-body">{t('rooms.makeProject.body', { n: info.members.length, name: (fresh && info.nameTaken && info.folderName) || typed || '…', folder })}</p>
            <p data-testid="make-project-later">{t('rooms.makeProject.laterFiles')}</p>
            {/* each reason in its own line (QA TC-7046): copies of team files stay so later people don't get them; the
                rest because not everyone here sees them */}
            {stay.unseen > 0 && <p data-testid="make-project-staying">{t('rooms.makeProject.staying', { n: stay.unseen })}</p>}
            {stay.copies > 0 && <p data-testid="make-project-staying-copies">{t('rooms.makeProject.stayingCopies', { n: stay.copies })}</p>}
            {stay.other > 0 && <p data-testid="make-project-staying-other">{t('rooms.makeProject.stayingOther', { n: stay.other })}</p>}
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
      {already && (
        <p role="alert" className="mt-2 text-sm text-ink" data-testid="make-project-already">
          {t('rooms.makeProject.already')}
          {already.projectId && (
            <>
              {' '}
              <Link to={`/projects/${already.projectId}`} onClick={onClose} className="font-medium text-accent-text underline-offset-2 hover:underline" data-testid="make-project-already-link">
                {t('rooms.makeProject.alreadyOpen')}
              </Link>
            </>
          )}
        </p>
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
  const typed = clean(name)
  const problem = projectNameProblem(name)
  const nameError = !typed ? t('rooms.makeProject.nameEmpty') : problem === 'nameLong' ? t('rooms.makeProject.nameLong', { n: PROJECT_NAME_MAX }) : problem === 'nameReserved' ? t('rooms.makeProject.nameReserved') : undefined
  const make = async () => {
    if (!typed || problem || busy) return
    setBusy(true)
    setError(null)
    let p
    try {
      p = await api.call(API.createProject, { body: { name: typed, scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: peer.id }] } })
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
      setBusy(false)
      return
    }
    useProjects.getState().see(p)
    toast({ level: 'success', text: t('rooms.makeProject.made', { name: p.name }) })
    onClose()
    // the project is made: its room opens, or, when that fails, the project page (whose Chat room opens it); never a
    // second try that would make a second project
    try {
      const room = await useRooms.getState().openProjectRoom(p.id, true)
      navigateTo(`/rooms/${room.id}`)
    } catch {
      navigateTo(`/projects/${p.id}`)
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
          <Button variant="primary" busy={busy} disabled={!typed || !!problem} onClick={() => void make()} data-testid="make-project-confirm">
            {t('rooms.makeProject.confirm')}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void make() }} className="space-y-3 text-sm break-keep" data-testid="make-project">
        <Field label={t('rooms.makeProject.name')} error={nameError}>
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

/** The files that stay, by why (QA TC-7046): copies of files from a folder, others, and the rest because not everyone
 * here sees them (an older server sends only the total: all of it that last one, as it said before). */
export function stayCounts(info: Pick<MakeProjectInfo, 'filesStaying' | 'filesStayingCopies' | 'filesStayingOther'>): { unseen: number; copies: number; other: number } {
  const copies = info.filesStayingCopies ?? 0, other = info.filesStayingOther ?? 0
  return { unseen: Math.max(0, info.filesStaying - copies - other), copies, other }
}
