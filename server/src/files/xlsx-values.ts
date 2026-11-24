// Excel values (docs/decisions/20261124-doc-skills.md): a workbook built with openpyxl holds formulas with no stored
// result, so the file preview, a phone or a mail preview shows empty cells. LibreOffice recalculates a copy in the
// converters' isolation (files/office-view.ts officeRecalc); this takes ONLY the result of each formula cell from that
// copy and writes it into the original file's own sheet XML. Nothing else of the original changes: its formulas, styles,
// charts, names and parts stay byte for byte. Runs in the office worker (both files are untrusted).
import { ToolError } from '../policy/errors'
import { readZip, writeZip, type ZipEntry } from './zip-write'
import { checkZip, isZip } from './zip-guard'

const dec = new TextDecoder('utf-8', { fatal: false }), enc = new TextEncoder()
const CELL = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g
const attr = (attrs: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1] ?? null
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** sheet name -> its part, from workbook.xml and its .rels */
function sheetParts(entries: ZipEntry[]): Map<string, string> {
  const get = (n: string) => entries.find((e) => e.name === n)
  const wb = get('xl/workbook.xml'), rels = get('xl/_rels/workbook.xml.rels')
  const out = new Map<string, string>()
  if (!wb || !rels) return out
  const targets = new Map<string, string>()
  for (const m of dec.decode(rels.data).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1]!, 'Id'), t = attr(m[1]!, 'Target')
    if (id && t) targets.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t}`)
  }
  for (const m of dec.decode(wb.data).matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1]!, 'name'), id = /\sr:id="([^"]*)"/.exec(m[1]!)?.[1] ?? attr(m[1]!, 'id')
    const t = id ? targets.get(id) : undefined
    if (name && t) out.set(unesc(name), t)
  }
  return out
}

/** shared strings of a package */
function sharedStrings(entries: ZipEntry[]): string[] {
  const e = entries.find((x) => x.name === 'xl/sharedStrings.xml')
  if (!e) return []
  return [...dec.decode(e.data).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1]!)).join(''))
}

type Value = { t: 'n' | 'str' | 'b' | 'e'; v: string }

/** each formula cell's result in the recalculated copy, by sheet name and cell */
function results(entries: ZipEntry[]): Map<string, Map<string, Value>> {
  const ss = sharedStrings(entries)
  const out = new Map<string, Map<string, Value>>()
  for (const [name, part] of sheetParts(entries)) {
    const e = entries.find((x) => x.name === part)
    if (!e) continue
    const m = new Map<string, Value>()
    for (const c of dec.decode(e.data).matchAll(CELL)) {
      const body = c[3] ?? ''
      if (!/<f\b/.test(body)) continue
      const r = attr(c[1]!, 'r'), t = attr(c[1]!, 't') ?? 'n'
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      if (!r || v === undefined) continue
      if (t === 's') m.set(r, { t: 'str', v: esc(ss[Number(unesc(v))] ?? '') })
      else if (t === 'str' || t === 'b' || t === 'e') m.set(r, { t, v })
      else if (t === 'n' && /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) m.set(r, { t: 'n', v })
    }
    out.set(name, m)
  }
  return out
}

/** The original workbook with the recalculated copy's formula results. Returns the bytes and how many cells got one. */
export function mergeXlsxValues(original: Uint8Array, recalculated: Uint8Array): { bytes: Uint8Array; cells: number; formulas: number } {
  for (const b of [original, recalculated]) { if (!isZip(b)) throw new ToolError('not an Excel file'); checkZip(b) }
  const orig: ZipEntry[] = readZip(original), got = results(readZip(recalculated))
  let cells = 0, formulas = 0
  for (const [name, part] of sheetParts(orig)) {
    const e = orig.find((x) => x.name === part)
    const vals = got.get(name)
    if (!e) continue
    const xml = dec.decode(e.data)
    const next = xml.replace(CELL, (whole, attrs: string, _end: string, body: string | undefined) => {
      if (!body || !/<f\b/.test(body)) return whole
      formulas++
      const r = attr(attrs, 'r'), v = r ? vals?.get(r) : undefined
      if (!v) return whole
      cells++
      const a = attrs.replace(/\st="[^"]*"/, '') + (v.t === 'n' ? '' : ` t="${v.t}"`)
      const f = /<f\b[^>]*\/>|<f\b[^>]*>[\s\S]*?<\/f>/.exec(body)![0]
      const rest = body.replace(/<f\b[^>]*\/>|<f\b[^>]*>[\s\S]*?<\/f>/, '').replace(/<v>[\s\S]*?<\/v>/, '').replace(/<is>[\s\S]*?<\/is>/, '')
      return `<c${a}>${f}<v>${v.v}</v>${rest}</c>`
    })
    if (next !== xml) { e.data = enc.encode(next); delete e.raw; delete e.store }
  }
  return { bytes: cells ? writeZip(orig) : original, cells, formulas }
}

/** The office worker's `xlsx-values` mode: [length of the original (4 bytes, big-endian), original, recalculated copy]. */
export const XLSX_VALUES_MODE = 'xlsx-values'
export function xlsxValuesRequest(input: Uint8Array): Uint8Array {
  if (input.length < 4) throw new ToolError('no workbook')
  const n = new DataView(input.buffer, input.byteOffset, 4).getUint32(0)
  if (4 + n > input.length) throw new ToolError('a bad request')
  return mergeXlsxValues(input.subarray(4, 4 + n), input.subarray(4 + n)).bytes
}
