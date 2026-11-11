// A team project's members (docs/DECISIONS.md "Project members in one panel"): opened from 관리 on the 멤버 row of the
// project page, from 멤버 in a list card's ⋯ and from the line under a shared chat's box that says who sees it
// (components/chat/WhoSees.tsx), for whoever may change them (Project.membersEditable: its creator, the owner or an
// admin, also one who is not a member: docs/DECISIONS.md "Project contents only for members"; a projects/<name> folder
// in place). The members now and a search to add (components/ProjectParticipants.tsx), the count line ("멤버 3명"), and
// the other settings of its folder: those on the folder itself with × for whoever changes the members (PUT
// …/participants `removeRules`), those on folders inside read-only, and how many inside the caller may not read
// (`otherRulesHidden`). Saving goes through the same folder rules as Admin › Folder permissions (the rules hash it read;
// 409 when someone changed them meanwhile, and the list shows what is there now). A confirm first when someone gains it,
// or when the save also writes a rule nobody chose here (the floor rule an older folder lacks, the creator's rule taken
// out in Admin): the server's dry run says what, and how many lose it; when the only one it adds is the caller, the
// "Add me" confirm instead. Taking people out alone saves at once.
import { X } from 'lucide-react'
import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import type { Project, ProjectAccess, ProjectAccessPreview, ProjectOtherRule, ProjectParticipant } from '@mycel/shared/api'
import { api, API, ApiError, errorText, isApiError } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { useProjects } from '../store/projects'
import { isAdmin, useMe } from '../store/session'
import { refusalKey } from '../lib/sharedChat'
import { isProjectsFolder } from '../lib/projectFolders'
import { Button, ErrorNote, IconButton, Modal, Skeleton, confirmDialog } from './ui'
import { AccessSummary, ParticipantPicker, participantKey, ruleKey, sameParticipants, useAccessCount, useParticipantOptions, widenLines, type ParticipantOption, type RuleRef } from './ProjectParticipants'

/** the members a save sends: the participants without the creator (the server always keeps the creator) */
export const chosenOf = (a: ProjectAccess): ProjectParticipant[] => a.participants.filter((x) => !x.creator).map(({ subjectType, subjectId }) => ({ subjectType, subjectId }))

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
        <ChangeLines t={t} p={p} />
        {p.added > 0 && <p className="text-faint">{t('projects.widenNotice')}</p>}
      </div>
    ),
    confirm: p.added ? t('projects.widenConfirm') : t('common.save'),
  })
}

/** What else a save does that the person did not choose here: how many lose it, the rule it adds or puts back. */
function ChangeLines({ t, p }: { t: ReturnType<typeof useT>; p?: ProjectAccessPreview }) {
  if (!p) return null
  return (
    <>
      {p.removed > 0 && <p data-testid="project-narrow-line">{t('projects.narrowBody', { n: p.removed })}</p>}
      {p.addsFloor && <p className="break-keep" data-testid="project-adds-floor">{t('projects.addsFloor')}</p>}
      {p.restoresCreator && <p className="break-keep" data-testid="project-restores-creator">{t('projects.restoresCreator')}</p>}
    </>
  )
}

/** "Add me" (docs/DECISIONS.md "Project contents only for members"): the owner or an admin adds themselves to a project
 * they manage without being a member; its members are told. `p`: the dry run of a members dialog save that adds only
 * them (what else it does is said under it). False when cancelled. */
export function confirmAddMe(t: ReturnType<typeof useT>, name: string, p?: ProjectAccessPreview): Promise<boolean> {
  return confirmDialog({
    title: t('projects.addMeTitle', { name }),
    body: (
      <div className="space-y-2" data-testid="project-add-me-confirm">
        <p>{t('projects.addMeBody')}</p>
        <ChangeLines t={t} p={p} />
      </div>
    ),
    confirm: t('projects.addMe'),
  })
}

/** The project as the server sees it now, for the page or list it was saved from: as the caller manages it (manage=1:
 * an owner or admin who is not a member, or who just took themselves out, gets the project without its contents). */
export const projectNow = (id: string) => api.call(API.getProject, { params: { id }, query: { manage: '1' } })

/** Who an other setting is for, in the dialog's words ("Sales 부서", "모두", "팀원"). */
const ruleWho = (t: ReturnType<typeof useT>, r: ProjectOtherRule) =>
  r.subjectType === 'everyone' ? t('rules.everyone') : r.subjectType === 'role' ? t(`role.${r.subjectId as 'member'}`) : r.subjectType === 'group' ? t('projects.whoGroup', { name: r.name ?? '' }) : r.name ?? ''

export function ProjectMembersDialog({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: (p: Project) => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const admin = isAdmin(me)
  const [access, setAccess] = useState<ProjectAccess | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [participants, setParticipants] = useState<ProjectParticipant[]>([])
  // other settings of the folder itself taken out (×), until the save
  const [removing, setRemoving] = useState<RuleRef[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = (a: ProjectAccess) => { setAccess(a); setParticipants(chosenOf(a)); setRemoving([]) }
  const load = () => api.call(API.getProjectAccess, { params: { id: project.id } })
  useEffect(() => {
    let live = true
    load().then((a) => live && shown(a), (e) => live && setLoadError(errorText(e, locale, t('error.network'))))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const removed = useMemo(() => new Set(removing.map(ruleKey)), [removing])
  const current = useMemo(() => (access ? chosenOf(access) : []), [access])
  // a setting on the folder itself (not one on a folder inside): taken out here by whoever changes the members
  const own = (r: ProjectOtherRule) => r.path === project.folderPath
  // a person or group who only reads by a setting of the folder itself (until taken out here): shown in the list, tagged
  const fixedRule = (r: ProjectOtherRule) => own(r) && r.access !== 'none' && !!r.subjectId && (r.subjectType === 'group' || r.subjectType === 'user') && !removed.has(ruleKey(r))
  // the people and groups already there are offered too (a group an admin added, a person switched off), and those with
  // a setting of the folder itself, which the list shows tagged
  const extra = useMemo<ParticipantOption[]>(() => [
    ...(access?.participants ?? []).map(({ subjectType, subjectId, name }) => ({ subjectType, subjectId, name })),
    ...(access?.otherRules ?? []).filter((r) => own(r) && r.access !== 'none' && r.subjectId && r.name && (r.subjectType === 'group' || r.subjectType === 'user'))
      .map((r) => ({ subjectType: r.subjectType as 'group' | 'user', subjectId: r.subjectId!, name: r.name! })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [access, project.folderPath])
  const options = useParticipantOptions(extra)
  // the creator and anyone who sees it by another setting of the folder (read): not changed in the list. A "no access"
  // setting is no member: it stays in the box below
  const fixed = useMemo(() => {
    const m = new Map<string, string>()
    for (const x of access?.participants ?? []) if (x.creator) m.set(participantKey(x), t('projects.creatorTag'))
    for (const r of access?.otherRules ?? []) if (fixedRule(r)) m.set(`${r.subjectType}:${r.subjectId}`, `${t(`access.${r.access}`)} · ${t('projects.folderRuleTag')}`)
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access, project.folderPath, removed, t])
  const editable = !!access?.editable
  const count = useAccessCount(participants, { projectId: project.id, enabled: editable, removeRules: removing })
  const changed = editable && (!sameParticipants(participants, current) || removing.length > 0)

  const save = async () => {
    setBusy(true)
    setError(null)
    const removeRules = removing.length ? { removeRules: removing } : {}
    try {
      const p = await api.call(API.previewProjectAccess, { body: { projectId: project.id, participants, ...removeRules } })
      // the only one the save adds is me (an owner or admin who is not a member): the "Add me" confirm
      const keys = new Set(current.map(participantKey))
      const adds = participants.filter((x) => !keys.has(participantKey(x)))
      const addsOnlyMe = !!me && adds.length === 1 && adds[0]!.subjectType === 'user' && adds[0]!.subjectId === me.user.id && p.added <= 1
      if (addsOnlyMe ? !(await confirmAddMe(t, project.name, p)) : asksFirst(p) && !(await confirmMembers(t, p))) return
      const a = await api.call(API.putProjectParticipants, { params: { id: project.id }, body: { participants, expectedHash: access!.rulesHash, ...removeRules } })
      shown(a)
      // the project as the server sees it now: how many see it, and whether anyone else does by a rule (Project.alone:
      // the line under a chat's box, docs/DECISIONS.md "Who sees it, always"), and whether I am a member now (an owner
      // or admin who added or took out themselves); unread, the count alone (its split is old)
      const next = await projectNow(project.id).catch(() => {
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
  const hidden = access?.otherRulesHidden ?? 0
  const take = (r: ProjectOtherRule) => setRemoving((xs) => [...xs, { subjectType: r.subjectType, subjectId: r.subjectId }])
  const keep = (r: ProjectOtherRule) => setRemoving((xs) => xs.filter((x) => ruleKey(x) !== ruleKey(r)))
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
        {/* changed elsewhere meanwhile (a folder moved), or a project made before outside projects/: who changes it */}
        {access && !editable && (
          <p className="text-sm break-keep text-muted" data-testid="project-members-locked">
            {!admin ? t('projects.membersByAdmins') : isProjectsFolder(project.folderPath) ? t('projects.membersFolderMissing') : t('projects.legacyNote')}
          </p>
        )}
        {/* the other settings of its folder: those of the folder itself can go (×, undone before the save), those of
            folders inside are shown only; folders inside the caller may not read are counted */}
        {editable && (otherRules.length > 0 || hidden > 0) && (
          <div className="rounded-lg border border-line px-3 py-2 text-sm" data-testid="project-other-rules">
            {otherRules.length > 0 && <p className="font-medium">{t('projects.otherRules')}</p>}
            {otherRules.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-muted">
                {otherRules.map((r) => {
                  const who = ruleWho(t, r)
                  const out = own(r) && removed.has(ruleKey(r))
                  const id = `${r.subjectType}-${r.subjectId ?? 'all'}`
                  return (
                    <li key={`${r.path}:${r.subjectType}:${r.subjectId}`} className="flex min-h-9 items-center gap-2 break-keep" data-testid={`project-other-rule-${id}`} data-state={out ? 'removed' : own(r) ? 'own' : 'inside'}>
                      <span className={clsx('min-w-0 flex-1', out && 'text-faint line-through')}>
                        {!own(r) ? `${t('projects.ruleInside', { path: r.path.slice(project.folderPath.length + 1) })} · ` : ''}
                        {who}: {t(`access.${r.access}`)}
                      </span>
                      {own(r) && (out ? (
                        <button type="button" className="touch-hit shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent-text hover:bg-hover" onClick={() => keep(r)} aria-label={t('projects.undoRemoveLabel', { name: who })} data-testid={`project-other-rule-undo-${id}`}>
                          {t('projects.undoRemove')}
                        </button>
                      ) : (
                        <IconButton label={t('projects.removeMember', { name: who })} onClick={() => take(r)} className="touch-hit shrink-0" data-testid={`project-other-rule-remove-${id}`}>
                          <X size={14} aria-hidden />
                        </IconButton>
                      ))}
                    </li>
                  )
                })}
              </ul>
            )}
            {hidden > 0 && <p className={clsx('text-xs text-faint', otherRules.length > 0 && 'mt-1')} data-testid="project-other-rules-hidden">{t('projects.insideOwn', { n: hidden })}</p>}
          </div>
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
