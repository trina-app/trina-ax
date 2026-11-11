// What a connected service is about to be sent, as a person reads it on the server's card (docs/DECISIONS.md "Plain
// words in errors, cards and steps"): the tool by its title, not its id, and every value of the call as a labelled line
// ("받는 사람  a@b.example", "제목  주간 회의"), the recipients first. The exact JSON stays one click away on the card
// (ConfirmDetail.exact). Lines are made only when they show every value of the call in full; otherwise the card shows
// the JSON open, as before. Nothing here decides whether the card is shown or what its answer does (tools.ts gate).
import { readableToolName } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { opaqueParts } from '../../tools/url-gate'
import { FIELD_WORDS, say, type TextKey } from './text'

/** more values than this, nested deeper, or more characters in all: no lines, the JSON open */
export const CARD_LINES_MAX = 40
export const CARD_LINES_DEPTH = 4
export const CARD_LINES_CHARS = 20_000
const TITLE_MAX = 80

/** Characters that show nothing, turn text around or control the terminal: control characters (but a line break),
 * format characters, default-ignorable ones (joiners, selectors, Unicode tags) and private-use ones. An emoji's own
 * joiners, selectors and skin tones are allowed (EMOJI is taken out first); anywhere else such a character can carry data
 * nobody sees. In a title they are dropped; a call whose names or values hold one gets no lines (the JSON open). */
const INVISIBLE = /(?!\n)[\p{Cc}\p{Cf}\p{DI}\p{Co}]/u
const INVISIBLE_ALL = /[\p{Cc}\p{Cf}\p{DI}\p{Co}]/gu
const EMOJI = /\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}]|\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}]|\uFE0F|\uFE0E)?)*|[0-9#*]\uFE0F?\u20E3/gu
const invisible = (s: string) => INVISIBLE.test(s.replace(EMOJI, ''))
/** White space that a line would not show as it is sent: a tab or another kind of space, two spaces in a row, a space
 * at either end of a line, more than one empty line, white space at the start or the end. Such a value gets no lines
 * either: spacing can carry data too, and only the exact JSON shows every space. */
const ODD_SPACE = /[^\S\n ]| {2}| \n|\n |\n{3}|^\s|\s$/u
/** at most this long, a name of a value; a longer one squeezes the values off the card: no lines */
const NAME_MAX = 40

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** A service tool as the card and the step name it: its title from the service (MCP `title`, on one line, at most 80
 * characters, invisible and direction-changing characters out), else its id in words ("create_task" -> "Create task").
 * The title is the service's words like its id: a service that would mislead with it could also mark the tool read-only
 * and never be asked about at all (mcp.ts toolOf). */
export function toolTitle(tool: { name: string; title?: string | null }): string {
  const title = (tool.title ?? '').slice(0, 1000).normalize('NFKC').replace(/[\s\p{Zl}\p{Zp}]+/gu, ' ').replace(INVISIBLE_ALL, '').replace(/ {2,}/g, ' ').trim()
  return clip(title, TITLE_MAX) || readableToolName(tool.name) || tool.name
}

const METHOD_WORDS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
/** What an HTTP API method does, in words (methodPOST …); another method as it is. */
export function methodWord(method: string, L: Locale): string {
  const m = method.toUpperCase()
  return METHOD_WORDS.has(m) ? say(`method${m}` as TextKey, L) : m
}

/** One argument name in words: a known name's word in `L` (FIELD_WORDS), else its own words ("page_id" -> "Page id"),
 * else as it is. A name with a long random-looking part is shown as it is, so the card's highlight finds it. */
export function fieldWord(name: string, L: Locale): string {
  const key = name.toLowerCase().replace(/[\s_.-]+/g, '')
  const known = Object.hasOwn(FIELD_WORDS, key) ? FIELD_WORDS[key] : undefined
  if (known) return known[L] ?? known.en
  if (name.length > NAME_MAX || opaqueParts(name).length || !/^[A-Za-z][A-Za-z0-9]*(?:[ _.-][A-Za-z0-9]+)*$/.test(name)) return name
  return readableToolName(name) || name
}

type Seg = string | number
/** A value's place in the call in words: "받는 사람", "Parent › Page id", "Children 2 › Paragraph". */
function label(path: Seg[], L: Locale): string {
  const parts: string[] = []
  for (const s of path) {
    if (typeof s === 'number') parts.push(`${parts.pop() ?? ''} ${s + 1}`.trim())
    else parts.push(fieldWord(s, L))
  }
  return parts.join(' › ')
}


/**
 * Every value of a call as a labelled line, in the call's order with the recipients first (`isRecipient`: a name that
 * says where it goes), each text exactly as it is sent (a Windows line break as a line break), or null when lines could
 * not show all of it: more than CARD_LINES_MAX values, nested deeper than CARD_LINES_DEPTH, more than CARD_LINES_CHARS
 * in all, a name longer than NAME_MAX, an invisible character in a name or a value (INVISIBLE), white space a line
 * would not show as sent (ODD_SPACE), or not an object at all. A list of plain values is one line, one value per row.
 * Two values whose names read the same get their names as sent after the words ("내용 (html)").
 */
export function cardLines(args: unknown, L: Locale, isRecipient: (name: string) => boolean): { name: string; value: string }[] | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const lines: { name: string; raw: string; value: string; first: boolean }[] = []
  let chars = 0
  let bad = false
  const scalar = (v: unknown): string | null => {
    if (v === null || v === undefined) return say('valueNone', L)
    if (typeof v === 'boolean') return say(v ? 'valueYes' : 'valueNo', L)
    if (typeof v === 'number' || typeof v === 'bigint') return String(v)
    if (typeof v === 'string') {
      const t = v.replace(/\r\n/g, '\n')
      if (invisible(t) || ODD_SPACE.test(t)) { bad = true; return null }
      return t || say('valueEmpty', L)
    }
    return null
  }
  const add = (path: Seg[], value: string, first: boolean) => {
    chars += value.length
    if (lines.length >= CARD_LINES_MAX || chars > CARD_LINES_CHARS) { bad = true; return }
    lines.push({ name: label(path, L), raw: path.map((x) => (typeof x === 'number' ? `[${x}]` : x)).join('.'), value, first })
  }
  const walk = (v: unknown, path: Seg[], first: boolean) => {
    if (bad) return
    if (path.length > CARD_LINES_DEPTH) { bad = true; return }
    const name = path.at(-1)
    // a name: no line break either
    if (typeof name === 'string' && (name.length > NAME_MAX || invisible(name) || name.includes('\n'))) { bad = true; return }
    const first2 = first || (typeof name === 'string' && isRecipient(name))
    if (Array.isArray(v)) {
      if (!v.length) return add(path, say('valueNone', L), first2)
      // a list of plain values: one line, a value per row
      if (v.every((x) => x === null || typeof x !== 'object')) {
        const values = v.map(scalar)
        if (bad || values.some((x) => x === null)) { bad = true; return }
        return add(path, values.join('\n'), first2)
      }
      v.forEach((x, i) => walk(x, [...path, i], first2))
      return
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>)
      if (!entries.length) return add(path, say('valueNone', L), first2)
      for (const [k, x] of entries) walk(x, [...path, k], first2)
      return
    }
    const s = scalar(v)
    if (s === null) { bad = true; return }
    add(path, s, first2)
  }
  const top = Object.entries(args as Record<string, unknown>)
  if (!top.length) return null
  for (const [k, x] of top) walk(x, [k], false)
  if (bad) return null
  const same = new Map<string, number>()
  for (const l of lines) same.set(l.name, (same.get(l.name) ?? 0) + 1)
  return [...lines.filter((l) => l.first), ...lines.filter((l) => !l.first)].map(({ name, raw, value }) => ({ name: (same.get(name) ?? 0) > 1 && raw !== name ? `${name} (${raw})` : name, value }))
}
