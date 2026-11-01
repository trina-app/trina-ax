// The "/" list of skills in the message box. Typing "/" at the start of the message lists the skills the person
// can use (GET /api/skills: skills/**/*.md with a name header that they can read, and their own personal skills in
// users/<me>/skills/, marked "Personal"); choosing one writes "/<name> " and the server puts that
// skill in front of the message (server/src/chat/skills.ts). Arrow keys move, Enter / Tab choose, Esc closes. Every
// match is in the list, which scrolls (like Claude Code's "/" menu): the arrow keys keep the chosen row in sight, so a
// sixth or a twentieth skill is as easy to reach as the first, on a phone as well.
import clsx from 'clsx'
import { Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SkillInfo } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'

/** The skills that fit what is typed after "/" (null: not a skill command, the menu stays closed). All of them. */
export function matchSkills(skills: SkillInfo[], text: string): SkillInfo[] | null {
  if (!text.startsWith('/') || text.includes('\n')) return null
  const q = text.slice(1).toLowerCase()
  // a chosen skill followed by its input: done
  if (skills.some((s) => q.startsWith(s.name.toLowerCase() + ' '))) return null
  const hits = skills.filter((s) => s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q))
  return hits.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
}

/** Where a scrolling list should be (its scrollTop) so a row is wholly in sight: unchanged when it already is, else
 * the least move that shows it (the row's top at the top, or its bottom at the bottom). */
export function scrollToShow(row: { top: number; height: number }, view: { scrollTop: number; height: number }): number {
  if (row.top < view.scrollTop) return row.top
  if (row.top + row.height > view.scrollTop + view.height) return row.top + row.height - view.height
  return view.scrollTop
}

export function useSkillMenu(text: string, setText: (s: string) => void) {
  const t = useT()
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [active, setActive] = useState(0)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
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
  // the arrow keys move past the rows in sight (or typing changes the rows): the list scrolls, only the list and never
  // the page, to keep the chosen row shown
  useEffect(() => {
    const list = listRef.current
    const row = list?.children[active] as HTMLElement | undefined
    if (!list || !row) return
    list.scrollTop = scrollToShow({ top: row.offsetTop, height: row.offsetHeight }, { scrollTop: list.scrollTop, height: list.clientHeight })
  }, [active, hits])

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
      {/* about five and a half rows, so the cut row says there is more; at most 40% of a short window (a phone on its
          side, the keyboard up); "relative" makes the rows' offsetTop count from the list */}
      <ul ref={listRef} role="listbox" aria-label={t('skills.menu')} className="relative max-h-[min(16rem,40dvh)] overflow-y-auto overscroll-contain" data-testid="skill-menu-list">
        {hits!.map((s, i) => (
          <li key={s.path} role="option" aria-selected={i === active}>
            <button
              type="button"
              // keep the focus in the message box
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(s)}
              // only a real move of the pointer picks the row: the list scrolling under a pointer that stands still
              // (the arrow keys) must not take the choice back
              onMouseMove={(e) => {
                const p = pointer.current
                if (p && p.x === e.clientX && p.y === e.clientY) return
                pointer.current = { x: e.clientX, y: e.clientY }
                if (i !== active) setActive(i)
              }}
              // one highlighted row: the pointer moving onto a row makes it the chosen one (no second hover colour)
              className={clsx('flex w-full flex-col rounded-xl px-2 py-1.5 text-left', i === active && 'bg-accent-soft')}
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
