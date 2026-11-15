// The two lists of Admin › Folder permissions (Folders.tsx; docs/DECISIONS.md "드라이브처럼 공유 P1.5"), in the Files
// page's words: no rules, steps or disk names on screen.
// - FolderList: the folders shared differently from the folder they are in (every folder with its own sharing), each
//   Limited marked (Limit access: the folder's `limited`, docs/DECISIONS.md "Folder access adds up like Google Drive
//   (P2)") and who it is shared with, [Share] opening the folder's Share dialog. A team project's folder is its members'
//   to change (on the project), so they are one line.
// - PersonOpens: read only, what one person can open and why (the server's own answer, GET /api/admin/access/people/:id:
//   the permission function's reason per folder), and what they cannot open.
import clsx from 'clsx'
import { ChevronRight, Folder as FolderIcon, FolderKanban, Lock, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Access, Folder, Group, PersonAccessResponse, PersonFolderAccess, User } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { inProjects, namesText } from '../../lib/folder-sharing'
import { useFolderWords } from '../../lib/folderLabels'
import { useLocale, useT } from '../../i18n'
import { Avatar } from '../../components/Avatar'
import { Button, EmptyState, ErrorNote, Skeleton, useMediaQuery } from '../../components/ui'
import { useFaceOf } from '../../store/people'
import { useMeStrict } from '../../store/session'
import { useAdminGroups, useAdminUsers } from '../../store/adminPeople'
import { useLoad } from './common'
import { useAdminBar } from './phoneBar'

const fold = (s: string) => s.normalize('NFC').toLocaleLowerCase()
/** Files' order: Company-wide and what is in it, the team's skills, groups, connected folders, then anything else */
const TOP_ORDER = ['shared', 'skills', 'groups', 'connected']
const order = (p: string) => {
  const i = TOP_ORDER.indexOf(p.split('/')[0] ?? '')
  return i < 0 ? TOP_ORDER.length : i
}
export const byFilesOrder = (a: string, b: string) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0)
const isPersonal = (p: string) => p === 'users' || p.startsWith('users/')
/** top folders that only hold others (Files lets everyone pass through them) */
const CONTAINERS = new Set(['groups', 'projects', 'connected'])
/** the word for a role */
const ROLE_WORD = { read: 'folderAccess.canView', write: 'folderAccess.canEdit' } as const
/** Limit access: nothing from the folders above reaches it, only its own rules (`Folder.limited`; docs/DECISIONS.md
 * "Folder access adds up like Google Drive (P2)") */
export const isLimited = (f: Pick<Folder, 'limited'>) => !!f.limited

/** A path in Files' names: "Company-wide › QA-test › Contracts", the last one strong. */
export function Crumbs({ path, team }: { path: string; team: string }) {
  const words = useFolderWords()
  const crumbs = path === '' ? [{ name: team, path: '' }] : words.crumbs(path)
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-row" data-testid="folder-crumbs">
      {crumbs.map((c, i) => (
        <span key={c.path} className="inline-flex min-w-0 items-center gap-x-1">
          {i > 0 && <ChevronRight size={12} className="shrink-0 text-faint" aria-hidden />}
          <span className={clsx('[overflow-wrap:anywhere]', i === crumbs.length - 1 ? 'font-semibold text-ink' : 'text-muted')}>{c.name}</span>
        </span>
      ))}
    </span>
  )
}

/** The one mark on the list (the second plan review cut "Shared with more" and "Whole team"): Limit access. */
export function LimitedTag() {
  const t = useT()
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-warn/40 px-1.5 py-0.5 text-micro font-medium whitespace-nowrap text-warn" data-testid="folder-kind" data-kind="limited">
      <Lock size={11} aria-hidden /> {t('folders.kindLimited')}
    </span>
  )
}

/** The folders with their own sharing, and the notice for folders whose old rows lower someone. */
export function FolderList({ query, onShare }: { query: string; onShare: (path: string) => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const team = me.team.name
  const folders = useLoad(async () => (await api.call(API.listFolders)).items)
  const users = useAdminUsers()
  const groups = useAdminGroups()
  const words = useFolderWords()
  const rows = useMemo(() => {
    if (!folders.data || !users.data || !groups.data) return null
    const userById = new Map(users.data.map((u) => [u.id, u]))
    const groupById = new Map(groups.data.map((g) => [g.id, g]))
    const out: { folder: Folder; limited: boolean; who: string }[] = []
    const byPath = new Map(folders.data.map((f) => [f.path, f]))
    /** a folder above lets someone in here (access adds up to the nearest limited folder): only then "+ the folder above" */
    const aboveGives = (path: string): boolean => {
      for (let p = path; p !== ''; ) {
        p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
        const f = byPath.get(p)
        if (f && f.rules.some((r) => r.access !== 'none')) return true
        if (f?.limited) return false
      }
      return false
    }
    for (const f of folders.data) {
      // a limited folder with nobody added has no rules, and is listed too ("Owner and admins only")
      if ((!f.rules.length && !f.limited) || f.hidden || isPersonal(f.path) || inProjects(f.path)) continue
      // a group's own folder as it was made (only that group, Editor, not limited): not shared differently, so not listed
      if (f.groupId && !f.limited && f.rules.length === 1 && f.rules[0]!.subjectType === 'group' && f.rules[0]!.subjectId === f.groupId && f.rules[0]!.access === 'write') continue
      const rules = f.rules.map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId, access: r.access }))
      const limited = isLimited(f)
      out.push({ folder: f, limited, who: whoLine(t, locale, { rules, team, limited, path: f.path, userById, groupById, above: aboveGives(f.path) }) })
    }
    return out.sort((a, b) => byFilesOrder(a.folder.path, b.folder.path))
  }, [folders.data, users.data, groups.data, t, locale, team])
  // rule rows on folders Files does not show (a name it refuses, a temp or .system name; independent review, finding 5):
  // their rules still apply, so they stay reachable here, by their path. Personal folders' rows apply to nobody.
  const hiddenRows = folders.data?.filter((f) => f.hidden && (f.rules.length || f.limited) && !isPersonal(f.path)) ?? []
  const projectCount = folders.data?.filter((f) => /^projects\/[^/]+$/i.test(f.path) && f.rules.length).length ?? 0
  const err = folders.error ?? users.error ?? groups.error
  if (err && !rows) return <ErrorNote onRetry={() => { void folders.reload(); void users.reload(); void groups.reload() }}>{err}</ErrorNote>
  if (!rows) return <Skeleton lines={6} />
  const q = fold(query.trim())
  const label = (p: string) => (p === '' ? team : words.crumbs(p).map((c) => c.name).join(' › '))
  const shown = q ? rows.filter((r) => fold(label(r.folder.path)).includes(q) || fold(r.who).includes(q)) : rows
  const shownHidden = q ? hiddenRows.filter((f) => fold(f.path).includes(q)) : hiddenRows
  return (
    <section aria-labelledby="folders-list-title" data-testid="folders-list">
      <h3 id="folders-list-title" className="sr-only">{t('folders.tabFolders')}</h3>
      {!shown.length && !(projectCount && !q) ? (
        shownHidden.length ? null : <EmptyState title={t(q ? 'folders.noMatch' : 'folders.none')} />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {shown.map((r) => (
            <li key={r.folder.path} className="flex min-h-14 items-center gap-3 py-2" data-testid="folders-row" data-path={r.folder.path} data-limited={r.limited || undefined}>
              {r.folder.groupId ? <Users size={16} className="shrink-0 text-faint" aria-hidden /> : <FolderIcon size={16} className="shrink-0 text-faint" aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Crumbs path={r.folder.path} team={team} />
                  {r.limited && <LimitedTag />}
                </div>
                <p className="text-xs [overflow-wrap:anywhere] text-muted" data-testid="folders-row-who">{r.who}</p>
              </div>
              <Button size="sm" onClick={() => onShare(r.folder.path)} aria-label={t('folders.shareOf', { name: label(r.folder.path) })} className="shrink-0 max-sm:min-h-11" data-testid="folders-share">
                {t('folders.share')}
              </Button>
            </li>
          ))}
          {projectCount > 0 && !q && (
            <li data-testid="folders-projects">
              <Link to="/projects" className="flex min-h-14 items-center gap-3 py-2 hover:bg-hover">
                <FolderKanban size={16} className="shrink-0 text-faint" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-row font-semibold text-ink">{t('folders.projects')} <span className="font-normal text-muted tabular-nums">· {projectCount}</span></p>
                  <p className="text-xs text-muted">{t('folders.projectsLine')}</p>
                </div>
                <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
              </Link>
            </li>
          )}
        </ul>
      )}
      {shown.length > 0 && <p className="mt-3 text-xs text-muted">{t('folders.rest')}</p>}
      {shownHidden.length > 0 && (
        <div className="mt-5" data-testid="folders-hidden">
          <h4 className="mb-1 text-xs font-semibold text-muted">{t('folders.hiddenTitle')}</h4>
          <ul className="divide-y divide-line border-y border-line">
            {shownHidden.map((f) => (
              <li key={f.path} className="flex min-h-12 items-center gap-3 py-1.5" data-testid="folders-hidden-row" data-path={f.path}>
                <FolderIcon size={16} className="shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere] text-muted">{f.path}</span>
                <Button size="sm" onClick={() => onShare(f.path)} className="shrink-0 max-sm:min-h-11" data-testid="folders-share">{t('folders.share')}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Who a folder is shared with, in one line: "Everyone at Acme · Viewer, Design · Editor", or "Owner and admins only". */
function whoLine(t: ReturnType<typeof useT>, locale: string, o: { rules: { subjectType: string; subjectId: string | null; access: Access }[]; team: string; limited: boolean; above: boolean; path: string; userById: Map<string, User>; groupById: Map<string, Group> }): string {
  const parts: string[] = []
  const every = o.rules.find((r) => r.subjectType === 'everyone' || (r.subjectType === 'role' && r.subjectId === 'member'))
  if (every && every.access !== 'none') parts.push(t('folders.whoEveryone', { team: o.team, role: t(ROLE_WORD[every.access]) }))
  for (const a of ['write', 'read'] as const) {
    const names = o.rules.filter((r) => r.access === a && r.subjectId && (r.subjectType === 'group' || (r.subjectType === 'user' && o.userById.get(r.subjectId)?.role === 'member')))
      .map((r) => (r.subjectType === 'group' ? o.groupById.get(r.subjectId!)?.name : o.userById.get(r.subjectId!)?.name) ?? r.subjectId!)
    if (names.length) parts.push(`${namesText(t, locale, names, names.length)} · ${t(ROLE_WORD[a])}`)
  }
  // access adds up (P2): a folder that is not limited also lets in who the folders above let in
  if (parts.length) return !o.limited && o.above ? `${parts.join(', ')} ${t('folders.plusAbove')}` : parts.join(', ')
  return o.limited || o.path === '' ? t('folders.whoStaff') : t('folders.whoAbove')
}

/** Every page of one person's folders (the server's answer pages them). */
async function allFolders(id: string): Promise<PersonAccessResponse> {
  const first = await api.call(API.explainPersonAccess, { params: { id }, query: { limit: 2000 } })
  let next = first.nextCursor
  const folders = [...first.folders]
  for (let i = 0; next !== null && i < 20; i++) {
    const p = await api.call(API.explainPersonAccess, { params: { id }, query: { cursor: next, limit: 2000 } })
    folders.push(...p.folders)
    next = p.nextCursor
  }
  return { ...first, folders, nextCursor: null }
}

/** What one person can open, read only: a list of people, and for the one chosen each folder with Viewer / Editor and
 * why, then the folders they cannot open. */
export function PersonOpens({ query }: { query: string }) {
  const t = useT()
  const locale = useLocale()
  const [params, setParams] = useSearchParams()
  const users = useAdminUsers()
  const groups = useAdminGroups()
  const faceOf = useFaceOf()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const person = params.get('person')
  const user = person ? users.data?.find((u) => u.id === person) : undefined
  useAdminBar(phone ? user?.name ?? null : null)
  const answerRef = useRef<HTMLDivElement>(null)
  const pick = (id: string) => {
    if (id !== person) setParams({ view: 'people', person: id })
    if (!phone) requestAnimationFrame(() => answerRef.current?.focus({ preventScroll: true }))
  }
  const q = fold(query.trim())
  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name ?? ''
  const list = (users.data ?? []).filter((u) => !q || [u.name, u.username, ...u.groupIds.map(groupName)].some((s) => fold(s).includes(q)))
    .sort((a, b) => (a.status === 'active') !== (b.status === 'active') ? (a.status === 'active' ? -1 : 1) : a.name.localeCompare(b.name, locale))
  const onPage = phone && !!person
  let body: ReactNode
  if (users.error) body = <ErrorNote onRetry={() => void users.reload()}>{users.error}</ErrorNote>
  else if (!users.data) body = <Skeleton lines={6} />
  else if (!person) body = <EmptyState title={t('folders.pickPerson')} />
  else if (!user) body = <EmptyState title={t('accessView.unknownPerson')}>{t('folders.pickPerson')}</EmptyState>
  else body = <PersonAnswer key={user.id} who={{ name: user.name, role: user.role, groupIds: user.groupIds, off: user.status !== 'active', id: user.id }} load={() => allFolders(user.id)} groupName={groupName} />
  return (
    <section aria-labelledby="access-people-title" data-testid="access-people">
      <h3 id="access-people-title" className="sr-only">{t('folders.tabPerson')}</h3>
      <div className="@container">
        <div className="flex flex-col gap-4 @2xl:flex-row @2xl:gap-0">
          <div hidden={onPage} className="border-b border-line pb-4 @2xl:w-64 @2xl:shrink-0 @2xl:border-r @2xl:border-b-0 @2xl:pr-4 @2xl:pb-0 max-md:border-b-0">
            {!users.data ? <Skeleton lines={5} /> : list.length ? (
              <ul aria-label={t('accessView.people')} className="scroll-thin space-y-0.5 @2xl:max-h-[min(36rem,70vh)] @2xl:overflow-y-auto" data-testid="access-person-list">
                {list.map((u) => (
                  <li key={u.id}>
                    <button type="button" onClick={() => pick(u.id)} aria-current={u.id === person || undefined} className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left max-md:min-h-11', u.id === person ? 'bg-accent-soft' : 'hover:bg-hover')} data-testid="access-person-option" data-person={u.id}>
                      <Avatar user={faceOf({ id: u.id, name: u.name })} size={24} />
                      <span className="min-w-0">
                        <span className="block truncate text-row font-medium text-ink">{u.name}</span>
                        <span className="block truncate text-xs text-muted">{[t(`role.${u.role}`), u.status !== 'active' ? t('folderAccess.switchedOff') : null].filter(Boolean).join(' · ')}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="px-2.5 text-sm text-faint">{t('accessView.noMatch')}</p>}
          </div>
          <div ref={answerRef} tabIndex={-1} hidden={phone && !person} className="min-w-0 flex-1 outline-none @2xl:pl-5" data-testid="access-answer">
            {body}
          </div>
        </div>
      </div>
    </section>
  )
}

/** Who the answer is for: a person (with a face), or someone about to be invited (no id). */
interface Who { id?: string; name: string; role: User['role']; groupIds: readonly string[]; off?: boolean }

function PersonAnswer({ who: user, load, groupName, compact }: { who: Who; load: () => Promise<PersonAccessResponse>; groupName: (id: string) => string; compact?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const team = me.team.name
  const faceOf = useFaceOf()
  const words = useFolderWords()
  const [answer, setAnswer] = useState<PersonAccessResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    let live = true
    setError(null)
    load().then((r) => live && setAnswer(r), (e) => live && setError(errorText(e, locale, t('error.network'))))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round])
  if (error && !answer) return <ErrorNote onRetry={() => setRound((n) => n + 1)}>{error}</ErrorNote>
  if (!answer) return <Skeleton lines={6} />
  const folderWord = (f: string) => (f === '' ? team : words.crumbs(f).map((c) => c.name).join(' › '))
  const rows = answer.folders.filter((f) => !isPersonal(f.path) && f.exists !== false).sort((a, b) => byFilesOrder(a.path, b.path))
  const open = rows.filter((f) => f.access !== 'none')
  // the group folders of groups they are not in are one count line (the list would grow with every group)
  const otherGroup = (f: PersonFolderAccess) => !!f.group && !user.groupIds.includes(f.group.id)
  // a team project's folder they are not in: one count line too (the list would grow with every project)
  // (one they left stays a row of its own: "Left the project")
  const otherProject = (f: PersonFolderAccess) => /^projects\/[^/]+$/i.test(f.path) && f.reason.kind !== 'left'
  // groups/, projects/ and connected/ only hold folders: everyone passes through them in Files, never "can't open"
  const container = (f: PersonFolderAccess) => CONTAINERS.has(f.path)
  const notInGroup = rows.filter((f) => f.access === 'none' && otherGroup(f)).length
  const notInProject = rows.filter((f) => f.access === 'none' && !otherGroup(f) && otherProject(f)).length
  const closed = rows.filter((f) => f.access === 'none' && !otherGroup(f) && !otherProject(f) && !container(f))
  // the owner and admins open every team folder but projects they are not in: one line, not a list
  if (user.role !== 'member') {
    return (
      <div data-testid="access-person">
        {!compact && (
          <div className="mb-3 flex items-center gap-2.5">
            <Avatar user={faceOf({ id: user.id ?? '', name: user.name })} size={32} />
            <h4 className="min-w-0 text-title-sm font-semibold break-words text-ink" data-testid="access-person-title">{t('folders.whatCanOpen', { name: user.name })}</h4>
          </div>
        )}
        <p className="text-sm text-muted" data-testid="access-staff-line">{t('folders.staffLine')}</p>
      </div>
    )
  }
  const reason = (f: PersonFolderAccess): string => {
    const r = f.reason
    if (r.kind !== 'rule') return ''
    const what = inProjects(f.path) ? t('folders.reasonProject')
      : r.tier === 'everyone' || r.tier === 'role' ? t('folders.everyoneAt', { team })
      : r.tier === 'group' ? t('folders.reasonGroup', { group: namesText(t, locale, r.rules.map((x) => groupName(x.subjectId ?? '')).filter(Boolean), r.rules.length) })
        : t('folders.reasonPerson')
    return r.folder !== f.path ? `${what} · ${t('folders.reasonFrom', { folder: folderWord(r.folder) })}` : what
  }
  // why they cannot open it, from the server's reason (#787): left the project, a limited folder that is not theirs
  // (here or one above it: `cutAt`), not a project member, or simply not added anywhere on the way up
  const why = (f: PersonFolderAccess): string => {
    const r = f.reason
    if (r.kind === 'left') return t('folders.cantLeft')
    if (inProjects(f.path)) return t('folders.cantProject')
    if (r.kind === 'no-rule' && r.cutAt !== undefined) return r.cutAt === f.path ? t('folders.cantLimited') : t('folders.cantLimitedFrom', { folder: folderWord(r.cutAt) })
    return t('folders.cantNotAdded')
  }
  const groupsLine = user.groupIds.map(groupName).filter(Boolean).join(', ')
  const row = (f: PersonFolderAccess, end: ReactNode, second: string) => (
    <li key={f.path} className="flex min-h-12 items-center gap-3 py-1.5" data-testid="access-row" data-path={f.path} data-access={f.access}>
      <div className="min-w-0 flex-1">
        <Crumbs path={f.path} team={team} />
        <p className="text-xs [overflow-wrap:anywhere] text-muted" data-testid="access-row-why">{second}</p>
      </div>
      {end}
    </li>
  )
  return (
    <div data-testid="access-person">
      {!compact && (
        <div className="mb-3 flex items-center gap-2.5">
          <Avatar user={faceOf({ id: user.id ?? '', name: user.name })} size={32} />
          <div className="min-w-0">
            <h4 className="text-title-sm font-semibold break-words text-ink" data-testid="access-person-title">{t('folders.whatCanOpen', { name: user.name })}</h4>
            <p className="text-xs text-muted">{[t(`role.${user.role}`), groupsLine || null, user.off ? t('folderAccess.switchedOff') : null, t('folders.aiSame')].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
      )}
      {open.length ? (
        <ul className="divide-y divide-line border-y border-line" data-testid="access-open">
          {open.map((f) => row(f, <span className="shrink-0 text-xs font-medium text-ink">{t(ROLE_WORD[f.access === 'write' ? 'write' : 'read'])}</span>, reason(f)))}
        </ul>
      ) : <p className="text-sm text-muted">{t('folders.opensNothing')}</p>}
      {(closed.length > 0 || notInGroup > 0 || notInProject > 0) && (
        <>
          <h5 className="mt-5 mb-1 text-xs font-semibold text-muted">{t('folders.cantOpen')}</h5>
          <ul className="divide-y divide-line border-y border-line" data-testid="access-closed">
            {closed.map((f) => row(f, <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted"><Lock size={12} aria-hidden /> {t('folders.cantOpenShort')}</span>, why(f)))}
          </ul>
          {notInGroup > 0 && <p className="mt-1.5 text-xs text-muted" data-testid="access-closed-groups">{t('folders.cantGroups', { n: notInGroup })}</p>}
          {notInProject > 0 && <p className="mt-1 text-xs text-muted" data-testid="access-closed-projects">{t('folders.cantProjects', { n: notInProject })}</p>}
        </>
      )}

    </div>
  )
}

/** The address of what someone can open (Members links here). */
export const personViewLink = (o: { person: string }) => `/admin/folders?${new URLSearchParams({ view: 'people', person: o.person })}`

/** The invite dialog's "What they'll be able to open": the same list for someone about to be invited with this role
 * and these groups (POST /api/admin/access/new-person), folded until opened. */
export function NewPersonPreview({ role, groupIds, groups }: { role: 'member' | 'admin'; groupIds: string[]; groups: Group[] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? ''
  return (
    <div className="border-t border-line pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-label font-medium text-ink transition hover:bg-hover max-sm:min-h-10"
        data-testid="new-person-preview-toggle"
      >
        <ChevronRight size={15} className={clsx('shrink-0 text-muted transition', open && 'rotate-90')} aria-hidden />
        {t('accessView.preview')}
      </button>
      {open && (
        <div className="pt-2" data-testid="new-person-preview">
          <PersonAnswer
            key={`${role}|${groupIds.join(',')}`}
            compact
            who={{ name: '', role, groupIds }}
            load={() => api.call(API.explainNewPersonAccess, { body: { role, groupIds, limit: 2000 } })}
            groupName={groupName}
          />
        </div>
      )}
    </div>
  )
}
