// "@" in a room's message box (the composer and the edit form): typing "@" and the start of a name lists the room's
// members that fit (lib/rooms.ts matchMembers); arrow keys move, Enter or Tab picks, Esc closes. Picking writes
// "@name " and remembers the person; what is sent mentions the picked people whose "@name" is still in the text.
import clsx from 'clsx'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { UserRef } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { insertMention, keptMentions, matchMembers, mentionAt } from '../../lib/rooms'
import { scrollToShow } from '../chat/SkillMenu'
import { usePeople } from '../../store/people'
import { Avatar } from '../Avatar'

export function useMentionMenu({ text, setText, input, members, meId, initial = [] }: { text: string; setText: (s: string) => void; input: RefObject<HTMLTextAreaElement | null>; members: UserRef[]; meId: string | null; initial?: UserRef[] }) {
  const t = useT()
  const id = useId()
  const [caret, setCaret] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const [picked, setPicked] = useState<UserRef[]>(initial)
  const listRef = useRef<HTMLUListElement>(null)
  const byId = usePeople((s) => s.byId)
  const at = useMemo(() => (caret === null ? null : mentionAt(text, caret)), [text, caret])
  const hits = useMemo(() => (at && closedFor !== text ? matchMembers(members, at.query, meId) : []), [at, members, meId, closedFor, text])
  const open = hits.length > 0
  useEffect(() => setActive(0), [at])
  useEffect(() => {
    const list = listRef.current
    const row = list?.children[active] as HTMLElement | undefined
    if (list && row) list.scrollTop = scrollToShow({ top: row.offsetTop, height: row.offsetHeight }, { scrollTop: list.scrollTop, height: list.clientHeight })
  }, [active, hits])

  /** where the caret is now (after typing, a click, the arrow keys) */
  const track = () => setCaret(input.current?.selectionStart ?? null)

  const pick = (u: UserRef) => {
    if (!at || caret === null) return
    const next = insertMention(text, at.start, caret, u.name)
    setText(next.text)
    setPicked((p) => (p.some((x) => x.id === u.id) ? p : [...p, u]))
    setCaret(next.caret)
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  /** the key was for the list (true: the box must not act on it, e.g. not send) */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open || e.nativeEvent.isComposing || e.keyCode === 229) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length)
      return true
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault()
      pick(hits[active] ?? hits[0]!)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setClosedFor(text)
      return true
    }
    return false
  }

  const optionId = (i: number) => `${id}-opt-${i}`
  /** for the text area: tells a screen reader which name is chosen */
  const inputProps = {
    'aria-controls': open ? `${id}-list` : undefined,
    'aria-activedescendant': open ? optionId(active) : undefined,
    'aria-autocomplete': 'list' as const,
    onSelect: track,
    onClick: track,
    onKeyUp: track,
  }

  const list = open ? (
    <div className="px-2 pt-2" data-testid="mention-menu">
      <ul ref={listRef} id={`${id}-list`} role="listbox" aria-label={t('rooms.mentionList')} className="relative max-h-[min(14rem,40dvh)] overflow-y-auto overscroll-contain">
        {hits.map((u, i) => (
          <li key={u.id} id={optionId(i)} role="option" aria-selected={i === active}>
            <button
              type="button"
              tabIndex={-1}
              // the focus stays in the message box
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(u)}
              onMouseMove={() => i !== active && setActive(i)}
              className={clsx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm', i === active && 'bg-accent-soft')}
              data-testid="mention-option"
            >
              <Avatar user={{ ...u, avatarVersion: byId[u.id]?.avatarVersion }} size={22} />
              <span className="truncate font-medium text-ink">{u.name}</span>
              {byId[u.id]?.title && <span className="truncate text-xs text-muted">{byId[u.id]!.title}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : null

  return {
    list,
    onKeyDown,
    inputProps,
    /** the mentions for what is sent now */
    mentions: () => keptMentions(text, picked),
    /** call from onChange: the caret moved with the typing */
    track,
    reset: () => {
      setPicked([])
      setClosedFor(null)
    },
  }
}
