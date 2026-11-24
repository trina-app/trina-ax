// What the server and the office worker share for edit_office (files/office-edit.ts runs in the worker only): the
// modes, the limits, the report's shape and the request framing. Nothing here parses a document, so the server process
// imports this file and never office-edit.ts.

export const OFFICE_EDIT_MODE = 'office-edit'
export const OFFICE_VERIFY_MODE = 'office-verify'
const MIB = 1024 * 1024
/** the documents edit_office changes (as comment_docx) */
export const OFFICE_EDIT_MAX = 48 * MIB
export const OFFICE_EDIT_LIMITS = {
  /** parts in the zip */
  entries: 5000,
  /** one XML part we parse, uncompressed */
  xmlBytes: 64 * MIB,
  /** elements of one part */
  nodes: 3_000_000,
  /** changes in one call */
  changes: 500,
  /** a replacement picture */
  imageBytes: 20 * MIB,
}
export type OfficeKind = 'docx' | 'xlsx' | 'pptx'

/** One line of the report for the AI: which change, where it went, the text before and after. */
export interface EditNote { change: number; where: string; before?: string; after?: string[] }
/** A cell an .xlsx edit wrote: what the verifier must read there (`formula` without "="). */
export interface CellWrite { sheet: string; ref: string; value: string | number | boolean | null; formula?: string }
export interface EditReport {
  notes: EditNote[]
  /** parts whose bytes changed, were added or were removed (the server checks every other part is copied as it was) */
  changed: string[]; added: string[]; removed: string[]
  /** .xlsx: the cells written (the verifier reads every other cell unchanged) */
  cells?: CellWrite[]
  /** .xlsx: formulas are calculated again when the file opens; stored results of other formulas are the old ones */
  recalc?: boolean
  /** .pptx, .xlsx: the pictures this call added: the slide or drawing part, the new shape id, its image relationship */
  placed?: PlacedPicture[]
}
export interface PlacedPicture { part: string; id: number; rid: string }


// ---------------------------------------------------------------- framing (JSON header + binary blobs)

/** [u32 json length][json][blob 0][blob 1]...; the JSON carries `blobs`, the blobs' lengths */
export function frame(json: Record<string, unknown>, blobs: Uint8Array[]): Uint8Array {
  const head = Buffer.from(JSON.stringify({ ...json, blobs: blobs.map((b) => b.length) }), 'utf8')
  const n = Buffer.alloc(4)
  n.writeUInt32BE(head.length, 0)
  return new Uint8Array(Buffer.concat([n, head, ...blobs.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength))]))
}
export function unframe<T>(b: Uint8Array): { json: T; blobs: Uint8Array[] } {
  if (b.length < 4) throw new Error('bad frame')
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false)
  if (4 + n > b.length) throw new Error('bad frame')
  const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(4, 4 + n))) as T & { blobs?: unknown }
  const lens = json.blobs
  if (!Array.isArray(lens) || !lens.every((x) => Number.isInteger(x) && x >= 0)) throw new Error('bad frame')
  const blobs: Uint8Array[] = []
  let p = 4 + n
  for (const len of lens as number[]) {
    if (p + len > b.length) throw new Error('bad frame')
    blobs.push(b.subarray(p, p + len))
    p += len
  }
  return { json, blobs }
}

export interface VerifyRequest { kind: OfficeKind; changed: string[]; added: string[]; notes: EditNote[]; cells?: CellWrite[]; placed?: PlacedPicture[] }
