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
  const memo = new Map<string, number>()
  const busy = new Set<string>()
  const cellNumber = (col: number, row: number, direct: boolean): number | null => {
    const c = rows[row - 1]?.[col - 1]
    if (c === undefined || c === null || c === '') return direct ? 0 : null
    if (typeof c === 'number') return c
    if (isFormula(c)) {
      const k = `${col},${row}`
      if (memo.has(k)) return memo.get(k)!
      if (busy.has(k)) throw new Give()
      busy.add(k)
      try { const v = evaluate(c.formula); memo.set(k, v); return v } finally { busy.delete(k) }
    }
    if (direct) throw new Give()
    return null // text in a range is skipped, as SUM does
  }
  function evaluate(f: string): number {
    const toks = lex(f)
    if (!toks) throw new Give()
    let p = 0
    const peek = () => toks[p]
    const op = (v: string) => { const t = toks[p]; if (t?.t === 'op' && t.v === v) { p++; return true } return false }
    const expr = (): number => { let v = term(); for (;;) { if (op('+')) v += term(); else if (op('-')) v -= term(); else return v } }
    const term = (): number => { let v = power(); for (;;) { if (op('*')) v *= power(); else if (op('/')) { const d = power(); if (d === 0) throw new Give(); v /= d } else return v } }
    const power = (): number => { const b = unary(); return op('^') ? b ** power() : b }
    const unary = (): number => (op('-') ? -unary() : op('+') ? unary() : primary())
    /** one function argument: a range or reference gives its numbers, anything else one number */
    const arg = (): number[] => {
      const t = peek()
      if (t?.t === 'ref' && toks[p + 1]?.t === 'op' && (toks[p + 1] as { v: string }).v === ':') {
        const a = t; p += 2
        const b = toks[p++]
        if (b?.t !== 'ref') throw new Give()
        const out: number[] = []
        for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) { const v = cellNumber(c, r, false); if (v !== null) out.push(v) }
        if (out.length > 100_000) throw new Give()
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
          case 'MIN': return all.length ? Math.min(...all) : 0
          case 'MAX': return all.length ? Math.max(...all) : 0
          case 'COUNT': return all.length
          case 'ABS': if (args.length !== 1 || args[0]!.length !== 1) throw new Give(); return Math.abs(args[0]![0]!)
          case 'ROUND': { if (args.length !== 2 || args[0]!.length !== 1 || args[1]!.length !== 1) throw new Give(); const d = args[1]![0]!, m = 10 ** d, x = args[0]![0]!; return (Math.sign(x) * Math.round(Math.abs(x) * m)) / m }
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
    } catch (e) { if (!(e instanceof Give)) throw e }
  }
}
