// Admin › Folder permissions › By person (read only): "what can this person see, and why?" and "what will someone new
// see?". One searchable list of people (someone new on top, the active people, then the disabled ones); the chosen
// person's team folders with the access and the reason, from the server's answers (AccessResults.tsx). Nothing here
// changes access: a row's "View or change rules" opens that folder's edit panel in By folder (`?edit=<path>&back=<this
// address>`), and closing or saving it comes back here, the focus on that row's button. The choice is in the address
// (`?view=people&person=<id>`, `?view=people&new=1&role=admin&groups=<id>,<id>`, `&prefix=<folder>`).
import clsx from 'clsx'
import { Search, UserPlus } from 'lucide-react'
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import type { Group, PersonAccessResponse, PersonFolderAccess, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { cleanPrefix, type Names, type Who } from '../../lib/access-view'
import { useLocale, useT } from '../../i18n'
import { Badge, EmptyState, ErrorNote, Field, Skeleton, inputCls, useMediaQuery } from '../../components/ui'
import { AccessResults, PrefixForm } from './AccessResults'
import { GroupChecks, RoleSelect, type MemberRole } from './people-choices'
import { useLoad } from './common'
import { InFolderHeader } from './folder-slots'
import { useAdminBar } from './phoneBar'

/** the "someone new" option of the list (not a person id: those are [a-z0-9_-]) */
const NEW = '+new'
/** at most this many people in the list at once; a big team narrows it by typing */
const LIST_MAX = 100

const fold = (s: string) => s.normalize('NFC').toLocaleLowerCase()

export default function AccessPeople() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const folders = useLoad(async () => (await api.call(API.listFolders)).items)
  const location = useLocation()
  const picker = useRef<HTMLDivElement>(null)
  const results = useRef<HTMLDivElement>(null)

  const isNew = params.get('new') === '1'
  const person = isNew ? null : params.get('person')
  const role: MemberRole = params.get('role') === 'admin' ? 'admin' : 'member'
  // groups that are gone are left out (the server refuses unknown groups)
  const groupIds = (params.get('groups') ?? '').split(',').filter((g) => g && (!groups.data || groups.data.some((x) => x.id === g)))
  // the folder narrowed to, as the server takes it ("/projects/" is projects); null: the address has no usable path
  const rawPrefix = params.get('prefix') ?? ''
  const cleaned = cleanPrefix(rawPrefix)
  const prefix = cleaned ?? ''
  const selected = isNew ? NEW : person
  // the role and groups just chosen, shown until the address has them (the router updates it in a transition, and a
  // controlled checkbox would spring back meanwhile); the address wins as soon as it changes, Back included
  const chosen = `${role}|${groupIds.join(',')}`
  const [pending, setPending] = useState<{ from: string; role: MemberRole; groupIds: string[] } | null>(null)
  const shown = pending?.from === chosen ? pending : { role, groupIds }
  const choose = (c: { role?: MemberRole; groupIds?: string[] }) => {
    const next = { role: c.role ?? shown.role, groupIds: c.groupIds ?? shown.groupIds }
    setPending({ from: chosen, ...next })
    go(next, true)
  }

  /** a new address for the choice: a person or someone new pushes (Back returns), role / groups / folder replace */
  const go = (o: { person?: string | null; isNew?: boolean; role?: MemberRole; groupIds?: string[]; prefix?: string }, replace = false) => {
    const q = new URLSearchParams({ view: 'people' })
    const n = o.isNew ?? isNew
    if (n) {
      q.set('new', '1')
      const r = o.role ?? role
      if (r !== 'member') q.set('role', r)
      const g = o.groupIds ?? groupIds
      if (g.length) q.set('groups', g.join(','))
    } else if (o.person ?? person) q.set('person', (o.person ?? person)!)
    const p = o.prefix ?? prefix
    if (p) q.set('prefix', p)
    setParams(q, { replace })
  }
  // a phone (below 768 px): the list alone, and a person (or someone new) a page of their own over it, pushed, under
  // the bar with their name (adminScreens.ts); the two never share the screen
  const phone = useMediaQuery('(max-width: 767.98px)')
  const pick = (id: string, pointer: boolean) => {
    if (id !== selected) go(id === NEW ? { isNew: true } : { isNew: false, person: id })
    // a tap on a narrow screen: the list sits above the answer, so bring the answer up (keys stay in the list)
    if (pointer && !phone) {
      requestAnimationFrame(() => {
        const a = picker.current?.getBoundingClientRect()
        const b = results.current?.getBoundingClientRect()
        const still = matchMedia('(prefers-reduced-motion: reduce)').matches
        if (a && b && b.top >= a.bottom - 1) results.current?.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' })
      })
    }
  }

  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name
  const ruleFolders = useMemo(() => (folders.data ? new Set(folders.data.filter((f) => f.rules.length).map((f) => f.path)) : undefined), [folders.data])
  const names: Names = { group: groupName, person: (id) => users.data?.find((u) => u.id === id)?.name, ruleFolders }
  const user = person ? users.data?.find((u) => u.id === person) : undefined
  useAdminBar(phone ? (isNew ? t('accessView.newPerson') : user?.name ?? null) : null)
  const onPage = phone && selected !== null
  // the folder's edit panel, in By folder (it knows the folder's row and the tree); this address to come back to
  const onEdit = (f: PersonFolderAccess) => setParams(new URLSearchParams({ edit: f.path, back: params.toString() }))
  /** the folder whose rules were just changed in By folder (the panel comes back here with it): its row may have moved
   * (to the folded folders, or out of them), and the focus goes to it, not to the page */
  const refocus = useRef<string | null>(typeof (location.state as { refocus?: unknown } | null)?.refocus === 'string' ? (location.state as { refocus: string }).refocus : null)
  const onShown = () => {
    const path = refocus.current
    if (path === null) return
    refocus.current = null
    const a = document.activeElement
    if (a && a !== document.body && a.isConnected) return
    const row = [...(results.current?.querySelectorAll<HTMLElement>('[data-testid="access-row"]') ?? [])].find((r) => r.dataset.path === path)
    const button = [...(row?.querySelectorAll<HTMLElement>('[data-testid="access-edit"]') ?? [])].find((b) => b.offsetParent !== null)
    ;(button ?? results.current?.querySelector<HTMLElement>('[data-testid="access-hidden-toggle"]'))?.focus()
  }
  // the lists beside the answer: without groups the names are missing, without folders no rules can be opened; said,
  // with a way to try again
  const side = [groups.error && `${t('accessView.groupsFailed')} ${groups.error}`, folders.error && `${t('accessView.foldersFailed')} ${folders.error}`].filter(Boolean)
  const sideNote = side.length > 0 && (
    <div className="mb-4" data-testid="access-side-error">
      <ErrorNote
        onRetry={() => {
          if (groups.error) void groups.reload()
          if (folders.error) void folders.reload()
        }}
      >
        {side.join(' ')}
      </ErrorNote>
    </div>
  )
  const answer = (key: string, who: Who, fetchPage: (cursor?: string) => Promise<PersonAccessResponse>) =>
    cleaned === null ? (
      // a path in the address that is none ("../etc", too long): said, and the way out stays
      <div data-testid="access-results">
        <ErrorNote>{t('accessView.prefixUrlBad')}</ErrorNote>
        <PrefixForm value={rawPrefix.slice(0, 200)} bad onApply={(p) => go({ prefix: p })} />
      </div>
    ) : (
      <AccessResults
        key={key}
        who={who}
        fetchPage={fetchPage}
        names={names}
        prefix={prefix}
        onPrefix={(p) => go({ prefix: p })}
        onEdit={onEdit}
        heading="h4"
        onShown={onShown}
        notFound={t('accessView.unknownPerson')}
      />
    )

  let body
  if (users.error) body = <ErrorNote onRetry={() => void users.reload()}>{users.error}</ErrorNote>
  else if (isNew && groups.error) body = sideNote
  else if (!users.data || (isNew && !groups.data)) body = <Skeleton lines={6} />
  else if (!selected) body = <EmptyState title={t('accessView.pick')} />
  // nobody by that id (deleted, or a wrong address): no retry, choose someone
  else if (!isNew && !user) body = <EmptyState title={t('accessView.unknownPerson')}>{t('accessView.pick')}</EmptyState>
  else if (isNew) {
    body = (
      <>
        {sideNote}
        <div className="mb-4" data-testid="access-new-setup">
          <h3 className="text-base font-semibold text-ink">{t('accessView.newPerson')}</h3>
          <p className="mt-0.5 text-xs text-muted">{t('accessView.newNote')}</p>
          <div className="mt-3 flex flex-col gap-3">
            <div className="max-w-60">
              <Field label={t('members.role')}>
                <RoleSelect value={shown.role} onChange={(r) => choose({ role: r })} testId="access-new-role" />
              </Field>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-label font-medium text-ink">{t('admin.groups')}</legend>
              <GroupChecks groups={groups.data ?? []} value={shown.groupIds} onChange={(g) => choose({ groupIds: g })} />
            </fieldset>
          </div>
        </div>
        {answer(`new|${role}|${groupIds.join(',')}|${prefix}`, { kind: 'new' }, (cursor) =>
          api.call(API.explainNewPersonAccess, { body: { role, groupIds, ...(prefix ? { prefix } : {}), ...(cursor !== undefined ? { cursor } : {}) } }),
        )}
      </>
    )
  } else {
    const u = user!
    body = (
      <>
        {sideNote}
        <div className="mb-4" data-testid="access-person">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 text-base font-semibold break-words text-ink">{u.name}</h3>
            <Badge>{t(`role.${u.role}`)}</Badge>
            {u.status === 'disabled' && <Badge>{t('members.disabled')}</Badge>}
          </div>
          {/* without the group list the names are not known: the note above says so, nothing is guessed here */}
          {groups.data && <p className="mt-0.5 text-xs text-muted">{u.groupIds.map((g) => groupName(g)).filter(Boolean).join(', ') || t('members.noGroups')}</p>}
          {u.status === 'disabled' && (
            <p role="note" className="mt-2 rounded-lg bg-subtle px-3 py-2 text-xs text-muted" data-testid="access-off-note">
              {t('accessView.offNote')}
            </p>
          )}
        </div>
        {answer(`person|${u.id}|${prefix}`, { kind: 'person', name: u.name, off: u.status === 'disabled' }, (cursor) =>
          api.call(API.explainPersonAccess, { params: { id: u.id }, query: { ...(prefix ? { prefix } : {}), ...(cursor !== undefined ? { cursor } : {}) } }),
        )}
      </>
    )
  }

  return (
    // no card: the people list and the answer sit on the page, split by a hairline; the search is in the page header
    <section aria-labelledby="access-people-title" data-testid="access-people">
      <h3 id="access-people-title" className="sr-only">
        {t('accessView.title')}
      </h3>
      <p className="mb-3 text-xs text-muted" hidden={onPage}>{t('accessView.desc')}</p>
      {/* side by side when the page is wide enough, else the list above the answer */}
      <div className="@container">
        <div className="flex flex-col gap-4 @2xl:flex-row @2xl:gap-0">
          <div ref={picker} hidden={onPage} className="border-b border-line pb-4 @2xl:w-64 @2xl:shrink-0 @2xl:border-r @2xl:border-b-0 @2xl:pr-4 @2xl:pb-0 max-md:border-b-0">
            <PersonPicker users={users.data} groups={groups.data ?? []} value={selected} onPick={pick} />
          </div>
          <div ref={results} hidden={phone && selected === null} className="min-w-0 flex-1 scroll-mt-4 @2xl:pl-5" data-testid="access-answer">
            {body}
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * One list to choose from: someone new, the active people, the disabled ones apart below. A listbox: Up and Down move,
 * Home and End jump, Enter or Space choose (choosing loads an answer, so moving alone does not); Down from the search
 * field goes to the first option and Up from there goes back. Only one option is in the Tab order (the one last
 * focused, else the chosen one).
 */
function PersonPicker({ users, groups, value, onPick }: { users: User[] | null; groups: Group[]; value: string | null; onPick: (id: string, pointer: boolean) => void }) {
  const t = useT()
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState<string | null>(null)
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const options = useRef(new Map<string, HTMLElement>())
  if (!users) return <Skeleton lines={5} />

  const q = fold(query.trim())
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? ''
  const matches = (u: User) => !q || [u.name, u.username, ...u.groupIds.map(groupName)].some((s) => fold(s).includes(q))
  const byName = (a: User, b: User) => a.name.localeCompare(b.name, locale) || a.id.localeCompare(b.id)
  const active = users.filter((u) => u.status === 'active' && matches(u)).sort(byName)
  const off = users.filter((u) => u.status !== 'active' && matches(u)).sort(byName)
  const activeShown = active.slice(0, LIST_MAX)
  const offShown = off.slice(0, Math.max(0, LIST_MAX - activeShown.length))
  // the chosen person stays in the list (a link from Members can choose someone past the first LIST_MAX)
  const chosen = value ? users.find((u) => u.id === value) : undefined
  if (chosen && matches(chosen) && !activeShown.includes(chosen) && !offShown.includes(chosen)) (chosen.status === 'active' ? activeShown : offShown).push(chosen)
  const notShown = Math.max(0, active.length + off.length - activeShown.length - offShown.length)
  const showNew = !q || fold(t('accessView.newPerson')).includes(q)
  const ids = [...(showNew ? [NEW] : []), ...activeShown.map((u) => u.id), ...offShown.map((u) => u.id)]
  const tabbable = focused && ids.includes(focused) ? focused : value && ids.includes(value) ? value : ids[0]

  const focusAt = (i: number) => {
    const id = ids[Math.max(0, Math.min(ids.length - 1, i))]
    if (id) options.current.get(id)?.focus()
  }
  const onKey = (id: string) => (e: KeyboardEvent) => {
    const i = ids.indexOf(id)
    if (e.key === 'ArrowDown') focusAt(i + 1)
    else if (e.key === 'ArrowUp') i === 0 ? input.current?.focus() : focusAt(i - 1)
    else if (e.key === 'Home') focusAt(0)
    else if (e.key === 'End') focusAt(ids.length - 1)
    else if (e.key === 'Enter' || e.key === ' ') onPick(id, false)
    else return
    e.preventDefault()
  }
  const option = (id: string, label: string, meta: string, icon?: boolean) => {
    const on = id === value
    return (
      <div
        key={id}
        ref={(el) => {
          if (el) options.current.set(id, el)
          else options.current.delete(id)
        }}
        role="option"
        aria-selected={on}
        tabIndex={id === tabbable ? 0 : -1}
        onClick={(e) => onPick(id, e.detail > 0)}
        onKeyDown={onKey(id)}
        onFocus={() => setFocused(id)}
        className={clsx('flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 focus-visible:-outline-offset-2 max-sm:min-h-10', on ? 'bg-accent-soft' : 'hover:bg-hover')}
        data-testid="access-person-option"
        data-person={id === NEW ? 'new' : id}
      >
        {icon && <UserPlus size={15} className={clsx('mt-0.5 shrink-0', on ? 'text-accent-text' : 'text-muted')} aria-hidden />}
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-ink">{label}</span>
          <span className="block truncate text-xs text-muted">{meta}</span>
        </span>
      </div>
    )
  }
  const personOption = (u: User) => option(u.id, u.name, [t(`role.${u.role}`), u.groupIds.map(groupName).filter(Boolean).join(', ') || t('members.noGroups')].join(' · '))

  return (
    <div>
      <InFolderHeader slot="filter">
      <div className="relative w-full sm:w-72">
        <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' || !ids.length) return
            e.preventDefault()
            focusAt(0)
          }}
          placeholder={t('accessView.search')}
          aria-label={t('accessView.search')}
          aria-controls={ids.length ? listId : undefined}
          className={`${inputCls} h-9 pl-9`}
          data-testid="access-person-search"
        />
      </div>
      </InFolderHeader>
      {ids.length ? (
        <div id={listId} role="listbox" aria-label={t('accessView.people')} className="scroll-thin mt-2 max-h-72 space-y-0.5 overflow-y-auto overscroll-contain @2xl:max-h-[min(36rem,70vh)]" data-testid="access-person-list">
          {showNew && option(NEW, t('accessView.newPerson'), t('accessView.newPersonHint'), true)}
          {activeShown.map(personOption)}
          {offShown.length > 0 && (
            <div role="group" aria-label={t('accessView.off')} className="mt-2 border-t border-line pt-2">
              <div aria-hidden className="px-2.5 pb-1 text-xs font-medium text-faint">
                {t('accessView.off')}
              </div>
              {offShown.map(personOption)}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-3 px-2.5 text-sm text-faint">{t('accessView.noMatch')}</p>
      )}
      {notShown > 0 && <p className="mt-2 px-2.5 text-xs text-faint">{t('accessView.moreMatches', { n: notShown })}</p>}
    </div>
  )
}
