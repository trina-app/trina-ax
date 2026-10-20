// 20k-file team tree for the grep benchmark (port of the prototype gen_big.py, no Python).
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { makePdf } from '../lib/pdf'

let seed = 42
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]

export function genBig(team: string, nText = 19700, nOffice = 300) {
  const t0 = Date.now()
  const words = ('the of and to in is for on with as by at from this that project meeting budget review customer report plan team update ' +
    '회의 결정 예산 고객 보고서 계획 일정 검토 마케팅 캠페인 매출 채용 온보딩 파트너 리스크 status owner deadline q3 q4 kpi').split(' ')
  const lines: string[] = []
  for (let i = 0; i < 20000; i++) { const n = 4 + Math.floor(rnd() * 18); lines.push(Array.from({ length: n }, () => pick(words)).join(' ')) }
  const CORPUS = lines.join('\n') + '\n'
  const tops: [string, number, number][] = [['shared', 0.28, 8], ['groups/marketing', 0.22, 6], ['users/alice', 0.1, 4], ['groups/finance', 0.3, 8], ['users/bob', 0.05, 3], ['projects/atlas', 0.05, 3]]
  const leaves = new Map<string, string[]>()
  for (const [top, , n2] of tops) { const l: string[] = []; for (let a = 0; a < n2; a++) for (let b = 0; b < 5; b++) l.push(`${top}/area${String(a).padStart(2, '0')}/2026-q${b + 1}`); leaves.set(top, l) }
  let count = 0, bytes = 0
  for (const [top, share] of tops) {
    const nf = Math.floor(nText * share)
    for (let i = 0; i < nf; i++) {
      const leaf = pick(leaves.get(top)!)
      const ext = pick(['.md', '.md', '.md', '.txt', '.csv'])
      const p = path.join(team, leaf, `doc${String(count).padStart(5, '0')}${ext}`)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const size = Math.floor(2048 * Math.pow(100, rnd()))
      const off = Math.floor(rnd() * (CORPUS.length - 210000))
      let body = CORPUS.slice(off, off + size); body = body.slice(body.indexOf('\n') + 1)
      const extra: string[] = []
      if (count % 997 === 0) extra.push(`Invoice reference INVOICE-2026-${String(count).padStart(5, '0')} approved`)
      if (count % 50 === 0) extra.push('Project Falcon kickoff notes')
      if (top === 'groups/finance' || top === 'projects/atlas') extra.push('CANARY-FIN-7731 confidential salary table')
      if (top === 'users/bob') extra.push('CANARY-BOB-4402 private')
      if (extra.length) { const ls = body.split('\n'); for (const e of extra) ls.splice(Math.floor(rnd() * ls.length), 0, e); body = ls.join('\n') }
      fs.writeFileSync(p, body); bytes += body.length; count++
    }
  }
  fs.mkdirSync(path.join(team, 'shared/redos'), { recursive: true })
  fs.writeFileSync(path.join(team, 'shared/redos/aaaa.txt'), 'x\n' + 'a'.repeat(40) + 'b\n' + 'a'.repeat(5000) + '!\n')
  // office files (docx via one pandoc call per file is slow; generate a template docx once and vary only xlsx/pdf text)
  let k = 0
  for (const top of ['shared', 'groups/marketing', 'users/alice', 'groups/finance']) {
    for (let j = 0; j < nOffice / 4; j++) {
      const leaf = pick(leaves.get(top)!)
      const base = path.join(team, leaf, `office${String(k).padStart(4, '0')}`)
      const off = Math.floor(rnd() * (CORPUS.length - 3000))
      const txt = CORPUS.slice(off, off + 1500).split('\n').slice(1, -1)
      if (j % 10 === 0) txt.push('Project Falcon budget line')
      if (top === 'groups/finance') txt.push('CANARY-FIN-7731 in office file')
      const kind = j % 3
      if (kind === 0) {
        const p = Bun.spawnSync(['pandoc', '-f', 'markdown', '-o', base + '.docx'], { stdin: new TextEncoder().encode(txt.join('\n\n')) })
        if (p.exitCode !== 0) throw new Error('pandoc failed')
      } else if (kind === 1) {
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(txt.slice(0, 40).map((t) => [t])), 'S'); fs.writeFileSync(base + '.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
      } else fs.writeFileSync(base + '.pdf', makePdf(txt.slice(0, 40)))
      k++
    }
  }
  fs.symlinkSync(path.join(team, 'groups/finance'), path.join(team, 'shared/link-to-finance'))
  return { files: count + k + 1, office: k, textMB: Math.round(bytes / 1e6), seconds: (Date.now() - t0) / 1000 }
}
