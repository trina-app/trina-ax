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
// out in Admin): the server's dry run says what; when the only one it adds is the caller, the "Add me" confirm instead.
// Taking people out asks too: "2 people lose access: Kim and Lee" (names, three and "and N more"; QA TC-1067).
// Who is in it (docs/DECISIONS.md "Who is in a project, by face"): whoever changes the members reads the picker (each
// group row opens to its people) and one count under it, "5 people", me included (QA TC-1065: no second list of the same
// people). Its members open it too (the faces on the project page): for them the list of everyone in it, each once
// (ProjectPeople.tsx PeopleList, the creator and "나" marked), and who changes the members.
// Adding people who would start seeing answers of its shared chats that used places some of them can't open: one line
// under the count ("3 answers here used places Sales can't open…") with "Show answers", which turns the dialog's body
// into the list of those answers (components/WideningList.tsx; docs/DECISIONS.md "People who see a shared chat later:
// nothing new is hidden"); ‹ goes back to the picks. On a phone an answer opens on this screen: the draft is kept first
// (store/wideningDraft.ts) and the dialog opens again on the list when the person comes back (WideningDraftHost).
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { Project, ProjectAccess, ProjectAccessPreview, ProjectOtherRule, ProjectParticipant, WideningAnswer } from '@mycel/shared/api'
import { api, API, ApiError, errorText, isApiError } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { useProjects } from '../store/projects'
import { isAdmin, useMe } from '../store/session'
import { refusalKey } from '../lib/sharedChat'
import { isProjectsFolder } from '../lib/projectFolders'
import { Button, ErrorNote, IconButton, Modal, Skeleton, confirmDialog, useMediaQuery } from './ui'
import { answerHref, WideningList } from './WideningList'
import { freshDraft, useWideningDraft, type WideningDraft } from '../store/wideningDraft'
import { hasPeopleList, PeopleList, useProjectPeople } from './ProjectPeople'
import { AccessSummary, ParticipantPicker, participantKey, ruleKey, sameParticipants, useAccessCount, useParticipantOptions, widenLines, type ParticipantOption, type RuleRef } from './ProjectParticipants'

/** the members a save sends: the participants without the creator (the server always keeps the creator) */
export const chosenOf = (a: ProjectAccess): ProjectParticipant[] => a.participants.filter((x) => !x.creator).map(({ subjectType, subjectId }) => ({ subjectType, subjectId }))

/** The dry run asks first: someone gains or loses it, or the save writes a rule nobody chose here. */
export const asksFirst = (p: ProjectAccessPreview) => p.added > 0 || p.removed > 0 || !!p.addsFloor || !!p.restoresCreator

/** "Kim, Lee, Park and 2 more": up to three names the server sent, then how many more of `total`. */
export function namesLine(t: ReturnType<typeof useT>, names: readonly string[], total: number): string {
  const list = names.join(t('rooms.nameSep'))
  return total > names.length ? t('rooms.groupNamesMore', { names: list, n: total - names.length }) : list
}

/** The confirm: who gains it and what they will see, how many lose it, the rule the save adds; false when cancelled.
 * `names`: the people and groups being added, as picked (the widening line). */
export function confirmMembers(t: ReturnType<typeof useT>, p: ProjectAccessPreview, names = ''): Promise<boolean> {
  const lines = p.added ? [...widenLines(t, p), ...(p.hiddenAnswers && names ? [t('chat.share.widen', { n: p.hiddenAnswers, names })] : [])] : []
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
      {p.removed > 0 && (
        <p className="break-keep" data-testid="project-narrow-line">
          {p.removedNames?.length ? t('projects.loseAccess', { n: p.removed, names: namesLine(t, p.removedNames, p.removed) }) : t('projects.narrowBody', { n: p.removed })}
        </p>
      )}
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

export function ProjectMembersDialog({ project, onClose, onSaved, initial }: { project: Project; onClose: () => void; onSaved: (p: Project) => void
  /** a phone's way back from an answer of the widening list: the picks and the list as they were */
  initial?: WideningDraft }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const admin = isAdmin(me)
  const phone = useMediaQuery('(max-width: 767.98px)')
  const navigate = useNavigate()
  const location = useLocation()
  // the widening list in place of the body (the picks stay)
  const [listing, setListing] = useState(false)
  const listScroll = useRef(initial?.scroll ?? 0)
  const restore = useRef(initial)
  const [access, setAccess] = useState<ProjectAccess | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [participants, setParticipants] = useState<ProjectParticipant[]>([])
  // other settings of the folder itself taken out (×), until the save
  const [removing, setRemoving] = useState<RuleRef[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = (a: ProjectAccess) => {
    setAccess(a)
    // back from an answer on a phone: the picks and the list, unless the members were saved meanwhile or it is too old
    const d = restore.current
    restore.current = undefined
    if (d && freshDraft(d) && d.projectId === project.id && d.rulesHash === a.rulesHash) {
      setParticipants(d.participants); setRemoving(d.removeRules); setListing(true)
    } else { setParticipants(chosenOf(a)); setRemoving([]); listScroll.current = 0 }
    if (d) useWideningDraft.getState().drop()
  }
  const load = () => api.call(API.getProjectAccess, { params: { id: project.id } })
  // whoever manages it reads its participants; a member who does not reads only who is in it
  const manages = !!(project.canManage ?? project.membersEditable)
  useEffect(() => {
    if (!manages) return
    let live = true
    load().then((a) => live && shown(a), (e) => live && setLoadError(errorText(e, locale, t('error.network'))))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, manages])
  const people = useProjectPeople(project)
  const groupPeople = useMemo(() => {
    if (!people || !people.groups) return undefined
    const byId = new Map(people.people.map((x) => [x.id, x]))
    return new Map(people.groups.map((g) => [g.id, g.people.flatMap((id) => byId.get(id) ?? [])]))
  }, [people])

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
  // a group's people who left the project (docs/DECISIONS.md "Leaving a project"): "Marketing · except Kim" on its row,
  // the only place a leaver shows (owner, QA TC-1074); adding them by name takes the exception away
  const notes = useMemo(() => new Map((access?.participants ?? []).filter((x) => x.except?.length).map((x) => [participantKey(x), t('projects.except', { names: x.except!.map((u) => u.name).join(t('rooms.nameSep')) })])), [access, t])
  const editable = !!access?.editable
  const count = useAccessCount(participants, { projectId: project.id, enabled: editable, removeRules: removing })
  const changed = editable && (!sameParticipants(participants, current) || removing.length > 0)
  // the people and groups being added, as picked ("Sales and Sam"): the widening line and the list's title
  const addedNames = useMemo(() => {
    const keys = new Set(current.map(participantKey))
    return participants.filter((x) => !keys.has(participantKey(x))).map((x) => options.find((o) => participantKey(o) === participantKey(x))?.name ?? '').filter(Boolean).join(t('rooms.nameSep'))
  }, [participants, current, options, t])
  const widen = editable && !!count?.hiddenAnswers && !!addedNames
  // nothing to list any more (the picks changed): back to them
  useEffect(() => { if (listing && !addedNames) setListing(false) }, [listing, addedNames])
  const body = useRef<HTMLDivElement>(null)
  const scroller = useCallback(() => body.current?.closest<HTMLElement>('.overflow-y-auto') ?? null, [])
  /** a phone: the answer opens on this screen; the draft first, so Back brings the dialog and its picks back */
  const openOnPhone = (a: WideningAnswer) => {
    if (!access) return
    useWideningDraft.getState().keep({ projectId: project.id, participants, removeRules: removing, rulesHash: access.rulesHash, scroll: listScroll.current, from: location.pathname + location.search, at: Date.now(), left: true })
    navigate(answerHref(a))
    onClose()
  }

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
      if (addsOnlyMe ? !(await confirmAddMe(t, project.name, p)) : asksFirst(p) && !(await confirmMembers(t, p, addedNames))) return
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
      title={listing ? (
        <span className="flex min-w-0 items-center gap-1">
          <IconButton label={t('tabs.back')} onClick={() => setListing(false)} className="-ml-2 shrink-0 touch-hit" data-testid="widening-list-back">
            <ChevronLeft size={18} aria-hidden />
          </IconButton>
          <span className="min-w-0 break-keep" data-testid="widening-list-title">{t('share.widenList.title', { names: addedNames })}</span>
        </span>
      ) : t('projects.membersTitle', { name: project.name })}
      width={560}
      footer={listing ? undefined :
        <>
          {/* read only (a member who does not manage it, or members changed elsewhere): 닫기 */}
          <Button variant="ghost" onClick={onClose}>{editable ? t('common.cancel') : t('common.close')}</Button>
          {editable && <Button variant="primary" busy={busy} disabled={!changed} onClick={() => void save()} data-testid="project-members-save">{t('common.save')}</Button>}
        </>
      }
    >
      {listing && access ? (
        <div ref={body}>
          <WideningList target={{ kind: 'project', projectId: project.id }} add={participants} names={addedNames} phone={phone} onOpen={phone ? openOnPhone : undefined}
            scroller={scroller} initialScroll={listScroll.current} onScroll={(top) => { listScroll.current = top }} />
        </div>
      ) : (
      <div className="space-y-4" data-testid="project-members-dialog">
        {loadError && <ErrorNote>{loadError}</ErrorNote>}
        {manages && !access && !loadError && <Skeleton lines={4} />}
        {access && editable && (
          <div className="space-y-2">
            <ParticipantPicker options={options} value={participants} onChange={setParticipants} fixed={fixed} current={current} groupPeople={groupPeople} notes={notes} />
            {/* the one count of this dialog: everyone who sees it, me included (after the change while one is pending) */}
            <AccessSummary count={count} />
            {/* the widening warning: answers the people being added would start seeing that used places they miss */}
            {widen && (
              <p className="text-sm leading-6 break-keep text-ink" data-testid="project-widen-answers">
                {t('chat.share.widen', { n: count!.hiddenAnswers!, names: addedNames })}{' '}
                <button type="button" onClick={() => setListing(true)} className="touch-hit inline-flex items-center font-medium text-accent-text hover:underline" data-testid="project-widen-show">
                  {t('share.widenList.show')}<ChevronRight size={14} aria-hidden />
                </button>
              </p>
            )}
          </div>
        )}
        {/* changed elsewhere meanwhile (a folder moved), or a project made before outside projects/: who changes it */}
        {(access ? !editable : !manages) && (
          <p className="text-sm break-keep text-muted" data-testid="project-members-locked">
            {!admin ? (project.creatorChangesMembers && project.createdBy ? t('projects.membersByCreator', { name: project.createdBy.name }) : t('projects.membersByAdmins')) : isProjectsFolder(project.folderPath) ? t('projects.membersFolderMissing') : t('projects.legacyNote')}
          </p>
        )}
        {!manages && people === null && <Skeleton lines={3} />}
        {/* a member's list could not be read: say so rather than an empty dialog */}
        {!manages && people === false && hasPeopleList(project) && <ErrorNote>{t('error.network')}</ErrorNote>}
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
        {/* a member who does not change them: everyone in it now, each once (whoever changes them reads the picker) */}
        {(!manages || (access && !editable)) && people && people.people.length > 0 && <PeopleList people={people.people} />}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
      )}
    </Modal>
  )
}
