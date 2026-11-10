// The emoji picker's data, search and "Recently used" (components/EmojiPicker.tsx, docs/DECISIONS.md "Any emoji as a
// reaction"). The data is two lazy chunks the build makes from emojibase-data (scripts/emoji-data.ts): English names
// and keywords for everyone, Korean ones for a Korean speaker or a search in Hangul. Nothing here is markup: the names
// are shown as text, and only strings that are one emoji (the server's rule) are offered or remembered.
import { emojiForm, isStatusEmoji } from '@mycel/shared'
import type { MessageKey } from '../i18n'

export interface Emoji {
  emoji: string
  /** emojibase's group (EMOJI_GROUPS) */
  group: number
  /** English name and keywords */
  name: string
  keys: string
  /** Korean name and keywords, once loaded and where the data has them */
  local?: string
  localKeys?: string
}

/** emojibase's groups, in the picker's order, with their headings (2, skin tones and hair alone, is not in the data) */
export const EMOJI_GROUPS: readonly { group: number; label: MessageKey }[] = [
  { group: 0, label: 'emoji.g.smileys' },
  { group: 1, label: 'emoji.g.people' },
  { group: 3, label: 'emoji.g.nature' },
  { group: 4, label: 'emoji.g.food' },
  { group: 5, label: 'emoji.g.travel' },
  { group: 6, label: 'emoji.g.activities' },
  { group: 7, label: 'emoji.g.objects' },
  { group: 8, label: 'emoji.g.symbols' },
  { group: 9, label: 'emoji.g.flags' },
]

/** The data modules' lines as emoji (scripts/emoji-data.ts has the format); a line that is not one emoji is skipped. */
export function parseEmoji(en: string, local?: string): Emoji[] {
  const loc = local?.split('\n')
  const out: Emoji[] = []
  en.split('\n').forEach((line, i) => {
    const [emoji = '', group = '', name = '', keys = ''] = line.split('\t')
    if (!isStatusEmoji(emoji)) return
    const [ln = '', lk = ''] = (loc?.[i] ?? '').split('\t')
    out.push({ emoji, group: Number(group), name, keys, ...(ln ? { local: ln, localKeys: lk } : {}) })
  })
  return out
}

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF]/
/** Does the search need the Korean names? */
export const hasHangul = (s: string) => HANGUL.test(s)

/** results of a search, at most */
export const SEARCH_MAX = 120

/** The emoji whose names or keywords (English, and Korean when loaded) hold every word of the query, best first: a name
 * that starts with it, then a word of a name that does, then the others, each in the data's order. An emoji typed or
 * pasted into the search is itself the result (a skin tone, one newer than the data), in its full form (emojiForm). */
export function searchEmoji(list: readonly Emoji[], query: string, max = SEARCH_MAX): string[] {
  const raw = query.trim()
  if (!raw) return []
  if (isStatusEmoji(raw)) return [emojiForm(raw)]
  const q = raw.toLowerCase()
  const terms = q.split(/\s+/)
  const hits: { rank: number; i: number; emoji: string }[] = []
  list.forEach((e, i) => {
    const name = e.name.toLowerCase(), local = (e.local ?? '').toLowerCase()
    const hay = `${name}\t${e.keys.toLowerCase()}\t${local}\t${(e.localKeys ?? '').toLowerCase()}`
    if (!terms.every((t) => hay.includes(t))) return
    const rank = name.startsWith(q) || local.startsWith(q) ? 0 : ` ${name}`.includes(` ${q}`) || ` ${local}`.includes(` ${q}`) ? 1 : 2
    hits.push({ rank, i, emoji: e.emoji })
  })
  return hits.sort((a, b) => a.rank - b.rank || a.i - b.i).slice(0, max).map((h) => h.emoji)
}

// ---------------- loading ----------------

let enText: Promise<string> | null = null
let koText: Promise<string> | null = null
const parsed = new Map<boolean, Emoji[]>()

/** The data, loaded once (the Korean names too when `korean`); a failed load is tried again next time. */
export function loadEmoji(korean: boolean): Promise<Emoji[]> {
  const done = parsed.get(korean)
  if (done) return Promise.resolve(done)
  enText ??= import('virtual:emoji/en').then((m) => m.default, (e: unknown) => { enText = null; throw e })
  if (korean) koText ??= import('virtual:emoji/ko').then((m) => m.default, (e: unknown) => { koText = null; throw e })
  return Promise.all([enText, korean ? koText : undefined]).then(([en, ko]) => {
    const list = parseEmoji(en, ko ?? undefined)
    parsed.set(korean, list)
    return list
  })
}

/** The data when it is loaded already (a picker opened again draws at once). */
export const loadedEmoji = (korean: boolean): Emoji[] | undefined => parsed.get(korean)

// ---------------- recently used ----------------

/** emoji "Recently used" keeps, at most (two rows of the grid) */
export const RECENT_MAX = 16
const RECENT_PREFIX = 'mycel.emoji.recent:'
/** per person, so a shared computer does not show one person's emoji to the next */
export const recentKey = (userId: string) => `${RECENT_PREFIX}${userId}`

type Store = Pick<Storage, 'getItem' | 'setItem'>
const local = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** My recently used emoji on this browser, the last first; anything that is not one emoji is dropped. */
export function readRecent(userId: string, s: Store | null = local()): string[] {
  try {
    const v = JSON.parse(s?.getItem(recentKey(userId)) ?? '[]') as unknown
    if (!Array.isArray(v)) return []
    return [...new Set(v.filter((x): x is string => typeof x === 'string' && isStatusEmoji(x)).map(emojiForm))].slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/** An emoji I just used goes first (once); the oldest past RECENT_MAX goes. */
export function noteRecent(userId: string, emoji: string, s: Store | null = local()): string[] {
  if (!isStatusEmoji(emoji)) return readRecent(userId, s)
  const e = emojiForm(emoji)
  const next = [e, ...readRecent(userId, s).filter((x) => x !== e)].slice(0, RECENT_MAX)
  try { s?.setItem(recentKey(userId), JSON.stringify(next)) } catch { /* storage full or blocked: this time only */ }
  return next
}
