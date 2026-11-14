// make_file writes an .xlsx formula together with its result when the formula is simple, so a viewer that does not
// calculate (the file preview, a phone, a mail preview) shows numbers and not "=SUM(B2:B5)". Simple means: numbers, cell
// references of the same sheet, + - * / ^, parentheses, and SUM, AVERAGE, MIN, MAX, COUNT, ABS, ROUND over literal cells or
// other simple formulas. Anything else gets no result (the spreadsheet app calculates it when it opens the file, as before).
type Cell = string | number | { formula: string; result?: unknown } | { error: string } | undefined | null

const isFormula = (c: Cell): c is { formula: string; result?: unknown } => typeof c === 'object' && c !== null && 'formula' in c

const colNumber = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
type Tok = { t: 'num'; v: number } | { t: 'ref'; col: number; row: number } | { t: 'id'; v: string } | { t: 'op'; v: string }

function lex(f: string): Tok[] | null {
  const out: Tok[] = []
  for (let i = 0; i < f.length; ) {
    const rest = f.slice(i)
    if (/^\s/.test(rest)) { i++; continue }
    let m = /^(?:\d+(?:\.\d*)?|\.\d+)(?![\p{L}\p{N}_.$])/u.exec(rest)
    if (m) { out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue }
    m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?![\p{L}\p{N}_.(])/u.exec(rest)
    if (m) { out.push({ t: 'ref', col: colNumber(m[1]!), row: Number(m[2]) }); i += m[0].length; continue }
    m = /^[A-Za-z][A-Za-z0-9]*(?=\()/.exec(rest)
    if (m) { out.push({ t: 'id', v: m[0].toUpperCase() }); i += m[0].length; continue }
    if ('+-*/^(),:'.includes(rest[0]!)) { out.push({ t: 'op', v: rest[0]! }); i++; continue }
    return null // a string, a sheet name, %, another operator, a name: not simple
  }
  return out
}

class Give extends Error {}

/** Adds `result` to every simple formula of the grid (rows[r][c] is cell row r+1, column c+1). */
export function addFormulaResults(rows: Cell[][]): void {
  const memo = new Map<string, number | null>()
  const width = rows.reduce((n, r) => Math.max(n, r?.length ?? 0), 0)
  const busy = new Set<string>()
  const cellNumber = (col: number, row: number, direct: boolean): number | null => {
    const c = rows[row - 1]?.[col - 1]
    if (c === undefined || c === null || c === '') return direct ? 0 : null
    if (typeof c === 'number') return c
    if (isFormula(c)) {
      const k = `${col},${row}`
      if (memo.has(k)) { const m = memo.get(k)!; if (m === null) throw new Give(); return m }
      if (busy.has(k)) throw new Give()
      busy.add(k)
      try { const v = evaluate(c.formula); memo.set(k, v); return v } catch (e) { memo.set(k, null); throw e } finally { busy.delete(k) }
    }
    if (direct) throw new Give()
    return null // text in a range is skipped, as SUM does
  }
  function evaluate(f: string): number {
    const toks = f.length > 2000 ? null : lex(f)
    if (!toks || toks.length > 1000) throw new Give()
    let p = 0
    const peek = () => toks[p]
    const op = (v: string) => { const t = toks[p]; if (t?.t === 'op' && t.v === v) { p++; return true } return false }
    const expr = (): number => { let v = term(); for (;;) { if (op('+')) v += term(); else if (op('-')) v -= term(); else return v } }
    const term = (): number => { let v = power(); for (;;) { if (op('*')) v *= power(); else if (op('/')) { const d = power(); if (d === 0) throw new Give(); v /= d } else return v } }
    const power = (): number => { let v = unary(); while (op('^')) { const e = unary(); if (v === 0 && e === 0) throw new Give(); v = v ** e } return v }
    const unary = (): number => (op('-') ? -unary() : op('+') ? unary() : primary())
    /** one function argument: a range or reference gives its numbers, anything else one number */
    const arg = (): number[] => {
      const t = peek()
      const next = toks[p + 1]
      const nv = next?.t === 'op' ? next.v : null
      if (t?.t === 'ref' && (nv === ':' || nv === ',' || nv === ')')) {
        const a = t; p += nv === ':' ? 2 : 1
        let b = a
        if (nv === ':') { const x = toks[p - 1 + 1]; if (x?.t !== 'ref') throw new Give(); b = x; p++ }
        // empty cells and text in a reference are skipped (SUM, MIN, AVERAGE, COUNT); cells past the data are empty
        const out: number[] = []
        const r1 = Math.min(a.row, b.row), r2 = Math.min(Math.max(a.row, b.row), rows.length)
        const c1 = Math.min(a.col, b.col), c2 = Math.min(Math.max(a.col, b.col), width)
        for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const v = cellNumber(c, r, false); if (v !== null) out.push(v) }
        if (nv !== ':' && out.length > 1) throw new Give()
        return out
      }
      return [expr()]
    }
    const primary = (): number => {
      const t = toks[p++]
      if (!t) throw new Give()
      if (t.t === 'num') return t.v
      if (t.t === 'ref') return cellNumber(t.col, t.row, true)!
      if (t.t === 'op' && t.v === '(') { const v = expr(); if (!op(')')) throw new Give(); return v }
      if (t.t === 'id') {
        if (!op('(')) throw new Give()
        const args: number[][] = []
        if (!op(')')) { for (;;) { args.push(arg()); if (op(')')) break; if (!op(',')) throw new Give() } }
        const all = args.flat()
        switch (t.v) {
          case 'SUM': return all.reduce((a, b) => a + b, 0)
          case 'AVERAGE': if (!all.length) throw new Give(); return all.reduce((a, b) => a + b, 0) / all.length
          case 'MIN': return all.reduce((a, b) => (b < a ? b : a), all.length ? all[0]! : 0)
          case 'MAX': return all.reduce((a, b) => (b > a ? b : a), all.length ? all[0]! : 0)
          case 'COUNT': return all.length
          case 'ABS': if (args.length !== 1 || args[0]!.length !== 1) throw new Give(); return Math.abs(args[0]![0]!)
          case 'ROUND': { if (args.length !== 2 || args[0]!.length !== 1 || args[1]!.length !== 1) throw new Give(); const d = Math.trunc(args[1]![0]!), x = args[0]![0]!; if (Math.abs(d) > 15) throw new Give(); const m = 10 ** d; return (Math.sign(x) * Math.round(Number((Math.abs(x) * m).toPrecision(15)))) / m }
          default: throw new Give()
        }
      }
      throw new Give()
    }
    const v = expr()
    if (p !== toks.length || !Number.isFinite(v)) throw new Give()
    return v
  }
  for (const row of rows) for (const c of row ?? []) {
    if (!isFormula(c)) continue
    try {
      const v = evaluate(c.formula)
      // 0.1 + 0.2 style noise: Excel shows 15 significant digits
      c.result = Number(v.toPrecision(15))
    } catch { /* no result: a wrong or missing result must never stop the save (Give, a too deep formula) */ }
  }
}
