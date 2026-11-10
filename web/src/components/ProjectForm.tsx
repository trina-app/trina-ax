// The project create / edit dialog (Projects page). A project is a folder with instructions, and it lives in one place
// (docs/DECISIONS.md "Projects live only in projects/"): a team project in a new projects/<name> that the server makes,
// with the people and groups who see it; a personal one in users/<me>/projects/<name>. Members make team projects too,
// unless the team lets only admins (Me.team.projectCreators).
// A new team project: its members (components/ProjectParticipants.tsx) and how many people will see it. An existing
// one's members are changed in their own dialog (components/ProjectMembersDialog.tsx, docs/DECISIONS.md "Project
// members in one panel"), not here; a project on another folder, made before, says on its page where. Editing a team
// project: "이 프로젝트의 채팅을 프로젝트 사람들과 공유" (shared project chats) with what turning it on or off does. A
// project whose folder is in the trash: admins may point it at an existing projects/<name>. One PATCH saves the edit.
import { useEffect, useId, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Project, ProjectParticipant } from '@mycel/shared/api'
import { api, API, ApiError, errorText } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { useProjects } from '../store/projects'
import { isAdmin, useMe } from '../store/session'
import FolderPicker from './FolderPicker'
import { refusalKey } from '../lib/sharedChat'
import { projectSkillsOn } from '../lib/bulkFiles'
import { Button, Field, Modal, Switch, confirmDialog, inputCls } from './ui'
import { AccessSummary, MembersField, ParticipantPicker, participantKey, useAccessCount, useParticipantOptions } from './ProjectParticipants'

export function ProjectForm({ project, onClose, onSaved }: {
  project?: Project
  onClose: () => void
  onSaved: (p: Project) => void
}) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const admin = isAdmin(me)
  // members make team projects unless the team lets only admins (an older server: admins only)
  const mayTeam = admin || me?.team.projectCreators === 'members'
  const [mode, setMode] = useState<'team' | 'personal'>(mayTeam ? 'team' : 'personal')
  const [name, setName] = useState(project?.name ?? '')
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const personalProject = !!project && project.folderPath.startsWith('users/')
  const teamProject = !!project && !personalProject

  // a new team project: who sees it, the members chosen here (me, the owner and admins always do)
  const [participants, setParticipants] = useState<ProjectParticipant[]>([])
  const options = useParticipantOptions()
  const fixed = useMemo(() => new Map(me ? [[participantKey({ subjectType: 'user', subjectId: me.user.id }), t('projects.whoMe')]] : []), [me, t])
  const picking = !project && mode === 'team'
  const count = useAccessCount(participants, { enabled: picking })

  // shared project chats: a team project in place, on a server that knows them (it says the audience)
  const canShare = !!project && project.audience !== undefined && teamProject && !project.inTrash
  const safeOps = !!me?.server?.allChatsConfidential
  const [shareChats, setShareChats] = useState(!!project?.shareChats)
  const shareHint = useId()

  // a project whose folder is in the trash: an admin may point it at an existing projects/<name>
  const [folder, setFolder] = useState(project?.folderPath ?? '')
  const [folderPicked, setFolderPicked] = useState(false)
  const [picker, setPicker] = useState(false)
  const repointable = !!project?.inTrash && admin
  const [readers, setReaders] = useState<number | null>(null)
  useEffect(() => {
    if (!repointable || !folderPicked) return
    let live = true
    setReaders(null)
    api.call(API.explainFolderAccess, { query: { path: folder, limit: 1 } }).then((r) => live && setReaders(r.summary.access.read + r.summary.access.write), () => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, folderPicked])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [takenBy, setTakenBy] = useState<string | null>(null)
  const finalName = name.trim()

  const save = async (skillsOk = false) => {
    setBusy(true)
    setError(null)
    setTakenBy(null)
    try {
      let p: Project
      if (project) {
        p = await api.call(API.updateProject, { params: { id: project.id }, body: { name: finalName, instructions,
          ...(repointable && folderPicked ? { folderPath: folder } : {}),
          // the setting goes only when it changed (and never while safe operations hold it)
          ...(canShare && !safeOps && shareChats !== !!project.shareChats ? { shareChats } : {}), ...(skillsOk ? { skillsOk } : {}) } })
      } else {
        p = await api.call(API.createProject, { body: mode === 'personal' ? { name: finalName, scope: 'personal', instructions, participants: [] } : { name: finalName, scope: 'team', instructions, participants } })
      }
      useProjects.getState().put(p)
      onSaved(p)
      onClose()
    } catch (e) {
      // the chosen projects/<name> holds skills: they switch on in this project's chats once the person says yes
      const skills = projectSkillsOn(e)
      if (skills && !skillsOk) {
        setBusy(false)
        if (await confirmDialog({ title: t('files.skillsOnTitle'), body: t('projects.skillsOnBody', { n: skills.length, names: skills.join(', ') }), confirm: t('common.save') })) await save(true)
        return
      }
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
          <Button variant="primary" busy={busy} disabled={!finalName} onClick={() => void save()} data-testid="project-save">
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
            {readers === null ? t('projects.inTrashOpens', { folder }) : t('projects.inTrashOpensCount', { folder, n: readers })}
          </p>
        )}
        <Field label={t('projects.name')}>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} data-autofocus data-testid="project-name" />
        </Field>
        {!project && (
          <Field label={t('projects.kind')} hint={!mayTeam ? t('projects.teamAdminsOnly') : undefined}>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm" role="radiogroup">
              {(mayTeam ? (['team', 'personal'] as const) : (['personal'] as const)).map((m) => (
                <label key={m} className="flex items-center gap-1.5">
                  <input type="radio" name="project-kind" checked={mode === m} onChange={() => setMode(m)} data-testid={`project-kind-${m}`} /> {t(`projects.kind.${m}`)}
                </label>
              ))}
            </div>
          </Field>
        )}
        {picking && (
          <MembersField label={t('projects.participants')}>
            <div className="space-y-2">
              <ParticipantPicker options={options} value={participants} onChange={setParticipants} fixed={fixed} />
              <AccessSummary count={count} />
            </div>
          </MembersField>
        )}
        {repointable && (
          <Field label={t('projects.folder')} hint={t('projects.repointHint')}>
            <div className="flex gap-2">
              <input className={inputCls} value={folder || t('files.root')} readOnly data-testid="project-folder" />
              <Button onClick={() => setPicker(true)} data-testid="project-folder-choose">{t('common.choose')}</Button>
            </div>
          </Field>
        )}
        <Field label={t('projects.instructions')} hint={t('projects.instructionsHint')}>
          <textarea className={`${inputCls} h-40 resize-y py-2`} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={50_000} />
        </Field>
        {canShare && (
          <div data-testid="project-share-chats">
            <Switch checked={shareChats} onChange={setShareChats} label={t('projects.shareChats')} disabled={safeOps} testId="project-share-chats-toggle" describedBy={shareHint} />
            {/* what flipping it does now; under safe operations why it cannot (the switch's own width + gap: under its words) */}
            <p id={shareHint} className="mt-1 pl-11 text-xs leading-5 break-keep text-faint" data-testid="project-share-chats-hint">
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
      {repointable && (
        <FolderPicker
          open={picker}
          title={t('projects.folder')}
          confirmLabel={t('common.choose')}
          initial="projects"
          onPick={(p) => {
            setFolder(p)
            setFolderPicked(true)
            setPicker(false)
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </Modal>
  )
}
