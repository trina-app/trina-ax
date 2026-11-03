// One person's team folders (or someone new's), from the server's answer (GET /api/admin/access/people/:id, POST
// /api/admin/access/new-person): grouped by kind, each row with the access and the reason in words
// (lib/access-view.ts). Read only. Shown by Folder permissions › By person (AccessPeople.tsx), where a row's "View or
// change rules" opens that folder's rule editor, and by the invite and add-member dialogs ("Folders this person will
// see"). Access is never told by colour: the level is grey text with an icon; the warning colour marks a risk the
// screen computes (a member who manages team skills).
import clsx from 'clsx'
import { ChevronRight, Eye, EyeOff, FolderSearch, Pencil, Signpost, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Group, PersonAccessResponse, PersonFolderAccess, Role } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { cleanPrefix, groupRows, levelOf, reasonText, riskOf, shortPath, summaryLines, type Level, type Names, type Section, type Who } from '../../lib/access-view'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { Badge, Button, EmptyState, ErrorNote, IconButton, Skeleton, inputCls, useAnnounce } from '../../components/ui'
import type { MemberRole } from './people-choices'

/** The address of Folder permissions › By person: a member (`person`), or someone new (`new=1`, with the role and
 * groups to compute with); `prefix` narrows to one folder. Links, Back and reloading keep the choice. */
export function personViewLink(o: { person?: string; newPerson?: { role: MemberRole; groupIds: readonly string[] }; prefix?: string }): string {
  const q = new URLSearchParams({ view: 'people' })
  if (o.newPerson) {
    q.set('new', '1')
    if (o.newPerson.role !== 'member') q.set('role', o.newPerson.role)
    if (o.newPerson.groupIds.length) q.set('groups', o.newPerson.groupIds.join(','))
  } else if (o.person) q.set('person', o.person)
  if (o.prefix) q.set('prefix', o.prefix)
  return `/admin/folders?${q}`
}

const LEVEL_ICON: Record<Level, LucideIcon> = { write: Pencil, read: Eye, listed: Signpost, none: EyeOff }
const levelKey = (l: Level): MessageKey => (l === 'write' ? 'access.write' : l === 'read' ? 'access.read' : l === 'listed' ? 'accessView.level.listed' : 'accessView.level.none')

/** The access as words and an icon, in ink and greys only: write and read in ink (write heavier), a name shown on the
 * way in muted, none in faint. */
function LevelLabel({ level, className }: { level: Level; className?: string }) {
  const t = useT()
  const Icon = LEVEL_ICON[level]
  return (
    <span className={clsx('items-start gap-1.5', level === 'write' ? 'font-medium text-ink' : level === 'read' ? 'text-ink' : level === 'listed' ? 'text-muted' : 'text-faint', className)}>
      <Icon size={13} className="mt-[3px] shrink-0" aria-hidden />
      <span>{t(levelKey(level))}</span>
    </span>
  )
}

function Row({ f, role, names, onEdit }: { f: PersonFolderAccess; role: Role; names: Names; onEdit?: (f: PersonFolderAccess) => void }) {
  const t = useT()
  const level = levelOf(f)
  const root = t('accessView.rootFolder')
  const full = f.path === '' ? root : f.path
  const short = shortPath(f.path, root)
  const meta = f.group ? t('rules.groupOf', { name: f.group.name }) : f.projects?.length ? f.projects.map((p) => t('accessView.projectOf', { name: p.name })).join(', ') : null
  const risk = riskOf(f, role)
  const editLabel = t('accessView.editNamed', { path: full })
  // rules inside a personal folder never apply (the server ignores them): nothing to open there
  const canEdit = onEdit && !f.kinds.includes('personal')
  return (
    <li className="flex items-start gap-3 py-2.5" data-testid="access-row" data-path={f.path} data-level={level}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="block max-w-full min-w-0 truncate text-sm font-medium text-ink" title={full}>
            <span aria-hidden>{short}</span>
            <span className="sr-only">{full}</span>
          </span>
          {meta && <span className="text-xs text-faint">{meta}</span>}
          {f.exists === false && <span className="text-xs text-faint">{t('rules.missingOnDisk')}</span>}
        </div>
        {/* narrow: the access on its own line under the path; wide: its own column */}
        <LevelLabel level={level} className="mt-0.5 flex text-xs @lg/results:hidden" />
        <p className="mt-0.5 text-xs text-muted" data-testid="access-reason">
          {reasonText(t, f, role, names)}
        </p>
        {risk && (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="access-risk">
            <Badge tone="warn">{t('accessView.risk.skills')}</Badge>
            <span className="text-xs text-muted">{t('accessView.risk.skillsHint')}</span>
          </p>
        )}
      </div>
      <LevelLabel level={level} className="hidden w-32 shrink-0 text-[13px] @lg/results:flex" />
      {canEdit ? (
        <>
          <span className="-my-1.5 hidden shrink-0 @lg/results:block">
            <Button size="sm" variant="ghost" aria-label={editLabel} onClick={() => onEdit(f)} data-testid="access-edit">
              {t('accessView.edit')}
            </Button>
          </span>
          <span className="-my-1 shrink-0 max-sm:-my-1.5 @lg/results:hidden">
            <IconButton label={editLabel} onClick={() => onEdit(f)} data-testid="access-edit">
              <SlidersHorizontal size={15} />
            </IconButton>
          </span>
        </>
      ) : (
        // the own folder has nothing to open: an empty place the button's width, so the access stays in its column
        onEdit && (
          <span className="invisible -my-1.5 hidden shrink-0 @lg/results:block" aria-hidden>
            <Button size="sm" variant="ghost" tabIndex={-1}>
              {t('accessView.edit')}
            </Button>
          </span>
        )
      )}
    </li>
  )
}

function SectionList({ section, rows, role, names, onEdit, heading: H }: { section: Section; rows: PersonFolderAccess[]; role: Role; names: Names; onEdit?: (f: PersonFolderAccess) => void; heading: 'h3' | 'h4' }) {
  const t = useT()
  const id = useId()
  return (
    <section aria-labelledby={id} className="mt-5" data-testid="access-section" data-section={section}>
      <H id={id} className="flex items-baseline gap-2 border-b border-line pb-1.5 text-xs font-semibold text-muted">
        {t(`accessView.section.${section}`)}
        <span className="font-normal text-faint tabular-nums">{rows.length}</span>
      </H>
      <ul className="divide-y divide-line">
        {rows.map((f) => (
          <Row key={f.path} f={f} role={role} names={names} onEdit={onEdit} />
        ))}
      </ul>
    </section>
  )
}

/** The folders the person cannot see at all, folded under "N folders they cannot see". */
function HiddenRows({ rows, role, names, onEdit, heading }: { rows: PersonFolderAccess[]; role: Role; names: Names; onEdit?: (f: PersonFolderAccess) => void; heading: 'h3' | 'h4' }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="mt-5 border-t border-line pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-muted transition hover:bg-hover hover:text-ink max-sm:min-h-10"
        data-testid="access-hidden-toggle"
      >
        <ChevronRight size={15} className={clsx('transition', open && 'rotate-90')} aria-hidden />
        {t('accessView.hidden', { n: rows.length })}
      </button>
      <div id={id} hidden={!open} data-testid="access-hidden">
        {open && groupRows(rows).map((g) => <SectionList key={g.section} section={g.section} rows={g.rows} role={role} names={names} onEdit={onEdit} heading={heading} />)}
      </div>
    </div>
  )
}

/** Narrow to one folder (and what is below it): the server's `prefix`. */
function PrefixForm({ value, onApply }: { value: string; onApply: (p: string) => void }) {
  const t = useT()
  const [typed, setTyped] = useState(value)
  const [bad, setBad] = useState(false)
  const id = useId()
  useEffect(() => setTyped(value), [value])
  return (
    <form
      role="search"
      aria-label={t('accessView.prefix')}
      className="mt-4 flex flex-wrap items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        const p = cleanPrefix(typed)
        setBad(p === null)
        if (p !== null) onApply(p)
      }}
    >
      <div className="min-w-0 flex-[1_1_12rem]">
        <label htmlFor={`${id}-in`} className="sr-only">
          {t('accessView.prefix')}
        </label>
        <div className="relative">
          <FolderSearch size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
          <input
            id={`${id}-in`}
            type="search"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value)
              setBad(false)
            }}
            placeholder={t('accessView.prefixHint')}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={`${inputCls} pl-9`}
            aria-invalid={bad || undefined}
            aria-describedby={bad ? `${id}-bad` : undefined}
            data-testid="access-prefix"
          />
        </div>
        {bad && (
          <span id={`${id}-bad`} role="alert" className="mt-1 block text-xs text-danger">
            {t('accessView.prefixBad')}
          </span>
        )}
      </div>
      <Button type="submit" data-testid="access-prefix-apply">
        {t('accessView.prefixApply')}
      </Button>
      {value && (
        <Button variant="ghost" onClick={() => onApply('')} data-testid="access-prefix-clear">
          {t('accessView.prefixClear')}
        </Button>
      )}
    </form>
  )
}

/**
 * The answer, page by page. `fetchPage(cursor)` asks the server (no cursor: the first page); the parent gives this a
 * new `key` when the person, role, groups or folder change, and a new `reloadKey` after rules were saved. The summary
 * is said to screen readers each time an answer arrives.
 */
export function AccessResults({ who, fetchPage, names, prefix = '', onPrefix, onEdit, heading = 'h3', reloadKey = 0, onShown }: {
  who: Who
  fetchPage: (cursor?: string) => Promise<PersonAccessResponse>
  names: Names
  prefix?: string
  onPrefix?: (p: string) => void
  onEdit?: (f: PersonFolderAccess) => void
  heading?: 'h3' | 'h4'
  reloadKey?: number
  /** after an answer is on the screen (the page puts the focus back on a row whose rules changed) */
  onShown?: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const announce = useAnnounce()
  const [data, setData] = useState<PersonAccessResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  /** more than one page shown: the count line stays after the last one */
  const [paged, setPaged] = useState(false)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const countRef = useRef<HTMLParagraphElement>(null)
  const say = (r: PersonAccessResponse) => announce(summaryLines(t, who, r.folders, r, prefix).join(' '))

  useEffect(() => {
    let live = true
    setError(null)
    fetchRef.current().then(
      (r) => {
        if (!live) return
        setData(r)
        say(r)
      },
      (e) => live && setError(errorText(e, locale, t('error.network'))),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, reloadKey])

  const shownRef = useRef(onShown)
  shownRef.current = onShown
  useLayoutEffect(() => {
    if (data) shownRef.current?.()
  }, [data])

  const loadMore = async () => {
    if (!data?.nextCursor || more.busy) return
    setMore({ busy: true, error: null })
    try {
      const r = await fetchRef.current(data.nextCursor)
      const next = { ...r, folders: [...data.folders, ...r.folders] }
      setData(next)
      setPaged(true)
      setMore({ busy: false, error: null })
      say(next)
      // the button goes with the last page: the count line takes the focus instead of the page
      if (r.nextCursor === null) requestAnimationFrame(() => countRef.current?.focus())
    } catch (e) {
      setMore({ busy: false, error: errorText(e, locale, t('error.network')) })
    }
  }

  if (!data) return error ? <ErrorNote onRetry={() => setAttempt((n) => n + 1)}>{error}</ErrorNote> : <Skeleton lines={6} className="mt-1" />

  const rows = data.folders
  const shown = rows.filter((f) => levelOf(f) !== 'none')
  const hidden = rows.filter((f) => levelOf(f) === 'none')
  const lines = summaryLines(t, who, rows, data, prefix)
  return (
    <div className="@container/results" data-testid="access-results">
      <div data-testid="access-summary">
        <p className="text-sm text-ink">{lines[0]}</p>
        {lines.slice(1).map((l) => (
          <p key={l} className="mt-0.5 text-xs text-muted">
            {l}
          </p>
        ))}
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote onRetry={() => setAttempt((n) => n + 1)}>{error}</ErrorNote>
        </div>
      )}
      {onPrefix && <PrefixForm value={prefix} onApply={onPrefix} />}
      {rows.length === 0 ? (
        <EmptyState icon={<FolderSearch size={26} aria-hidden />} title={prefix ? t('accessView.emptyPrefix', { path: prefix }) : t('accessView.empty')} />
      ) : (
        <>
          {groupRows(shown).map((g) => (
            <SectionList key={g.section} section={g.section} rows={g.rows} role={data.role} names={names} onEdit={onEdit} heading={heading} />
          ))}
          {hidden.length > 0 && <HiddenRows rows={hidden} role={data.role} names={names} onEdit={onEdit} heading={heading} />}
        </>
      )}
      {(data.nextCursor !== null || paged) && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3">
          {data.nextCursor !== null && (
            <Button size="sm" onClick={() => void loadMore()} busy={more.busy} data-testid="access-more">
              {t('common.loadMore')}
            </Button>
          )}
          <p ref={countRef} tabIndex={-1} className="text-xs text-faint tabular-nums outline-none">
            {t('accessView.loaded', { n: rows.length, total: data.total })}
          </p>
          {more.error && (
            <div className="w-full">
              <ErrorNote onRetry={() => void loadMore()}>{more.error}</ErrorNote>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The invite and add-member dialogs: "Folders this person will see", folded until asked, worked out by the server from
 * the role and groups chosen above (the same answer as Folder permissions › By person, which the link opens).
 */
export function NewPersonPreview({ role, groupIds, groups }: { role: MemberRole; groupIds: string[]; groups: Group[] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const id = useId()
  const names: Names = { group: (g) => groups.find((x) => x.id === g)?.name, person: () => undefined }
  return (
    <div className="border-t border-line pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-ink transition hover:bg-hover max-sm:min-h-10"
        data-testid="new-person-preview-toggle"
      >
        <ChevronRight size={15} className={clsx('shrink-0 text-muted transition', open && 'rotate-90')} aria-hidden />
        {t('accessView.preview')}
      </button>
      <div id={id} hidden={!open} className="pt-2" data-testid="new-person-preview">
        {open && (
          <>
            <AccessResults
              key={`${role}|${groupIds.join(',')}`}
              who={{ kind: 'new' }}
              fetchPage={(cursor) => api.call(API.explainNewPersonAccess, { body: { role, groupIds, cursor } })}
              names={names}
            />
            <Link to={personViewLink({ newPerson: { role, groupIds } })} className="mt-3 inline-block text-xs text-accent-text underline-offset-2 hover:underline" data-testid="new-person-preview-full">
              {t('accessView.previewFull')}
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
