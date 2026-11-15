// The person's stored connection keys, hidden in what the AI gives the tools that save it (QA TC-3041): a file made
// or written (make_file, write, edit, edit_files, edit_hwp), an artifact, a deck, a video's description, a new file
// name. The answer, the steps and the audit already go through the turn's redactor (redact.ts); these arguments go
// through the same one before any card shows them and before anything is written, so the file, its text cache and an
// owner export hold HIDDEN where the AI wrote the key. remember, schedule_create and post_to_room hide it themselves.
//
// What the person already has stays as it is: a field the tool only uses to find text in an existing file (edit's
// old_string, edit_hwp's find and label cells, an artifact edit's old) is never changed, a replacement keeps a key
// form that the text it replaces already holds, and write keeps a form the file it overwrites already holds (their
// own uploaded file with their key in it is not changed by an AI rewrite). Paths the tool only reads (make_file's
// source and template, a promo's sources and logo) are left too.
import { HIDDEN } from './hide'
import type { Redactor } from './redact'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** every string in a JSON-like value, with `hide` applied; `keep` names top-level fields left as they are */
function deep(v: unknown, hide: (s: string) => string, keep: ReadonlySet<string> = new Set()): unknown {
  if (typeof v === 'string') return hide(v)
  if (Array.isArray(v)) return v.map((x) => deep(x, hide))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keep.has(k) ? x : deep(x, hide)]))
  return v
}

/** `text` with every key form hidden except the forms that `kept` holds as written */
export function hideExcept(r: Redactor, text: string, kept: string | null | undefined): string {
  if (!r.re || !text) return text
  if (!kept) return r.hide(text)
  return text.replace(r.re, (m) => (kept.includes(m) ? m : HIDDEN))
}

/** The tools whose arguments are saved somewhere, and what of them stays as given (see above). */
const KEEP: Record<string, readonly string[]> = {
  write: [],
  edit: ['file_path', 'old_string', 'new_string'],
  make_file: ['source', 'template'],
  edit_hwp: ['file_path', 'changes'],
  artifact: ['edits'],
  rename_file: ['path'],
  move_files: ['paths'],
  copy_files: ['paths'],
  save_url: ['url'],
  save_room_file: ['room', 'file'],
  generate_video: [],
  promo_video: ['sources', 'logo'],
  intro_deck: ['urls'],
}
export const KEY_HIDING_TOOLS: readonly string[] = Object.keys(KEEP)

export interface HiddenArgs { args: unknown; hidden: boolean }

/**
 * The arguments of a call to `name` with the stored keys hidden as described above. `current(path)`: the text of the
 * file write would overwrite (null: none, or not readable as text). A tool not listed, or a redactor with nothing to
 * hide, gets its arguments back unchanged.
 */
export function hideKeysInArgs(name: string, args: unknown, r: Redactor, current?: (path: string) => string | null): HiddenArgs {
  const keep = KEEP[name]
  if (!keep || !r.re || !isObj(args)) return { args, hidden: false }
  const out = deep(args, r.hide, new Set(keep)) as Obj
  if (name === 'write' && typeof args.content === 'string') {
    const was = typeof args.file_path === 'string' ? safe(() => current?.(args.file_path as string) ?? null) : null
    out.content = hideExcept(r, args.content, was)
  }
  if (name === 'edit' && typeof args.new_string === 'string') {
    out.new_string = hideExcept(r, args.new_string, typeof args.old_string === 'string' ? args.old_string : null)
  }
  if (name === 'edit_hwp' && Array.isArray(args.changes)) {
    out.changes = args.changes.map((c) => {
      if (!isObj(c)) return c
      if (typeof c.find === 'string' && typeof c.replace === 'string') return { ...c, replace: hideExcept(r, c.replace, c.find) }
      if (isObj(c.cell) && typeof c.value === 'string') return { ...c, value: r.hide(c.value) }
      if (isObj(c.add_rows)) return { ...c, add_rows: { ...c.add_rows, ...(Array.isArray(c.add_rows.rows) ? { rows: deep(c.add_rows.rows, r.hide) } : {}) } }
      return c
    })
  }
  if (name === 'artifact' && Array.isArray(args.edits)) {
    out.edits = args.edits.map((e) => (isObj(e) && typeof e.new === 'string' ? { ...e, new: hideExcept(r, e.new, typeof e.old === 'string' ? e.old : null) } : e))
  }
  return { args: out, hidden: JSON.stringify(out) !== JSON.stringify(args) }
}

function safe<T>(f: () => T): T | null {
  try { return f() } catch { return null }
}

/** what the AI is told after a call whose arguments had a key hidden */
export const KEYS_HIDDEN_NOTE = `A stored connection key in what you gave this tool was saved as ${HIDDEN}: the saved result does not hold the key. Say so if you tell the user what was saved; never write the key out another way.`
