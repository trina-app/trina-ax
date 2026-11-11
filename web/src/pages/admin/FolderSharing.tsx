// The admin's part of the Files page's "Who can open it" panel (components/FolderAccess.tsx; docs/DECISIONS.md "Who can
// open it, like Drive's Share"): the people and groups who can open the folder, one general access setting, and an
// admin changes them right here, like Google Drive's Share dialog. The words are for office workers: no rules, paths
// or reasons on screen. Everything on screen comes from the admin endpoints (the server refuses them to members), and
// what a change does comes from the server's answer for exactly the draft on screen (useRulesDraft: the same draft,
// answer, hash and save as Admin › Folder permissions' editor). Save asks the server again at once, and asks the admin
// before anyone gets more access. Mounted once per folder (`key`), so a draft, its hash and its answers belong to one
// folder. Phones: the panel is the app's bottom sheet (#339's shared phone rows are not on dev yet; the rows here use
// the same 44 px sizes and switch to them when they land).
import clsx from 'clsx'
import { ChevronRight, TriangleAlert, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { Access, Folder, FolderEditPreview, Group, Project, User } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { addNamed, draftOf, removeNamed, setNamed, type Basic, type Draft } from '../../lib/access-edit'
import { isSkillsPath } from '../../lib/access-view'
import { aboveRows, askTitle, generalLevel, hasPanel, latentLines, outcomeLines, overridingGroup, overrideText, parentOf, sameOutcome, saveAsk, type AboveRow } from '../../lib/folder-sharing'
import { useFolderName } from '../../lib/folderLabels'
import { useLocale, useT } from '../../i18n'
import { Button, ErrorNote, IconButton, Skeleton, confirmDialog } from '../../components/ui'
import { Avatar } from '../../components/Avatar'
import { GroupTile } from '../../components/GroupTile'
import { useFaceOf } from '../../store/people'
import { useMeStrict } from '../../store/session'
import { AddNamed, type ListControl } from './AddNamed'
import { useRulesDraft } from './useRulesDraft'

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
          api.call(API.listUsers),
          api.call(API.listGroups),
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
  const folder = loaded.folders.find((f) => f.path === path && !f.hidden) ?? null
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

const LEVEL_WORD: Record<Access, 'folderAccess.canView' | 'folderAccess.canEdit' | 'folderAccess.noAccess'> = { read: 'folderAccess.canView', write: 'folderAccess.canEdit', none: 'folderAccess.noAccess' }

function Body({ path, projectOf, onSwap, onLeave, guard, list, footer, folder, users, groups, below, reload, onStale }: FolderSharingProps & {
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
  const stored = useMemo(() => draftOf(d.base.rules, d.root).draft, [d.base.rules, d.root])
  const storedAccess = useMemo(() => new Map(stored.named.map((n) => [`${n.subjectType}:${n.subjectId}`, n.access])), [stored])
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
  const general = generalLevel(draft.basic, above)
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
  const anyNone = draft.named.some((n) => n.access === 'none') || fromAbove.some((r) => r.access === 'none')
  // shared/ and skills/ keep a setting of their own: "same as the folder above" only when it is what they have now
  const choices = d.choices.filter((b) => b !== 'follow' || folder?.keep !== 'team' || d.initial.basic === 'follow')
  const parent = parentOf(path)
  const basicLabel = (b: Basic) =>
    b === 'follow' ? (parent === '' || parent === null ? t('folderAccess.sameAsTop') : hasPanel(parent) ? t('folderAccess.sameAs', { folder: nameOf(parent) }) : t('folderAccess.sameAsAbove'))
      : b === 'named' ? t('folderAccess.onlyHere')
        : t(b === 'read' ? 'folderAccess.everyoneView' : 'folderAccess.everyoneEdit', { team })
  const hint = (() => {
    if (general === 'none' && !anyone) return t('folderAccess.hintAdminsOnly')
    if (draft.basic === 'follow') return t(above === 'none' ? 'folderAccess.hintAboveOnly' : above === 'read' ? 'folderAccess.hintAboveView' : 'folderAccess.hintAboveEdit', { team })
    if (draft.basic === 'named') return t('folderAccess.hintOnly')
    return t(draft.basic === 'read' ? 'folderAccess.hintEveryoneView' : 'folderAccess.hintEveryoneEdit', { team })
  })()

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
      // asked again now, for exactly this draft: what is saved is what the admin was shown
      const fresh = await d.askNow()
      if (!fresh || !shown || gone()) return
      // another admin changed this folder: the note says so (the draft kept); the next Save decides
      if (hash !== null && fresh.hash !== hash) return
      if (!sameOutcome(shown, fresh)) {
        setChangedNow(true)
        return
      }
      const ask = saveAsk(fresh)
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
        const again = await d.askNow()
        if (gone()) return
        if (!again || again.hash !== fresh.hash || !sameOutcome(fresh, again)) {
          if (again && again.hash === fresh.hash) setChangedNow(true)
          return
        }
      }
      if (gone() || leaving.current) return
      const saved = await d.save()
      if (saved) reload()
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
  const openFrom = (folderPath: string) => (hasPanel(folderPath) ? void swap(folderPath) : void leave(`/admin/folders?folder=${encodeURIComponent(folderPath)}`))
  const fromText = (folderPath: string) => (folderPath === '' ? t('folderAccess.fromTop') : t('folderAccess.fromFolder', { folder: nameOf(folderPath) }))

  const taken = new Set(draft.named.map((n) => `${n.subjectType}:${n.subjectId}`))
  // the owner and admins can always open it: a setting would change nothing for them
  const addable = users.filter((u) => u.role === 'member')
  const nothing = !draft.named.length && !fromAbove.length
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
      <ul ref={listRef} className={clsx('divide-y divide-line transition-opacity', dim && 'opacity-60')} data-testid="sharing-list" aria-busy={(!ready && !d.preview.error) || undefined}>
        {draft.named.map((n, i) => {
          const k = `${n.subjectType}:${n.subjectId}`
          const u = n.subjectType === 'user' ? userById.get(n.subjectId) : undefined
          const g = n.subjectType === 'group' ? groupById.get(n.subjectId) : undefined
          const label = u?.name ?? g?.name ?? '?'
          const always = !!u && (u.role === 'owner' || u.role === 'admin')
          const over = u ? overridingGroup(draft, u.id, groupById) : null
          const offerNone = n.access === 'none' || storedAccess.get(k) === 'none'
          const second = g ? t('accessEdit.kind.group', { n: g.memberIds.length })
            : over ? overrideText(t, over.name, n.access)
              : u ? [t(`role.${u.role}`), u.status === 'disabled' ? t('folderAccess.switchedOff') : null].filter(Boolean).join(' · ') : ''
          return (
            <li key={k} className="flex min-h-12 items-center gap-2.5 py-1.5" data-testid="sharing-row" data-subject={k} data-access={n.access}>
              {g ? <GroupTile size={24} /> : <Avatar user={faceOf({ id: n.subjectId, name: label })} size={24} />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{label}</p>
                {second && <p className="text-xs [overflow-wrap:anywhere] text-faint sm:truncate" data-testid="sharing-row-second">{second}</p>}
              </div>
              {always ? (
                <span className="shrink-0 text-xs text-muted">{t('folderAccess.always')}</span>
              ) : (
                <select
                  value={n.access}
                  aria-label={t('folderAccess.levelOf', { name: label })}
                  onChange={(e) => setDraft((x) => setNamed(x, i, e.target.value as Access))}
                  className="h-8 shrink-0 cursor-pointer rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent max-sm:h-11"
                  data-testid="sharing-level"
                >
                  <option value="read">{t('folderAccess.canView')}</option>
                  <option value="write">{t('folderAccess.canEdit')}</option>
                  {offerNone && <option value="none">{t('folderAccess.noAccess')}</option>}
                </select>
              )}
              <IconButton
                label={t('folderAccess.remove', { name: label })}
                onClick={() => {
                  setDraft((x) => removeNamed(x, i))
                  search.current?.focus()
                }}
                className="shrink-0 max-sm:size-11"
                data-testid="sharing-remove"
              >
                <X size={15} />
              </IconButton>
            </li>
          )
        })}
        {[...projectRows.values()].map(({ project: p, folder: f }) => (
          <AboveButton key={`project:${f}`} onOpen={() => openFrom(f)} title={t('folderAccess.projectMembers')} second={t('folderAccess.fromProject', { project: p.name })} level={null} label={t('folderAccess.changeIn', { folder: nameOf(f) })} tile testId="sharing-above-project" />
        ))}
        {plainAbove.map((r) => {
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
        })}
        {nothing && data && <li className="py-2 text-sm text-faint" data-testid="sharing-empty">{t('folderAccess.noneAdded')}</li>}
      </ul>
      {!data && !d.preview.error && <Skeleton lines={2} />}
      {d.connected && <p className="text-xs text-muted" data-testid="sharing-connected">{t('folderAccess.connectedCopy')}</p>}
      {skills && <p className="text-xs text-muted" data-testid="sharing-skills">{t('folderAccess.skillsEdit')}</p>}

      <GeneralAccess value={draft.basic} choices={choices} label={basicLabel} hint={hint} except={anyNone} onChange={(b) => setDraft((x) => ({ ...x, basic: b }))}
        from={draft.basic === 'follow' && parent !== null && hasPanel(parent) ? () => void swap(parent) : null} fromText={parent !== null ? t('folderAccess.changeInShort', { folder: nameOf(parent) }) : ''} fromLabel={parent !== null ? t('folderAccess.changeIn', { folder: nameOf(parent) }) : ''} keepOne={d.keepsOne} />

      <div className="space-y-1 border-t border-line pt-3 text-xs text-muted">
        <p data-testid="sharing-footer">{t('folderAccess.adminsAlways')}</p>
        <p>
          {below > 0 && <span data-testid="sharing-below">{t('folderAccess.sharedDifferently', { n: below })} · </span>}
          <Link
            to={`/admin/folders?folder=${encodeURIComponent(path)}`}
            onClick={(e) => {
              e.preventDefault()
              void leave(`/admin/folders?folder=${encodeURIComponent(path)}`)
            }}
            className="text-accent-text underline-offset-2 hover:underline"
            data-testid="sharing-open-admin"
          >
            {t('folderAccess.openInAdmin')}
          </Link>
        </p>
      </div>

      <Footer to={footer}>
        <div className="w-full space-y-2" data-testid="sharing-footer-bar">
          {edited && d.saveable && <Outcome data={data} ready={ready} error={d.preview.error} lines={data ? lines(data) : []} onRetry={d.retry} />}
          {changedNow && <p role="status" className="text-xs text-warn" data-testid="sharing-changed-now">{t('folderAccess.changedNow')}</p>}
          {d.refused && <ErrorNote>{d.refused}</ErrorNote>}
          <div className="flex items-center justify-end gap-2">
            {edited ? (
              <>
                <Button variant="ghost" onClick={() => void (async () => {
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

function GeneralAccess({ value, choices, label, hint, except, onChange, from, fromText, fromLabel, keepOne }: {
  value: Basic
  choices: Basic[]
  label: (b: Basic) => string
  hint: string
  except: boolean
  onChange: (b: Basic) => void
  from: (() => void) | null
  fromText: string
  fromLabel: string
  keepOne: boolean
}) {
  const t = useT()
  const id = useId()
  return (
    <section aria-labelledby={id} data-testid="sharing-general">
      <h3 id={id} className="text-sm font-semibold text-ink">{t('folderAccess.general')}</h3>
      <select
        value={value}
        aria-labelledby={id}
        onChange={(e) => onChange(e.target.value as Basic)}
        className="mt-1.5 h-9 w-full cursor-pointer rounded-lg border border-field-border bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent max-sm:h-11"
        data-testid="sharing-general-select"
      >
        {choices.map((b) => <option key={b} value={b}>{label(b)}</option>)}
      </select>
      <p className="mt-1.5 text-xs text-muted" data-testid="sharing-general-hint">
        {hint}
        {except && <> {t('folderAccess.hintExcept')}</>}
        {from && (
          <>
            {' '}
            <button type="button" onClick={from} aria-label={fromLabel} className="font-medium text-accent-text underline-offset-2 hover:underline" data-testid="sharing-general-from">
              {fromText} ›
            </button>
          </>
        )}
      </p>
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

