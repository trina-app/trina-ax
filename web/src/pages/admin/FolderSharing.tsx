// The admin's part of the Share dialog (components/FolderAccess.tsx; docs/DECISIONS.md "Who can open it, like Drive's
// Share" and "Share like Google Drive (P1)"), used from Files and from Admin › Folder permissions: Google Drive's Share
// dialog in Drive's order and words. People with access (a role menu Viewer / Editor / Remove access per row, greyed rows
// from the folders above, the owner and admins), Access removed (old "No access" rows, brought back with Add), and
// General access (Restricted, or the team with a role; a folder with no setting of its own shows what it gets from
// above), and Limit access (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)": access adds up from the
// folders above; a limited folder lets in only who is added here). The words are for office workers: no rules, paths
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
import { aboveRows, askTitle, peopleOf, audienceOf, generalLevel, hasPanel, inheritedOf, inProjects, latentLines, outcomeLines, parentOf, pickable, pickBasic, removedPeople, sameOutcome, saveAsk, type AboveRow } from '../../lib/folder-sharing'
import { useFolderName } from '../../lib/folderLabels'
import { useLocale, useT } from '../../i18n'
import { Button, ErrorNote, Skeleton, Switch, confirmDialog } from '../../components/ui'
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
  const limited = !!draft.limited
  const level = generalLevel(draft.basic, limited, above)
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
  // shared/ and skills/ keep a setting of their own (the server refuses neither rules nor limit there): no "follow" for
  // them, and Restricted there is Limit access (as P1 stored it, review of #787)
  const teamFolder = folder?.keep === 'team'
  const pick = (to: Access) => setDraft((x) => {
    if (teamFolder && to === 'none') return { ...x, basic: 'named', limited: true }
    const b = pickBasic(to, { initial: d.initial.basic, limited: !!x.limited, above })
    return { ...x, basic: teamFolder && b === 'follow' ? (to === 'none' ? 'named' : to) : b }
  })
  /** Limit access on or off: the team's "only people added" goes with it (no setting of the team's either way). Off: a
   * role lower than what the folders above give is raised to it (12-A at save time: access adds up, so a lower row
   * would restrict nobody); the server does the same on save */
  const setLimit = (on: boolean) => setDraft((x) => {
    if (on) return { ...x, limited: true, basic: x.basic === 'follow' ? 'named' : x.basic }
    const own: Access = x.basic === 'read' || x.basic === 'write' ? x.basic : 'none'
    // shared/ or skills/ with nobody added and nothing from the team root: off would leave it with no setting at all,
    // which the server refuses (they keep a rule or a limit): the limit stays, pick a team role first
    if (teamFolder && own === 'none' && above === 'none' && !x.named.some((n) => n.access !== 'none')) return x
    const basic = RANK_OF[own] >= RANK_OF[above] ? (x.basic === 'named' && !teamFolder ? 'follow' : x.basic) : teamFolder ? (above as 'read' | 'write') : 'follow'
    const named = x.named.map((n) => {
      if (n.access === 'none') return n
      const from = data ? inheritedOf(data.above, n) : null
      return from && RANK_OF[from.access] > RANK_OF[n.access] ? { ...n, access: from.access } : n
    })
    return { ...x, limited: false, basic, named }
  })
  // Limit access is the owner's and admins' (the dialog is theirs): on subfolders; on a top folder (nothing above it but
  // the team root) only while it is limited, so a limit the update put there can be taken away, and always on shared/
  // and skills/ (their Restricted is the limit); never at the team root
  const limitShown = parent !== null && (parent !== '' || limited || !!d.base.limited || teamFolder)
  // people the update listed by name on this folder ("Added when folders changed"), while their role is as it was
  const byConversion = new Set((folder?.rules ?? []).filter((r) => r.byConversion).map((r) => `${r.subjectType}:${r.subjectId}:${r.access}`))
  // a connected folder offers the team no Editor, unless it has it now (shown as it is)
  const teamEdit = d.choices.includes('write') || level === 'write'
  // people listed (here or from above) have their own role: the team's line says "everyone else" then
  const listed = draft.named.some((n) => n.access !== 'none') || fromAbove.some((r) => r.access !== 'none')
  const hint = !data ? '' : level === 'none' ? t(anyone ? 'folderAccess.restrictedHint' : 'folderAccess.hintAdminsOnly')
    : t(level === 'read' ? (listed ? 'folderAccess.teamHintViewElse' : 'folderAccess.teamHintView') : listed ? 'folderAccess.teamHintEditElse' : 'folderAccess.teamHintEdit', { team })
  const folderWord = (f: string) => (f === '' ? team : nameOf(f))
  /** Remove access (the role menu), asked first: a native menu's arrow keys would otherwise remove a row on the way */
  const removeRow = async (i: number, label: string) => {
    if (!(await confirmDialog({ title: t('folderAccess.removeTitle', { name: label }), confirm: t('folderAccess.removeAccess'), danger: true }))) return
    setDraft((x) => removeNamed(x, i))
    search.current?.focus()
  }
  const isStaff = (u: User | undefined) => !!u && (u.role === 'owner' || u.role === 'admin')
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
      const cuts = limited && !d.initial.limited && peopleOf(fresh.changes, 'lose').count > 0
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
  const startAccess = (o: { kind: 'user' | 'group'; id: string }): Access =>
    data && !limited && inheritedOf(data.above, { subjectType: o.kind, subjectId: o.id })?.access === 'write' ? 'write' : 'read'
  // the owner and admins can always open it: a setting would change nothing for them
  const addable = users.filter((u) => u.role === 'member')
  const nothing = !draft.named.length && !fromAbove.length && !staff
  // Access removed (a limited folder, as saved): who opens the folder above but not this one, read from the folder
  // answers of both; people added in the draft since leave it
  const [removedAll, setRemovedAll] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    if (!d.base.limited || parent === null) { setRemovedAll([]); return }
    let live = true
    void Promise.all([api.call(API.explainFolderAccess, { query: { path, limit: 2000 } }), api.call(API.explainFolderAccess, { query: { path: parent, limit: 2000 } })])
      .then(([here, up]) => { if (live) setRemovedAll(removedPeople(here.people, up.people, path)) }, () => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, d.base.limited, d.base.hash])
  const removedAllNow = limited ? removedAll.filter((p) => !draft.named.some((n) => n.subjectType === 'user' && n.subjectId === p.id)) : []
  // a long list would push General access out of sight: the first few, then "Show all"
  const [removedOpen, setRemovedOpen] = useState(false)
  const removedList = removedOpen ? removedAllNow : removedAllNow.slice(0, REMOVED_SHOWN)
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
        saidOf={(o) => t('accessEdit.added', { name: o.name, access: t(startAccess(o) === 'write' ? 'folderAccess.canEdit' : 'folderAccess.canView') })}
        onAdd={(o) => {
          setDraft((x) => {
            // Viewer, or Editor when the folders above let them edit already (access adds up: Viewer would be lower than
            // what they have, and cannot be picked)
            const added = addNamed(x, { subjectType: o.kind, subjectId: o.id }, startAccess(o))
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
            // what the folders above give them (access adds up): a lower role cannot be chosen here, and the row says
            // where the wider one comes from ("Editor from 'Company-wide'")
            const from = data && !limited && !always ? inheritedOf(data.above, n) : null
            const lower = from && from.access === 'write' ? from : null
            const tag = byConversion.has(`${k}:${n.access}`)
            const second = [
              lower ? t('folderAccess.fromAbove', { role: t('folderAccess.canEdit'), folder: folderWord(lower.folder) }) : g ? t('accessEdit.kind.group', { n: g.memberIds.length }) : u ? [t(`role.${u.role}`), u.status === 'disabled' ? t('folderAccess.switchedOff') : null].filter(Boolean).join(' · ') : '',
              tag ? t('folderAccess.byConversion') : null,
            ].filter(Boolean).join(' · ')
            return (
              <li key={k} className="flex min-h-12 items-center gap-2.5 py-1.5" data-testid="sharing-row" data-subject={k} data-access={n.access}>
                {g ? <GroupTile size={24} /> : <Avatar user={faceOf({ id: n.subjectId, name: label })} size={24} />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-row font-medium text-ink">{label}</p>
                  {second && <p className="text-xs [overflow-wrap:anywhere] text-faint sm:truncate" data-testid={lower ? 'sharing-row-from' : 'sharing-row-second'}>{second}</p>}
                </div>
                <select
                  value={always ? STAFF : n.access}
                  aria-label={`${t('folderAccess.levelOf', { name: label })}: ${always ? t('folderAccess.manager') : t(n.access === 'write' ? 'folderAccess.canEdit' : 'folderAccess.canView')}`}
                  onChange={(e) => {
                    if (e.target.value === REMOVE) void removeRow(i, label)
                    else if (e.target.value !== STAFF) setDraft((x) => setNamed(x, i, e.target.value as Access))
                  }}
                  className={roleSelect}
                  data-testid="sharing-level"
                >
                  {always ? (
                    <option value={STAFF}>{t('folderAccess.manager')}</option>
                  ) : (
                    <>
                      <option value="read" disabled={!!lower && n.access !== 'read'}>{t('folderAccess.canView')}</option>
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
              <span className="shrink-0 pr-1 text-xs text-muted">{t('folderAccess.manager')}</span>
            </li>
          )}
          {nothing && data && <li className="py-2 text-sm text-faint" data-testid="sharing-empty">{t('folderAccess.noneAdded')}</li>}
        </ul>
      </section>

      {/* Drive's "Access removed" on a limited folder: people who can open the folder above but not this one. Add lists
          them here as Viewer (asked before Save, like any more access) */}
      {removedAllNow.length > 0 && (
        <section aria-labelledby={removedId} data-testid="sharing-removed">
          <h3 id={removedId} className="text-title-sm font-semibold text-ink">{t('folderAccess.accessRemoved')}</h3>
          <ul className={clsx('mt-1 divide-y divide-line transition-opacity', dim && 'opacity-60')}>
            {removedList.map((p) => (
              <li key={p.id} className="flex min-h-12 items-center gap-2.5 py-1.5" data-testid="sharing-removed-row" data-subject={`user:${p.id}`}>
                <Avatar user={faceOf({ id: p.id, name: p.name })} size={24} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-row font-medium text-ink">{p.name}</p>
                  <p className="text-xs text-faint">{t('folderAccess.cantOpenHere')}</p>
                </div>
                <Button size="sm" aria-label={t('folderAccess.addBack', { name: p.name })} onClick={() => { setDraft((x) => addNamed(x, { subjectType: 'user', subjectId: p.id })); setFocusKey(`user:${p.id}`) }} className="shrink-0 max-sm:min-h-11" data-testid="sharing-add-back">
                  {t('folderAccess.addBackShort')}
                </Button>
              </li>
            ))}
          </ul>
          {removedAllNow.length > removedList.length && (
            <button type="button" onClick={() => setRemovedOpen(true)} className="mt-1 text-xs font-medium text-accent-text underline-offset-2 hover:underline max-sm:min-h-11" data-testid="sharing-removed-more">
              {t('folderAccess.showAllRemoved', { n: removedAllNow.length })}
            </button>
          )}
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
        keepOne={d.keepsOne}
        // nothing to pick from before the first answer: what the folder above gives is not known yet (review M1)
        loading={!data}
        // access adds up: lower than what the folders above give the team needs Limit access ("Limit access to change this")
        canPick={(l) => pickable(l, { limited, above })}
        needsLimit={!limited && limitShown && above !== 'none' && data?.everyoneAbove?.folder != null ? { text: t(above === 'write' ? 'folderAccess.teamEditsAbove' : 'folderAccess.teamViewsAbove', { team, folder: folderWord(data.everyoneAbove.folder) }), use: () => setLimit(true) } : null}
      />

      {limitShown && (
        <LimitAccess
          on={limited}
          parent={parent === '' ? t('files.root') : nameOf(parent!)}
          onChange={setLimit}
          // shared/ or skills/ with nobody added and nothing from the team root: off would leave no setting (refused)
          locked={teamFolder && limited && draft.basic !== 'read' && draft.basic !== 'write' && above === 'none' && !draft.named.some((n) => n.access !== 'none')}
        />
      )}

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
      {/* greyed by its words (muted), not by opacity: the text keeps its contrast (axe). The visible words are the
          button's name; where it leads is added for screen readers */}
      <button type="button" onClick={onOpen} className="flex min-h-12 w-full items-center gap-2.5 rounded-md py-1.5 text-left transition hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
        {tile ? <GroupTile size={24} /> : face ? <Avatar user={face} size={24} /> : <GroupTile size={24} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-muted">{title}</p>
          <p className="text-xs [overflow-wrap:anywhere] text-muted sm:truncate">
            {second} · <span className="text-accent-text">{t('folderAccess.changeThere')}</span><span className="sr-only"> ({label})</span>
            <ChevronRight size={12} className="ml-0.5 inline align-[-1px] text-accent-text" aria-hidden />
          </p>
        </div>
        {level && <span className="shrink-0 pr-1 text-xs text-muted">{level}</span>}
      </button>
    </li>
  )
}

const RANK_OF: Record<Access, number> = { none: 0, read: 1, write: 2 }

/** Access removed shows this many before "Show all". */
const REMOVED_SHOWN = 3

/** General access, as Drive has it: Restricted or the team, then the team's role; one true line under it, and where it
 * comes from when the folder has no setting of its own. On a folder that is not limited a choice lower than what the
 * folders above give cannot be picked: the line says so, with "Limit access to change this". */
function GeneralAccess({ level, teamName, teamEdit, hint, onPick, onAudience, from, keepOne, loading, canPick, needsLimit }: {
  level: Access
  teamName: string
  teamEdit: boolean
  hint: string
  onPick: (level: Access) => void
  onAudience: (a: 'restricted' | 'team') => void
  from: { text: string; label: string; open: () => void } | null
  keepOne: boolean
  loading: boolean
  canPick: (level: Access) => boolean
  needsLimit: { text: string; use: () => void } | null
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
          aria-label={loading ? t('folderAccess.general') : `${t('folderAccess.general')}: ${audience === 'restricted' ? t('folderAccess.restricted') : teamName}`}
          onChange={(e) => onAudience(e.target.value as 'restricted' | 'team')}
          className={clsx(generalSelect, 'min-w-0 flex-1 disabled:cursor-default disabled:opacity-60')}
          disabled={loading}
          aria-busy={loading || undefined}
          data-testid="sharing-general-select"
          data-level={level}
        >
          {loading && <option value="">{t('common.loading')}</option>}
          <option value="restricted" disabled={!canPick('none')}>{t('folderAccess.restricted')}</option>
          <option value="team">{teamName}</option>
        </select>
        {!loading && audience === 'team' && (
          <select value={level} aria-label={`${t('folderAccess.teamRole', { team: teamName })}: ${t(level === 'write' ? 'folderAccess.canEdit' : 'folderAccess.canView')}`} onChange={(e) => onPick(e.target.value as Access)} disabled={loading} className={clsx(generalSelect, 'shrink-0')} data-testid="sharing-general-role">
            <option value="read" disabled={!canPick('read')}>{t('folderAccess.canView')}</option>
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
      {!loading && needsLimit && (
        <p className="mt-1 text-xs text-muted" data-testid="sharing-general-above">
          {!from && <>{needsLimit.text}{' · '}</>}
          <button type="button" onClick={needsLimit.use} className="font-medium text-accent-text underline-offset-2 hover:underline max-sm:min-h-11" data-testid="sharing-general-limit">{t('folderAccess.lowerNeedsLimit')}</button>
        </p>
      )}
      {keepOne && <p role="note" className="mt-1.5 rounded-lg bg-warn-soft px-2.5 py-1.5 text-xs text-warn" data-testid="sharing-keep-one">{t('folderAccess.keepOne')}</p>}
    </section>
  )
}

/** Drive's Share › Settings › Limit access: only people added here open it (and the owner and admins, the Managers). */
function LimitAccess({ on, parent, onChange, locked }: { on: boolean; parent: string; onChange: (on: boolean) => void; locked?: boolean }) {
  const t = useT()
  const id = useId()
  return (
    <section aria-labelledby={id} data-testid="sharing-settings">
      <h3 id={id} className="text-title-sm font-semibold text-ink">{t('folderAccess.settings')}</h3>
      <div className="mt-1.5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-row font-medium text-ink">{t('folderAccess.limit')}</p>
          <p className="text-xs text-muted" id={`${id}-hint`}>{t('folderAccess.limitHint', { parent })}</p>
          {locked && <p className="mt-0.5 text-xs text-muted" id={`${id}-locked`} data-testid="sharing-limit-locked">{t('folderAccess.limitLocked')}</p>}
        </div>
        <Switch checked={on} onChange={onChange} disabled={locked} label={t('folderAccess.limit')} hideLabel describedBy={locked ? `${id}-hint ${id}-locked` : `${id}-hint`} testId="sharing-limit" />
      </div>
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

