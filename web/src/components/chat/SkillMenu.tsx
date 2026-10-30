// The "/" list of skills in the message box. Typing "/" at the start of the message lists the skills the person
// can use (GET /api/skills: skills/**/*.md with a name header that they can read, and their own personal skills in
// users/<me>/skills/, marked "Personal"); choosing one writes "/<name> " and the server puts that
// skill in front of the message (server/src/chat/skills.ts). Arrow keys move, Enter / Tab choose, Esc closes.
import clsx from 'clsx'
import { Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { SkillInfo } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'

const SHOWN_MAX = 8

/** The skills that fit what is typed after "/" (null: not a skill command, the menu stays closed). */
export function matchSkills(skills: SkillInfo[], text: string): SkillInfo[] | null {
  if (!text.startsWith('/') || text.includes('\n')) return null
  const q = text.slice(1).toLowerCase()
  // a chosen skill followed by its input: done
  if (skills.some((s) => q.startsWith(s.name.toLowerCase() + ' '))) return null
  const hits = skills.filter((s) => s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q))
  return hits.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q))).slice(0, SHOWN_MAX)
}

export function useSkillMenu(text: string, setText: (s: string) => void) {
  const t = useT()
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [active, setActive] = useState(0)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const wanted = text.startsWith('/')
  // loaded each time a message starts with "/" (a skill saved a moment ago shows up without a reload)
  useEffect(() => {
    if (!wanted) { setSkills(null); return }
    if (skills) return
    let live = true
    api.call(API.listSkills).then((r) => live && setSkills(r.items), () => live && setSkills([]))
    return () => { live = false }
  }, [wanted, skills])
  const hits = useMemo(() => (skills && closedFor !== text ? matchSkills(skills, text) : null), [skills, text, closedFor])
  const open = !!hits?.length
  useEffect(() => setActive(0), [text])

  const choose = (s: SkillInfo) => setText(`/${s.name} `)
  /** Handles the key when the menu is open; true = handled (don't send the message). */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : hits!.length - 1)) % hits!.length)
      return true
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault()
      choose(hits![active] ?? hits![0]!)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setClosedFor(text)
      return true
    }
    return false
  }

  const menu = open ? (
    <div className="px-3 pt-3" data-testid="skill-menu">
      <div className="mb-1 flex items-center justify-between px-2 text-xs text-faint">
        <span className="flex items-center gap-1.5 font-medium text-muted"><Sparkles size={13} aria-hidden /> {t('skills.menu')}</span>
        <span className="max-sm:hidden">{t('skills.hint')}</span>
      </div>
      <ul role="listbox" aria-label={t('skills.menu')} className="max-h-64 overflow-y-auto">
        {hits!.map((s, i) => (
          <li key={s.path} role="option" aria-selected={i === active}>
            <button
              type="button"
              // keep the focus in the message box
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(s)}
              onMouseEnter={() => setActive(i)}
              className={clsx('flex w-full flex-col rounded-xl px-2 py-1.5 text-left', i === active ? 'bg-accent-soft' : 'hover:bg-hover')}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                /{s.name}
                {s.personal && <span className="rounded-full bg-hover px-1.5 text-[11px] font-normal text-muted" data-testid="skill-personal">{t('skills.personal')}</span>}
              </span>
              <span className="truncate text-xs text-muted">{s.description || s.path}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : null
  return { menu, onKeyDown }
}
