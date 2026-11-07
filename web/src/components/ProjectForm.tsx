// The project create / edit dialog (Projects page, and "Make it a project" on a folder of the Files page). A project is
// a folder of the team folder with instructions: on an existing folder the name may stay empty, and the folder's own
// name is used. A new project on "Existing folder" needs a folder chosen (never the whole team folder: an older server
// may already have a project there, and the 409 would only confuse). A 409 that names the project already on the
// folder offers to open it.
// Editing a team project: "이 프로젝트의 채팅을 프로젝트 사람들과 공유" (shared project chats, docs/DECISIONS.md "Shared
// project chats") with what turning it on or off does; not for a personal project, a project whose folder is in the
// trash, or an older server; off while safe operations are on. An admin pointing a project with shared chats at another
// folder hears how many people will see them there.
import { useEffect, useId, useState } from 'react'
import { parentPath } from '../lib/paths'
import { Link } from 'react-router-dom'
import type { Group, Project, ProjectParticipant, User } from '@mycel/shared/api'
import { api, API, ApiError, errorText } from '../lib/api'
import { folderName, projectName } from '../lib/projectFolders'
import { useLocale, useT } from '../i18n'
import { useProjects } from '../store/projects'
import { isAdmin, useMe } from '../store/session'
import FolderPicker from './FolderPicker'
import { refusalKey } from '../lib/sharedChat'
import { Button, Field, Modal, Switch, inputCls } from './ui'

export function ProjectForm({ project, initialFolder, initialName, onClose, onSaved }: {
  project?: Project
  /** a new project on this folder (Files: "Make it a project"); the dialog starts on "Existing folder" with it chosen */
  initialFolder?: string
  initialName?: string
  onClose: () => void
  onSaved: (p: Project) => void
}) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  // an existing project's folder is changed by admins only (the server refuses it for anyone else)
  const folderLocked = !!project && !isAdmin(me)
  // new project (design tab 5): on an existing folder, a personal one (users/<me>/projects/), or, for admins, a new
  // team folder projects/<slug> with the groups / people who work in it
  const [mode, setMode] = useState<'existing' | 'personal' | 'team'>('existing')
  const [groups, setGroups] = useState<Group[]>([])
  const [people, setPeople] = useState<User[]>([])
  const [participants, setParticipants] = useState<ProjectParticipant[]>([])
  useEffect(() => {
    if (project || mode !== 'team' || !isAdmin(me)) return
    api.call(API.listGroups).then((r) => setGroups(r.items), () => setGroups([]))
    api.call(API.listUsers).then((r) => setPeople(r.items.filter((u) => u.status === 'active')), () => setPeople([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])
  const toggle = (x: ProjectParticipant) =>
    setParticipants((cur) => (cur.some((y) => y.subjectType === x.subjectType && y.subjectId === x.subjectId) ? cur.filter((y) => !(y.subjectType === x.subjectType && y.subjectId === x.subjectId)) : [...cur, x]))
  const picked = (x: ProjectParticipant) => participants.some((y) => y.subjectType === x.subjectType && y.subjectId === x.subjectId)
  const [name, setName] = useState(project?.name ?? initialName ?? '')
  const [folder, setFolder] = useState(project?.folderPath ?? initialFolder ?? '')
  /** the admin chose a folder in this dialog (also the same path again): only then does a save point the project at one */
  const [folderPicked, setFolderPicked] = useState(false)
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  // shared project chats: a team project in place, on a server that knows them (it says the audience)
  const canShare = !!project && project.audience !== undefined && !project.folderPath.startsWith('users/') && !project.inTrash
  const safeOps = !!me?.server?.allChatsConfidential
  const [shareChats, setShareChats] = useState(!!project?.shareChats)
  const shareHint = useId()
  // the folder changes in this dialog: the project's shared chats move with it, to whoever reads that folder
  const repoint = !!project && folderPicked && (folder !== project.folderPath || !!project.inTrash)
  const [picking, setPicking] = useState(false)
  /** where the picker opens: the chosen folder, or for a project whose folder is in the trash the nearest folder above
   * its old path that is there (the old path itself is missing, and the picker would open on nothing) */
  const [pickFrom, setPickFrom] = useState('')
  const openPicker = async () => {
    let at = folder
    if (project?.inTrash && !folderPicked) {
      for (;;) {
        try { await api.call(API.tree, { query: { path: at, limit: 1 } }); break } catch { if (at === '') break; at = parentPath(at) }
      }
    }
    setPickFrom(at)
    setPicking(true)
  }
  /** a project whose folder is in the trash, pointed by this dialog at a folder: how many people read that folder now
   * (they all see the project and its instructions after the save); null while unknown */
  const [readers, setReaders] = useState<number | null>(null)
  useEffect(() => {
    if (!(project?.inTrash || project?.sharedChats) || !folderPicked) return
    let live = true
    setReaders(null)
    api.call(API.explainFolderAccess, { query: { path: folder, limit: 1 } }).then(
      (r) => live && setReaders(r.summary.access.read + r.summary.access.write),
      () => {},
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, folderPicked])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** the project already on the chosen folder, when the 409 names it */
  const [takenBy, setTakenBy] = useState<string | null>(null)
  // a new project on a chosen folder: an empty name is the folder's own name; no folder chosen yet: nothing to save
  const onFolder = !project && mode === 'existing'
  const noFolder = onFolder && folder === ''
  const finalName = onFolder ? projectName(name, folder) : name.trim()
  const save = async () => {
    setBusy(true)
    setError(null)
    setTakenBy(null)
    try {
      const p = project
        // the folder goes only when it changed, or for a project whose folder is in the trash when the admin chose one here
        // (also its old path: the folder now there). A save that only renames or edits the instructions keeps such a
        // project as it is (review round 4: sending the old path on every save made a folder there that opened the
        // instructions to everyone reading the folder above)
        ? await api.call(API.updateProject, { params: { id: project.id }, body: { name: finalName, instructions, ...(folder !== project.folderPath || (project.inTrash && folderPicked) ? { folderPath: folder } : {}),
            // the setting goes only when it changed (and never while safe operations hold it)
            ...(canShare && !safeOps && shareChats !== !!project.shareChats ? { shareChats } : {}) } })
        : await api.call(API.createProject, {
            body:
              mode === 'personal' ? { name: finalName, scope: 'personal', instructions, participants: [] }
              : mode === 'team' ? { name: finalName, scope: 'team', instructions, participants }
              : { name: finalName, scope: 'team', folderPath: folder, instructions, participants: [] },
          })
      useProjects.getState().put(p)
      onSaved(p)
      onClose()
    } catch (e) {
      const refused = refusalKey(e, 'project')
      setError(refused ? t(refused) : errorText(e, locale, t('error.network')))
      const id = e instanceof ApiError && e.code === 'conflict' ? e.body.params?.projectId : undefined
      setTakenBy(typeof id === 'string' ? id : null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={project ? t('projects.edit') : t('projects.new')}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!finalName || noFolder} onClick={save} data-testid="project-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {project?.inTrash && !folderPicked && (
          <p role="status" className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="project-form-in-trash">
            {t('projects.inTrashEdit')}
          </p>
        )}
        {/* the admin chose a folder for it: saving opens the project, its name and instructions, to whoever reads it */}
        {project?.inTrash && folderPicked && (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger" data-testid="project-form-opens">
            {readers === null ? t('projects.inTrashOpens', { folder: folder || t('files.root') }) : t('projects.inTrashOpensCount', { folder: folder || t('files.root'), n: readers })}
          </p>
        )}
        <Field label={t('projects.name')} hint={onFolder && folderName(folder) ? t('projects.nameHint') : undefined}>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={onFolder ? folderName(folder) : undefined} data-autofocus data-testid="project-name" />
        </Field>
        {!project && (
          <Field label={t('projects.kind')}>
            <div className="flex flex-wrap gap-3 text-sm" role="radiogroup">
              {(['existing', 'personal', ...(isAdmin(me) ? ['team' as const] : [])] as const).map((m) => (
                <label key={m} className="flex items-center gap-1.5">
                  <input type="radio" name="project-kind" checked={mode === m} onChange={() => setMode(m)} data-testid={`project-kind-${m}`} /> {t(`projects.kind.${m}`)}
                </label>
              ))}
            </div>
          </Field>
        )}
        {!project && mode === 'team' && (
          <Field label={t('projects.participants')} hint={t('projects.participantsHint')}>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line p-2 text-sm" data-testid="project-participants">
              {groups.map((g) => (
                <label key={`g:${g.id}`} className="flex items-center gap-2">
                  <input type="checkbox" checked={picked({ subjectType: 'group', subjectId: g.id })} onChange={() => toggle({ subjectType: 'group', subjectId: g.id })} /> {g.name}
                </label>
              ))}
              {people.map((u) => (
                <label key={`u:${u.id}`} className="flex items-center gap-2">
                  <input type="checkbox" checked={picked({ subjectType: 'user', subjectId: u.id })} onChange={() => toggle({ subjectType: 'user', subjectId: u.id })} /> {u.name}
                </label>
              ))}
            </div>
          </Field>
        )}
        {(project || mode === 'existing') && <Field label={t('projects.folder')} hint={t(noFolder ? 'projects.folderPick' : 'projects.folderHint')}>
          <div className="flex gap-2">
            <input className={inputCls} value={project ? folder || t('files.root') : folder} placeholder={noFolder ? t('projects.folderNone') : undefined} readOnly data-testid="project-folder" />
            {!folderLocked && <Button onClick={() => void openPicker()} data-testid="project-folder-choose">{t('common.choose')}</Button>}
          </div>
        </Field>}
        {/* the shared chats go with the project to the folder chosen here: to everyone who reads it */}
        {repoint && !!project?.sharedChats && readers !== null && (
          <p role="status" className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm break-keep text-warn" data-testid="project-form-repoint-shared">
            {t('projects.repointShared', { n: project.sharedChats, m: readers })}
          </p>
        )}
        <Field label={t('projects.instructions')} hint={t('projects.instructionsHint')}>
          <textarea className={`${inputCls} h-40 resize-y py-2`} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={50_000} />
        </Field>
        {canShare && (
          <div data-testid="project-share-chats">
            <Switch checked={shareChats} onChange={setShareChats} label={t('projects.shareChats')} disabled={safeOps} testId="project-share-chats-toggle" describedBy={shareHint} />
            {/* what flipping it does now; under safe operations why it cannot (the switch's own width + gap: under its words) */}
            <p id={shareHint} className="mt-1 pl-11 text-xs leading-5 break-keep text-faint" data-testid="project-share-chats-hint">
              {/* what saving would do: by the saved setting, so turning it on still says who will see the chats */}
              {safeOps ? t('projects.shareChatsSafeOps') : project?.shareChats ? t('projects.shareChatsOn') : t('projects.shareChatsOff', { n: project?.audience ?? 0 })}
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
            {takenBy && (
              <>
                {' '}
                <Link to={`/projects/${takenBy}`} onClick={onClose} className="font-medium underline" data-testid="project-taken-open">
                  {t('files.openProject')}
                </Link>
              </>
            )}
          </p>
        )}
      </div>
      <FolderPicker
        open={picking}
        title={t('projects.folder')}
        confirmLabel={t('common.choose')}
        initial={pickFrom}
        onPick={(p) => {
          setFolder(p)
          setFolderPicked(true)
          setPicking(false)
        }}
        onClose={() => setPicking(false)}
      />
    </Modal>
  )
}
