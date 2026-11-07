// One search for a person or a group, shared by Admin › Folder permissions' edit panel (AccessEdit.tsx) and the Team
// skills page's "who can edit" dialog (SkillManagers.tsx).
import clsx from 'clsx'
import { Search, UserRound, UsersRound } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type MutableRefObject, type RefObject } from 'react'
import type { Group, User } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { Badge } from '../../components/ui'

export interface NamedOption { kind: 'user' | 'group'; id: string; name: string; sub: string; off: boolean }

/** Whether the list is open, and a way to close it: the panel's Esc closes the list first. */
export type ListControl = MutableRefObject<{ open: boolean; close: () => void }>

/** One search for a person or a group (WAI-ARIA combobox with a list): arrows move, Enter adds, Esc closes the list.
 * What is already named is not offered. The list lies over what is below it: in the flow, its closing on blur moved
 * everything below it up under a click on its way (the click landed on something else). `inline`: in the flow after
 * all, for a dialog whose body scrolls (a list lying over its end would be cut off there). `saidOf`: what a screen
 * reader hears once one is picked (default: added with read access, as the edit panel adds them). */
export function AddNamed({ users, groups, taken, list, inputRef, onAdd, inline, saidOf }: {
  users: User[]
  groups: Group[]
  taken: ReadonlySet<string>
  list?: ListControl
  inputRef: RefObject<HTMLInputElement | null>
  onAdd: (o: NamedOption) => void
  inline?: boolean
  saidOf?: (o: NamedOption) => string
}) {
  const t = useT()
  const listId = useId()
  const labelId = useId()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [said, setSaid] = useState('')
  if (list) list.current = { open, close: () => setOpen(false) }
  const options = useMemo(() => {
    const s = q.trim().toLocaleLowerCase()
    const all: NamedOption[] = [
      ...groups.map((g) => ({ kind: 'group' as const, id: g.id, name: g.name, sub: t('accessEdit.kind.group', { n: g.memberIds.length }), off: false })),
      ...users.map((u) => ({ kind: 'user' as const, id: u.id, name: u.name, sub: `${u.username} · ${t(`role.${u.role}`)}`, off: u.status === 'disabled' })),
    ]
    return all.filter((o) => !taken.has(`${o.kind}:${o.id}`) && (!s || o.name.toLocaleLowerCase().includes(s) || o.sub.toLocaleLowerCase().includes(s)))
  }, [q, users, groups, taken, t])
  const shown = options.slice(0, 50)
  const cur = Math.min(active, Math.max(0, shown.length - 1))
  const pick = (o: NamedOption) => {
    onAdd(o)
    setSaid(saidOf ? saidOf(o) : t('accessEdit.added', { name: o.name, access: t('access.read') }))
    setQ('')
    setActive(0)
    setOpen(false)
    inputRef.current?.focus()
  }
  const optionId = (i: number) => `${listId}-o${i}`
  useEffect(() => {
    if (!open) return
    document.getElementById(optionId(cur))?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, open])
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      setActive((a) => (shown.length ? (e.key === 'ArrowDown' ? (a + 1) % shown.length : (a - 1 + shown.length) % shown.length) : 0))
    } else if (e.key === 'Enter') {
      if (!open || !shown[cur]) return
      e.preventDefault()
      pick(shown[cur]!)
    } else if (e.key === 'Escape' && open) {
      // the list only: the panel stays
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }
  return (
    <div className="mt-2">
      <label id={labelId} className="sr-only" htmlFor={`${listId}-input`}>
        {t('accessEdit.add')}
      </label>
      <div className="relative">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" aria-hidden />
          <input
            id={`${listId}-input`}
            ref={inputRef}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && shown[cur] ? optionId(cur) : undefined}
            autoComplete="off"
            value={q}
            placeholder={t('accessEdit.addPlaceholder')}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
              setOpen(true)
            }}
            onFocus={() => setOpen(q !== '')}
            onClick={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKey}
            className="h-9 w-full rounded-lg border border-field-border bg-surface pr-3 pl-8 text-sm text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-1 focus:ring-accent max-sm:min-h-10"
            data-testid="edit-add"
          />
        </div>
        <ul
          id={listId}
          role="listbox"
          aria-labelledby={labelId}
          hidden={!open}
          className={clsx('scroll-thin overflow-y-auto rounded-xl border border-line bg-surface p-1', inline ? 'mt-1 max-h-48' : 'absolute inset-x-0 top-full z-30 mt-1 max-h-56 shadow-lg')}
          data-testid="edit-add-list"
        >
          {shown.map((o, i) => (
            <li
              key={`${o.kind}:${o.id}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === cur}
              // keep the focus in the field (a click would blur it and close the list first)
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              onMouseMove={() => setActive(i)}
              className={clsx('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm max-sm:min-h-10', i === cur ? 'bg-hover' : '')}
              data-testid="edit-add-option"
              data-subject={`${o.kind}:${o.id}`}
            >
              {o.kind === 'group' ? <UsersRound size={14} className="shrink-0 text-faint" aria-hidden /> : <UserRound size={14} className="shrink-0 text-faint" aria-hidden />}
              <span className="min-w-0 truncate text-ink">{o.name}</span>
              <span className="min-w-0 shrink-[100] truncate text-xs text-faint">{o.sub}</span>
              {o.off && <Badge className="ml-auto">{t('accessEdit.disabled')}</Badge>}
            </li>
          ))}
          {!shown.length && <li className="px-2 py-1.5 text-xs text-faint">{t('accessEdit.noMatch')}</li>}
        </ul>
      </div>
      <p role="status" className="sr-only">
        {said}
      </p>
    </div>
  )
}
