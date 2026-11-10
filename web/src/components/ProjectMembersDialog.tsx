// A team project's members (docs/DECISIONS.md "Project members in one panel"): opened from 관리 on the 멤버 row of the
// project page, from 멤버 in a list card's ⋯ and from the line under a shared chat's box that says who sees it
// (components/chat/WhoSees.tsx), for whoever may change them (Project.membersEditable: its creator or an admin, a
// projects/<name> folder in place). The members now and a search to add (components/ProjectParticipants.tsx),
// the count line, and the rules this screen does not change, read-only (a link to Admin › Folder permissions for
// admins). Saving goes through the same folder rules as Admin › Folder permissions (the rules hash it read; 409 when
// someone changed them meanwhile, and the list shows what is there now). A confirm first when someone gains it, or when
// the save also writes a rule nobody chose here (the floor rule an older folder lacks, the creator's rule taken out in
// Admin): the server's dry run says what, and how many lose it. Taking people out alone saves at once.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Project, ProjectAccess, ProjectAccessPreview, ProjectParticipant } from '@mycel/shared/api'
import { api, API, ApiError, errorText, isApiError } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { useProjects } from '../store/projects'
import { isAdmin, useMe } from '../store/session'
import { refusalKey } from '../lib/sharedChat'
import { useFolderWords } from '../lib/folderLabels'
import { Button, ErrorNote, Modal, Skeleton, confirmDialog } from './ui'
import { AccessSummary, ParticipantPicker, participantKey, sameParticipants, useAccessCount, useParticipantOptions, widenLines, type ParticipantOption } from './ProjectParticipants'

/** the members a save sends: the participants without the creator (the server always keeps the creator) */
const chosenOf = (a: ProjectAccess): ProjectParticipant[] => a.participants.filter((x) => !x.creator).map(({ subjectType, subjectId }) => ({ subjectType, subjectId }))

/** The dry run asks first: someone gains it, or the save writes a rule nobody chose here. */
export const asksFirst = (p: ProjectAccessPreview) => p.added > 0 || !!p.addsFloor || !!p.restoresCreator

/** The confirm: who gains it and what they will see, how many lose it, the rule the save adds; false when cancelled. */
export function confirmMembers(t: ReturnType<typeof useT>, p: ProjectAccessPreview): Promise<boolean> {
  const lines = p.added ? widenLines(t, p) : []
  return confirmDialog({
    title: p.added ? t('projects.widenTitle') : t('projects.changeTitle'),
    body: (
      <div className="space-y-2" data-testid="project-widen-confirm">
        {p.added > 0 && <p>{t('projects.widenBody', { n: p.added })}</p>}
        {lines.length > 0 && <ul className="list-disc space-y-0.5 pl-5">{lines.map((l) => <li key={l}>{l}</li>)}</ul>}
        {p.removed > 0 && <p data-testid="project-narrow-line">{t('projects.narrowBody', { n: p.removed })}</p>}
        {p.addsFloor && <p className="break-keep" data-testid="project-adds-floor">{t('projects.addsFloor')}</p>}
        {p.restoresCreator && <p className="break-keep" data-testid="project-restores-creator">{t('projects.restoresCreator')}</p>}
        {p.added > 0 && <p className="text-faint">{t('projects.widenNotice')}</p>}
      </div>
    ),
    confirm: p.added ? t('projects.widenConfirm') : t('common.save'),
  })
}

export function ProjectMembersDialog({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: (p: Project) => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const admin = isAdmin(me)
  const words = useFolderWords()
  const [access, setAccess] = useState<ProjectAccess | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [participants, setParticipants] = useState<ProjectParticipant[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = (a: ProjectAccess) => { setAccess(a); setParticipants(chosenOf(a)) }
  const load = () => api.call(API.getProjectAccess, { params: { id: project.id } })
  useEffect(() => {
    let live = true
    load().then((a) => live && shown(a), (e) => live && setLoadError(errorText(e, locale, t('error.network'))))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const current = useMemo(() => (access ? chosenOf(access) : []), [access])
  // the people and groups already there are offered too (a group an admin added, a person switched off), and those with
  // a rule set in Admin › Folder permissions, which the list shows tagged
  const extra = useMemo<ParticipantOption[]>(() => [
    ...(access?.participants ?? []).map(({ subjectType, subjectId, name }) => ({ subjectType, subjectId, name })),
    ...(access?.otherRules ?? []).filter((r) => r.path === project.folderPath && r.access !== 'none' && r.subjectId && r.name && (r.subjectType === 'group' || r.subjectType === 'user'))
      .map((r) => ({ subjectType: r.subjectType as 'group' | 'user', subjectId: r.subjectId!, name: r.name! })),
  ], [access, project.folderPath])
  const options = useParticipantOptions(extra)
  // the creator and anyone who sees it by a rule set in Admin › Folder permissions (read): not changed here. A "no
  // access" rule is no member: it stays in the read-only box below
  const fixed = useMemo(() => {
    const m = new Map<string, string>()
    for (const x of access?.participants ?? []) if (x.creator) m.set(participantKey(x), t('projects.creatorTag'))
    for (const r of access?.otherRules ?? []) if (r.path === project.folderPath && r.access !== 'none' && r.subjectId && (r.subjectType === 'group' || r.subjectType === 'user')) m.set(`${r.subjectType}:${r.subjectId}`, `${t(`access.${r.access}`)} · ${t('projects.folderRuleTag')}`)
    return m
  }, [access, project.folderPath, t])
  const editable = !!access?.editable
  const count = useAccessCount(participants, { projectId: project.id, enabled: editable })
  const changed = editable && !sameParticipants(participants, current)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const p = await api.call(API.previewProjectAccess, { body: { projectId: project.id, participants } })
      if (asksFirst(p) && !(await confirmMembers(t, p))) return
      const a = await api.call(API.putProjectParticipants, { params: { id: project.id }, body: { participants, expectedHash: access!.rulesHash } })
      shown(a)
      // the project as the server sees it now: how many see it, and whether anyone else does by a rule (Project.alone:
      // the line under a chat's box, docs/DECISIONS.md "Who sees it, always"); unread, the count alone (its split is old)
      const next = await api.call(API.getProject, { params: { id: project.id } }).catch(() => {
        const { alone: _, audienceSplit: _s, ...rest } = project
        return { ...rest, audience: a.people }
      })
      useProjects.getState().put(next)
      onSaved(next)
      onClose()
    } catch (e) {
      // someone changed who sees it meanwhile: show what is there now
      if (isApiError(e, 'conflict') && (e as ApiError).body.params?.reason === 'rules_changed') load().then(shown, () => {})
      const refused = refusalKey(e, 'project')
      setError(refused ? t(refused) : errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }

  const otherRules = access?.otherRules ?? []
  return (
    <Modal
      open
      onClose={onClose}
      title={t('projects.membersTitle', { name: project.name })}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          {editable && <Button variant="primary" busy={busy} disabled={!changed} onClick={() => void save()} data-testid="project-members-save">{t('common.save')}</Button>}
        </>
      }
    >
      <div className="space-y-4" data-testid="project-members-dialog">
        {loadError && <ErrorNote>{loadError}</ErrorNote>}
        {!access && !loadError && <Skeleton lines={4} />}
        {access && editable && (
          <div className="space-y-2">
            <ParticipantPicker options={options} value={participants} onChange={setParticipants} fixed={fixed} current={current} />
            <AccessSummary count={count} />
          </div>
        )}
        {/* changed elsewhere meanwhile (a folder moved, an admin's rule): who changes it now */}
        {access && !editable && (
          <p className="text-sm break-keep text-muted" data-testid="project-members-locked">
            {!admin ? t('projects.membersByAdmins') : /^projects\/[^/]+$/.test(project.folderPath) ? t('projects.membersFolderMissing') : t('projects.legacyNote', { folder: words.path(project.folderPath) || t('files.root') })}
          </p>
        )}
        {editable && otherRules.length > 0 && (
          <div className="rounded-lg border border-line px-3 py-2 text-sm" data-testid="project-other-rules">
            <p className="font-medium">{t('projects.otherRules')}</p>
            <ul className="mt-1 space-y-0.5 text-muted">
              {otherRules.map((r) => (
                <li key={`${r.path}:${r.subjectType}:${r.subjectId}`} className="break-keep">
                  {r.path !== project.folderPath ? `${t('projects.ruleInside', { path: r.path.slice(project.folderPath.length + 1) })} · ` : ''}
                  {r.subjectType === 'everyone' ? t('rules.everyone') : r.subjectType === 'role' ? t(`role.${r.subjectId as 'member'}`) : r.subjectType === 'group' ? t('projects.whoGroup', { name: r.name ?? '' }) : r.name ?? ''}: {t(`access.${r.access}`)}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-faint">
              {t('projects.otherRulesHint')}{' '}
              {admin && <Link to={`/admin/folders?folder=${encodeURIComponent(project.folderPath)}`} className="text-accent-text underline" onClick={onClose}>{t('projects.otherRulesLink')}</Link>}
            </p>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
