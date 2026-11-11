// "@" in a room's message box (the composer, a thread's reply box and the edit form): typing "@" and the start of a name
// lists the room's members that fit (lib/rooms.ts matchMembers); arrow keys move, Enter or Tab picks, Esc closes.
// Picking writes "@name " with the name the room shows (the directory's, as on the messages) and makes it a mention token
// at once: the box (components/TokenTextarea.tsx) shows it in the accent colour, keeps it whole (Backspace takes all of
// it) and moves it with the edits around it; an edit inside it makes it plain text again. What is sent mentions exactly
// the people whose tokens are in the box (lib/rooms.ts mentionTokens): what stands out is who gets notified. Text that
// only looks like "@name" (pasted, typed without the list) notifies nobody and does not stand out.
// In the composer the AI comes first ("@트리나": the server asks it as the sender when the message goes; an edit never
// asks it, so the edit form leaves it out); every "@트리나" the server will take as a call stands out the same way.
// Right under it, where the box may use it, "@전체" (docs/DECISIONS.md "@전체"): picked, it is a token like a person's
// and the message goes with mentionsAll, which notifies every member who can see it; typed or pasted it is text.
import clsx from 'clsx'
import { Users } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ROOM_MENTION_ALL_WORDS, type UserRef } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { AI_MENTION_ID, ALL_MENTION_ID, allMatches, aiMatches, insertMention, lineBreaks, matchMembers, mentionAt, mentionsIn, mentionTokens, tokenMentions, tokenMentionsAll, type MentionToken, type PickedMention } from '../../lib/rooms'
import { shiftRanges, type TextEdit } from '../../lib/textTokens'
import { scrollToShow } from '../chat/SkillMenu'
import { usePeople } from '../../store/people'
import { useRooms } from '../../store/rooms'
import { useMe } from '../../store/session'
import { StatusEmoji } from '../StatusMessage'
import { Avatar } from '../Avatar'
import { AiFace } from './AiFace'

/** A mention's look in the box: the accent colour of a sent mention on its soft background. The shadows widen the
 * background sideways without moving a letter (not up or down: on phones two lines' backgrounds would touch). */
export const mentionTokenClass = (): string => 'rounded bg-accent-soft text-accent-text shadow-[2px_0_0_var(--color-accent-soft),-2px_0_0_var(--color-accent-soft)] box-decoration-clone'

/** "@전체"'s word in every language (a message may come from someone who writes another one): the server's list, which
 * each language's rooms.mentionAll is one of (test/unit/room-mention-all.test.tsx) */
export const MENTION_ALL_WORDS: readonly string[] = ROOM_MENTION_ALL_WORDS

/** "@전체" in a room's boxes: who it reaches (everyone else in the room), or null where it is not offered: a DM (the
 * other person is the whole room) and, for anyone but an owner or admin, the everyone room (the server refuses it). */
export function useEveryone(roomId: string, members: UserRef[], meId: string | null): { count: number } | null {
  const kind = useRooms((s) => s.rooms.find((r) => r.id === roomId)?.kind)
  const role = useMe()?.user.role
  const count = members.filter((m) => m.id !== meId).length
  return useMemo(() => (kind && kind !== 'dm' && count > 0 && (kind !== 'all' || role === 'owner' || role === 'admin') ? { count } : null), [kind, role, count])
}

/** `everyone`: the box may mention everyone ("@전체"), and how many people that notifies; absent, it has no "@전체". */
export function useMentionMenu({ text, setText, input, members, meId, initial = [], ai = false, everyone }: { text: string; setText: (s: string) => void; input: RefObject<HTMLTextAreaElement | null>; members: UserRef[]; meId: string | null; initial?: PickedMention[]; ai?: boolean; everyone?: { count: number } | null }) {
  const t = useT()
  const id = useId()
  const [caret, setCaret] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const [picked, setPicked] = useState<PickedMention[]>(initial)
  const caretNext = useRef<number | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const byId = usePeople((s) => s.byId)
  // the members by the name the room shows them with (the directory's: a name changed since the list was read)
  const shown = useMemo(() => members.map((m) => ({ ...m, name: byId[m.id]?.name || m.name })), [members, byId])
  // a person who left the room is no mention any more (the server keeps only members), "@전체" none where it may not be used
  const allowed = !!everyone
  const tokens = useMemo(() => mentionTokens(text, picked.filter((p) => (p.id === ALL_MENTION_ID ? allowed : members.some((m) => m.id === p.id))), ai), [text, picked, ai, members, allowed])
  const at = useMemo(() => {
    const a = caret === null ? null : mentionAt(text, caret)
    // right after a person's mention (or "@전체"): it is done, no list ("@트리나" typed out still lists the AI: Enter picks it, as
    // it always did, and does not send)
    return a && tokens.some((x) => x.kind !== 'ai' && x.start === a.start) ? null : a
  }, [text, caret, tokens])
  const aiName = t('rooms.aiName')
  const allName = t('rooms.mentionAll')
  const hits = useMemo(() => {
    if (!at || closedFor === text) return []
    const people = matchMembers(shown, at.query, meId)
    const all = allowed && allMatches(at.query, MENTION_ALL_WORDS) ? [{ id: ALL_MENTION_ID, name: allName }] : []
    // "@전체" right under the AI for a bare "@"; once something is typed, after the people it fits ("@전" for 전지현 must
    // not pick everyone with Enter)
    return [...(ai && aiMatches(at.query) ? [{ id: AI_MENTION_ID, name: aiName }] : []), ...(at.query ? [...people, ...all] : [...all, ...people])]
  }, [at, shown, meId, closedFor, text, ai, aiName, allowed, allName])
  const open = hits.length > 0
  useEffect(() => setActive(0), [at])
  useEffect(() => {
    const list = listRef.current
    const row = list?.children[active] as HTMLElement | undefined
    if (list && row) list.scrollTop = scrollToShow({ top: row.offsetTop, height: row.offsetHeight }, { scrollTop: list.scrollTop, height: list.clientHeight })
  }, [active, hits])
  // the caret after a picked name, as soon as the text with it is in the box (a key typed next lands after it)
  useLayoutEffect(() => {
    const c = caretNext.current
    const el = input.current
    if (c === null || !el) return
    caretNext.current = null
    el.focus()
    el.setSelectionRange(c, c)
  })

  /** where the caret is now (after typing, a click, the arrow keys) */
  const track = () => setCaret(input.current?.selectionStart ?? null)

  const pick = (u: UserRef) => {
    if (!at || caret === null) return
    const next = insertMention(text, at.start, caret, u.name)
    const edit: TextEdit = { from: at.start, removed: caret - at.start, inserted: next.caret - at.start }
    // the AI is no person: its name in the text is what calls it (mentionTokens finds it there); "@전체" is kept as a
    // person is (only the picked one notifies)
    setPicked((p) => (u.id === AI_MENTION_ID ? shiftRanges(p, edit) : [...shiftRanges(p, edit), { start: at.start, end: at.start + u.name.length + 1, id: u.id, name: u.name }]))
    setText(next.text)
    setCaret(next.caret)
    caretNext.current = next.caret
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
  /** for the box (TokenTextarea): its tokens, its text changes, and which name of the list is chosen for a screen reader */
  const inputProps = {
    tokens: tokens as readonly MentionToken[],
    tokenClass: mentionTokenClass,
    onTextChange: (value: string, edit: TextEdit) => {
      setPicked((p) => shiftRanges(p, edit))
      setText(value)
      track()
    },
    'aria-controls': open ? `${id}-list` : undefined,
    'aria-activedescendant': open ? optionId(active) : undefined,
    'aria-autocomplete': 'list' as const,
    onSelect: track,
    onClick: track,
    onKeyUp: track,
  }

  const list = open ? (
    <div className="px-2 pt-2" data-testid="mention-menu">
      {/* a phone: at most a quarter of what is in sight (lib/viewport.ts --app-h), so with the keyboard up the text field
          and send stay above it */}
      <ul ref={listRef} id={`${id}-list`} role="listbox" aria-label={t('rooms.mentionList')} className="relative max-h-[min(14rem,40dvh)] overflow-y-auto overscroll-contain max-md:max-h-[min(14rem,calc(var(--app-h,100dvh)*0.25))]">
        {hits.map((u, i) => (
          <li key={u.id} id={optionId(i)} role="option" aria-selected={i === active}>
            <button
              type="button"
              tabIndex={-1}
              // the focus stays in the message box
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(u)}
              onMouseMove={() => i !== active && setActive(i)}
              className={clsx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm max-md:min-h-11', i === active && 'bg-accent-soft')}
              data-testid="mention-option"
              data-ai={u.id === AI_MENTION_ID ? '' : undefined}
              data-all={u.id === ALL_MENTION_ID ? '' : undefined}
            >
              {u.id === ALL_MENTION_ID ? (
                <>
                  <span aria-hidden className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
                    <Users size={12} />
                  </span>
                  <span className="truncate font-medium text-ink">{u.name}</span>
                  <span className="truncate text-xs text-muted">{t('rooms.mentionAllHint', { n: everyone?.count ?? 0 })}</span>
                </>
              ) : u.id === AI_MENTION_ID ? (
                <>
                  <AiFace size={22} />
                  <span className="truncate font-medium text-ink">{u.name}</span>
                  <span className="truncate text-xs text-muted">{t('rooms.aiMention')}</span>
                </>
              ) : (
                <>
                  <Avatar user={{ ...u, avatarVersion: byId[u.id]?.avatarVersion }} size={22} />
                  <span className="truncate font-medium text-ink">{u.name}</span>
                  <StatusEmoji userId={u.id} className="-ml-1" />
                  {byId[u.id]?.title && <span className="truncate text-xs text-muted">{byId[u.id]!.title}</span>}
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : null

  return {
    list,
    /** the list is shown */
    open,
    onKeyDown,
    inputProps,
    /** the picked people and where they are (a draft keeps them) */
    picked,
    /** the mentions for what is sent now: exactly the people whose tokens are in the box */
    mentions: () => tokenMentions(tokens),
    /** "@전체" stands in the box: what is sent mentions everyone (mentionsAll) */
    mentionsAll: () => tokenMentionsAll(tokens),
    reset: () => {
      setPicked([])
      setClosedFor(null)
    },
    /** the box takes this text and these mentions as they are (another box of the same place left them: a draft) */
    restore: (body: string, people: PickedMention[]) => {
      setPicked(people)
      setText(body)
    },
    /** a send the server refused comes back: its text goes before what is in the box now (on a line of its own), with
     * the people it mentioned marked again (by the names the room shows and the member list has) */
    putBack: (body: string, ids: string[], all = false) => {
      const people = [
        ...ids.flatMap((uid) => [...new Set([byId[uid]?.name, members.find((m) => m.id === uid)?.name])].filter((n): n is string => !!n).map((name) => ({ id: uid, name }))),
        ...(all ? MENTION_ALL_WORDS.map((name) => ({ id: ALL_MENTION_ID, name })) : []),
      ]
      const back = lineBreaks(body)
      const typed = text
      const shift = typed ? back.length + 1 : 0
      setPicked((p) => [...mentionsIn(back, people), ...(typed ? shiftRanges(p, { from: 0, removed: 0, inserted: shift }) : [])])
      setText(typed ? `${back}\n${typed}` : back)
    },
  }
}

/** The people a message mentions as picked mentions, for the edit form (by the names the room shows and the member list
 * has: as the message shows them). */
export const pickedInMessage = (body: string, people: { id: string; name: string }[]) => mentionsIn(body, people.filter((p) => p.name))
