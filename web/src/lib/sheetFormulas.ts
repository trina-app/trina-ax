// Formula results for the spreadsheet preview (S-112). A file made by the AI (make_file, or openpyxl in the work
// folder) stores formulas without their results, and SheetJS does not calculate. Excel and Google Sheets calculate
// on open, so people expect numbers there, not "=SUM(B2:B4)".
//
// This file works out the common formulas for display only: + - * / ^ & %, comparisons, cell and range references
// (also to another sheet), SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, IFERROR, ROUND, ABS, AND, OR, NOT. A formula
// that uses anything else, a case whose Excel result is not certain (text in arithmetic, a range where one value is
// expected, a reference past the rows the preview read, a circular reference) is left as its formula: the preview
// never shows a number that Excel would not show. A stored result in the file always wins; nothing is written back.
import type { CellObject, WorkBook } from 'xlsx'

/** A formula cell of one sheet: its A1 address, the formula without "=", and whether the preview shows a result. */
export type SheetFormula = { addr: string; formula: string; shown: boolean }

type Err = { error: string }
type Scalar = number | string | boolean | null | Err // null = an empty cell
type Ref = { sheet: string; r0: number; c0: number; r1: number; c1: number }
type Val = Scalar | Ref

/** Thrown when a formula is outside what this file can calculate with certainty. */
class Unsupported extends Error {}
function no(why: string): never {
  throw new Unsupported(why)
}

const isErr = (v: unknown): v is Err => typeof v === 'object' && v !== null && 'error' in v
const isRef = (v: unknown): v is Ref => typeof v === 'object' && v !== null && 'sheet' in v
const DIV0: Err = { error: '#DIV/0!' }
/** SheetJS's codes for the Excel error values. */
const ERR_CODE: Record<string, number> = { '#NULL!': 0x00, '#DIV/0!': 0x07, '#VALUE!': 0x0f, '#REF!': 0x17, '#NAME?': 0x1d, '#NUM!': 0x24, '#N/A': 0x2a }

const colNum = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
const colName = (c: number) => {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

// ---- tokens ----

type Tok =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'ref'; v: Omit<Ref, 'sheet'> & { sheet?: string; cols?: boolean } }
  | { k: 'fn'; v: string }
  | { k: 'op'; v: string }

/** Excel's last row and column (0-based): 1048576 and XFD. */
const MAX_ROW = 1_048_575
const MAX_COL = 16_383
const CELL = String.raw`\$?([A-Z]{1,3})\$?(\d{1,7})`
const COLS = String.raw`\$?([A-Z]{1,3}):\$?([A-Z]{1,3})(?![\d(A-Z])`
const SHEET = String.raw`(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!`

function tokens(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    let m: RegExpExecArray | null
    if (/^\s/.test(rest)) {
      i++
      continue
    }
    if ((m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(rest))) {
      out.push({ k: 'num', v: Number(m[0]) })
    } else if (rest[0] === '"') {
      m = /^"((?:[^"]|"")*)"/.exec(rest) ?? no('string')
      out.push({ k: 'str', v: m[1]!.replace(/""/g, '"') })
    } else if ((m = new RegExp(`^(?:${SHEET})?(?:${COLS}|${CELL}(?::${CELL})?)(?![\\p{L}\\p{N}_(!])`, 'u').exec(rest))) {
      const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]
      if (m[3] !== undefined) {
        const a = colNum(m[3]), b = colNum(m[4]!)
        if (Math.max(a, b) > MAX_COL) no('outside the grid')
        out.push({ k: 'ref', v: { sheet, r0: 0, r1: 0, c0: Math.min(a, b), c1: Math.max(a, b), cols: true } })
      } else {
        const c0 = colNum(m[5]!), r0 = Number(m[6]) - 1
        const c1 = m[7] !== undefined ? colNum(m[7]) : c0, r1 = m[8] !== undefined ? Number(m[8]) - 1 : r0
        if (r0 < 0 || r1 < 0 || Math.max(r0, r1) > MAX_ROW || Math.max(c0, c1) > MAX_COL) no('outside the grid') // e.g. XYZ1: a name
        out.push({ k: 'ref', v: { sheet, r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) } })
      }
    } else if ((m = /^([A-Za-z][A-Za-z0-9.]*)\s*\(/.exec(rest))) {
      out.push({ k: 'fn', v: m[1]!.toUpperCase() })
    } else if ((m = /^(TRUE|FALSE)(?![\w(!])/i.exec(rest))) {
      out.push({ k: 'bool', v: m[1]!.toUpperCase() === 'TRUE' })
    } else if ((m = /^(<>|<=|>=|[-+*/^&=<>%(),])/.exec(rest))) {
      out.push({ k: 'op', v: m[1]! })
    } else {
      // a defined name, an error literal, a structured reference, an array constant, a row range …
      no(`token ${rest.slice(0, 12)}`)
    }
    i += m[0].length
  }
  return out
}

// ---- syntax tree ----

type Node =
  | { t: 'lit'; v: Scalar }
  | { t: 'ref'; v: Tok & { k: 'ref' } }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'pct'; a: Node }
  | { t: 'paren'; a: Node } // kept: Excel's zero rule for a last + or - does not apply inside parentheses
  | { t: 'call'; fn: string; args: Node[] }

// Excel precedence, lowest first: comparison, &, + -, * /, ^, unary minus, %.
const LEVELS = [['=', '<>', '<', '>', '<=', '>='], ['&'], ['+', '-'], ['*', '/'], ['^']]

function parse(src: string): Node {
  const ts = tokens(src)
  let p = 0
  const peekOp = (...ops: string[]) => {
    const t = ts[p]
    return t?.k === 'op' && ops.includes(t.v) ? t.v : undefined
  }
  const expect = (op: string) => (peekOp(op) ? p++ : no(`expected ${op}`))
  const level = (n: number): Node => {
    if (n === LEVELS.length) return unary()
    let a = level(n + 1)
    for (let op = peekOp(...LEVELS[n]!); op; op = peekOp(...LEVELS[n]!)) {
      p++
      a = { t: 'bin', op, a, b: level(n + 1) }
    }
    return a
  }
  const unary = (): Node => {
    const op = peekOp('-', '+')
    if (op) {
      p++
      return { t: 'un', op, a: unary() }
    }
    let a = atom()
    while (peekOp('%')) {
      p++
      a = { t: 'pct', a }
    }
    return a
  }
  const atom = (): Node => {
    const t = ts[p++] ?? no('end')
    if (t.k === 'num' || t.k === 'str' || t.k === 'bool') return { t: 'lit', v: t.v }
    if (t.k === 'ref') return { t: 'ref', v: t }
    if (t.k === 'fn') {
      const args: Node[] = []
      if (!peekOp(')')) {
        do args.push(level(0))
        while (peekOp(',') && ++p)
      }
      expect(')')
      return { t: 'call', fn: t.v, args }
    }
    if (t.v === '(') {
      const a = level(0)
      expect(')')
      return { t: 'paren', a }
    }
    return no(`op ${t.v}`)
  }
  const root = level(0)
  if (p !== ts.length) no('trailing')
  return root
}

// ---- values ----

/** Excel's General text for a number inside "&": up to 15 significant digits. */
function numText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
  const s = n.toPrecision(15)
  if (/e/i.test(s)) no('exponent text')
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

function num(v: Scalar): number | Err {
  if (isErr(v)) return v
  if (v === null) return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  return no('text in arithmetic')
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : no('overflow')
}

/** Excel's order across types: numbers < text < logicals; text without case. */
function compare(a: Scalar, b: Scalar): number {
  const rank = (v: Scalar) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2)
  // an empty cell takes the other side's type
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (typeof a === 'string') {
    const x = a.toLowerCase(), y = (b as string).toLowerCase()
    if (x === y) return 0
    // Excel sorts text by its own collation (accents, Hangul, "-" and "'" are ordered differently): plain letters,
    // digits and spaces only
    if (!/^[a-z0-9 ]*$/.test(x) || !/^[a-z0-9 ]*$/.test(y)) no('text order')
    return x < y ? -1 : 1
  }
  // numbers compare on the 15 digits Excel keeps: =0.1+0.2=0.3 is TRUE
  const x = Number(Number(a).toPrecision(15)), y = Number(Number(b).toPrecision(15))
  return x < y ? -1 : x > y ? 1 : 0
}

/** ROUND: half away from zero, on the decimal value Excel shows (15 digits), not the binary one. */
function round(n: number, d: number): number {
  const f = 10 ** d
  const x = Number((Math.abs(n) * f).toPrecision(15))
  return finite((Math.sign(n) * Math.round(x)) / f)
}

// ---- the workbook ----

type Sheet = { data: (CellObject | undefined)[][]; rows: number; cut: boolean }
const MAX_DEPTH = 200
/** Cell reads for the whole workbook preview, all formulas together (a few hundred ms): thousands of "=SUM(A1:A1048576)"
 * each with a budget of its own froze the tab (review of batch 3, #374). Past it every formula left shows as its text,
 * never a number worked out from part of a range. */
const MAX_CELLS = 8_000_000
/** Filled range values kept for reuse (all ranges together), so the same range read by many formulas costs its reads once. */
const MAX_KEPT = 2_000_000

export class FormulaBook {
  private sheets = new Map<string, Sheet | null>() // null: two sheets with one upper-case name
  /** Cells of array formulas ({=…} over a range): only the first cell holds the formula, the others read empty. */
  private arrays: Ref[] = []
  /** The formula being worked out at the top, for Excel's zero rule of a last + or -. */
  private root: Node | null = null
  private memo = new Map<string, Scalar | Unsupported>()
  private busy = new Set<string>()
  private depth = 0
  /** cell reads so far, for the whole book (MAX_CELLS) */
  private reads = 0
  /** the filled values of a range read in full (key: sheet and box), and how many values are kept (MAX_KEPT) */
  private ranges = new Map<string, Exclude<Scalar, null>[]>()
  private kept = 0
  /** The file asks to be recalculated on open (openpyxl and XlsxWriter set this; XlsxWriter stores 0 as every
   * result): Excel then ignores the stored results, so the preview does too. */
  readonly fullCalc: boolean

  /** `cut` names the sheets the preview read only partly (sheetRows): a reference past their last row is not
   * calculated. */
  constructor(wb: WorkBook, cut: ReadonlySet<string>, decodeRange: (ref: string) => { e: { r: number } }) {
    const calc = (wb.Workbook as { CalcPr?: { fullCalcOnLoad?: string } } | undefined)?.CalcPr?.fullCalcOnLoad
    this.fullCalc = calc === '1' || calc === 'true'
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name] as { '!data'?: (CellObject | undefined)[][]; '!ref'?: string } | undefined
      const data = ws?.['!data'] ?? []
      const rows = ws?.['!ref'] ? decodeRange(ws['!ref']).e.r + 1 : 0
      const key = name.toUpperCase()
      this.sheets.set(key, this.sheets.has(key) ? null : { data, rows, cut: cut.has(name) })
      data.forEach((row, r) =>
        row?.forEach((cell, c) => {
          if (!cell?.F) return
          const m = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(cell.F)
          const box = m ? { r0: Number(m[2]) - 1, c0: colNum(m[1]!), r1: Number(m[4] ?? m[2]) - 1, c1: colNum(m[3] ?? m[1]!) } : { r0: r, c0: c, r1: MAX_ROW, c1: MAX_COL }
          this.arrays.push({ sheet: key, ...box })
        }),
      )
    }
  }

  /** A formula cell whose stored result is not used: none was stored (SheetJS reads it as type "z", or as an error
   * without a value), or the file asks for a full recalculation. */
  missing(cell: CellObject | undefined): cell is CellObject & { f: string } {
    return !!cell?.f && (this.fullCalc || cell.t === 'z' || cell.v === undefined)
  }

  /** The result of one formula cell, or Unsupported. */
  result(sheet: string, r: number, c: number): Scalar | Unsupported {
    const key = `${sheet.toUpperCase()}!${r},${c}`
    const known = this.memo.get(key)
    if (known !== undefined) return known
    const cell = this.sheets.get(sheet.toUpperCase())?.data[r]?.[c]
    if (!this.missing(cell)) return new Unsupported('no formula')
    if (this.busy.has(key)) throw new Unsupported('circular')
    if (this.depth >= MAX_DEPTH) throw new Unsupported('depth') // not memoised: a shallower start may succeed
    this.busy.add(key)
    this.depth++
    const outer = this.root
    try {
      if (cell.F) no('array formula')
      const root = parse(cell.f)
      this.root = root
      let v = this.value(root, sheet)
      if (isRef(v)) v = this.single(v) // "=A1" or "=Sheet2!B5"; a range would spill
      if (v === null) v = 0 // "=A1" on an empty cell shows 0, as in Excel
      this.memo.set(key, v)
      return v
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e
      if (e.message === 'depth' || e.message === 'circular') throw e // the outer formula fails too
      this.memo.set(key, e)
      return e
    } finally {
      this.root = outer
      this.busy.delete(key)
      this.depth--
    }
  }

  private sheetOf(name: string): Sheet {
    return this.sheets.get(name.toUpperCase()) ?? no('no such sheet, or two sheets with one name')
  }

  /** A whole-column reference ("B:B") ends at the sheet's last row; on a sheet cut at the row limit it is not known. */
  private resolve(t: Tok & { k: 'ref' }, here: string): Ref {
    const sheet = t.v.sheet ?? here
    const s = this.sheetOf(sheet)
    if (!t.v.cols) {
      if (s.cut && t.v.r1 >= s.rows) no('past the rows read')
      return { sheet, r0: t.v.r0, r1: t.v.r1, c0: t.v.c0, c1: t.v.c1 }
    }
    if (s.cut) no('whole column on a cut sheet')
    return { sheet, r0: 0, r1: Math.max(0, s.rows - 1), c0: t.v.c0, c1: t.v.c1 }
  }

  /** The value of one cell: a stored value, or its formula's result. */
  private cell(sheet: string, r: number, c: number): Scalar {
    if (++this.reads > MAX_CELLS) no('too many cells')
    const s = this.sheetOf(sheet)
    const key = sheet.toUpperCase()
    if (this.arrays.some((a) => a.sheet === key && r >= a.r0 && r <= a.r1 && c >= a.c0 && c <= a.c1)) no('inside an array formula')
    const cell = s.data[r]?.[c]
    if (!cell) return null
    if (this.missing(cell)) {
      const v = this.result(sheet, r, c)
      if (v instanceof Unsupported) throw v
      return v
    }
    switch (cell.t) {
      case 'n':
        return typeof cell.v === 'number' ? cell.v : no('number cell')
      case 's':
        return String(cell.v ?? '')
      case 'b':
        return !!cell.v
      case 'e':
        return { error: cell.w ?? no('error text') }
      case 'z':
        return null
      default:
        return no(`cell type ${cell.t}`) // a date cell (cellDates) is not read here
    }
  }

  private single(ref: Ref): Scalar {
    if (ref.r0 !== ref.r1 || ref.c0 !== ref.c1) no('range as one value')
    return this.cell(ref.sheet, ref.r0, ref.c0)
  }

  /** A range's values in order, without its empty cells (every use skips them: SUM-like numbers, COUNT, COUNTA), so
   * a million-row range of a few thousand values is reused as those few thousand. Read in full before any is used,
   * and kept (up to MAX_KEPT values): a read that fails (Unsupported, also the budget) keeps nothing, so a range is
   * reused only as it was read whole. */
  private cells(ref: Ref): readonly Exclude<Scalar, null>[] {
    const key = `${ref.sheet.toUpperCase()}!${ref.r0},${ref.c0}:${ref.r1},${ref.c1}`
    const known = this.ranges.get(key)
    if (known) return known
    const out: Exclude<Scalar, null>[] = []
    for (let r = ref.r0; r <= ref.r1; r++)
      for (let c = ref.c0; c <= ref.c1; c++) {
        const v = this.cell(ref.sheet, r, c)
        if (v !== null) out.push(v)
      }
    if (this.kept + out.length <= MAX_KEPT) {
      this.ranges.set(key, out)
      this.kept += out.length
    }
    return out
  }

  private scalar(n: Node, here: string): Scalar {
    const v = this.value(n, here)
    return isRef(v) ? this.single(v) : v
  }

  private value(n: Node, here: string): Val {
    switch (n.t) {
      case 'lit':
        return n.v
      case 'ref':
        return this.resolve(n.v, here)
      case 'un': {
        const a = num(this.scalar(n.a, here))
        return isErr(a) ? a : n.op === '-' ? -a : a
      }
      case 'pct': {
        const a = num(this.scalar(n.a, here))
        return isErr(a) ? a : a / 100
      }
      case 'paren':
        return this.value(n.a, here)
      case 'bin':
        return this.binary(n.op, this.scalar(n.a, here), this.scalar(n.b, here), n === this.root)
      case 'call':
        return this.call(n.fn, n.args, here)
    }
  }

  /** `top`: the formula's last operation. */
  private binary(op: string, a: Scalar, b: Scalar, top = false): Scalar {
    if (isErr(a)) return a
    if (isErr(b)) return b
    if (op === '&') {
      const text = (v: Exclude<Scalar, Err>) => (v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? numText(v) : v)
      return text(a) + text(b)
    }
    if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
      const c = compare(a, b)
      return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0
    }
    const x = num(a), y = num(b)
    if (isErr(x)) return x
    if (isErr(y)) return y
    switch (op) {
      case '+':
      case '-': {
        const r = finite(op === '+' ? x + y : x - y)
        // binary noise left by cancelling (0.5-0.4-0.1): Excel shows 0 when it is the formula's last + or -;
        // elsewhere its result depends on rules not modelled here
        if (r !== 0 && Math.abs(r) < Math.max(Math.abs(x), Math.abs(y)) * 2 ** -48) return top ? 0 : no('cancellation')
        return r
      }
      case '*':
        return finite(x * y)
      case '/':
        return y === 0 ? DIV0 : finite(x / y)
      case '^':
        if (x === 0 && y === 0) no('0^0') // #NUM! in Excel
        if (x < 0 && !Number.isInteger(y)) no('root of a negative')
        return finite(x ** y)
    }
    return no(`op ${op}`)
  }

  /** Numbers of SUM-like arguments: in a reference only number cells count (text, logicals, empty cells are
   * skipped, an error is the result); a typed number or logical counts. */
  private numbers(args: Node[], here: string): number[] | Err {
    const out: number[] = []
    for (const a of args) {
      const v = this.value(a, here)
      if (isRef(v)) {
        for (const x of this.cells(v)) {
          if (isErr(x)) return x
          if (typeof x === 'number') out.push(x)
        }
      } else if (isErr(v)) return v
      else if (typeof v === 'number') out.push(v)
      else if (typeof v === 'boolean' && a.t === 'lit') out.push(Number(v)) // a typed TRUE counts; one from a cell would not
      else no('text or empty argument')
    }
    return out
  }

  private logical(v: Scalar): boolean | Err {
    if (isErr(v)) return v
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (v === null) return false
    return no('text as a condition')
  }

  private call(fn: string, args: Node[], here: string): Val {
    const arity = (min: number, max: number) => (args.length < min || args.length > max ? no(`${fn} arguments`) : undefined)
    switch (fn) {
      case 'SUM': {
        arity(1, 255)
        const ns = this.numbers(args, here)
        return isErr(ns) ? ns : finite(ns.reduce((s, x) => s + x, 0))
      }
      case 'AVERAGE': {
        arity(1, 255)
        const ns = this.numbers(args, here)
        if (isErr(ns)) return ns
        return ns.length ? finite(ns.reduce((s, x) => s + x, 0) / ns.length) : DIV0
      }
      case 'MIN':
      case 'MAX': {
        arity(1, 255)
        const ns = this.numbers(args, here)
        if (isErr(ns)) return ns
        return ns.length ? ns.reduce((m, x) => (fn === 'MIN' ? Math.min(m, x) : Math.max(m, x))) : 0
      }
      case 'COUNT':
      case 'COUNTA': {
        arity(1, 255)
        let n = 0
        for (const a of args) {
          const v = this.value(a, here)
          if (!isRef(v)) no(`${fn} of a typed value`)
          for (const x of this.cells(v)) {
            if (fn === 'COUNT' ? typeof x === 'number' : x !== null) n++
          }
        }
        return n
      }
      case 'IF': {
        arity(2, 3)
        const c = this.logical(this.scalar(args[0]!, here))
        if (isErr(c)) return c
        // only the branch taken is worked out, as in Excel
        const branch = c ? args[1]! : args[2]
        if (!branch) return false
        // an empty cell stays empty here (Excel passes the reference on); result() shows it as 0 at the top
        return this.value(branch, here)
      }
      case 'IFERROR': {
        arity(2, 2)
        const v = this.value(args[0]!, here)
        return isErr(isRef(v) ? this.single(v) : v) ? this.value(args[1]!, here) : v
      }
      case 'ROUND': {
        arity(2, 2)
        const n = num(this.scalar(args[0]!, here)), d = num(this.scalar(args[1]!, here))
        if (isErr(n)) return n
        if (isErr(d)) return d
        return round(n, Math.trunc(d))
      }
      case 'ABS': {
        arity(1, 1)
        const n = num(this.scalar(args[0]!, here))
        return isErr(n) ? n : Math.abs(n)
      }
      case 'AND':
      case 'OR': {
        arity(1, 255)
        let acc = fn === 'AND'
        for (const a of args) {
          const v = this.value(a, here)
          if (isRef(v)) no(`${fn} of a range`)
          const b = this.logical(v)
          if (isErr(b)) return b
          acc = fn === 'AND' ? acc && b : acc || b
        }
        return acc
      }
      case 'NOT': {
        arity(1, 1)
        const b = this.logical(this.scalar(args[0]!, here))
        return isErr(b) ? b : !b
      }
    }
    return no(`function ${fn}`)
  }
}

/** Number format text, from SheetJS's SSF.format. */
type Format = (z: string | number, v: number) => string

/**
 * Fills in the result of each formula cell that has no stored result (SheetJS reads it as type "z" with `f`), or
 * every formula cell when the file asks for a full recalculation, in the dense sheets of `wb`, for display. A cell the preview cannot work out keeps its formula as text ("=VLOOKUP(…)").
 * Returns every formula cell per sheet, also those with a stored result, so the preview can show the formula on hover.
 */
export function fillFormulaResults(
  wb: WorkBook,
  opts: { cut: ReadonlySet<string>; decodeRange: (ref: string) => { e: { r: number } }; format: Format },
): Map<string, SheetFormula[]> {
  const book = new FormulaBook(wb, opts.cut, opts.decodeRange)
  const out = new Map<string, SheetFormula[]>()
  // first work out every missing result, against the cells as read; then write them in
  const results: { row: (CellObject | undefined)[]; j: number; cell: CellObject; v: Scalar | Unsupported }[] = []
  for (const name of wb.SheetNames) {
    const list: SheetFormula[] = []
    out.set(name, list)
    const data = (wb.Sheets[name] as { '!data'?: (CellObject | undefined)[][] } | undefined)?.['!data'] ?? []
    data.forEach((row, i) => {
      row?.forEach((cell, j) => {
        if (!cell?.f) return
        const addr = `${colName(j)}${i + 1}`
        if (!book.missing(cell)) {
          list.push({ addr, formula: cell.f, shown: true })
          return
        }
        let v: Scalar | Unsupported
        try {
          v = book.result(name, i, j)
        } catch (e) {
          if (!(e instanceof Unsupported)) throw e
          v = e
        }
        list.push({ addr, formula: cell.f, shown: !(v instanceof Unsupported) })
        results.push({ row, j, cell, v })
      })
    })
  }
  for (const { row, j, cell, v } of results) row[j] = displayCell(cell, v, opts.format)
  return out
}

function displayCell(cell: CellObject, v: Scalar | Unsupported, format: Format): CellObject {
  const f = cell.f!
  const z = cell.z
  if (v instanceof Unsupported || v === null) return { t: 's', v: `=${f}`, w: `=${f}`, f }
  if (isErr(v)) return { t: 'e', v: ERR_CODE[v.error] ?? 0x0f, w: v.error, f }
  if (typeof v === 'boolean') return { t: 'b', v, w: v ? 'TRUE' : 'FALSE', f }
  if (typeof v === 'string') return { t: 's', v, w: v, f }
  let w: string
  try {
    w = format(z ?? 'General', v)
  } catch {
    try {
      w = numText(v)
    } catch {
      return { t: 's', v: `=${f}`, w: `=${f}`, f }
    }
  }
  return { t: 'n', v, w, f, ...(z !== undefined ? { z } : {}) }
}
