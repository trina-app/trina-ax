// move_picture for Word (edit_office) and Hangul (edit_hwp): the same picture, moved or resized by the id the result
// gave. The server keeps, for a while, what the call that placed it did (its changes as given, the file before it and
// the file it made); a move does that call again on the file as it was before, with this picture's place changed, and
// saves the result as a new version. So nothing in the document is edited twice and no format needs a "move" of its
// own. Only while the file is still what that call made, for the same person: else the AI is told to place it again.
// Kept in memory (a restart forgets them), bounded in bytes and time.
import crypto from 'node:crypto'
import { ToolError } from '../policy/errors'
import { sha256 } from '../files/store'

interface Placement { user: string; file: string; result: string; base: Uint8Array; changes: unknown[]; at: number }
const LIMITS = { bytes: 256 * 1024 * 1024, ms: 24 * 3600 * 1000 }
const calls = new Map<string, Placement>()
const pictures = new Map<string, { call: string; index: number }>()
let held = 0

function drop(id: string) {
  const p = calls.get(id)
  if (!p) return
  held -= p.base.length
  calls.delete(id)
  for (const [k, v] of pictures) if (v.call === id) pictures.delete(k)
}

/** A call that placed pictures: their ids, in the order of `indexes` (the changes that placed them). */
export function rememberPlacement(p: Omit<Placement, 'at'>, indexes: number[]): string[] {
  const now = Date.now()
  for (const [id, x] of calls) if (now - x.at > LIMITS.ms) drop(id)
  if (!indexes.length || p.base.length > LIMITS.bytes / 4) return []
  const call = crypto.randomUUID()
  calls.set(call, { ...p, at: now })
  held += p.base.length
  while (held > LIMITS.bytes) drop(calls.keys().next().value!)
  return indexes.map((index) => {
    const id = `pic-${crypto.randomBytes(4).toString('hex')}`
    pictures.set(id, { call, index })
    return id
  })
}

/** The call to do again for these moves: the file before it and its changes with each moved picture's change merged. */
export function replayPlacement<M extends { picture: unknown }>(user: string, file: string, current: Uint8Array, moves: M[], merge: (placed: Record<string, unknown>, move: M) => unknown): { base: Uint8Array; changes: unknown[] } {
  const again = 'place it again (insert the picture anew), then move that one'
  let call: string | null = null
  const out = new Map<number, M>()
  for (const m of moves) {
    const id = String(m.picture)
    const ref = pictures.get(id)
    if (!ref) throw new ToolError(`no picture ${JSON.stringify(id)} is known here (an id from the result that placed it, such as pic-1a2b3c4d; ids are forgotten after a day or a server restart); ${again}; nothing was saved`)
    if (call && ref.call !== call) throw new ToolError('the pictures of one call are moved together; give the pictures of one earlier result at a time; nothing was saved')
    call = ref.call
    out.set(ref.index, m)
  }
  const p = calls.get(call!)!
  if (p.user !== user || p.file !== file) throw new ToolError(`that picture is not in '${file}'; nothing was saved`)
  if (sha256(current) !== p.result) throw new ToolError(`'${file}' changed after that picture was placed, so it cannot be moved by its id; ${again}; nothing was saved`)
  return { base: p.base, changes: p.changes.map((c, i) => (out.has(i) ? merge(c as Record<string, unknown>, out.get(i)!) : c)) }
}

/** A moved picture's change: a new target replaces the old one; dx_mm/dy_mm add to what it was moved already; one side
 * alone keeps the picture's shape. `targets`: the fields that name where it goes. */
export function mergeMove(placed: Record<string, unknown>, move: Record<string, unknown>, targets: readonly string[]): Record<string, unknown> {
  const n: Record<string, unknown> = { ...placed }
  const retarget = targets.some((k) => move[k] !== undefined)
  if (retarget) { for (const k of targets) delete n[k]; delete n.shift }
  for (const k of targets) if (move[k] !== undefined) n[k] = move[k]
  if (move.width_mm !== undefined || move.height_mm !== undefined) {
    delete n.width_mm; delete n.height_mm
    if (move.width_mm !== undefined) n.width_mm = move.width_mm
    if (move.height_mm !== undefined) n.height_mm = move.height_mm
  }
  if (move.layer !== undefined) n.layer = move.layer
  if (move.dx_mm !== undefined || move.dy_mm !== undefined) {
    const s = (n.shift ?? { x_mm: 0, y_mm: 0 }) as { x_mm: number; y_mm: number }
    n.shift = { x_mm: s.x_mm + Number(move.dx_mm ?? 0), y_mm: s.y_mm + Number(move.dy_mm ?? 0) }
  }
  return n
}
