// 팀 파일's folder plan after the upload (docs/DECISIONS.md "Setup 팀 파일: the AI proposes folders"; lib/organize.ts,
// POST /api/onboarding/files/organize …): once the step's run landed its files in 전사 공유 (shared/) without a failure,
// "읽고 정리하는 중… n/N" while the server reads them and asks the caller's AI once; then the proposal, a flat list
// grouped by folder ("전사 공유 › 양식 (3)", Google Drive's "Organize my files"): per row another folder (the plan's and
// the existing ones, or a new one) or ✕ (the file stays where it went up), a new folder's name typed inline, one
// [이대로 정리] and "나중에" (on to the next step, the files where they are). [이대로 정리] moves them on the server as
// the caller; the result says what went where, asks owners and admins whether the forms it moved become team skills
// (FormSkills.tsx: "견적서 양식 … 스킬로 만들어둘까요?"), asks once "이 n개는 'A사 리뉴얼' 프로젝트로 묶을까요?" when the AI saw such a group (a team project
// with the setup's team group as participant, its files moved into its folder; "나중에" drops the question) and goes on
// with the step's next button. Nothing to sort, no answer: the run's own end screen (TeamFilesStep RunView) as before.
// The state lives in this tab (another page and back: no second plan), keyed by the run; sign-out forgets it. The proposal's
// id is also kept in this browser (per person, not cleared by an expired session) while it waits: after a reload, or coming back later (the server keeps a plan for an
// hour), the same plan shows again on the step (resumeOrganize) instead of leaving the files loose in 전사 공유.
import clsx from 'clsx'
import { Check, ChevronRight, FolderPlus, Loader2, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { create } from 'zustand'
import { ORGANIZE_LIMITS, SHARED_HOME, cleanFolderName, formSkillPaths, type OrganizeApplied, type OrganizePlan } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { onFolderUploadsForgotten, type Run } from '../../lib/folderRuns'
import { useFolderWords } from '../../lib/folderLabels'
import { choicesOf, editFromPlan, folderCount, groupsOf, kept, movesOf, newFolderFor, projectBody, projectPaths, removeRow, renameFolder, setFolder, type OrgEdit, type OrgRow } from '../../lib/organize'
import { setupReturnState } from '../../lib/welcome'
import { useLocale, useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { Button, ErrorNote } from '../ui'
import { Tooltip } from '../Tooltip'
import { FormSkills } from './FormSkills'

/** how often the page asks how far the plan is */
const POLL_MS = 600
/** the page stops waiting after this long (the server's own limits end well before) */
const GIVE_UP_MS = ORGANIZE_LIMITS.readMs + ORGANIZE_LIMITS.aiMs + 15_000

type Org =
  | { s: 'idle' }
  | { s: 'reading'; read: number; total: number }
  | { s: 'proposal'; id: string; plan: OrganizePlan; edit: OrgEdit; busy?: boolean; error?: string | null }
  /** project: ask · busy · done · later · taken (the project could not be made under that name: only 나중에).
   * `where`: each moved file's place now (after a project took some); `gone`: plan folders the project emptied (trashed);
   * `projectFailed`: the project's files that did not move */
  | { s: 'result'; plan: OrganizePlan; applied: OrganizeApplied; project: 'ask' | 'busy' | 'done' | 'later' | 'taken'; projectId?: string; error?: string | null; where?: Record<string, string>; projectFailed?: number }
  /** nothing to sort, no plan, or put off: the run's end screen */
  | { s: 'none' }
interface OrgState { runId: number | null; org: Org }
export const useOrganize = create<OrgState>(() => ({ runId: null, org: { s: 'idle' } }))
const set = (org: Org) => useOrganize.setState({ org })
let generation = 0

/** The waiting proposal's id, per person, in this browser (the plan itself is on the server). */
const SAVED_KEY = 'mycel.organizePlan'
const savePlan = (userId: string, id: string) => { try { localStorage.setItem(SAVED_KEY, JSON.stringify({ userId, id })) } catch { /* this tab only */ } }
const savedPlan = (userId: string): string | null => {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_KEY) ?? 'null') as { userId?: string; id?: string } | null
    return v && v.userId === userId && typeof v.id === 'string' ? v.id : null
  } catch { return null }
}
const clearSaved = () => { try { localStorage.removeItem(SAVED_KEY) } catch { /* nothing kept */ } }
/** The run id of a proposal brought back from the server (no run of this tab behind it). */
export const RESUMED = -1

/** A plan this tab does not have but the browser remembers: ask the server and show it again. */
export async function resumeOrganize(userId: string): Promise<void> {
  const id = savedPlan(userId)
  if (!id || useOrganize.getState().org.s !== 'idle') return
  const g = generation
  try {
    const st = await api.call(API.organizeStatus, { params: { id } })
    if (g !== generation || useOrganize.getState().org.s !== 'idle') return
    const edit = st.state === 'done' && st.plan ? editFromPlan(st.plan) : null
    if (st.plan && edit?.rows.length) useOrganize.setState({ runId: RESUMED, org: { s: 'proposal', id, plan: st.plan, edit } })
    else clearSaved()
  } catch {
    // forgotten by the server (an hour) or not this person's: nothing to bring back
    clearSaved()
  }
}

/** The paths each run of the step landed (TeamFilesStep's run reports every landed file). */
const landedOf = new Map<number, string[]>()
export function rememberLanded(runId: number, paths: string[]) { landedOf.set(runId, paths) }
onFolderUploadsForgotten(() => { generation++; landedOf.clear(); useOrganize.setState({ runId: null, org: { s: 'idle' } }) })

/** Should the plan start for this run now? A finished run with no failure that landed files in shared/, once per run. */
export function organizeWanted(run: Run | null): boolean {
  if (!run || run.view.status !== 'done' || useOrganize.getState().runId === run.view.id) return false
  return (run.view.base === SHARED_HOME || run.view.base.startsWith(`${SHARED_HOME}/`)) && (landedOf.get(run.view.id)?.length ?? 0) > 0
}

/** Start the plan for a run's landed files and follow it to the proposal (or to "none"). */
export async function beginOrganize(run: Run, userId: string): Promise<void> {
  const g = ++generation
  const paths = [...new Set(landedOf.get(run.view.id) ?? [])].slice(0, ORGANIZE_LIMITS.files)
  useOrganize.setState({ runId: run.view.id, org: { s: 'reading', read: 0, total: Math.min(paths.length, ORGANIZE_LIMITS.read) } })
  try {
    const started = await api.call(API.startOrganize, { body: { paths } })
    if (g !== generation) return
    set({ s: 'reading', read: 0, total: started.total })
    const until = Date.now() + GIVE_UP_MS
    for (;;) {
      await new Promise((done) => setTimeout(done, POLL_MS))
      if (g !== generation) return
      const st = await api.call(API.organizeStatus, { params: { id: started.id } })
      if (g !== generation) return
      if (st.state === 'done' && st.plan) {
        const edit = editFromPlan(st.plan)
        if (edit.rows.length) savePlan(userId, started.id); else clearSaved()
        set(edit.rows.length ? { s: 'proposal', id: started.id, plan: st.plan, edit } : { s: 'none' })
        return
      }
      set({ s: 'reading', read: st.read, total: st.total })
      if (Date.now() > until) { set({ s: 'none' }); return }
    }
  } catch {
    if (g === generation) set({ s: 'none' })
  }
}

export interface OrganizeViewProps {
  /** the run's uploaded count (the step's onDone) */
  uploaded: number
  /** the setup's team group: a project made here gets it as participant */
  teamGroupId: string | null
  nextLabel: string
  busy: boolean
  phone: boolean
  onDone: (n: number) => void
}

/** The plan's screens while it is under way, proposed or applied; null otherwise (the run's end screen shows). */
export function OrganizeView(p: OrganizeViewProps) {
  const org = useOrganize((s) => s.org)
  if (org.s === 'reading') return <Reading read={org.read} total={org.total} />
  if (org.s === 'proposal') return <Proposal {...p} id={org.id} plan={org.plan} edit={org.edit} applying={!!org.busy} error={org.error ?? null} />
  if (org.s === 'result') return <Result {...p} org={org} />
  return null
}

function Reading({ read, total }: { read: number; total: number }) {
  const t = useT()
  return (
    <div className="space-y-3" data-testid="organize-reading">
      <h2 className="flex items-center gap-2 text-display font-semibold text-ink" role="status" data-testid="organize-reading-title">
        <Loader2 size={16} className="shrink-0 animate-spin text-accent-text" aria-hidden />
        {t('welcome.organize.reading', { k: Math.min(read, total), n: total })}
      </h2>
      <p className="text-sm text-muted">{t('welcome.organize.readingHint')}</p>
    </div>
  )
}

const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'
const NEW = '\u0000new'

function Proposal({ id, plan, edit, applying, error, uploaded, teamGroupId, busy, phone, onDone }: OrganizeViewProps & { id: string; plan: OrganizePlan; edit: OrgEdit; applying: boolean; error: string | null }) {
  const t = useT()
  const locale = useLocale()
  const words = useFolderWords()
  const ids = useId()
  const shared = words.name(SHARED_HOME, SHARED_HOME)
  const groups = groupsOf(edit)
  const rows = kept(edit)
  const choices = choicesOf(edit)
  const full = folderCount(edit) >= ORGANIZE_LIMITS.folders
  const [capped, setCapped] = useState(false)
  const change = (e: OrgEdit) => useOrganize.setState({ org: { s: 'proposal', id, plan, edit: e } })
  const pickFor = (r: OrgRow, v: string) => {
    if (v === NEW) {
      const next = newFolderFor(edit, r.path, t('welcome.organize.newFolder'))
      setCapped(!next)
      if (next) change(next)
      return
    }
    setCapped(false)
    change(setFolder(edit, r.path, v))
  }
  const apply = async () => {
    const moves = movesOf(edit)
    if (!moves.length) { clearSaved(); return onDone(uploaded) }
    useOrganize.setState({ org: { s: 'proposal', id, plan, edit, busy: true } })
    try {
      const applied = await api.call(API.applyOrganize, { body: { id, moves } })
      // a project question only with the setup's team group (a project without it would be the owner's alone, while the
      // question says the whole team works on it)
      const project = teamGroupId && plan.project && plan.project.paths.length >= ORGANIZE_LIMITS.projectMin ? 'ask' : 'later'
      clearSaved()
      useOrganize.setState({ org: { s: 'result', plan, applied, project } })
    } catch (e) {
      useOrganize.setState({ org: { s: 'proposal', id, plan, edit, error: errorText(e, locale, t('error.network')) } })
    }
  }
  const later = () => { clearSaved(); set({ s: 'none' }); onDone(uploaded) }
  const removed = edit.removed.length
  return (
    <div className="space-y-4" data-testid="organize-proposal" data-ai={plan.ai}>
      <div className="space-y-1">
        <h2 className="text-display font-semibold text-ink">{t('welcome.organize.title')}</h2>
        <p className="text-sm text-balance text-muted" data-testid="organize-desc">{t('welcome.organize.desc', { n: rows.length, k: groups.length, shared })}</p>
      </div>
      {plan.ai !== 'done' && <p className="text-sm text-ink" role="status" data-testid="organize-no-ai">{t('welcome.organize.noAi')}</p>}
      <div className={phone ? 'space-y-4' : 'space-y-3'} data-testid="organize-groups">
        {groups.map((g) => (
          <section key={g.folder} className={phone ? 'border-y border-line' : 'rounded-xl border border-line bg-surface'} aria-labelledby={`${ids}-${g.folder}`} data-testid="organize-group" data-folder={g.folder}>
            <header className={clsx('flex min-h-11 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-line py-2', phone ? 'px-0' : 'px-4')}>
              <span className="text-sm text-muted">{shared}</span>
              <ChevronRight size={14} className="shrink-0 text-faint" aria-hidden />
              {g.isNew ? (
                <FolderNameField name={g.folder} id={`${ids}-${g.folder}`} disabled={applying || busy} onRename={(to) => change(renameFolder(edit, g.folder, to))} />
              ) : <h3 id={`${ids}-${g.folder}`} className="text-sm font-semibold text-ink" data-testid="organize-group-name">{g.folder}</h3>}
              <span className="text-sm text-muted tabular-nums" data-testid="organize-group-count">({g.rows.length})</span>
              {g.isNew && <span className="ml-1 rounded-full border border-line px-1.5 text-xs text-muted" data-testid="organize-group-new">{t('welcome.organize.isNew')}</span>}
            </header>
            <ul>
              {g.rows.map((r, i) => (
                <li key={r.path} className={clsx('flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2', phone ? 'px-0' : 'px-4', i > 0 && 'border-t border-line')} data-testid="organize-row" data-path={r.path}>
                  <span className="min-w-0 flex-[1_1_12rem] truncate text-sm text-ink" title={r.name}>{r.name}</span>
                  <div className={clsx('flex items-center gap-1', phone && 'w-full')}>
                    <select className={clsx('h-9 min-w-0 rounded-lg border border-field-border bg-surface px-2 text-sm text-ink md:h-8', phone ? 'flex-1' : 'max-w-48')} value={g.folder} disabled={applying || busy}
                      aria-label={t('welcome.organize.moveTo', { name: r.name })} onChange={(e) => pickFor(r, e.target.value)} data-testid="organize-row-folder">
                      {choices.map((c) => <option key={c} value={c}>{c}</option>)}
                      <option value={NEW} disabled={full && !(g.rows.length === 1)}>{t('welcome.organize.newFolderOption')}</option>
                    </select>
                    <Tooltip label={t('welcome.organize.remove', { name: r.name })}>
                      <button type="button" className="touch-hit inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-faint hover:bg-hover hover:text-ink md:size-8" disabled={applying || busy}
                        aria-label={t('welcome.organize.remove', { name: r.name })} onClick={() => change(removeRow(edit, r.path))} data-testid="organize-row-remove">
                        <X size={16} aria-hidden />
                      </button>
                    </Tooltip>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {removed > 0 && <p className="text-label text-muted" data-testid="organize-removed">{t('welcome.organize.removed', { n: removed })}</p>}
      {capped && <p className="text-label text-warn" role="status" data-testid="organize-capped">{t('welcome.organize.capped', { n: ORGANIZE_LIMITS.folders })}</p>}
      {error && <ErrorNote onRetry={() => void apply()}>{error}</ErrorNote>}
      <div className={phone ? 'space-y-2' : 'flex flex-wrap items-center gap-3'}>
        <Button variant="primary" className={phone ? 'w-full' : undefined} busy={applying} disabled={busy || !rows.length} onClick={() => void apply()} data-testid="organize-apply">{t('welcome.organize.apply')}</Button>
        <div className={phone ? 'flex justify-center' : undefined}>
          <Button variant="ghost" disabled={applying || busy} onClick={later} data-testid="organize-later">{t('welcome.organize.later')}</Button>
        </div>
      </div>
    </div>
  )
}

/** A new folder's name, typed in place (Enter or leaving the field keeps it; an empty name keeps the old one). */
function FolderNameField({ name, id, disabled, onRename }: { name: string; id: string; disabled: boolean; onRename: (to: string) => void }) {
  const t = useT()
  const [v, setV] = useState(name)
  useEffect(() => setV(name), [name])
  const [bad, setBad] = useState(false)
  // a name no folder can have (only dots, a leading dot, too long) goes back to the old one, with why
  const keep = () => {
    const clean = cleanFolderName(v)
    if (v.trim() && !clean) { setBad(true); setV(name); return }
    setBad(false)
    if (clean && clean !== name) onRename(clean); else setV(name)
  }
  return (
    <>
      <input id={id} value={v} disabled={disabled} maxLength={ORGANIZE_LIMITS.folderChars} aria-label={t('welcome.organize.folderName')} aria-invalid={bad || undefined}
        className="h-8 w-40 min-w-0 rounded-md border border-field-border bg-surface px-2 text-sm font-semibold text-ink max-sm:flex-1"
        onChange={(e) => { setV(e.target.value); setBad(false) }} onBlur={keep} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); keep() } }} data-testid="organize-group-rename" />
      {bad && <span role="alert" className="basis-full text-label text-warn" data-testid="organize-group-rename-bad">{t('welcome.organize.badName')}</span>}
    </>
  )
}

function Result({ org, uploaded, teamGroupId, nextLabel, busy, phone, onDone }: OrganizeViewProps & { org: Extract<Org, { s: 'result' }> }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const words = useFolderWords()
  const shared = words.name(SHARED_HOME, SHARED_HOME)
  // on the welcome steps the project's page shows the way back to the team files step (SetupReturn.tsx)
  const inSteps = useLocation().pathname === '/welcome'
  const { plan, applied } = org
  // where each sorted file is now: a project may have taken some out of 전사 공유
  const now = applied.moved.map((m) => org.where?.[m.to] ?? m.to)
  const inFolders = now.filter((p) => p.startsWith(`${SHARED_HOME}/`) && p.split('/').length === 3)
  const folders = [...new Set(inFolders.map((p) => p.split('/')[1]!))]
  // the forms offered as skills (formSkillPaths), where they are now (a project may have taken one)
  const forms = formSkillPaths(plan, applied).map((p) => org.where?.[p] ?? p)
  const project = plan.project
  const makeProject = async () => {
    if (!project) return
    useOrganize.setState({ org: { ...org, project: 'busy', error: null } })
    let made: { id: string; folderPath: string }
    try {
      made = await api.call(API.createProject, { body: projectBody(project.name, teamGroupId) })
    } catch (e) {
      // a name that is taken (409): asking again would fail the same way, so only 나중에 is left
      useOrganize.setState({ org: { ...org, project: isApiError(e, 'conflict') ? 'taken' : 'ask', error: errorText(e, locale, t('error.network')) } })
      return
    }
    const where: Record<string, string> = { ...org.where }
    let failed = 0
    for (const from of projectPaths(project.paths, applied)) {
      try {
        const r = await api.call(API.move, { body: { from, to: `${made.folderPath}/${from.slice(from.lastIndexOf('/') + 1)}`, onExists: 'rename' } })
        where[from] = r.entry.path
      } catch { failed++ }
    }
    // a 전사 공유 folder this plan made and the project emptied goes too (the result line no longer names it)
    const left = [...new Set(project.paths.map((p) => projectPaths([p], applied)[0]!).filter((p) => where[p]).map((p) => p.slice(0, p.lastIndexOf('/'))))]
    for (const dir of left) {
      const name = dir.split('/')[1]
      if (dir.split('/').length !== 2 || dir.split('/')[0] !== SHARED_HOME || !name || plan.existing.some((x) => x.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase())) continue
      try {
        const tr = await api.call(API.tree, { query: { path: dir } })
        if (!tr.entries.length) await api.call(API.remove, { query: { path: dir } })
      } catch { /* it stays */ }
    }
    useOrganize.setState({ org: { ...org, project: 'done', projectId: made.id, where, projectFailed: failed, error: null } })
  }
  return (
    <div className="space-y-4" data-testid="organize-result">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-display font-semibold text-ink" role="status" data-testid="organize-result-title">
          <Check size={18} className="shrink-0 text-ok" aria-hidden />
          {t('welcome.organize.done', { n: inFolders.length, k: folders.length })}
        </h2>
        {folders.length > 0 && <p className="text-sm text-muted" data-testid="organize-result-folders">{shared} › {folders.join(', ')}</p>}
      </div>
      {applied.failed.length > 0 && <p className="text-sm text-warn" role="status" data-testid="organize-result-failed">{t('welcome.organize.failed', { n: applied.failed.length })}</p>}
      <FormSkills forms={forms} phone={phone} />
      {project && org.project !== 'later' && (
        <div className={clsx('space-y-2', phone ? 'border-y border-line py-3' : 'rounded-xl border border-line bg-surface p-4')} data-testid="organize-project" data-state={org.project}>
          {org.project === 'done' ? (
            <p className="flex flex-wrap items-center gap-2 text-sm text-ink" role="status" data-testid="organize-project-done">
              <FolderPlus size={16} className="shrink-0 text-ok" aria-hidden /> {t('welcome.organize.projectDone', { name: project.name })}
              {!!org.projectFailed && <span className="basis-full text-label text-warn" data-testid="organize-project-failed">{t('welcome.organize.projectFailed', { n: org.projectFailed })}</span>}
              {org.projectId && <Link to={`/projects/${org.projectId}`} state={inSteps ? setupReturnState('files') : undefined} className={clsx(quietLink, 'text-sm')} data-testid="organize-project-open">{t('welcome.organize.projectOpen')}</Link>}
            </p>
          ) : (
            <>
              <p className="text-sm font-medium text-ink" data-testid="organize-project-question">{t('welcome.organize.project', { n: project.paths.length, name: project.name })}</p>
              <p className="text-label text-muted">{t('welcome.organize.projectHint', { team: me.team.name })}</p>
              {org.error && <ErrorNote>{org.error}</ErrorNote>}
              <div className="flex flex-wrap items-center gap-2">
                {org.project !== 'taken' && <Button size="sm" className="max-md:min-h-11" busy={org.project === 'busy'} disabled={busy} onClick={() => void makeProject()} data-testid="organize-project-yes">{t('welcome.organize.projectYes')}</Button>}
                <Button size="sm" variant="ghost" className="max-md:min-h-11" disabled={org.project === 'busy' || busy} onClick={() => useOrganize.setState({ org: { ...org, project: 'later', error: null } })} data-testid="organize-project-later">{t('welcome.organize.later')}</Button>
              </div>
            </>
          )}
        </div>
      )}
      <div className={phone ? 'space-y-2' : 'flex flex-wrap items-center gap-3'}>
        <Button variant="primary" className={phone ? 'w-full' : undefined} disabled={busy || org.project === 'busy'} onClick={() => onDone(uploaded)} data-testid="organize-next">{nextLabel}</Button>
      </div>
    </div>
  )
}
