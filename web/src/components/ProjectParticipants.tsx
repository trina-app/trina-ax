// Who sees a team project (docs/DECISIONS.md "Projects live only in projects/", "Project members in one panel"): the
// member picker of the project create, share and members dialogs, and the count line under it. People come from the
// people directory (/api/people, every member may read it: a name and a title); groups ("부서" in Korean copy) are a
// member's own groups (Me.groups) and, for admins, every group (Admin › Groups). The creator always sees the project.
// Each row shows who it is the way the people list does (docs/DECISIONS.md "The member picker shows faces"): a person's
// picture and title (the directory's, which every member reads), a group's mark and, only for admins (who read every
// group's members in Admin › Groups), how many active people it holds and up to 3 of their faces; a member's own groups
// say "내 부서" instead, since members do not read who is in a group.
// The count is the server's (POST /api/projects/access-preview), so it matches who really sees it: its members ("멤버
// 3명"), the owner and admins only when they are members (docs/DECISIONS.md "Project contents only for members": no part
// for the owner and admins by role any more).
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Search, Users, X } from 'lucide-react'
import clsx from 'clsx'
import type { Group, ProjectAccessPreview, ProjectParticipant, ProjectPerson, SubjectType } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { usePeopleList } from '../store/people'
import { isAdmin, useMe } from '../store/session'
import { IconButton } from './ui'
import { Avatar, type AvatarUser } from './Avatar'
import { FaceStack } from './FaceStack'
import { ListIcon, ListRow, rowName } from './list/List'

export const participantKey = (x: { subjectType: string; subjectId: string }) => `${x.subjectType}:${x.subjectId}`
export const sameParticipants = (a: readonly ProjectParticipant[], b: readonly ProjectParticipant[]) => {
  const ka = new Set(a.map(participantKey))
  return ka.size === new Set(b.map(participantKey)).size && b.every((x) => ka.has(participantKey(x)))
}

/** A person or group the picker can show: its name, and for a person the directory's title (two people of one name) and
 * photo version. A group: `members`, its active people, only for an admin (who reads them in Admin › Groups); `mine`, I
 * am in it. */
export interface ParticipantOption extends ProjectParticipant {
  name: string
  title?: string
  avatarVersion?: number
  members?: readonly AvatarUser[]
  mine?: boolean
}

const NO_EXTRA: readonly ParticipantOption[] = []
/** What the picker offers: groups (a member's own; every group for admins), then the active people, both by name. */
export function useParticipantOptions(extra: readonly ParticipantOption[] = NO_EXTRA): ParticipantOption[] {
  const me = useMe()
  const people = usePeopleList()
  const admin = isAdmin(me)
  const [allGroups, setAllGroups] = useState<Group[] | null>(null)
  useEffect(() => {
    if (!admin) return
    let live = true
    api.call(API.listGroups).then((r) => live && setAllGroups(r.items), () => live && setAllGroups([]))
    return () => { live = false }
  }, [admin])
  return useMemo(() => {
    const mine = new Set((me?.groups ?? []).map((g) => g.id))
    const byId = new Map((people ?? []).map((p) => [p.id, p]))
    const groups: ParticipantOption[] = admin
      // an admin: who is in it, the active people only (the directory's, once read: no "0 people" before it), by name
      ? (allGroups ?? []).map((g) => ({ subjectType: 'group', subjectId: g.id, name: g.name, mine: mine.has(g.id), ...(people ? { members: g.memberIds.flatMap((id) => byId.get(id) ?? []).sort(byName) } : {}) }))
      : (me?.groups ?? []).map((g) => ({ subjectType: 'group', subjectId: g.id, name: g.name, mine: true }))
    const persons = (people ?? []).map((p) => ({ subjectType: 'user' as const, subjectId: p.id, name: p.name, ...(p.title ? { title: p.title } : {}), ...(p.avatarVersion ? { avatarVersion: p.avatarVersion } : {}) }))
    const out = new Map<string, ParticipantOption>()
    // a person named only by `extra` (a member switched off, not in the directory) keeps the letter
    for (const x of [...groups.sort(byName), ...persons.sort(byName), ...extra]) if (!out.has(participantKey(x))) out.set(participantKey(x), x)
    return [...out.values()]
  }, [admin, allGroups, me, people, extra])
}
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
/** what a search compares: case and width folded, spaces left out ("김 강현" finds 김강현) */
const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '')

/** The picker's label and the picker, as a group (not a <label> around it: a click on a row's text would focus the
 * search and swap the list for the results). */
export function MembersField({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id}>
      <p id={id} className="mb-1.5 block text-label font-medium text-ink">{label}</p>
      {children}
    </div>
  )
}

/**
 * The members now and a search to add. The list: `fixed` first (always in and not changed here: me or the creator, a
 * person or group with a rule set in Admin › Folder permissions; the tag says why), then the groups and people chosen,
 * each with × to take them out. With `current` (the members saved now: the members dialog) a row added since is marked
 * 새로 and a row taken out stays, struck through, with 되돌리기 until the save. Focusing the search lists everyone who
 * can be added (and the ones already in, marked 추가됨), typing narrows it, and the results take the list's place (on a phone's sheet too) until one is added,
 * Esc, or focus leaves the picker (the search is cleared then). After × or 되돌리기 the keyboard stays on the row.
 * `groupPeople` (the members dialog: GET …/people's groups): a group row says how many people it holds and opens to
 * list them. `notes`: words a row's second line ends with (a group's "except Kim": people in it who left the project).
 */
export function ParticipantPicker({ options, value, onChange, fixed = new Map(), current, groupPeople, notes, testId = 'project-participants' }: {
  options: readonly ParticipantOption[]
  value: readonly ProjectParticipant[]
  onChange: (v: ProjectParticipant[]) => void
  /** key → the tag shown instead of × (e.g. "만든 사람") */
  fixed?: ReadonlyMap<string, string>
  /** the members as saved now: rows show what the save changes */
  current?: readonly ProjectParticipant[]
  /** group id → the people in the project it holds */
  groupPeople?: ReadonlyMap<string, readonly ProjectPerson[]>
  /** key → words at the end of the row's second line */
  notes?: ReadonlyMap<string, string>
  testId?: string
}) {
  const t = useT()
  const [q, setQ] = useState('')
  // the group rows opened to show their people
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string) => setOpened((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // focus put back on the box after an add: not a person asking for the list again
  const quiet = useRef(false)
  const searchId = useId()
  /** focus put on an element by the picker itself: the search taking it is not someone asking for the results */
  const focusQuiet = (el: HTMLElement | null | undefined) => { quiet.current = true; el?.focus(); quiet.current = false }
  // where the keyboard goes after × or 되돌리기 swapped the button under it (the row's other button, or the search)
  const [focusTo, setFocusTo] = useState<string | null>(null)
  useEffect(() => {
    if (!focusTo) return
    focusQuiet(box.current?.querySelector<HTMLElement>(`[data-testid="${focusTo}"]`) ?? input.current)
    setFocusTo(null)
  }, [focusTo])
  const byKey = useMemo(() => new Map(options.map((x) => [participantKey(x), x])), [options])
  const picked = new Set(value.map(participantKey))
  const before = current ? new Set(current.map(participantKey)) : null
  const searching = open

  // fixed ones in their order, then the chosen and the ones taken out before saving: groups, then people, by name
  const rows: ParticipantOption[] = []
  const seen = new Set<string>()
  for (const k of [...fixed.keys(), ...value.map(participantKey), ...(current ?? []).map(participantKey)]) {
    const x = byKey.get(k)
    if (x && !seen.has(k)) { seen.add(k); rows.push(x) }
  }
  const rank = (x: ParticipantOption) => (fixed.has(participantKey(x)) ? 0 : 1)
  rows.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? 0 : a.subjectType === b.subjectType ? byName(a, b) : a.subjectType === 'group' ? -1 : 1))

  const needle = fold(q)
  const results = options.filter((x) => !needle || fold(x.name).includes(needle) || fold(x.title ?? '').includes(needle))
  const isIn = (x: ParticipantOption) => picked.has(participantKey(x)) || fixed.has(participantKey(x))

  const add = (x: ParticipantOption) => {
    onChange([...value, { subjectType: x.subjectType, subjectId: x.subjectId }])
    setQ('')
    setOpen(false)
    focusQuiet(input.current)
  }
  const close = () => { setQ(''); setOpen(false) }
  const remove = (x: ParticipantOption) => {
    onChange(value.filter((y) => participantKey(y) !== participantKey(x)))
    // a member saved now stays as a struck-through row with 되돌리기; any other row goes (the search, then)
    setFocusTo(before?.has(participantKey(x)) ? `participant-undo-${x.subjectType}-${x.subjectId}` : `${testId}-search`)
  }
  const undo = (x: ParticipantOption) => {
    onChange([...value, { subjectType: x.subjectType, subjectId: x.subjectId }])
    setFocusTo(`participant-remove-${x.subjectType}-${x.subjectId}`)
  }
  const meId = useMe()?.user.id
  /** a person's short tags: 나 for me (one word, projects.youTag, everywhere: QA TC-1084) and the fixed tag (나, 만든 사람) */
  const tags = (x: ParticipantOption) => {
    const tag = fixed.get(participantKey(x))
    const you = x.subjectType === 'user' && x.subjectId === meId && tag !== t('projects.youTag') && t('projects.youTag')
    return [you, tag].filter(Boolean).join(' · ')
  }
  /** the second line: a person's title, a group's kind (with how many people when that may be read; `n`: how many of
   * them are in the project, the members dialog's), then the tags unless the row puts them on the name's line
   * (`inline`: a person's row in the list, so my row is as tall as the others) */
  const sub = (x: ParticipantOption, n?: number, inline = false) => {
    const count = n ?? x.members?.length
    const kind = x.subjectType !== 'group' ? x.title : count !== undefined ? t('projects.groupCount', { n: count }) : x.mine ? t('projects.groupMine') : t('projects.groupTag')
    return [kind, !inline && tags(x), notes?.get(participantKey(x))].filter(Boolean).join(' · ')
  }

  return (
    <div
      ref={box}
      className="rounded-lg border border-line"
      data-testid={testId}
      // focus left the picker (not to a result): the list again
      onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) close() }}
      // Esc closes the results first (from the search or a result); the dialog stays open
      onKeyDown={(e) => { if (e.key === 'Escape' && searching) { e.preventDefault(); close(); focusQuiet(input.current) } }}
    >
      <label htmlFor={searchId} className="flex items-center gap-2 border-b border-line px-2.5">
        <Search size={14} className="shrink-0 text-faint" aria-hidden />
        <input
          ref={input}
          id={searchId}
          className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none max-sm:min-h-10"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => { if (!quiet.current) setOpen(true) }}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'ArrowDown') setOpen(true) }}
          placeholder={t('projects.participantsSearch')}
          aria-label={t('projects.participantsSearch')}
          autoComplete="off"
          data-testid={`${testId}-search`}
        />
      </label>
      {searching ? (
        // the box keeps the focus on a click anywhere in the results (a row, the padding, the scrollbar): the list stays
        // until the add
        <ul className="p-1 sm:max-h-72 sm:overflow-y-auto" aria-label={t('projects.searchResults')} onMouseDown={(e) => e.preventDefault()} data-testid={`${testId}-results`}>
          {results.map((x) => {
            const added = isIn(x)
            return (
              <ListRow
                key={participantKey(x)}
                onClick={() => add(x)}
                disabled={added}
                face
                icon={<Face x={x} />}
                name={x.name}
                meta={sub(x) || undefined}
                end={
                  <span className="flex shrink-0 items-center gap-2.5 self-center">
                    {x.members && x.members.length > 0 && <FaceStack people={x.members} count={x.members.length} size={28} testId={`participant-faces-${x.subjectId}`} />}
                    <span className={clsx('text-meta font-medium', added ? 'text-faint' : 'text-accent-text')}>{added ? t('projects.added') : t('projects.add')}</span>
                  </span>
                }
                testId={`participant-add-${x.subjectType}-${x.subjectId}`}
                link={{ 'data-added': added ? '' : undefined }}
              />
            )
          })}
          {!results.length && <li className="px-3 py-2 text-sm text-faint">{t('projects.participantsNone')}</li>}
        </ul>
      ) : (
        <ul className="p-1 sm:max-h-72 sm:overflow-y-auto" aria-label={t('projects.participants')}>
          {rows.map((x) => {
            const k = participantKey(x)
            const tag = fixed.get(k)
            const out = !!before && before.has(k) && !picked.has(k)
            const fresh = !!before && !before.has(k) && picked.has(k)
            const inside = x.subjectType === 'group' ? groupPeople?.get(x.subjectId) : undefined
            const s = sub(x, inside?.length, !inside)
            const nameTags = inside ? '' : tags(x)
            const open = opened.has(x.subjectId)
            return (
              <li key={k} className="flex min-h-row-min flex-wrap items-center gap-x-2.5 rounded-lg px-3 py-1.5 pointer-coarse:min-h-[max(2.75rem,var(--spacing-row-min))]" data-testid={`participant-${x.subjectType}-${x.subjectId}`} data-state={tag !== undefined ? 'fixed' : out ? 'removed' : fresh ? 'new' : 'member'}>
                <ListIcon face><Face x={x} /></ListIcon>
                {/* the name on one line; the title, the group tag and the tag under it (a group's: how many people, and
                    the name opens to list them) */}
                {inside ? (
                  <button type="button" aria-expanded={open} aria-controls={`${testId}-group-${x.subjectId}`} onClick={() => toggle(x.subjectId)} className="group flex min-w-0 flex-1 items-center gap-1 rounded text-left" data-testid={`participant-group-toggle-${x.subjectId}`}>
                    <span className="min-w-0">
                      <span className={clsx('block truncate group-hover:underline', rowName(), out && 'text-faint line-through')}>{x.name}</span>
                      <span className="block truncate text-meta text-faint">
                        {s}
                        {fresh && <> · <span className="font-medium text-accent-text">{t('projects.newTag')}</span></>}
                      </span>
                    </span>
                    <ChevronDown size={14} className={clsx('shrink-0 text-faint transition-transform motion-reduce:transition-none', open && 'rotate-180')} aria-hidden />
                  </button>
                ) : (
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className={clsx('truncate', rowName(), out && 'text-faint line-through')}>{x.name}</span>
                    {nameTags && <span className="shrink-0 text-meta text-faint" data-testid={`participant-tags-${x.subjectType}-${x.subjectId}`}>{nameTags}</span>}
                  </span>
                  {(s || fresh) && (
                    <span className="block truncate text-meta text-faint">
                      {s}
                      {fresh && <>{s && ' · '}<span className="font-medium text-accent-text">{t('projects.newTag')}</span></>}
                    </span>
                  )}
                </span>
                )}
                {tag === undefined && (out ? (
                  <button type="button" className="touch-hit shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent-text hover:bg-hover" onClick={() => undo(x)} aria-label={t('projects.undoRemoveLabel', { name: x.name })} data-testid={`participant-undo-${x.subjectType}-${x.subjectId}`}>
                    {t('projects.undoRemove')}
                  </button>
                ) : (
                  <IconButton label={t('projects.removeMember', { name: x.name })} onClick={() => remove(x)} className="touch-hit shrink-0" data-testid={`participant-remove-${x.subjectType}-${x.subjectId}`}>
                    <X size={14} aria-hidden />
                  </IconButton>
                ))}
                {inside && (
                  <ul id={`${testId}-group-${x.subjectId}`} hidden={!open} className="basis-full pt-1 pb-0.5 pl-6" aria-label={x.name} data-testid={`participant-group-people-${x.subjectId}`}>
                    {open && inside.map((u) => (
                      <li key={u.id} className="flex min-h-7 items-center gap-2 text-xs text-muted">
                        <Avatar user={u} size={18} />
                        <span className="min-w-0 truncate">{u.name}</span>
                      </li>
                    ))}
                    {open && !inside.length && <li className="text-xs text-faint">{t('projects.groupNobody')}</li>}
                  </ul>
                )}
              </li>
            )
          })}
          {!rows.length && <li className="px-3 py-2 text-sm text-faint">{t('projects.membersNone')}</li>}
        </ul>
      )}
    </div>
  )
}

/** a row's face, in the list's icon box: a person's picture (or letter), a group's mark */
const Face = ({ x }: { x: ParticipantOption }) =>
  x.subjectType === 'group' ? <Users /> : <Avatar user={{ id: x.subjectId, name: x.name, avatarVersion: x.avatarVersion }} size="fill" />

/**
 * Who would see it (the server's count; the last one stays while it counts again; the names are the list above it):
 * "멤버 3명", for everyone (docs/DECISIONS.md "Project contents only for members": a team project is its members', the
 * owner and admins included only as members, so there is no part for them by role). No owner's or admin's name anywhere.
 */
export function AccessSummary({ count, testId = 'project-access-summary' }: { count: AccessCount | null; testId?: string }) {
  const t = useT()
  const last = useRef<AccessCount | null>(null)
  if (count !== null) last.current = count
  const c = count ?? last.current
  return (
    <p className={clsx('text-xs leading-5 break-keep text-muted', count === null && c !== null && 'opacity-60')} aria-live="polite" data-testid={testId}>
      {!c ? t('projects.whoCounting') : accessWords(t, c)}
    </p>
  )
}

/** The count line: the project's members ("멤버 3명"). */
export function accessWords(t: ReturnType<typeof useT>, c: AccessCount): string {
  return t('projects.whoMembers', { n: c.n })
}

/** The server's count for the line under the picker. */
export interface AccessCount { n: number }

/** How many people would see the project with these participants (the server's dry run; `removeRules`: other settings
 * of its folder taken out too), asked again 300 ms after the last change; null while asking or when it failed. */
export function useAccessCount(participants: readonly ProjectParticipant[], o: { projectId?: string; enabled: boolean; removeRules?: readonly RuleRef[] }): AccessCount | null {
  const [n, setN] = useState<AccessCount | null>(null)
  const key = participants.map(participantKey).sort().join(',')
  const removing = (o.removeRules ?? []).map(ruleKey).sort().join(',')
  useEffect(() => {
    if (!o.enabled) return
    let live = true
    setN(null)
    const h = setTimeout(() => {
      api.call(API.previewProjectAccess, { body: { participants: [...participants], ...(o.projectId ? { projectId: o.projectId } : {}), ...(o.removeRules?.length ? { removeRules: [...o.removeRules] } : {}) } }).then((r) => live && setN({ n: r.people }), () => {})
    }, 300)
    return () => { live = false; clearTimeout(h) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, removing, o.projectId, o.enabled])
  return n
}

/** Another setting on a project's own folder (a person or group who only reads, an everyone or role setting), taken
 * out from the members dialog (PUT …/participants `removeRules`). */
export interface RuleRef { subjectType: SubjectType; subjectId: string | null }
export const ruleKey = (r: { subjectType: string; subjectId: string | null }) => `${r.subjectType}:${r.subjectId ?? ''}`

/** The widening confirm's lines: who gains it, and what they will see (only what there is). Asked by someone who
 * manages the project without being a member (`contentsHidden`): no numbers, only that they will see its files and
 * chats. */
export function widenLines(t: ReturnType<typeof useT>, p: ProjectAccessPreview): string[] {
  if (p.contentsHidden) return [t('projects.othersSee')]
  return [
    ...(p.files ? [p.othersFiles ? t('projects.widenFilesOthers', { n: p.files, m: p.othersFiles }) : t('projects.widenFiles', { n: p.files })] : []),
    ...(p.sharedChats ? [t('projects.widenChats', { n: p.sharedChats })] : []),
    // the project skills by name (the people who gain it use them in its chats): three, then "외 N"
    ...(p.skills ? [t('projects.widenSkills', { n: p.skills, m: p.added, names: skillList(t, p) })] : []),
  ]
}

const skillList = (t: ReturnType<typeof useT>, p: ProjectAccessPreview) => {
  const names = p.skillNames ?? []
  const more = p.skills - Math.min(names.length, 3)
  return [...names.slice(0, 3), ...(more > 0 ? [t('projects.whoMore', { n: more })] : [])].join(', ')
}
