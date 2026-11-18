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
import { HIDDEN, hideWith } from './hide'
import { nothingToHide, type Redactor } from './redact'

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
  if (nothingToHide(r) || !text) return text
  if (!kept || r.withheld) return r.hide(text)
  return hideWith(r.res, text, (m) => (kept.includes(m) ? m : HIDDEN))
}

/** The tools whose arguments are saved somewhere, and what of them stays as given (see above). */
const KEEP: Record<string, readonly string[]> = {
  write: [],
  edit: ['file_path', 'old_string', 'new_string'],
  make_file: ['source', 'template'],
  edit_hwp: ['file_path', 'changes'],
  stamp_pdf: ['file_path', 'image', 'page', 'position', 'width_mm', 'margin_mm'],
  edit_pdf: ['file_path'],
  merge_pdfs: ['files'],
  split_pdf: ['file_path', 'parts', 'every'],
  resize_images: ['paths', 'longest_side', 'width', 'max_mb', 'preset'],
  unzip_file: ['path', 'list_only'],
  make_zip: ['paths'],
  // the saved result is the files' own data; a key the AI wrote into the SQL is hidden like any argument
  query_data: ['paths', 'sheet', 'header_row', 'show_rows', 'split_by'],
  comment_docx: ['file_path'],
  edit_office: ['file_path'],
  artifact: ['edits'],
  rename_file: ['path'],
  move_files: ['paths'],
  copy_files: ['paths'],
  save_url: ['url'],
  save_connector_file: ['file'],
  save_room_file: ['room', 'file'],
  save_chat_file: ['file'],
  generate_video: [],
  promo_video: ['sources', 'logo'],
  save_promo_video: [],
  intro_deck: ['urls'],
}
export const KEY_HIDING_TOOLS: readonly string[] = Object.keys(KEEP)

/** `note`: what the AI is told after the call when something was hidden (KEYS_HIDDEN_NOTE when not given) */
export interface HiddenArgs { args: unknown; hidden: boolean; note?: string }

/**
 * The arguments of a call to `name` with the stored keys hidden as described above. `current(path)`: the text of the
 * file write would overwrite (null: none, or not readable as text). A tool not listed, or a redactor with nothing to
 * hide, gets its arguments back unchanged.
 */
export function hideKeysInArgs(name: string, args: unknown, r: Redactor, current?: (path: string) => string | null): HiddenArgs {
  const keep = KEEP[name]
  if (!keep || nothingToHide(r) || !isObj(args)) return { args, hidden: false }
  // the keys could not be made into a hider: nothing is saved unchecked
  if (r.withheld) throw new KeyRefusal(UNCHECKED_REFUSAL, 'stored keys could not be read')
  const out = deep(args, r.hide, new Set(keep)) as Obj
  if (name === 'write' && typeof args.content === 'string') {
    // the file it overwrites is the one at the path it really writes: the hidden one
    const target = typeof out.file_path === 'string' ? out.file_path : null
    const was = target !== null ? safe(() => current?.(target) ?? null) : null
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

/** what the AI is told after a call to a connected service whose arguments had a key hidden */
export const KEYS_SENT_HIDDEN_NOTE = `A stored connection key in what you gave this tool was sent as ${HIDDEN}: the service did not get the key. Say so if you tell the user what was sent; never write the key out another way.`

/** A call that is not sent at all: hiding the key would change data that must arrive byte for byte (a file's base64),
 * or the keys could not all be read to check it. */
export class KeyRefusal extends Error {
  /** for the audit line: why it was not sent */
  constructor(message: string, readonly short = 'a stored key in its data') { super(message) }
}

/** base64 data (a file, an attachment), not words: long and made of base64 characters only, once its whitespace (a
 * wrap at any width) is taken out */
const BLOB = /^[A-Za-z0-9+/_-]{64,}={0,2}$/

const DATA_REFUSAL = `Nothing was sent: data in what you gave this tool (a file or an attachment) holds one of the user's stored connection keys, and it cannot be sent with the key taken out. Tell the user; do not try it another way.`
/** a stored secret could not be read now: nothing is sent unchecked */
export const UNCHECKED_REFUSAL = `Nothing was sent: one of the user's stored connection keys could not be read just now, so what you gave this tool could not be checked for it. Try again in a moment; if it keeps failing, tell the user.`

/**
 * The arguments of a call to a connected service (a tool a connection provider adds to the turn: an MCP tool, Gmail,
 * Drive, Notion, api_request, call_tool; QA TC-3081) with every stored key hidden, in every value and field name. It
 * runs before the room card, the connection's card and the call, so the card shows exactly what is sent and the service
 * never gets the key. The connection's own credentials are never arguments (service.ts authHeaders, the connection
 * address), so they are not touched. KeyRefusal (the call is not sent) for a value that holds a key only once its
 * whitespace is taken out (base64 wrapped across lines, a key cut by a space or a line break: the redactor's patterns
 * do not match across them), and for base64 data that holds one (a file with a hole in it would be sent otherwise).
 */
export function hideAllArgs(args: unknown, r: Redactor): HiddenArgs {
  if (nothingToHide(r)) return { args, hidden: false }
  if (r.withheld) throw new KeyRefusal(UNCHECKED_REFUSAL, 'stored keys could not be read')
  let hidden = false
  const one = (s: string): string => {
    const h = r.hide(s)
    // what would be sent, with its whitespace taken out: a key still there was cut by a space or a line break (also
    // next to a whole copy that was hidden; HIDDEN itself becomes "[hiddenkey]", which matches nothing)
    const flat = h.replace(/\s+/g, '')
    if (flat !== h && r.hide(flat) !== flat) throw new KeyRefusal(DATA_REFUSAL)
    if (h === s) return s
    if (BLOB.test(s.replace(/\s+/g, ''))) throw new KeyRefusal(DATA_REFUSAL)
    hidden = true
    return h
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return one(v)
    if (Array.isArray(v)) return v.map(walk)
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [one(k), walk(x)]))
    return v
  }
  const out = walk(args)
  return hidden ? { args: out, hidden: true, note: KEYS_SENT_HIDDEN_NOTE } : { args, hidden: false }
}
