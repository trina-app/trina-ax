// The project create / edit dialog (Projects page, and "Make it a project" on a folder of the Files page). A project is
// a folder of the team folder with instructions: on an existing folder the name may stay empty, and the folder's own
// name is used. A new project on "Existing folder" needs a folder chosen (never the whole team folder: an older server
// may already have a project there, and the 409 would only confuse). A 409 that names the project already on the
// folder offers to open it.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Group, Project, ProjectParticipant, User } from '@mycel/shared/api'
import { api, API, ApiError, errorText } from '../lib/api'
import { folderName, projectName } from '../lib/projectFolders'
import { useLocale, useT } from '../i18n'
import { useProjects } from '../store/projects'
import { isAdmin, useMe } from '../store/session'
import FolderPicker from './FolderPicker'
import { Button, Field, Modal, inputCls } from './ui'

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
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const [picking, setPicking] = useState(false)
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
        // a project whose folder is in the trash takes the chosen folder also when it is the same path (the folder now
        // there): the server ends the trash state only on a folderPath
        ? await api.call(API.updateProject, { params: { id: project.id }, body: { name: finalName, instructions, ...(folder !== project.folderPath || project.inTrash ? { folderPath: folder } : {}) } })
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
      setError(errorText(e, locale, t('error.network')))
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
            {!folderLocked && <Button onClick={() => setPicking(true)}>{t('common.choose')}</Button>}
          </div>
        </Field>}
        <Field label={t('projects.instructions')} hint={t('projects.instructionsHint')}>
          <textarea className={`${inputCls} h-40 resize-y py-2`} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={50_000} />
        </Field>
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
        initial={folder}
        onPick={(p) => {
          setFolder(p)
          setPicking(false)
        }}
        onClose={() => setPicking(false)}
      />
    </Modal>
  )
}
