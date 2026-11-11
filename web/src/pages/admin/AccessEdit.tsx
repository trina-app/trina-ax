// Admin › Folder permissions › By folder: changing one folder's rules (stage 5). It replaces the chosen folder's part of
// the screen (beside the tree; the whole screen on a phone, as a dialog with its own way back) and asks the first
// question first: the basic access for everyone not named, then the people and groups named, each with read, read and
// write, or no access. While the admin edits, the server works out what saving would change (POST
// /api/admin/access/edit-preview, server/src/admin/access-edit.ts: the permission function itself) and the panel shows
// it: who loses access first, who gains, the folders below that change with them, and the warnings the server finds;
// the Save button says the impact. Requests wait for the typing to settle, and an answer for an older draft is
// dropped (the request is aborted). Old role rows are read as the basic access and saved as "everyone" (no access
// changes; lib/access-edit.ts says why). A save carries the hash of the rules it started from: when another admin
// changed them meanwhile the server refuses it (409), and the panel asks again, says so and keeps the draft.
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Check, Info, TriangleAlert, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import type { Access, Folder, FolderEditChange, FolderEditPreview, FolderEditWarning, Group, User } from '@mycel/shared/api'
import { addNamed, outcomesOf, outcomeWords, removeNamed, setNamed, type Basic, type Draft } from '../../lib/access-edit'
import { folderName, isSkillsPath, skillEditorsText, skillManagersOf, skillsLockedText, sourceText, whoSeesText } from '../../lib/access-view'
import { useT, type MessageKey } from '../../i18n'
import { Badge, Button, ErrorNote, IconButton, Skeleton, confirmDialog, useFocusTrap, useMediaQuery } from '../../components/ui'
import { Avatar } from '../../components/Avatar'
import { GroupTile } from '../../components/GroupTile'
import { useFaceOf } from '../../store/people'
import { useFolderPeople } from './SkillManagers'
import { useRulesDraft, type useEditPreview } from './useRulesDraft'
import { AddNamed, type ListControl } from './AddNamed'

export { PREVIEW_DEBOUNCE_MS } from './useRulesDraft'
/** At most this many names of a change are said in a row; the rest are counted (the server sends up to 50). */
const NAMES_SHOWN = 6
const ACCESSES: readonly Access[] = ['read', 'write', 'none']
/** The keys that move between tabs (and choose one) */
const TAB_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End'])

/** Below 640px the panel is the whole screen (a dialog with its own way back). */
const useNarrow = (query = '(max-width: 639.98px)') => useMediaQuery(query)

export interface AccessEditProps {
  path: string
  /** the folder's rule row (rules, rulesHash, keep), or null when it has none yet */
  folder: Folder | null
  users: User[]
  groups: Group[]
  /** after Cancel or close (asked first when something was changed) */
  onClose: () => void
  /** after a save, with the folder's rule row as the server stored it */
  onSaved: (saved: Folder) => void | Promise<void>
  /** another admin changed the rules: the rule rows and the tree come again */
  onStale: () => void
  /** set by the panel: resolves true when the panel may go (nothing changed, or the admin agreed to drop it) */
  guard?: MutableRefObject<() => Promise<boolean>>
  /** opened from By person: closing goes back there, and the way out says so */
  returnLabel?: string
  /** a phone's page under Admin's bar (its ‹ is the way back, AccessTree.tsx gives the editor its own history entry): no
   * full-screen panel of its own, no second way back */
  inPage?: boolean
}

export default function AccessEdit({ path, folder, users, groups, onClose, onSaved, onStale, guard, returnLabel, inPage }: AccessEditProps) {
  const t = useT()
  const narrow = useNarrow() && !inPage
  const root = path === ''
  const headingId = useId()
  const box = useRef<HTMLElement>(null)

  /** people and groups named, groups first, each by name (the server keeps them by id) */
  const sorted = (d: Draft): Draft => {
    const label = (n: Draft['named'][number]) => (n.subjectType === 'group' ? groups.find((g) => g.id === n.subjectId)?.name : users.find((u) => u.id === n.subjectId)?.name) ?? n.subjectId
    return { ...d, named: [...d.named].sort((a, b) => (a.subjectType === b.subjectType ? label(a).localeCompare(label(b)) : a.subjectType === 'group' ? -1 : 1)) }
  }
  const d = useRulesDraft({ path, folder, sort: sorted, onStale })
  const { base, hadRules, draft, setDraft, stale, saving, refused, converted, preview, data, edited, keepsOne, connected, choices, ready, why } = d

  // while a save is on its way the panel goes without asking: the save lands and the tree follows it
  const askToLeave = async () => !edited || saving || (await confirmDialog({ title: t('accessEdit.discardTitle'), body: t('accessEdit.discardBody'), confirm: t('accessEdit.discard'), danger: true }))
  if (guard) guard.current = askToLeave
  const leave = useRef(askToLeave)
  leave.current = askToLeave
  // in-app moves outside the panel ask first too while something was changed (the app's router has no navigation
  // blocker): a link (the admin menu, any other) or a tab (By folder / By person), clicked or moved through with the
  // arrows. The panel's own buttons ask already. When the admin drops the draft, the same click or key goes through.
  useEffect(() => {
    if (!edited) return
    let pass = false
    /** the question is open: more clicks or keys (a held arrow) wait for it instead of asking again */
    let asking = false
    const onEvent = (e: Event) => {
      if (pass || e.defaultPrevented) return
      const mouse = e instanceof MouseEvent
      const key = mouse ? '' : (e as globalThis.KeyboardEvent).key
      if (mouse ? e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey : !TAB_KEYS.has(key)) return
      const el = (e.target as Element | null)?.closest?.(mouse ? 'a[href], [role="tab"]' : '[role="tab"]')
      if (!(el instanceof HTMLElement) || box.current?.contains(el)) return
      // a link that opens a new tab or saves a file leaves the panel where it is
      if (el instanceof HTMLAnchorElement && (el.target === '_blank' || el.hasAttribute('download'))) return
      e.preventDefault()
      e.stopPropagation()
      if (asking || (!mouse && (e as globalThis.KeyboardEvent).repeat)) return
      asking = true
      void leave.current().then((ok) => {
        asking = false
        if (!ok) return
        pass = true
        try {
          if (mouse) el.click()
          else el.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key, bubbles: true }))
        } finally {
          pass = false
        }
      })
    }
    document.addEventListener('click', onEvent, true)
    document.addEventListener('keydown', onEvent, true)
    return () => {
      document.removeEventListener('click', onEvent, true)
      document.removeEventListener('keydown', onEvent, true)
    }
  }, [edited])
  const requestClose = async () => {
    if (await askToLeave()) onClose()
  }
  // a tab closed or reloaded with changes not saved: the browser asks
  useEffect(() => {
    if (!edited) return
    const ask = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [edited])

  /** the add list: Esc closes it first (on a phone the focus trap takes Esc before the field sees it) */
  const list = useRef({ open: false, close: () => {} })
  const onEscape = () => {
    if (list.current.open) {
      list.current.close()
      return
    }
    void requestClose()
  }
  // a phone: the whole screen, with the focus kept inside (Esc goes back)
  useFocusTrap(box, narrow, onEscape)
  // beside the tree: the heading takes the focus when the panel opens
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!narrow) heading.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // nothing edited: plain "Save" (disabled); once there is something to save, what it does, the outcomes kept apart
  // ("2 can no longer open it · 1 can no longer edit"), or that only folders inside change, or nothing
  const impact = ready ? outcomeWords(t, outcomesOf(data!.changes)) : null
  const saveLabel = !impact || !d.saveable ? t('common.save')
    : impact.length ? t('accessEdit.saveParts', { parts: impact.join(' · ') })
      : data!.below.length ? t('accessEdit.saveBelow')
        : t('accessEdit.saveNone')
  const whyId = useId()
  const save = async () => {
    const saved = await d.save()
    if (saved) await onSaved(saved)
  }

  const name = root ? t('accessView.rootFolder') : folderName(t, path)
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])

  return (
    <section
      ref={box}
      role={narrow ? 'dialog' : undefined}
      aria-modal={narrow || undefined}
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        // beside the tree: Esc closes too (on a phone the focus trap does it)
        if (narrow || e.key !== 'Escape' || e.defaultPrevented) return
        e.preventDefault()
        onEscape()
      }}
      className={clsx('flex flex-col', narrow && 'fixed inset-0 z-40 bg-surface')}
      data-testid="edit-panel"
      data-path={path}
    >
      {returnLabel && !narrow && !inPage && (
        <button type="button" onClick={() => void requestClose()} className="-mx-2 mb-2 inline-flex items-center gap-1.5 self-start rounded-lg px-2 py-1.5 text-label font-medium text-muted transition hover:bg-hover hover:text-ink" data-testid="edit-return">
          <ArrowLeft size={15} aria-hidden /> {returnLabel}
        </button>
      )}
      <header className={clsx('flex items-start gap-2', narrow ? 'border-b border-line py-2 pr-4 pl-2 pt-[max(0.5rem,var(--safe-top))]' : 'pb-1')}>
        {narrow && (
          <IconButton label={returnLabel ?? t('accessEdit.back')} onClick={() => void requestClose()} className="shrink-0" data-testid="edit-back">
            <ArrowLeft size={20} />
          </IconButton>
        )}
        <div className={clsx('min-w-0 flex-1', narrow && 'pt-1')}>
          {/* one line: what the panel does and for which folder */}
          <h3 id={headingId} ref={heading} tabIndex={-1} data-autofocus className="text-base font-semibold [overflow-wrap:anywhere] text-ink outline-none">
            {hadRules ? t('accessEdit.title') : t('accessTree.addRules')}
            <span aria-hidden className="mx-1.5 font-normal text-faint">·</span>
            <span className="font-normal text-muted" data-testid="edit-path">
              {name}
            </span>
          </h3>
        </div>
        {!narrow && !inPage && (
          <IconButton label={t('common.close')} onClick={() => void requestClose()} className="-mt-1 -mr-1 shrink-0 focus-visible:-outline-offset-2" data-testid="edit-close">
            <X size={18} />
          </IconButton>
        )}
      </header>

      <div className={clsx('space-y-5', narrow ? 'scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4' : 'pt-2')}>
        <HowRules />
        {stale && (
          <div role="status" className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn" data-testid="edit-stale">
            <p className="flex items-start gap-1.5">
              <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
              <span>{t(stale === 'kept' ? 'accessEdit.staleKept' : 'accessEdit.staleLoaded')}</span>
            </p>
            {stale === 'kept' && (
              <button
                type="button"
                className="mt-1 ml-[1.15rem] font-medium underline underline-offset-2"
                onClick={d.loadTheirs}
                data-testid="edit-stale-load"
              >
                {t('accessEdit.staleLoad')}
              </button>
            )}
          </div>
        )}
        {(converted.member || converted.admin) && (
          <p role="note" className="flex items-start gap-1.5 rounded-lg bg-subtle px-2.5 py-1.5 text-xs text-muted" data-testid="edit-converted">
            <Info size={13} className="mt-px shrink-0" aria-hidden />
            <span>{t(converted.member && converted.admin ? 'accessEdit.convertedBoth' : converted.member ? 'accessEdit.convertedMember' : 'accessEdit.convertedAdmin')}</span>
          </p>
        )}

        <BasicAccess
          value={draft.basic}
          choices={choices}
          root={root}
          followText={data && data.above ? followText(t, data.above, data.members) : null}
          connected={connected}
          keepsOne={keepsOne}
          keepsOneId={whyId}
          onChange={(b) => setDraft((d) => ({ ...d, basic: b }))}
        />

        <NamedList
          draft={draft}
          users={userById}
          groups={groupById}
          allUsers={users}
          allGroups={groups}
          list={list}
          onChange={setDraft}
        />

        <Result path={path} preview={preview} data={data} ready={ready} rulesHash={base.hash} onRetry={d.retry} />

        {refused && (
          <div data-testid="edit-refused">
            <ErrorNote>{refused}</ErrorNote>
          </div>
        )}
      </div>

      <footer className={clsx('flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface', narrow ? 'px-4 py-3 pb-[max(0.75rem,var(--safe-bottom))]' : 'sticky bottom-0 z-10 mt-5 py-3')}>
        {/* nothing changed: a disabled Save says so to a screen reader only; the other reasons show */}
        {why && why !== 'keep' && (
          <p id={whyId} className={clsx('mr-auto min-w-0 text-xs text-faint', why === 'same' && 'sr-only')} data-testid="edit-save-why">
            {t(why === 'same' ? 'accessEdit.why.same' : why === 'failed' ? 'accessEdit.why.failed' : 'accessEdit.why.waits')}
          </p>
        )}
        <Button variant="ghost" onClick={() => void requestClose()} data-testid="edit-cancel">
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void save()} busy={saving} disabled={!!why} aria-describedby={why ? whyId : undefined} data-testid="edit-save">
          {saveLabel}
        </Button>
      </footer>
    </section>
  )
}

// ---------------- the basic access ----------------

/** "Follow the folder above" in words: what the folder gets with no rules of its own, now, from the server. One folder
 * for everyone: "지금은 shared 규칙: 모두 · 고칠 수 있음"; no rule: "지금은 팀장과 관리자만"; several: with where from. */
function followText(t: ReturnType<typeof useT>, above: FolderEditPreview['above'] & {}, members: number): string {
  const who = whoSeesText(t, { who: above }, members)
  const rules = above.filter((w) => w.reason === 'rule')
  if (!rules.length) return t('accessEdit.follow.now', { who })
  const folders = new Set((rules.some((w) => w.access !== 'none') ? rules.filter((w) => w.access !== 'none') : rules).map((w) => w.folder ?? ''))
  if (folders.size === 1) return t('accessEdit.follow.from', { folder: folderName(t, [...folders][0]!), who })
  return t('accessEdit.follow.mixed', { who, source: sourceText(t, { who: above, path: '\u0000' }, members) })
}

const BASIC_LABEL: Record<Basic, MessageKey> = { follow: 'accessEdit.basic.follow', named: 'accessEdit.basic.named', read: 'accessEdit.basic.read', write: 'accessEdit.basic.write' }

function BasicAccess({ value, choices, followText: follow, connected, keepsOne, keepsOneId, onChange }: {
  value: Basic
  choices: Basic[]
  root: boolean
  followText: string | null
  connected: boolean
  keepsOne: boolean
  keepsOneId: string
  onChange: (b: Basic) => void
}) {
  const t = useT()
  const name = useId()
  // the choices say what they do; only "same as the folder above" adds what that gives now
  return (
    <fieldset data-testid="edit-basic">
      <legend className="text-sm font-semibold text-ink">{t('accessEdit.basic')}</legend>
      <div className="mt-1.5 grid gap-0.5">
        {choices.map((b) => (
          <label
            key={b}
            className={clsx('flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors', value === b ? 'bg-accent-soft' : 'hover:bg-hover')}
            data-testid={`edit-basic-${b}`}
          >
            <input type="radio" name={name} value={b} checked={value === b} onChange={() => onChange(b)} className="mt-[3px] shrink-0 accent-[var(--c-accent)]" />
            <span className="min-w-0">
              <span className="block text-ink">{t(BASIC_LABEL[b])}</span>
              {b === 'follow' && (
                <span className="block text-xs [overflow-wrap:anywhere] text-muted" data-testid="edit-follow-now">
                  {follow ?? <span className="inline-block h-3 w-40 animate-pulse rounded bg-subtle align-middle" aria-hidden />}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
      {connected && (
        <p className="mt-1 px-2.5 text-xs text-muted" data-testid="edit-connected">
          {t('accessEdit.connectedNoWrite')}
        </p>
      )}
      {keepsOne && (
        <p id={keepsOneId} role="note" className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-warn-soft px-2.5 py-1.5 text-xs text-warn" data-testid="edit-keep-one">
          <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
          <span>{t('accessEdit.keepTeam')}</span>
        </p>
      )}
    </fieldset>
  )
}

/** "How rules work": the three rules behind the editor, folded away (they used to repeat as paragraphs). */
function HowRules() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div data-testid="edit-how">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted transition hover:text-ink"
        data-testid="edit-how-toggle"
      >
        <Info size={13} aria-hidden /> {t('accessEdit.howTitle')}
      </button>
      <ul id={id} hidden={!open} className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-muted marker:text-faint">
        <li>{t('accessEdit.basicHint')}</li>
        <li>{t('accessEdit.namedHint')}</li>
        <li>{t('accessEdit.howFollow')}</li>
      </ul>
    </div>
  )
}

// ---------------- people and groups ----------------

/** a person's picture or a group's tile before each name (20 px; with the gap, a phone's access switch line starts
 * under the name: pl-7) */
const FACE = 20

function NamedList({ draft, users, groups, allUsers, allGroups, list, onChange }: {
  draft: Draft
  users: Map<string, User>
  groups: Map<string, Group>
  allUsers: User[]
  allGroups: Group[]
  list: ListControl
  onChange: (d: Draft | ((d: Draft) => Draft)) => void
}) {
  const t = useT()
  const titleId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  /** after a row is removed, the focus goes to the row now at that place, else to the search */
  const search = useRef<HTMLInputElement>(null)
  const focusRow = useRef<number | null>(null)
  useEffect(() => {
    const i = focusRow.current
    if (i === null) return
    focusRow.current = null
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-testid="edit-named"]') ?? []
    const row = rows[Math.min(i, rows.length - 1)]
    ;(row?.querySelector<HTMLElement>('input:checked') ?? search.current)?.focus()
  })
  const taken = new Set(draft.named.map((n) => `${n.subjectType}:${n.subjectId}`))
  const faceOf = useFaceOf()
  return (
    <section aria-labelledby={titleId} data-testid="edit-people">
      <h4 id={titleId} className="text-sm font-semibold text-ink">
        {t('accessEdit.named')}
      </h4>
      <AddNamed
        inputRef={search}
        users={allUsers}
        groups={allGroups}
        taken={taken}
        list={list}
        onAdd={(o) => onChange((d) => addNamed(d, { subjectType: o.kind, subjectId: o.id }))}
      />
      {draft.named.length ? (
        <ul ref={listRef} className="mt-2 divide-y divide-line" data-testid="edit-named-list">
          {draft.named.map((n, i) => {
            const u = n.subjectType === 'user' ? users.get(n.subjectId) : undefined
            const g = n.subjectType === 'group' ? groups.get(n.subjectId) : undefined
            const label = u?.name ?? g?.name ?? '?'
            const always = u && (u.role === 'owner' || u.role === 'admin')
            return (
              <li key={`${n.subjectType}:${n.subjectId}`} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 py-2" data-testid="edit-named" data-subject={`${n.subjectType}:${n.subjectId}`}>
                {n.subjectType === 'group' ? <GroupTile size={FACE} /> : <Avatar user={faceOf({ id: n.subjectId, name: label })} size={FACE} />}
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
                  {/* a phone: the whole name shows (it wraps); the access switch goes to its own line below */}
                  <span className="min-w-0 text-sm font-medium break-words text-ink sm:truncate">{label}</span>
                  <span className="text-xs text-faint">{n.subjectType === 'group' ? t('accessEdit.kind.group', { n: g?.memberIds.length ?? 0 }) : u ? t(`role.${u.role}`) : ''}</span>
                  {u?.status === 'disabled' && (
                    <span data-testid="edit-named-off">
                      <Badge>{t('accessEdit.disabled')}</Badge>
                    </span>
                  )}
                  {always && <span className="text-xs text-faint">· {t('accessEdit.always')}</span>}
                </span>
                <div className="flex shrink-0 items-center gap-x-2 max-sm:basis-full max-sm:pl-7">
                  <AccessChoice
                    name={label}
                    value={n.access}
                    onChange={(a) => onChange((d) => setNamed(d, i, a))}
                  />
                  <IconButton
                    label={t('accessEdit.remove', { name: label })}
                    onClick={() => {
                      focusRow.current = i
                      onChange((d) => removeNamed(d, i))
                    }}
                    className="shrink-0 focus-visible:-outline-offset-2 max-sm:ml-auto"
                    data-testid="edit-named-remove"
                  >
                    <X size={15} />
                  </IconButton>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-faint">{t('accessEdit.noneNamed')}</p>
      )}
    </section>
  )
}

/** Read / read and write / no access for one person or group: native radios (arrow keys move), drawn as one strip. */
function AccessChoice({ name, value, onChange }: { name: string; value: Access; onChange: (a: Access) => void }) {
  const t = useT()
  const group = useId()
  return (
    <fieldset className="shrink-0">
      <legend className="sr-only">{t('accessEdit.accessOf', { name })}</legend>
      <div className="inline-flex rounded-lg bg-subtle p-0.5">
        {ACCESSES.map((a) => (
          <label
            key={a}
            className={clsx(
              'cursor-pointer rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent max-sm:py-1.5',
              value === a ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
            )}
            data-testid={`edit-access-${a}`}
          >
            <input type="radio" name={group} value={a} checked={value === a} onChange={() => onChange(a)} className="sr-only" />
            {t(`access.${a}`)}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

// ---------------- the result ----------------

function Result({ path, preview, data, ready, rulesHash, onRetry }: { path: string; preview: ReturnType<typeof useEditPreview>; data: FolderEditPreview | null; ready: boolean; rulesHash: string | null; onRetry: () => void }) {
  const t = useT()
  const titleId = useId()
  // skills/ and its folders: who could change the team's skills with these rules, and who of skills/' managers not here
  const skills = isSkillsPath(path)
  const inSkills = skills && path.includes('/')
  const top = useFolderPeople(inSkills ? path.slice(0, path.indexOf('/')) : null)
  // each person's access here now (asked again when the rules the panel started from change), and with these rules:
  // the people the answer names as changing, the others as now. A change that names only part of its people leaves
  // the line out rather than guess
  const here = useFolderPeople(inSkills ? path : null, rulesHash ?? '')
  const after = new Map<string, Access>()
  for (const c of data?.changes ?? []) for (const p of c.people) after.set(p.id, c.after)
  const exact = !!data && data.changes.every((c) => c.people.length === c.count)
  const locked = inSkills && exact && top.data && here.data ? skillsLockedText(t, skillManagersOf(top.data.values()), (id) => after.get(id) ?? here.data!.get(id)?.access) : null
  const less = data?.changes.filter((c) => c.direction === 'less') ?? []
  const more = data?.changes.filter((c) => c.direction === 'more') ?? []
  // the counts show; who exactly (and the folders below) opens on request
  const [showPeople, setShowPeople] = useState(false)
  const peopleId = useId()
  let body: ReactNode
  if (!data) body = preview.error ? <ErrorNote onRetry={onRetry}>{preview.error}</ErrorNote> : <Skeleton lines={3} className="mt-2" />
  else {
    body = (
      <div className={clsx('transition-opacity', !ready && 'opacity-60')}>
        <p className="mt-1 text-label text-ink" data-testid="edit-next">
          {t('accessEdit.next', { who: whoSeesText(t, { who: data.next }, data.members) })}
        </p>
        {skills && (
          <p className="mt-1 text-xs text-muted" data-testid="edit-skill-editors">
            {skillEditorsText(t, data.next, data.members)}
          </p>
        )}
        {locked && (
          <p className="mt-1 text-xs text-muted" data-testid="edit-skill-locked">
            {locked}
          </p>
        )}
        {data.warnings.map((w) => (
          <p key={w.kind} role="note" className="mt-2 flex items-start gap-1.5 rounded-lg bg-warn-soft px-2.5 py-1.5 text-xs text-warn" data-testid="edit-warning" data-kind={w.kind}>
            <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
            <span>{warningText(t, w)}</span>
          </p>
        ))}
        {!data.changes.length ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted" data-testid="edit-no-change">
            <Check size={13} className="shrink-0 text-ok" aria-hidden />
            {t('accessEdit.noChange')}
          </p>
        ) : (
          <>
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="edit-summary">
              {/* the outcomes kept apart: losing edit is not losing access */}
              {outcomeWords(t, outcomesOf(less)).map((w) => <span key={w} className="font-medium text-warn">{w}</span>)}
              {outcomeWords(t, outcomesOf(more)).map((w) => <span key={w} className="font-medium text-ink">{w}</span>)}
              {data.below.length > 0 && <span className="text-muted">{t('accessEdit.below')}</span>}
              <button
                type="button"
                aria-expanded={showPeople}
                aria-controls={peopleId}
                onClick={() => setShowPeople((s) => !s)}
                className="font-medium text-accent-text underline-offset-2 hover:underline"
                data-testid="edit-show-people"
              >
                {t(showPeople ? 'accessEdit.hidePeople' : 'accessEdit.showPeople')}
              </button>
            </p>
            <div id={peopleId} hidden={!showPeople} data-testid="edit-people-detail">
              {less.length > 0 && <Changes title={t('accessEdit.lessTitle', { n: less.reduce((n, c) => n + c.count, 0) })} changes={less} testId="edit-less" />}
              {more.length > 0 && <Changes title={t('accessEdit.moreTitle', { n: more.reduce((n, c) => n + c.count, 0) })} changes={more} testId="edit-more" />}
              {data.below.length > 0 && <Below data={data} path={path} />}
            </div>
          </>
        )}
        {preview.error && (
          <p role="status" className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-danger" data-testid="edit-preview-stale">
            {t('accessEdit.previewFailed')}
            <button type="button" className="font-medium underline underline-offset-2" onClick={onRetry}>
              {t('common.retry')}
            </button>
          </p>
        )}
      </div>
    )
  }
  return (
    <section aria-labelledby={titleId} aria-busy={!ready || undefined} data-testid="edit-result" data-ready={ready}>
      <h4 id={titleId} className="flex items-center gap-2 text-sm font-semibold text-ink">
        {t('accessEdit.result')}
        {!ready && !preview.error && <span className="text-xs font-normal text-faint">{t('accessEdit.computing')}</span>}
      </h4>
      {body}
    </section>
  )
}

function warningText(t: ReturnType<typeof useT>, w: FolderEditWarning): string {
  switch (w.kind) {
    case 'team-files':
      return t('accessEdit.warn.teamFiles', { n: w.count })
    case 'team-instructions':
      return t('accessEdit.warn.teamInstructions', { n: w.count })
    case 'skills-everyone-writes':
      return t('accessEdit.warn.skillsEveryone', { n: w.count })
    case 'root-everyone':
      return t('accessEdit.warn.root', { n: w.count })
  }
}

function Changes({ title, changes, testId }: { title: string; changes: FolderEditChange[]; testId: string }) {
  const t = useT()
  return (
    <div className="mt-3" data-testid={testId}>
      <h5 className="text-xs font-semibold text-muted">{title}</h5>
      <ul className="mt-1 divide-y divide-line rounded-lg border border-line">
        {changes.map((c) => {
          const names = c.people.slice(0, NAMES_SHOWN).map((u) => u.name).join(', ')
          const rest = c.count - Math.min(c.people.length, NAMES_SHOWN)
          return (
            <li key={`${c.before}-${c.after}`} className="px-3 py-2" data-testid="edit-change">
              <p className="flex flex-wrap items-center gap-x-1.5 text-xs">
                <span className="text-muted">{t(`access.${c.before}`)}</span>
                <ArrowRight size={12} className="text-faint" aria-label={t('rules.becomes')} />
                <span className={clsx('font-medium', c.direction === 'less' ? 'text-warn' : 'text-ink')}>{t(`access.${c.after}`)}</span>
              </p>
              <p className="mt-0.5 text-label [overflow-wrap:anywhere] text-ink">{rest > 0 ? t('accessEdit.names', { names, n: rest }) : names}</p>
              {c.chatsReset > 0 && <p className="mt-0.5 text-xs text-faint">{t('accessEdit.chats', { n: c.chatsReset })}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** The folders below with rules of their own where access changes too (the people no rule there is for follow this
 * folder): each with how many lose and gain, and the first names. Folders below without rules change as this one does. */
function Below({ data, path }: { data: FolderEditPreview; path: string }) {
  const t = useT()
  return (
    <div className="mt-3" data-testid="edit-below">
      <h5 className="text-xs font-semibold text-muted">{t('accessEdit.below')}</h5>
      <ul className="mt-1 divide-y divide-line rounded-lg border border-line">
        {data.below.map((b) => {
          const total = b.less + b.more
          const names = b.people.map((u) => u.name).join(', ')
          const rest = total - b.people.length
          return (
            <li key={b.path} className="px-3 py-2" data-testid="edit-below-folder" data-path={b.path}>
              <p className="text-label font-medium [overflow-wrap:anywhere] text-ink" title={b.path}>
                {shortBelow(b.path, path)}
              </p>
              <p className="mt-0.5 text-xs [overflow-wrap:anywhere] text-muted">
                {[b.less ? t('accessEdit.belowLess', { n: b.less }) : null, b.more ? t('accessEdit.belowGain', { n: b.more }) : null].filter(Boolean).join(' · ')}
                {' · '}
                {rest > 0 ? t('accessEdit.names', { names, n: rest }) : names}
              </p>
            </li>
          )
        })}
        {data.belowMore > 0 && <li className="px-3 py-2 text-xs text-faint">{t('accessEdit.belowMore', { n: data.belowMore })}</li>}
      </ul>
    </div>
  )
}

/** A folder below the edited one, said from there ("apollo/drafts" under "projects"). */
const shortBelow = (p: string, base: string) => (base && p.startsWith(base + '/') ? p.slice(base.length + 1) : p)
