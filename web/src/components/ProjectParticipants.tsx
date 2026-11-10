// Who sees a team project (docs/DECISIONS.md "Projects live only in projects/", "Project members in one panel"): the
// member picker of the project create, share and members dialogs, and the count line under it. People come from the
// people directory (/api/people, every member may read it: a name and a title); groups ("부서" in Korean copy) are a
// member's own groups (Me.groups) and, for admins, every group (Admin › Groups). The creator, the owner and admins
// always see the project: the line says so. The count is the server's (POST /api/projects/access-preview), so it
// matches who really sees it.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Search, User, Users, X } from 'lucide-react'
import clsx from 'clsx'
import type { Group, ProjectAccessPreview, ProjectParticipant } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { usePeopleList } from '../store/people'
import { isAdmin, useMe } from '../store/session'
import { IconButton } from './ui'

export const participantKey = (x: { subjectType: string; subjectId: string }) => `${x.subjectType}:${x.subjectId}`
export const sameParticipants = (a: readonly ProjectParticipant[], b: readonly ProjectParticipant[]) => {
  const ka = new Set(a.map(participantKey))
  return ka.size === new Set(b.map(participantKey)).size && b.every((x) => ka.has(participantKey(x)))
}

/** A person or group the picker can show: its name, and for a person the directory's title (two people of one name). */
export interface ParticipantOption extends ProjectParticipant { name: string; title?: string }

/** What the picker offers: groups (a member's own; every group for admins), then the active people, both by name. */
export function useParticipantOptions(extra: readonly ParticipantOption[] = []): ParticipantOption[] {
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
    const groups = (admin ? allGroups ?? [] : me?.groups ?? []).map((g) => ({ subjectType: 'group' as const, subjectId: g.id, name: g.name }))
    const persons = (people ?? []).map((p) => ({ subjectType: 'user' as const, subjectId: p.id, name: p.name, ...(p.title ? { title: p.title } : {}) }))
    const out = new Map<string, ParticipantOption>()
    for (const x of [...groups.sort(byName), ...persons.sort(byName), ...extra]) if (!out.has(participantKey(x))) out.set(participantKey(x), x)
    return [...out.values()]
  }, [admin, allGroups, me, people, extra])
}
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
/** what a search compares: case and width folded, spaces left out ("김 강현" finds 김강현) */
const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '')

/**
 * The members now and a search to add. The list: `fixed` first (always in and not changed here: me or the creator, a
 * person or group with a rule set in Admin › Folder permissions; the tag says why), then the groups and people chosen,
 * each with × to take them out. With `current` (the members saved now: the members dialog) a row added since is marked
 * 새로 and a row taken out stays, struck through, with 되돌리기 until the save. Focusing the search lists everyone who
 * can be added, typing narrows it, and the results take the list's place (on a phone's sheet too) until one is added,
 * Esc, or focus leaves.
 */
export function ParticipantPicker({ options, value, onChange, fixed = new Map(), current, testId = 'project-participants' }: {
  options: readonly ParticipantOption[]
  value: readonly ProjectParticipant[]
  onChange: (v: ProjectParticipant[]) => void
  /** key → the tag shown instead of × (e.g. "만든 사람") */
  fixed?: ReadonlyMap<string, string>
  /** the members as saved now: rows show what the save changes */
  current?: readonly ProjectParticipant[]
  testId?: string
}) {
  const t = useT()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // focus put back on the box after an add: not a person asking for the list again
  const quiet = useRef(false)
  const searchId = useId()
  const byKey = useMemo(() => new Map(options.map((x) => [participantKey(x), x])), [options])
  const picked = new Set(value.map(participantKey))
  const before = current ? new Set(current.map(participantKey)) : null
  const searching = open || q.trim() !== ''

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
  const results = options.filter((x) => {
    const k = participantKey(x)
    return !picked.has(k) && !fixed.has(k) && (!needle || fold(x.name).includes(needle) || fold(x.title ?? '').includes(needle))
  })

  const add = (x: ParticipantOption) => {
    onChange([...value, { subjectType: x.subjectType, subjectId: x.subjectId }])
    setQ('')
    setOpen(false)
    quiet.current = true
    input.current?.focus()
    quiet.current = false
  }
  const remove = (x: ParticipantOption) => onChange(value.filter((y) => participantKey(y) !== participantKey(x)))
  const sub = (x: ParticipantOption) => [x.subjectType === 'group' ? t('projects.groupTag') : x.title, fixed.get(participantKey(x))].filter(Boolean).join(' · ')

  return (
    <div
      ref={box}
      className="rounded-lg border border-line"
      data-testid={testId}
      // focus left the picker (not to a result): the list again
      onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) setOpen(false) }}
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
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { setOpen(true); return }
            // Esc closes the results first; the dialog stays open
            if (e.key === 'Escape' && searching) { e.preventDefault(); setQ(''); setOpen(false) }
          }}
          placeholder={t('projects.participantsSearch')}
          aria-label={t('projects.participantsSearch')}
          autoComplete="off"
          data-testid={`${testId}-search`}
        />
      </label>
      {searching ? (
        <ul className="p-1 text-sm sm:max-h-72 sm:overflow-y-auto" aria-label={t('projects.searchResults')} data-testid={`${testId}-results`}>
          {results.map((x) => {
            const s = sub(x)
            return (
              <li key={participantKey(x)}>
                {/* the box keeps the focus on a click: the list stays until the add */}
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(x)}
                  className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover sm:min-h-10"
                  data-testid={`participant-add-${x.subjectType}-${x.subjectId}`}
                >
                  <RowIcon group={x.subjectType === 'group'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{x.name}</span>
                    {s && <span className="block truncate text-xs text-faint">{s}</span>}
                  </span>
                  <span className="shrink-0 text-xs font-medium text-accent-text">{t('projects.add')}</span>
                </button>
              </li>
            )
          })}
          {!results.length && <li className="px-2 py-2 text-faint">{t('projects.participantsNone')}</li>}
        </ul>
      ) : (
        <ul className="p-1 text-sm sm:max-h-72 sm:overflow-y-auto" aria-label={t('projects.participants')}>
          {rows.map((x) => {
            const k = participantKey(x)
            const tag = fixed.get(k)
            const out = !!before && before.has(k) && !picked.has(k)
            const fresh = !!before && !before.has(k) && picked.has(k)
            const s = sub(x)
            return (
              <li key={k} className="flex min-h-11 items-center gap-2.5 rounded-md px-2 py-1.5 sm:min-h-10" data-testid={`participant-${x.subjectType}-${x.subjectId}`} data-state={tag !== undefined ? 'fixed' : out ? 'removed' : fresh ? 'new' : 'member'}>
                <RowIcon group={x.subjectType === 'group'} />
                {/* the name on one line; the title, the group tag and the tag under it */}
                <span className="min-w-0 flex-1">
                  <span className={clsx('block truncate', out && 'text-faint line-through')}>{x.name}</span>
                  {(s || fresh) && (
                    <span className="block truncate text-xs text-faint">
                      {s}
                      {fresh && <>{s && ' · '}<span className="font-medium text-accent-text">{t('projects.newTag')}</span></>}
                    </span>
                  )}
                </span>
                {tag === undefined && (out ? (
                  <button type="button" className="touch-hit shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent-text hover:bg-hover" onClick={() => onChange([...value, { subjectType: x.subjectType, subjectId: x.subjectId }])} aria-label={t('projects.undoRemoveLabel', { name: x.name })} data-testid={`participant-undo-${x.subjectType}-${x.subjectId}`}>
                    {t('projects.undoRemove')}
                  </button>
                ) : (
                  <IconButton label={t('projects.removeMember', { name: x.name })} onClick={() => remove(x)} className="touch-hit shrink-0" data-testid={`participant-remove-${x.subjectType}-${x.subjectId}`}>
                    <X size={14} aria-hidden />
                  </IconButton>
                ))}
              </li>
            )
          })}
          {!rows.length && <li className="px-2 py-2 text-faint">{t('projects.membersNone')}</li>}
        </ul>
      )}
    </div>
  )
}

const RowIcon = ({ group }: { group: boolean }) =>
  group ? <Users size={14} className="shrink-0 text-faint" aria-hidden /> : <User size={14} className="shrink-0 text-faint" aria-hidden />

/** "9명이 봐요 (팀장·관리자 포함)": how many people see it (the server's count; the last one stays while it counts
 * again). The names are the list above it. */
export function AccessSummary({ count, testId = 'project-access-summary' }: { count: number | null; testId?: string }) {
  const t = useT()
  const last = useRef<number | null>(null)
  if (count !== null) last.current = count
  const n = count ?? last.current
  return (
    <p className={clsx('text-xs leading-5 break-keep text-muted', count === null && n !== null && 'opacity-60')} aria-live="polite" data-testid={testId}>
      {n === null ? t('projects.whoCounting') : t('projects.whoCount', { n })}
    </p>
  )
}

/** How many people would see the project with these participants (the server's dry run), asked again 300 ms after the
 * last change; null while asking or when it failed. */
export function useAccessCount(participants: readonly ProjectParticipant[], o: { projectId?: string; enabled: boolean }): number | null {
  const [n, setN] = useState<number | null>(null)
  const key = participants.map(participantKey).sort().join(',')
  useEffect(() => {
    if (!o.enabled) return
    let live = true
    setN(null)
    const h = setTimeout(() => {
      api.call(API.previewProjectAccess, { body: { participants: [...participants], ...(o.projectId ? { projectId: o.projectId } : {}) } }).then((r) => live && setN(r.people), () => {})
    }, 300)
    return () => { live = false; clearTimeout(h) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, o.projectId, o.enabled])
  return n
}

/** The widening confirm's lines: who gains it, and what they will see (only what there is). */
export function widenLines(t: ReturnType<typeof useT>, p: ProjectAccessPreview): string[] {
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
