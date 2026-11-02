// "쓸 수 있는 스킬" on the Team skills page: every skill the person can use (GET /api/skills, the same list as the "/"
// menu: the team skills in the skills/ folders they can read, and their own personal skills), the most used first
// (GET /api/skills/popular: the top 10 of the last 30 days have a count). A row is one line of text: clicking it starts
// a chat with the skill, and its "…" menu also opens the file. The whole description is the row's tooltip. The same
// read-only list for members and admins; what only skill managers and admins do (review suggestions, recent changes)
// stays in the page's other tabs. A chat starts from the skill's name, so of two skills with one name the server picks
// (server/src/chat/skills.ts).
import { FileText, MessageSquarePlus, MoreHorizontal, ScrollText, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { SkillInfo } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { navigateTo } from '../lib/nav'
import { parentPath } from '../lib/paths'
import { isSkillsPath } from '../lib/skillIssues'
import { useT } from '../i18n'
import { accessChanged, filesChanged, reloadAsked, skillsChanged } from '../store/live'
import { skillPrompt } from './PopularSkills'
import { EmptyState, ErrorNote, IconButton, Skeleton } from './ui'

type Skill = SkillInfo & { uses?: number }

/** The skill's file in Files (its folder, the file selected). */
export const skillFileLink = (path: string) => `/files?path=${encodeURIComponent(parentPath(path))}&select=${encodeURIComponent(path)}`
/** A new chat with "/<name> " in the message box. */
export const skillChatLink = (name: string) => `/?prompt=${encodeURIComponent(skillPrompt(name))}`

/** The folder a skill belongs to: for a skill that is a folder of its own (…/<name>/SKILL.md), the one around it. */
const skillHome = (path: string) => {
  const dir = parentPath(path)
  return path.endsWith('/SKILL.md') ? parentPath(dir) || dir : dir
}

/** `query`: the page's search box, matched against the name and the description. */
export function AvailableSkills({ query }: { query: string }) {
  const t = useT()
  const [items, setItems] = useState<Skill[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true, generation = 0
    const load = () => {
      const g = ++generation
      // the counts are a bonus: the list still shows when they don't load
      Promise.all([api.call(API.listSkills), api.call(API.popularSkills).catch(() => null)]).then(
        ([list, popular]) => {
          if (!active || g !== generation) return
          const uses = new Map(popular?.items.map((p) => [p.path, p.uses]))
          setItems(list.items.map((s) => ({ ...s, uses: uses.get(s.path) ?? 0 })).sort((a, b) => b.uses - a.uses))
          setFailed(false)
        },
        () => { if (active && g === generation) setFailed(true) },
      )
    }
    load()
    const offs = [
      accessChanged.on(load), skillsChanged.on(load), reloadAsked.on(load),
      filesChanged.on((changes) => { if (changes.some((c) => isSkillsPath(c.path) || (c.from && isSkillsPath(c.from)))) load() }),
    ]
    return () => { active = false; for (const off of offs) off() }
  }, [attempt])
  // never "no skills" for a list that did not load
  if (failed && !items) return <ErrorNote onRetry={() => { setFailed(false); setAttempt((n) => n + 1) }}>{t('error.network')}</ErrorNote>
  return <AvailableSkillsList items={items} query={query} />
}

/** The list without the data load (null: still loading). Personal skills get a section of their own. */
export function AvailableSkillsList({ items, query = '' }: { items: Skill[] | null; query?: string }) {
  const t = useT()
  if (!items) return <Skeleton lines={3} />
  if (!items.length) return <EmptyState icon={<Sparkles size={22} />} title={t('skills.noSkills')}>{t('skills.noSkillsHint')}</EmptyState>
  const q = query.trim().toLowerCase()
  const shown = q ? items.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q)) : items
  if (!shown.length) return <EmptyState icon={<Sparkles size={22} />} title={t('skills.noMatch', { q: query.trim() })} />
  return (
    <div className="space-y-6" data-testid="skill-list">
      <SkillSection title={t('skills.fromTeam')} items={shown.filter((s) => !s.personal)} />
      <SkillSection title={t('skills.personal')} items={shown.filter((s) => s.personal)} />
    </div>
  )
}

function SkillSection({ title, items }: { title: string; items: Skill[] }) {
  if (!items.length) return null
  return (
    <section aria-label={title}>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-medium">
        {title}
        <span className="rounded-full bg-subtle px-1.5 text-xs text-muted tabular-nums" data-testid="skill-count">{items.length}</span>
      </h2>
      <ul className="-mx-2 divide-y divide-line">
        {items.map((s) => <SkillRow key={s.path} skill={s} />)}
      </ul>
    </section>
  )
}

function SkillRow({ skill: s }: { skill: Skill }) {
  const t = useT()
  const line = [s.personal ? '' : `${skillHome(s.path)}/`, s.description].filter(Boolean).join(' · ')
  return (
    <li className="flex items-center gap-1 py-1" data-testid="skill-row" data-path={s.path}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 text-left hover:bg-hover"
        title={s.description || s.path}
        onClick={() => navigateTo(skillChatLink(s.name))}
        data-testid="skill-use"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-muted">
          <ScrollText size={16} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={s.name}>{s.name}</span>
          {line && <span className="mt-0.5 block truncate text-xs text-muted">{line}</span>}
        </span>
        {!!s.uses && <span className="shrink-0 text-xs text-faint tabular-nums" title={t('skills.usesHint')}>{t('skills.uses', { uses: s.uses })}</span>}
        <span className="sr-only">{t('skills.use')}</span>
      </button>
      <SkillMenu skill={s} />
    </li>
  )
}

function SkillMenu({ skill: s }: { skill: Skill }) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const menuItems = () => [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  useEffect(() => {
    if (!open) return
    menuItems()[0]?.focus()
    // not on losing focus: Safari moves focus off a button when it is pressed, and the click would find the menu gone
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.stopPropagation() // only the menu: not an open file or browser panel too (Layout)
      setOpen(false)
      box.current?.querySelector('button')?.focus() // Tab then moves on from the "…" button
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = menuItems()
      const at = items.indexOf(document.activeElement as HTMLElement)
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    }
  }
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm -outline-offset-2 hover:bg-hover focus:bg-hover'
  return (
    <div ref={box} className="relative shrink-0" onKeyDown={onKeyDown}>
      <IconButton label={t('skills.moreNamed', { name: s.name })} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="skill-more">
        <MoreHorizontal size={16} aria-hidden />
      </IconButton>
      {open && (
        <div role="menu" aria-label={t('skills.moreNamed', { name: s.name })} className="absolute top-full right-0 z-30 mt-1 w-44 rounded-lg border border-line bg-surface p-1 shadow-lg">
          <button role="menuitem" type="button" className={item} onClick={() => navigateTo(skillChatLink(s.name))}>
            <MessageSquarePlus size={14} aria-hidden /> {t('skills.use')}
          </button>
          <button role="menuitem" type="button" className={item} onClick={() => navigateTo(skillFileLink(s.path))} data-testid="skill-file">
            <FileText size={14} aria-hidden /> {t('skills.viewFile')}
          </button>
        </div>
      )}
    </div>
  )
}
