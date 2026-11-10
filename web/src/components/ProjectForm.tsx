// The project create / edit dialog (Projects page). A project is a folder with instructions, and it lives in one place
// (docs/DECISIONS.md "Projects live only in projects/"): a team project in a new projects/<name> that the server makes,
// with the people and groups who see it; a personal one in users/<me>/projects/<name>. Members make team projects too,
// unless the team lets only admins (Me.team.projectCreators).
// "볼 수 있는 사람" always shows who sees it (components/ProjectParticipants.tsx). Editing a team project in projects/:
// its creator and admins change the participants here; saving them goes through the same folder rules as Admin › Folder
// permissions (the rules hash, 409 when someone changed them meanwhile). When someone gains it, a confirm first says
// what they will see (the server's dry run); narrowing saves directly. Rules this screen does not change are listed,
// read-only. A project on another folder (made before) keeps working; admins see one line saying where to change it.
// Editing a team project: "이 프로젝트의 채팅을 프로젝트 사람들과 공유" (shared project chats) with what turning it on or
// off does. A project whose folder is in the trash: admins may point it at an existing projects/<name>.
import { useEffect, useId, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Project, ProjectAccess, ProjectParticipant } from '@mycel/shared/api'
import { api, API, ApiError, errorText, isApiError } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { useProjects } from '../store/projects'
import { isAdmin, useMe } from '../store/session'
import FolderPicker from './FolderPicker'
import { refusalKey } from '../lib/sharedChat'
import { projectSkillsOn } from '../lib/bulkFiles'
import { Button, Field, Modal, Switch, confirmDialog, inputCls } from './ui'
import { useFolderWords } from '../lib/folderLabels'
import { AccessSummary, ParticipantPicker, participantKey, sameParticipants, summaryNames, useAccessCount, useParticipantOptions, widenLines, type ParticipantOption } from './ProjectParticipants'

/** projects/<name>: a team project whose participants its edit screen changes */
const inProjects = (p: string) => /^projects\/[^/]+$/.test(p)

export function ProjectForm({ project, onClose, onSaved }: {
  project?: Project
  onClose: () => void
  onSaved: (p: Project) => void
}) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const words = useFolderWords()
  const admin = isAdmin(me)
  // members make team projects unless the team lets only admins (an older server: admins only)
  const mayTeam = admin || me?.team.projectCreators === 'members'
  const [mode, setMode] = useState<'team' | 'personal'>(mayTeam ? 'team' : 'personal')
  const [name, setName] = useState(project?.name ?? '')
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const personalProject = !!project && project.folderPath.startsWith('users/')
  const teamProject = !!project && !personalProject

  // who sees it: the participants chosen here (the creator, the owner and admins always do)
  const [participants, setParticipants] = useState<ProjectParticipant[]>([])
  const [access, setAccess] = useState<ProjectAccess | null>(null)
  const editsAccess = !!project && project.canEdit && teamProject && !!access?.editable
  useEffect(() => {
    if (!teamProject || !project?.canEdit) return
    let live = true
    api.call(API.getProjectAccess, { params: { id: project.id } }).then(
      (a) => { if (!live) return; setAccess(a); setParticipants(a.participants.filter((x) => !x.creator).map(({ subjectType, subjectId }) => ({ subjectType, subjectId }))) },
      () => {},
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])
  // the people and groups already there are offered too (a group an admin added, a person switched off)
  const extra = useMemo<ParticipantOption[]>(() => (access?.participants ?? []).map(({ subjectType, subjectId, name }) => ({ subjectType, subjectId, name })), [access])
  const options = useParticipantOptions(extra)
  // the creator (me, for a new project) and anyone with a rule set in Admin › Folder permissions: not changed here
  const fixed = useMemo(() => {
    const m = new Map<string, string>()
    if (!project && me) m.set(participantKey({ subjectType: 'user', subjectId: me.user.id }), t('projects.whoMe'))
    for (const x of access?.participants ?? []) if (x.creator) m.set(participantKey(x), t('projects.creatorTag'))
    for (const r of access?.otherRules ?? []) if (r.path === project?.folderPath && r.subjectId && (r.subjectType === 'group' || r.subjectType === 'user')) m.set(`${r.subjectType}:${r.subjectId}`, t(`access.${r.access}`))
    return m
  }, [project, me, access, t])
  const picking = (!project && mode === 'team') || editsAccess
  const count = useAccessCount(participants, { projectId: project?.id, enabled: picking })
  const creatorName = access?.participants.find((x) => x.creator)?.name
  const names = summaryNames(t, participants, options, project ? (creatorName ? [creatorName] : []) : [t('projects.whoMe')])

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
  const participantsChanged = editsAccess && !!access && !sameParticipants(participants, access.participants.filter((x) => !x.creator))

  /** someone gains it: the confirm says who and what they will see (the server's dry run); false when cancelled */
  const confirmWiden = async (): Promise<boolean> => {
    const p = await api.call(API.previewProjectAccess, { body: { projectId: project!.id, participants } })
    if (!p.added) return true
    const lines = widenLines(t, p)
    return confirmDialog({
      title: t('projects.widenTitle'),
      body: (
        <div className="space-y-2" data-testid="project-widen-confirm">
          <p>{t('projects.widenBody', { n: p.added })}</p>
          {lines.length > 0 && <ul className="list-disc space-y-0.5 pl-5">{lines.map((l) => <li key={l}>{l}</li>)}</ul>}
          <p className="text-faint">{t('projects.widenNotice')}</p>
        </div>
      ),
      confirm: t('projects.widenConfirm'),
    })
  }

  const save = async (skillsOk = false) => {
    setBusy(true)
    setError(null)
    setTakenBy(null)
    try {
      let p: Project
      if (project) {
        if (participantsChanged && !skillsOk) {
          if (!(await confirmWiden())) return
          const a = await api.call(API.putProjectParticipants, { params: { id: project.id }, body: { participants, expectedHash: access!.rulesHash } })
          setAccess(a)
        }
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
      // someone changed who sees it meanwhile: show what is there now
      if (project && isApiError(e, 'conflict') && (e as ApiError).body.params?.reason === 'rules_changed')
        api.call(API.getProjectAccess, { params: { id: project.id } }).then((a) => { setAccess(a); setParticipants(a.participants.filter((x) => !x.creator).map(({ subjectType, subjectId }) => ({ subjectType, subjectId }))) }, () => {})
      const refused = refusalKey(e, 'project')
      setError(refused ? t(refused) : errorText(e, locale, t('error.network')))
      const id = e instanceof ApiError && e.code === 'conflict' ? e.body.params?.projectId : undefined
      setTakenBy(typeof id === 'string' ? id : null)
    } finally {
      setBusy(false)
    }
  }
  const otherRules = access?.otherRules ?? []
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
          <Field label={t('projects.participants')}>
            <div className="space-y-2">
              <ParticipantPicker options={options} value={participants} onChange={setParticipants} fixed={fixed} />
              <AccessSummary names={names} count={count} />
            </div>
          </Field>
        )}
        {/* a team project whose participants are not changed here: who sees it, for admins (a member gets no details of
            an admin's folder rules, and no label for a project made before) */}
        {teamProject && !picking && access && admin && <AccessSummary names={access.participants.map((x) => (x.subjectType === 'group' ? t('projects.whoGroup', { name: x.name }) : x.name))} count={access.people} />}
        {editsAccess && otherRules.length > 0 && (
          <div className="rounded-lg border border-line px-3 py-2 text-sm" data-testid="project-other-rules">
            <p className="font-medium">{t('projects.otherRules')}</p>
            <ul className="mt-1 space-y-0.5 text-muted">
              {otherRules.map((r) => (
                <li key={`${r.path}:${r.subjectType}:${r.subjectId}`} className="break-keep">
                  {r.path !== project!.folderPath ? `${t('projects.ruleInside', { path: r.path.slice(project!.folderPath.length + 1) })} · ` : ''}
                  {r.subjectType === 'everyone' ? t('rules.everyone') : r.subjectType === 'role' ? t(`role.${r.subjectId as 'member'}`) : r.subjectType === 'group' ? t('projects.whoGroup', { name: r.name ?? '' }) : r.name ?? ''}: {t(`access.${r.access}`)}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-faint">
              {t('projects.otherRulesHint')}{' '}
              {admin && <Link to={`/admin/folders?folder=${encodeURIComponent(project!.folderPath)}`} className="text-accent-text underline" onClick={onClose}>{t('projects.otherRulesLink')}</Link>}
            </p>
          </div>
        )}
        {/* a project made before on another folder: no label for members; one line for admins */}
        {teamProject && admin && !inProjects(project!.folderPath) && !project!.inTrash && (
          <p className="text-xs leading-5 break-keep text-faint" data-testid="project-form-legacy">{t('projects.legacyNote', { folder: words.path(project!.folderPath) || t('files.root') })}</p>
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
