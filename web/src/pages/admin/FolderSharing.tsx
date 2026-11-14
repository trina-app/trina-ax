// The admin's part of the Share dialog (components/FolderAccess.tsx; docs/DECISIONS.md "Who can open it, like Drive's
// Share" and "Share like Google Drive (P1)"), used from Files and from Admin › Folder permissions: Google Drive's Share
// dialog in Drive's order and words. People with access (a role menu Viewer / Editor / Remove access per row, greyed rows
// from the folders above, the owner and admins), Access removed (old "No access" rows, brought back with Add), and
// General access (Restricted, or the team with a role; a folder with no setting of its own shows what it gets from
// above). The deepest rule still decides (until P2): a row that gives less than the person would get otherwise says so. The words are for office workers: no rules, paths
// or reasons on screen. Everything on screen comes from the admin endpoints (the server refuses them to members), and
// what a change does comes from the server's answer for exactly the draft on screen (useRulesDraft: the same draft,
// answer, hash and save as Admin › Folder permissions' editor). Save asks the server again at once, and asks the admin
// before anyone gets more access. Mounted once per folder (`key`), so a draft, its hash and its answers belong to one
// folder. Phones: the panel is the app's bottom sheet (#339's shared phone rows are not on dev yet; the rows here use
// the same 44 px sizes and switch to them when they land).
import clsx from 'clsx'
import { Building2, ChevronRight, Lock, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { Access, Folder, FolderEditPreview, Group, Project, User } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { addNamed, removeNamed, setNamed, type Draft } from '../../lib/access-edit'
import { isPersonalPath, isSkillsPath } from '../../lib/access-view'
import { aboveRows, askTitle, namesText, peopleOf, audienceOf, generalLevel, generalLowerOf, hasPanel, inProjects, latentLines, lowerOf, outcomeLines, overridingGroup, overrideText, parentOf, pickBasic, sameOutcome, saveAsk, type AboveRow, type Lower } from '../../lib/folder-sharing'
import { useFolderName } from '../../lib/folderLabels'
import { useLocale, useT } from '../../i18n'
import { Button, ErrorNote, Skeleton, confirmDialog } from '../../components/ui'
import { Avatar } from '../../components/Avatar'
import { GroupTile } from '../../components/GroupTile'
import { useFaceOf } from '../../store/people'
import { useMeStrict } from '../../store/session'
import { AddNamed, type ListControl } from './AddNamed'
import { useRulesDraft } from './useRulesDraft'
import { loadAdminGroups, loadAdminUsers, readAdmin } from '../../store/adminPeople'

export interface FolderSharingProps {
  path: string
  /** the folder's team project, for a project made before outside projects/ (its line on top) */
  project: Project | null
  /** a team project by its folder: rows that come from a project's folder say so */
  projectOf: (path: string) => Project | null
  /** open another folder's panel in place ("Change there"), after the leave question */
  onSwap: (path: string) => void
  /** leave the panel for another page (after the leave question) */
  onLeave: (to: string) => void
  /** set here: resolves true when the panel may go (nothing changed, or the admin dropped it) */
  guard: MutableRefObject<() => Promise<boolean>>
  /** the add field's list: Esc closes it first */
  list: ListControl
  /** the sheet's own footer (the Modal's footer slot): what will happen and the buttons go there, always in sight */
  footer: HTMLElement | null
  /** opened from Admin › Folder permissions: any folder there (the team root, a rule row the tree does not show), every
   * folder above opens in place, and no way to Admin (it is there) */
  admin?: boolean
  /** after a save (Admin reads its tree again) */
  onSaved?: () => void
}

export default function FolderSharing(props: FolderSharingProps) {
  const t = useT()
  const locale = useLocale()
  const { path } = props
  // the folder list, people and groups, read each time a folder is shown (and after a save): a rule row made meanwhile
  // is never missed
  const [loaded, setLoaded] = useState<{ folders: Folder[]; users: User[]; groups: Group[]; below: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    let live = true
    setError(null)
    void (async () => {
      try {
        const [folders, users, groups, below] = await Promise.all([
          api.call(API.listFolders),
          // people and groups: the admin screens' kept lists (read again after any change made here)
          readAdmin('users', loadAdminUsers).then((items) => ({ items })),
          readAdmin('groups', loadAdminGroups).then((items) => ({ items })),
          // folders inside with settings of their own (the tree's "rule folders only" list, the folder itself left out)
          api.call(API.explainAccessTree, { query: { path, rules: '1', limit: 1 } }).then((r) => Math.max(0, (r.levels[0]?.total ?? 0) - (r.self.rules > 0 ? 1 : 0)), () => 0),
        ])
        if (live) setLoaded({ folders: folders.items, users: users.items, groups: groups.items, below })
      } catch (e) {
        if (live) setError(errorText(e, locale, t('error.network')))
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, round])
  if (error && !loaded) return <ErrorNote onRetry={() => setRound((n) => n + 1)}>{error}</ErrorNote>
  if (!loaded) return <Skeleton lines={4} />
  // the folder's rule row by its exact path (names on disk), as Admin › Folder permissions finds it
  const folder = loaded.folders.find((f) => f.path === path && !f.hidden) ?? (props.admin ? loaded.folders.find((f) => f.path === path) : undefined) ?? null
  // another admin's rules came first (a 409): the folder list again, for the same draft (a row made meanwhile is then
  // saved over with PUT, not POSTed again)
  const refreshFolders = () => void api.call(API.listFolders).then((r) => setLoaded((l) => (l ? { ...l, folders: r.items } : l)), () => {})
  // after a save: nothing on screen until the list is read again, then a new draft from the saved rules (a draft started
  // from the list before the save would take the save for someone else's change)
  const reload = () => {
    setLoaded(null)
    setRound((n) => n + 1)
  }
  return <Body key={`${path}\u0003${round}`} {...props} folder={folder} users={loaded.users} groups={loaded.groups} below={loaded.below} reload={reload} onStale={refreshFolders} />
}

const LEVEL_WORD: Record<Access, 'folderAccess.canView' | 'folderAccess.canEdit' | 'folderAccess.cantOpenHere'> = { read: 'folderAccess.canView', write: 'folderAccess.canEdit', none: 'folderAccess.cantOpenHere' }
/** the role menu's own value for Remove access (Drive puts it in the same menu, under the roles) */
const REMOVE = 'remove'
/** the owner's or an admin's row: Full access, the only other choice is Remove access */
const STAFF = 'staff'
const generalSelect = 'h-9 cursor-pointer rounded-lg border border-field-border bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent max-sm:h-11'
const roleSelect = 'h-8 shrink-0 cursor-pointer rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent max-sm:h-11'

function Body({ path, project, projectOf, onSwap, onLeave, guard, list, footer, folder, users, groups, below, reload, onStale, admin, onSaved }: FolderSharingProps & {
  folder: Folder | null
  users: User[]
  groups: Group[]
  below: number
  reload: () => void
  onStale: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const team = me.team.name
  const nameOf = useFolderName()
  const faceOf = useFaceOf()
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  /** groups first, then people, each by name (the server keeps them by id) */
  const sort = (d: Draft): Draft => {
    const label = (n: Draft['named'][number]) => (n.subjectType === 'group' ? groupById.get(n.subjectId)?.name : userById.get(n.subjectId)?.name) ?? n.subjectId
    return { ...d, named: [...d.named].sort((a, b) => (a.access === 'none') !== (b.access === 'none') ? (a.access === 'none' ? 1 : -1) : a.subjectType === b.subjectType ? label(a).localeCompare(label(b)) : a.subjectType === 'group' ? -1 : 1) }
  }
  const d = useRulesDraft({ path, folder, sort, onStale })
  const { draft, setDraft, data, ready, edited } = d
  const [busy, setBusy] = useState(false)
  const [changedNow, setChangedNow] = useState(false)

  // the leave question: close, Esc, the backdrop, another folder, a link, a reload
  /** the panel left this folder (closed, another folder, a link) or unmounted: a Save on its way stops at its next step */
  const left = useRef(false)
  useEffect(() => () => {
    left.current = true
  }, [])
  /** how many times the changes were dropped (the leave question's Discard): a Save started before stops at its next
   * step, one started after goes on. Cancel › Discard keeps the panel, so it is not `left` (QA TC-287: it was, and every
   * later Save stopped until the panel was opened again) */
  const dropped = useRef(0)
  // the write itself is on its way: the panel goes without asking (the save lands). Before it (Save's fresh ask, its
  // confirm), leaving asks, and dropping the changes stops that Save
  /** the leave question is open: a Save whose fresh answer comes meanwhile does not write (the admin may be dropping it) */
  const leaving = useRef(false)
  /** `stay`: Cancel, which drops the changes and keeps the panel open on this folder */
  const askToLeave = async (o: { stay?: boolean } = {}) => {
    if (!edited || d.saving) return true
    leaving.current = true
    try {
      const ok = await confirmDialog({ title: t('folderAccess.discardTitle'), body: t('folderAccess.discardBody'), confirm: t('accessEdit.discard'), danger: true })
      if (ok) {
        dropped.current += 1
        if (!o.stay) left.current = true
      }
      return ok
    } finally {
      leaving.current = false
    }
  }
  guard.current = () => askToLeave()
  useEffect(() => () => {
    guard.current = async () => true
  }, [guard])
  useEffect(() => {
    if (!edited) return
    const ask = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [edited])

  // a person or group just added: its select takes the focus
  const [focusKey, setFocusKey] = useState<string | null>(null)
  // the add field takes the focus on a computer (Drive's first step; the Close button's tooltip covered the title).
  // Not on a touch screen: the keyboard would cover the list
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches) search.current?.focus()
  }, [])
  const peopleId = useId()
  const removedId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusKey) return
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-testid="sharing-row"]') ?? [])].find((r) => r.getAttribute('data-subject') === focusKey)
    row?.querySelector<HTMLSelectElement>('select')?.focus()
    setFocusKey(null)
  }, [focusKey])

  const skills = isSkillsPath(path)
  const above = data?.everyoneAbove?.access ?? 'none'
  const level = generalLevel(draft.basic, above)
  // the rows the folders above give, from the answer for the draft (dimmed while the next one is on its way)
  const fromAbove = data ? aboveRows(data.next, path) : []
  const projectRows = new Map<string, { project: Project; folder: string }>()
  const plainAbove: AboveRow[] = []
  for (const r of fromAbove) {
    const p = projectOf(r.folder)
    if (p) projectRows.set(r.folder, { project: p, folder: r.folder })
    else plainAbove.push(r)
  }
  const anyone = draft.named.some((n) => n.access !== 'none') || fromAbove.some((r) => r.access !== 'none')
  const parent = parentOf(path)
  // no setting here is possible except at the team root and in shared/ and skills/ (they keep one of their own)
  const canFollow = !d.root && folder?.keep !== 'team'
  const pick = (to: Access) => setDraft((x) => ({ ...x, basic: pickBasic(to, { initial: d.initial.basic, above, canFollow }) }))
  // a connected folder offers the team no Editor, unless it has it now (shown as it is)
  const teamEdit = d.choices.includes('write') || level === 'write'
  // people listed (here or from above) have their own role: the team's line says "everyone else" then
  const listed = draft.named.some((n) => n.access !== 'none') || fromAbove.some((r) => r.access !== 'none')
  const hint = !data ? '' : level === 'none' ? t(anyone ? 'folderAccess.restrictedHint' : 'folderAccess.hintAdminsOnly')
    : t(level === 'read' ? (listed ? 'folderAccess.teamHintViewElse' : 'folderAccess.teamHintView') : listed ? 'folderAccess.teamHintEditElse' : 'folderAccess.teamHintEdit', { team })
  /** the folder the greyed rows come from, or null when they come from several */
  const aboveFolders = new Set(fromAbove.filter((r) => r.access !== 'none').map((r) => r.folder))
  const aboveFolder = aboveFolders.size === 1 ? [...aboveFolders][0]! : null
  const folderWord = (f: string) => (f === '' ? team : nameOf(f))
  const lowerGeneral = data ? generalLowerOf(draft.basic, data.everyoneAbove, { above: data.above, named: new Set(draft.named.map((n) => `${n.subjectType}:${n.subjectId}`)) }) : null
  /** Remove access (the role menu), asked first: a native menu's arrow keys would otherwise remove a row on the way */
  const removeRow = async (i: number, label: string) => {
    if (!(await confirmDialog({ title: t('folderAccess.removeTitle', { name: label }), confirm: t('folderAccess.removeAccess'), danger: true }))) return
    setDraft((x) => removeNamed(x, i))
    search.current?.focus()
  }
  const isStaff = (u: User | undefined) => !!u && (u.role === 'owner' || u.role === 'admin')
  const lowerText = (l: Lower) =>
    l.kind === 'group' ? t('folderAccess.inGroupView', { group: l.group })
      : l.kind === 'team' ? (l.folder === null ? t('folderAccess.lowerTeam', { team }) : t('folderAccess.lowerTeamAbove', { team, folder: folderWord(l.folder) }))
        : l.kind === 'groupAbove' ? t('folderAccess.lowerGroupAbove', { group: l.group, folder: folderWord(l.folder) })
          : t('folderAccess.lowerSelfAbove', { folder: folderWord(l.folder) })
  // the owner and admins open every team folder, except projects (only as members) and personal folders
  const staff = !project && !inProjects(path) && !isPersonalPath(path)

  const lines = (p: FolderEditPreview) => outcomeLines(t, locale, p, { skills })

  /** a Save on its way, at once (two clicks before the next render are one Save) */
  const saving = useRef(false)
  const save = async () => {
    if (saving.current || busy || d.why) return
    saving.current = true
    setBusy(true)
    setChangedNow(false)
    // the panel went, or these changes were dropped (Cancel › Discard) since this Save began: it stops
    const run = dropped.current
    const gone = () => left.current || dropped.current !== run
    try {
      const shown = data
      const hash = d.base.hash
      // asked again now, for exactly this draft: what is saved is what the admin was shown. An answer for changes
      // dropped meanwhile is not kept (it would stand for the draft on screen)
      const fresh = await d.askNow({ live: () => !gone() })
      // the leave question is open (Cancel or close pressed meanwhile): this Save stops, and its confirm never takes
      // that question's place (a dialog replaces the one open without answering it, which kept `leaving` set and
      // stopped every later Save)
      if (!fresh || !shown || gone() || leaving.current) return
      // another admin changed this folder: the note says so (the draft kept); the next Save decides
      if (hash !== null && fresh.hash !== hash) return
      if (!sameOutcome(shown, fresh)) {
        setChangedNow(true)
        return
      }
      // Restricted that cuts off people the folders above let in (Drive's Limit access): asked first, by name, like the
      // team's own files (re-review of #779); other narrowing saves straight, "What will happen" having named who
      const cuts = draft.basic === 'named' && d.initial.basic !== 'named' && peopleOf(fresh.changes, 'lose').count > 0
      const ask = saveAsk(fresh) ?? (cuts ? { widen: false, later: false, narrow: [], skillsEveryone: false } : null)
      if (ask) {
        const ok = await confirmDialog({
          title: askTitle(t, fresh, ask),
          body: (
            <div className="space-y-1.5" data-testid="sharing-confirm-body">
              {/* which folder: the panel behind can show another one by now */}
              <p className="font-medium text-ink" data-testid="sharing-confirm-folder">{nameOf(path)}</p>
              {lines(fresh).filter((l) => l.kind !== 'none' && l.kind !== 'below').map((l) => <p key={l.kind} className={l.kind === 'lose' || l.kind === 'viewOnly' ? 'text-warn' : undefined}>{l.text}</p>)}
              {/* who gains that no head count can see, by name: people switched off, whoever joins these groups or the team */}
              {latentLines(t, locale, fresh.latent, team).map((l) => <p key={l} data-testid="sharing-confirm-latent">{l}</p>)}
              {ask.widen && fresh.below.some((b) => b.more > 0) && <p>{t('folderAccess.confirmBelow', { n: fresh.below.filter((b) => b.more > 0).length })}</p>}
              {ask.skillsEveryone && <p>{t('folderAccess.warnSkillsEveryone')}</p>}
              {ask.narrow.map((w) => (
                <p key={w.kind} className="text-warn">{w.kind === 'team-files' ? t('folderAccess.warnTeamFiles', { folder: nameOf(path) }) : t('folderAccess.warnSkills')}</p>
              ))}
            </div>
          ),
          confirm: ask.widen ? t('folderAccess.giveAccess') : t('folderAccess.saveAnyway'),
          danger: !ask.widen,
        })
        if (!ok || gone()) return
        // a confirm left open covers nothing: asked once more before the write
        const again = await d.askNow({ live: () => !gone() })
        if (gone()) return
        if (!again || again.hash !== fresh.hash || !sameOutcome(fresh, again)) {
          if (again && again.hash === fresh.hash) setChangedNow(true)
          return
        }
      }
      if (gone() || leaving.current) return
      const saved = await d.save()
      if (saved) {
        reload()
        onSaved?.()
      }
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  const leave = async (to: string) => {
    if (await askToLeave()) onLeave(to)
  }
  const swap = async (to: string) => {
    if (await askToLeave()) onSwap(to)
  }
  /** a row from a folder above opens that folder's panel, or Admin for the team root and the top folders */
  const inPlace = (folderPath: string) => admin || hasPanel(folderPath)
  const openFrom = (folderPath: string) => (inPlace(folderPath) ? void swap(folderPath) : void leave(`/admin/folders?folder=${encodeURIComponent(folderPath)}`))
  const fromText = (folderPath: string) => (folderPath === '' ? t('folderAccess.fromTop') : t('folderAccess.fromFolder', { folder: nameOf(folderPath) }))

  /** a row a folder above gives (or keeps out): greyed, the whole row opens that folder */
  const aboveRow = (r: AboveRow) => {
    const g = r.type === 'group' ? groupById.get(r.id) : undefined
    const u = r.type === 'user' ? userById.get(r.id) : undefined
    return (
      <AboveButton
        key={`${r.type}:${r.id}:${r.folder}:${r.access}`}
        onOpen={() => openFrom(r.folder)}
        title={g?.name ?? u?.name ?? r.name}
        second={fromText(r.folder)}
        level={t(LEVEL_WORD[r.access])}
        label={t('folderAccess.changeIn', { folder: r.folder === '' ? t('files.root') : nameOf(r.folder) })}
        tile={r.type === 'group'}
        face={r.type === 'user' ? faceOf({ id: r.id, name: u?.name ?? r.name }) : undefined}
        testId="sharing-above"
        subject={`${r.type}:${r.id}`}
      />
    )
  }

  const taken = new Set(draft.named.map((n) => `${n.subjectType}:${n.subjectId}`))
  // the owner and admins can always open it: a setting would change nothing for them
  const addable = users.filter((u) => u.role === 'member')
  const nothing = !draft.named.length && !fromAbove.length && !staff
  const removed = draft.named.map((n, i) => ({ n, i })).filter((x) => x.n.access === 'none')
  const removedAbove = plainAbove.filter((r) => r.access === 'none')
  const dim = !ready && !!data

  return (
    <div className="space-y-4" data-testid="sharing" data-path={path}>
      {d.stale && (
        <div role="status" className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn" data-testid="sharing-stale">
          <p className="flex items-start gap-1.5">
            <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
            <span>{t(d.stale === 'kept' ? 'folderAccess.staleKept' : 'folderAccess.staleLoaded')}</span>
          </p>
          {d.stale === 'kept' && (
            <button type="button" className="mt-1 ml-[1.15rem] font-medium underline underline-offset-2" onClick={d.loadTheirs} data-testid="sharing-show-theirs">
              {t('folderAccess.showTheirs')}
            </button>
          )}
        </div>
      )}

      <AddNamed
        inputRef={search}
        users={addable}
        groups={groups}
        taken={taken}
        list={list}
        inline
        placeholder={t('folderAccess.add')}
        saidOf={(o) => t('accessEdit.added', { name: o.name, access: t('folderAccess.canView') })}
        onAdd={(o) => {
          setDraft((x) => {
            const added = addNamed(x, { subjectType: o.kind, subjectId: o.id })
            // the new row at the top of the list
            return added === x ? x : { ...added, named: [added.named[added.named.length - 1]!, ...added.named.slice(0, -1)] }
          })
          setFocusKey(`${o.kind}:${o.id}`)
        }}
      />

      {/* busy until the answer for the draft on screen is in, the first one too: the rows from the folders above come
          with it */}
      <section aria-labelledby={peopleId} data-testid="sharing-people">
        <h3 id={peopleId} className="text-title-sm font-semibold text-ink">{t('folderAccess.peopleWithAccess')}</h3>
        <ul ref={listRef} className={clsx('mt-1 divide-y divide-line transition-opacity', dim && 'opacity-60')} data-testid="sharing-list" aria-busy={(!ready && !d.preview.error) || undefined}>
          {draft.named.map((n, i) => {
            if (n.access === 'none') return null
            const k = `${n.subjectType}:${n.subjectId}`
            const u = n.subjectType === 'user' ? userById.get(n.subjectId) : undefined
            const g = n.subjectType === 'group' ? groupById.get(n.subjectId) : undefined
            const label = u?.name ?? g?.name ?? '?'
            // the owner and admins open it anyway: their row changes nothing, and Remove access is all it offers
            const always = isStaff(u)
            // a role lower than what they would get without this row (the deepest rule decides until P2): said
            const lower = data ? lowerOf(draft, n, { groups: groupById, above: data.above, everyoneAbove: data.everyoneAbove, names: (id) => userById.get(id)?.name }) : null
            const over = !lower && u ? overridingGroup(draft, u.id, groupById) : null
            const second = lower ? lowerText(lower)
              : over ? overrideText(t, over.name, n.access)
                : g ? t('accessEdit.kind.group', { n: g.memberIds.length })
                  : u ? [t(`role.${u.role}`), u.status === 'disabled' ? t('folderAccess.switchedOff') : null].filter(Boolean).join(' · ') : ''
            return (
              <li key={k} className="flex min-h-12 items-center gap-2.5 py-1.5" data-testid="sharing-row" data-subject={k} data-access={n.access}>
                {g ? <GroupTile size={24} /> : <Avatar user={faceOf({ id: n.subjectId, name: label })} size={24} />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-row font-medium text-ink">{label}</p>
                  {/* a lower role is never cut: it is the one line that says why they get less */}
                  {second && <p className={clsx('text-xs [overflow-wrap:anywhere]', lower ? 'text-warn' : 'text-faint sm:truncate')} data-testid={lower ? 'sharing-row-lower' : 'sharing-row-second'}>{second}</p>}
                </div>
                <select
                  value={always ? STAFF : n.access}
                  aria-label={t('folderAccess.levelOf', { name: label })}
                  onChange={(e) => {
                    if (e.target.value === REMOVE) void removeRow(i, label)
                    else if (e.target.value !== STAFF) setDraft((x) => setNamed(x, i, e.target.value as Access))
                  }}
                  className={roleSelect}
                  data-testid="sharing-level"
                >
                  {always ? (
                    <option value={STAFF}>{t('folderAccess.fullAccess')}</option>
                  ) : (
                    <>
                      <option value="read">{t('folderAccess.canView')}</option>
                      <option value="write">{t('folderAccess.canEdit')}</option>
                    </>
                  )}
                  <option value={REMOVE}>{t('folderAccess.removeAccess')}</option>
                </select>
              </li>
            )
          })}
          {[...projectRows.values()].map(({ project: p, folder: f }) => (
            <AboveButton key={`project:${f}`} onOpen={() => openFrom(f)} title={t('folderAccess.projectMembers')} second={t('folderAccess.fromProject', { project: p.name })} level={null} label={t('folderAccess.changeIn', { folder: nameOf(f) })} tile testId="sharing-above-project" />
          ))}
          {plainAbove.filter((r) => r.access !== 'none').map(aboveRow)}
          {staff && (
            <li className="flex min-h-12 items-center gap-2.5 py-1.5" data-testid="sharing-staff">
              <GroupTile size={24} icon={ShieldCheck} />
              <p className="min-w-0 flex-1 truncate text-row font-medium text-ink">{t('folderAccess.staffRow')}</p>
              <span className="shrink-0 pr-1 text-xs text-muted">{t('folderAccess.fullAccess')}</span>
            </li>
          )}
          {nothing && data && <li className="py-2 text-sm text-faint" data-testid="sharing-empty">{t('folderAccess.noneAdded')}</li>}
        </ul>
      </section>

      {/* Drive's "Access removed": people and groups a "No access" row keeps out (set in Admin before P1). Add brings
          them back as Viewer (asked before Save, like any more access) */}
      {(removed.length > 0 || removedAbove.length > 0) && (
        <section aria-labelledby={removedId} data-testid="sharing-removed">
          <h3 id={removedId} className="text-title-sm font-semibold text-ink">{t('folderAccess.accessRemoved')}</h3>
          <ul className={clsx('mt-1 divide-y divide-line transition-opacity', dim && 'opacity-60')}>
            {removed.map(({ n, i }) => {
              const k = `${n.subjectType}:${n.subjectId}`
              const u = n.subjectType === 'user' ? userById.get(n.subjectId) : undefined
              const g = n.subjectType === 'group' ? groupById.get(n.subjectId) : undefined
              const label = u?.name ?? g?.name ?? '?'
              // the owner or an admin kept out here: the row does nothing (they open it anyway), so it only goes
              const staffRow = isStaff(u)
              return (
                <li key={k} className="flex min-h-12 items-center gap-2.5 py-1.5" data-testid="sharing-removed-row" data-subject={k}>
                  {g ? <GroupTile size={24} /> : <Avatar user={faceOf({ id: n.subjectId, name: label })} size={24} />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-row font-medium text-ink">{label}</p>
                    <p className="text-xs text-faint">{t(staffRow ? 'folderAccess.always' : 'folderAccess.cantOpenHere')}</p>
                  </div>
                  {staffRow ? (
                    <Button size="sm" variant="ghost" onClick={() => setDraft((x) => removeNamed(x, i))} className="shrink-0 max-sm:min-h-11" data-testid="sharing-removed-drop">
                      {t('folderAccess.removeFromList')}
                    </Button>
                  ) : (
                  <Button
                    size="sm"
                    aria-label={t('folderAccess.addBack', { name: label })}
                    onClick={() => {
                      setDraft((x) => setNamed(x, i, 'read'))
                      setFocusKey(k)
                    }}
                    className="shrink-0 max-sm:min-h-11"
                    data-testid="sharing-add-back"
                  >
                    {t('folderAccess.addBackShort')}
                  </Button>
                  )}
                </li>
              )
            })}
            {removedAbove.map(aboveRow)}
          </ul>
        </section>
      )}
      {!data && !d.preview.error && <Skeleton lines={2} />}
      {/* the first answer refused (a team project's folder opened by its address in Admin, a network error): said */}
      {!data && d.preview.error && <ErrorNote onRetry={d.retry}>{d.preview.error}</ErrorNote>}
      {d.connected && <p className="text-xs text-muted" data-testid="sharing-connected">{t('folderAccess.connectedCopy')}</p>}
      {skills && <p className="text-xs text-muted" data-testid="sharing-skills">{t('folderAccess.skillsEdit')}</p>}

      <GeneralAccess
        level={level}
        teamName={team}
        teamEdit={teamEdit}
        hint={hint}
        onPick={(to) => pick(to)}
        onAudience={(a) => pick(a === 'restricted' ? 'none' : above !== 'none' ? above : 'read')}
        from={draft.basic === 'follow' && parent !== null ? { text: fromText(parent), label: t('folderAccess.changeIn', { folder: parent === '' ? t('files.root') : nameOf(parent) }), open: () => openFrom(parent) } : null}
        lower={!lowerGeneral ? null
          : lowerGeneral.who !== undefined ? (lowerGeneral.folder === null
            ? t(lowerGeneral.kind === 'view' ? 'folderAccess.generalLowerViewWhoAbove' : 'folderAccess.generalLowerClosedWhoAbove', { who: namesText(t, locale, lowerGeneral.who, lowerGeneral.who.length) })
            : t(lowerGeneral.kind === 'view' ? 'folderAccess.generalLowerViewWho' : 'folderAccess.generalLowerClosedWho', { who: namesText(t, locale, lowerGeneral.who, lowerGeneral.who.length), folder: folderWord(lowerGeneral.folder) }))
            : t(lowerGeneral.kind === 'view' ? 'folderAccess.generalLowerView' : 'folderAccess.generalLowerClosed', { team, folder: folderWord(lowerGeneral.folder ?? '') })}
        keepOne={d.keepsOne}
        // nothing to pick from before the first answer: what the folder above gives is not known yet (review M1)
        loading={!data}
        // "no setting here" again: its own control (a pick never goes back to it, review H1)
        useAbove={draft.basic !== 'follow' && canFollow && parent !== null ? { text: t('folderAccess.useAbove', { folder: parent === '' ? t('files.root') : nameOf(parent) }), use: () => setDraft((x) => ({ ...x, basic: 'follow' })) } : null}
        // following a Restricted folder above still lets in who it lists: "only people listed here" cuts them off
        limit={draft.basic === 'follow' && parent !== null && level === 'none' && fromAbove.some((r) => r.access !== 'none') ? { text: aboveFolder === null ? t('folderAccess.limitHereAbove') : t('folderAccess.limitHere', { folder: aboveFolder === '' ? t('files.root') : nameOf(aboveFolder) }), use: () => setDraft((x) => ({ ...x, basic: 'named' })) } : null}
      />

      {(below > 0 || !admin) && <div className="border-t border-line pt-3 text-xs text-muted">
        <p>
          {below > 0 && <span data-testid="sharing-below">{t('folderAccess.sharedDifferently', { n: below })}{!admin && ' · '}</span>}
          {!admin && <Link
            to={`/admin/folders?folder=${encodeURIComponent(path)}`}
            onClick={(e) => {
              e.preventDefault()
              void leave(`/admin/folders?folder=${encodeURIComponent(path)}`)
            }}
            className="text-accent-text underline-offset-2 hover:underline"
            data-testid="sharing-open-admin"
          >
            {t('folderAccess.openInAdmin')}
          </Link>}
        </p>
      </div>}

      <Footer to={footer}>
        <div className="w-full space-y-2" data-testid="sharing-footer-bar">
          {edited && d.saveable && <Outcome data={data} ready={ready} error={d.preview.error} lines={data ? lines(data) : []} onRetry={d.retry} />}
          {changedNow && <p role="status" className="text-xs text-warn" data-testid="sharing-changed-now">{t('folderAccess.changedNow')}</p>}
          {d.refused && <ErrorNote>{d.refused}</ErrorNote>}
          <div className="flex items-center justify-end gap-2">
            {edited ? (
              <>
                {/* nothing to cancel while the save is being written: it lands */}
                <Button variant="ghost" disabled={d.saving} onClick={() => void (async () => {
                  if (await askToLeave({ stay: true })) {
                    setDraft(d.initial)
                    setChangedNow(false)
                  }
                })()} data-testid="sharing-cancel">
                  {t('common.cancel')}
                </Button>
                <Button variant="primary" onClick={() => void save()} busy={busy || d.saving} disabled={!!d.why} data-testid="sharing-save">
                  {t('common.save')}
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => onLeave('')} data-testid="sharing-done">
                {t('common.done')}
              </Button>
            )}
          </div>
        </div>
      </Footer>
    </div>
  )
}

/** The sheet's footer (the Modal's footer slot), or in place when there is none (a test mounting the panel alone). */
function Footer({ to, children }: { to: HTMLElement | null; children: ReactNode }) {
  return to ? createPortal(children, to) : <footer className="border-t border-line pt-3">{children}</footer>
}

/** A greyed row from a folder above: the whole row opens that folder (44 px), with "Change there ›". */
function AboveButton({ onOpen, title, second, level, label, tile, face, testId, subject }: {
  onOpen: () => void
  title: string
  second: string
  level: string | null
  label: string
  tile?: boolean
  face?: ReturnType<ReturnType<typeof useFaceOf>>
  testId: string
  subject?: string
}) {
  const t = useT()
  return (
    <li data-testid={testId} data-subject={subject}>
      <button type="button" onClick={onOpen} aria-label={`${title} · ${level ?? ''} · ${second} · ${label}`} className="flex min-h-12 w-full items-center gap-2.5 rounded-md py-1.5 text-left opacity-70 transition hover:bg-hover hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent">
        {tile ? <GroupTile size={24} /> : face ? <Avatar user={face} size={24} /> : <GroupTile size={24} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-ink">{title}</p>
          <p className="text-xs [overflow-wrap:anywhere] text-faint sm:truncate">
            {second} · <span className="text-accent-text">{t('folderAccess.changeThere')}</span>
            <ChevronRight size={12} className="ml-0.5 inline align-[-1px] text-accent-text" aria-hidden />
          </p>
        </div>
        {level && <span className="shrink-0 pr-1 text-xs text-muted">{level}</span>}
      </button>
    </li>
  )
}

/** General access, as Drive has it: Restricted or the team, then the team's role; one true line under it, where it
 * comes from when the folder has no setting of its own, and a lasting line when it is lower than the folder above. */
function GeneralAccess({ level, teamName, teamEdit, hint, onPick, onAudience, from, lower, keepOne, loading, useAbove, limit }: {
  level: Access
  teamName: string
  teamEdit: boolean
  hint: string
  onPick: (level: Access) => void
  onAudience: (a: 'restricted' | 'team') => void
  from: { text: string; label: string; open: () => void } | null
  lower: string | null
  keepOne: boolean
  loading: boolean
  useAbove: { text: string; use: () => void } | null
  limit: { text: string; use: () => void } | null
}) {
  const t = useT()
  const id = useId()
  const audience = audienceOf(level)
  return (
    <section aria-labelledby={id} data-testid="sharing-general">
      <h3 id={id} className="text-title-sm font-semibold text-ink">{t('folderAccess.general')}</h3>
      <div className="mt-1.5 flex items-center gap-2.5">
        <GroupTile size={32} icon={loading ? Building2 : audience === 'restricted' ? Lock : Building2} />
        {/* before the first answer no value is known: none is shown (not "Restricted"), re-review of #779 */}
        <select
          value={loading ? '' : audience}
          aria-labelledby={id}
          onChange={(e) => onAudience(e.target.value as 'restricted' | 'team')}
          className={clsx(generalSelect, 'min-w-0 flex-1 disabled:cursor-default disabled:opacity-60')}
          disabled={loading}
          aria-busy={loading || undefined}
          data-testid="sharing-general-select"
          data-level={level}
        >
          {loading && <option value="">{t('common.loading')}</option>}
          <option value="restricted">{t('folderAccess.restricted')}</option>
          <option value="team">{teamName}</option>
        </select>
        {!loading && audience === 'team' && (
          <select value={level} aria-label={t('folderAccess.teamRole', { team: teamName })} onChange={(e) => onPick(e.target.value as Access)} disabled={loading} className={clsx(generalSelect, 'shrink-0')} data-testid="sharing-general-role">
            <option value="read">{t('folderAccess.canView')}</option>
            {teamEdit && <option value="write">{t('folderAccess.canEdit')}</option>}
          </select>
        )}
      </div>
      {!loading && <p className="mt-1.5 text-xs text-muted" data-testid="sharing-general-hint">
        {hint}
        {from && (
          <>
            {' · '}
            <span data-testid="sharing-general-inherited">{from.text}</span>{' · '}
            <button type="button" onClick={from.open} aria-label={from.label} className="font-medium text-accent-text underline-offset-2 hover:underline" data-testid="sharing-general-from">
              {t('folderAccess.changeThere')} ›
            </button>
          </>
        )}
      </p>}
      {lower && <p role="note" className="mt-1.5 text-xs text-warn" data-testid="sharing-general-lower">{lower}</p>}
      {!loading && (useAbove || limit) && (
        <p className="mt-1 text-xs">
          {useAbove && <button type="button" onClick={useAbove.use} className="font-medium text-accent-text underline-offset-2 hover:underline max-sm:min-h-11" data-testid="sharing-general-follow">{useAbove.text}</button>}
          {limit && <button type="button" onClick={limit.use} className="font-medium text-accent-text underline-offset-2 hover:underline max-sm:min-h-11" data-testid="sharing-general-limit">{limit.text}</button>}
        </p>
      )}
      {keepOne && <p role="note" className="mt-1.5 rounded-lg bg-warn-soft px-2.5 py-1.5 text-xs text-warn" data-testid="sharing-keep-one">{t('folderAccess.keepOne')}</p>}
    </section>
  )
}

/** "What will happen", by name, from the answer for exactly the draft on screen. */
function Outcome({ data, ready, error, lines, onRetry }: { data: FolderEditPreview | null; ready: boolean; error: string | null; lines: { kind: string; text: string }[]; onRetry: () => void }) {
  const t = useT()
  if (error && !ready) {
    return (
      <p role="status" className="flex flex-wrap items-center gap-x-2 text-xs text-danger" data-testid="sharing-outcome-failed">
        {t('folderAccess.checkFailed')}
        <button type="button" className="font-medium underline underline-offset-2" onClick={onRetry}>
          {t('common.retry')}
        </button>
      </p>
    )
  }
  if (!data || !ready) return <p className="text-xs text-faint" data-testid="sharing-outcome-wait">{t('folderAccess.checking')}</p>
  return (
    <div role="status" className="space-y-0.5 text-xs" data-testid="sharing-outcome">
      {lines.map((l) => (
        <p key={l.kind} className={clsx(l.kind === 'lose' || l.kind === 'viewOnly' ? 'font-medium text-warn' : l.kind === 'none' ? 'text-muted' : 'font-medium text-ink')} data-kind={l.kind}>
          {l.text}
        </p>
      ))}
    </div>
  )
}

