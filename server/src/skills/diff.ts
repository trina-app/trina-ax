// A small line diff for the "save under skills/?" confirmation card (team skills, docs/DECISIONS.md "팀 스킬 관리"):
// unified-diff hunks with three lines of context, cut when long. Common head and tail are skipped first; the middle
// is compared line by line (LCS) when it is small enough, otherwise shown as removed + added.
export interface LineDiff { text: string; added: number; removed: number; truncated: boolean }

const CONTEXT = 3
const MAX_CELLS = 4_000_000

export function lineDiff(before: string, after: string, maxChars = 6000): LineDiff {
  const a = splitLines(before)
  const b = splitLines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const am = a.slice(head, a.length - tail)
  const bm = b.slice(head, b.length - tail)
  // ops over the whole files: ' ' same, '-' removed, '+' added (with the line numbers in a / b)
  const ops: { op: ' ' | '-' | '+'; line: string; ai: number; bi: number }[] = []
  for (let i = 0; i < head; i++) ops.push({ op: ' ', line: a[i]!, ai: i, bi: i })
  for (const o of middle(am, bm)) ops.push({ op: o.op, line: o.line, ai: head + o.ai, bi: head + o.bi })
  for (let i = 0; i < tail; i++) ops.push({ op: ' ', line: a[a.length - tail + i]!, ai: a.length - tail + i, bi: b.length - tail + i })
  const added = ops.filter((o) => o.op === '+').length
  const removed = ops.filter((o) => o.op === '-').length
  // hunks: changed lines with CONTEXT lines around them
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach((o, i) => { if (o.op !== ' ') for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true })
  const out: string[] = []
  let i = 0
  while (i < ops.length) {
    if (!keep[i]) { i++; continue }
    let j = i
    while (j < ops.length && keep[j]) j++
    const part = ops.slice(i, j)
    const aStart = part.find((o) => o.op !== '+')?.ai ?? part[0]!.ai
    const bStart = part.find((o) => o.op !== '-')?.bi ?? part[0]!.bi
    const aLen = part.filter((o) => o.op !== '+').length
    const bLen = part.filter((o) => o.op !== '-').length
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`)
    for (const o of part) out.push(o.op + o.line)
    i = j
  }
  let text = out.join('\n')
  let truncated = false
  if (text.length > maxChars) { text = text.slice(0, maxChars).replace(/\n[^\n]*$/, '') + '\n…'; truncated = true }
  return { text, added, removed, truncated }
}

function splitLines(s: string): string[] {
  if (s === '') return []
  const lines = s.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function middle(a: string[], b: string[]): { op: '-' | '+' | ' '; line: string; ai: number; bi: number }[] {
  const out: { op: '-' | '+' | ' '; line: string; ai: number; bi: number }[] = []
  if (a.length * b.length > MAX_CELLS) {
    a.forEach((line, i) => out.push({ op: '-', line, ai: i, bi: 0 }))
    b.forEach((line, i) => out.push({ op: '+', line, ai: a.length, bi: i }))
    return out
  }
  // LCS lengths from the end
  const w = b.length + 1
  const L = new Uint32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!)
  }
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ op: ' ', line: a[i]!, ai: i, bi: j }); i++; j++ }
    // removed lines before added ones where both keep the longest common part
    else if (i < a.length && (j >= b.length || L[(i + 1) * w + j]! >= L[i * w + j + 1]!)) { out.push({ op: '-', line: a[i]!, ai: i, bi: j }); i++ }
    else { out.push({ op: '+', line: b[j]!, ai: i, bi: j }); j++ }
  }
  return out
}
