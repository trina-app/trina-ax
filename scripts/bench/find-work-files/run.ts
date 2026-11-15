// "Find work files on this computer": a precision and recall bench on a made-up home folder (docs/DECISIONS.md "Find work
// files, part 6: fewer, better"). It builds a fake home in a temporary folder (no real file, no real name: every file is
// empty but for its size), runs the desktop app's look (desktop/src/common/work-files.ts lookRoots, a Mac's walk) and the
// page's list (web/src/lib/workFiles.ts workList), and counts how many shown files are labelled work (precision) and how
// many of the recent work files are shown (recall), for four AI cases:
//   none     no AI answered: the fixed rules alone
//   yes-all  an AI that picks everything it is shown (the worst AI: only the rules hold the list)
//   names    an AI that picks by the file's label ("a perfect judge of names"; an upper bound, never the real model)
// Spotlight is simulated from the fixture's own table (last opened, where from): `enrich` for the walk's newest files
// and `recentIn` (the per-folder "opened lately" list; an older look ignores it).
//   bun scripts/bench/find-work-files/run.ts [--json out.json] [--keep]
// The same file runs against an older checkout (copy it there): only APIs both have are used.
import { mkdtemp, mkdir, open, rm, utimes, lstat, opendir, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { lookRoots, type WorkFs, type WorkRoot, type WorkStat } from '../../../desktop/src/common/work-files'
import type { IndexedFile } from '../../../desktop/src/common/work-index'
import { docsFromScan, forAiRecent, workList } from '../../../web/src/lib/workFiles'

const D = 86_400_000
const NOW = Date.now()
type Label = 'work' | 'junk'
interface Fx { path: string; size: number; age: number; label: Label; used?: number; origins?: string[]; authors?: string[]; listed?: boolean }

// ---------------------------------------------------------------- the made-up home folder

const words = { names: ['Acme'], domains: ['acme.co.kr'], people: ['Minji Kim', 'Bo Lee'] }
const fx: Fx[] = []
const add = (path: string, label: Label, o: Partial<Fx> = {}) => fx.push({ path, size: 48_000, age: 20, label, ...o })
// a seeded random, so every run builds the same home
let seed = 7
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

// real work: business plans, proposals, quotes, contracts, decks, spreadsheets
const work: [string, Partial<Fx>][] = [
  ['Documents/Acme/2026 사업계획서.docx', { age: 4, used: 2 }],
  ['Documents/Acme/Q4 budget.xlsx', { age: 9, used: 3 }],
  ['Documents/Clients/Globex/Globex proposal v3.pptx', { age: 6, used: 6 }],
  ['Documents/Clients/Globex/Globex service contract.pdf', { age: 30 }],
  ['Documents/Clients/Initech/견적서_이니텍_2026-10.xlsx', { age: 12, used: 12 }],
  ['Documents/Contracts/NDA Initech signed.pdf', { age: 40, used: 38 }],
  ['Documents/Plans/Product roadmap 2027.key', { age: 14, used: 1 }],
  ['Documents/Plans/Hiring plan H1.numbers', { age: 50 }],
  ['Documents/Templates/Acme invoice template.xlsx', { age: 70, used: 20 }],
  ['Documents/Meetings/Weekly sync notes 2026-11.md', { age: 3, used: 1, size: 9000 }],
  ['Documents/Reports/Q3 sales report.pdf', { age: 33, authors: ['Bo Lee'] }],
  ['Documents/Reports/Market sizing study.docx', { age: 60 }],
  ['Documents/HWP/정부지원사업 신청서.hwp', { age: 18, used: 10 }],
  ['Desktop/Board deck Nov.pptx', { age: 2, used: 1 }],
  ['Desktop/Pricing sheet 2027.xlsx', { age: 5, used: 2 }],
  ['Desktop/Partner agreement draft.docx', { age: 8 }],
  ['Desktop/Working/Launch checklist.xlsx', { age: 10, used: 4 }],
  ['Desktop/Working/Customer interview summary.pdf', { age: 16, used: 15 }],
  ['Downloads/홍길동_1R 사업계획서.pdf', { age: 9, used: 9, origins: ['docs.google.com'] }],
  ['Downloads/Acme brand guide.pdf', { age: 25, origins: ['acme.slack.com'] }],
  ['Downloads/Globex RFP 2026.pdf', { age: 11, used: 10, origins: ['mail.google.com'] }],
  ['Downloads/Vendor quote - Hanil.pdf', { age: 21, origins: ['files.slack.com'], listed: true }],
  ['Downloads/Signed SOW Initech.pdf', { age: 7, used: 6, origins: ['acme-my.sharepoint.com'] }],
  ['Downloads/Team OKR 2026 H2.xlsx', { age: 19, origins: ['acme.notion.site'] }],
  ['Downloads/Competitor analysis.pptx', { age: 28, origins: ['drive.google.com'] }],
  ['Downloads/Investor update October.pdf', { age: 26, origins: ['www.notion.so'] }],
  ['Downloads/Client onboarding guide.pdf', { age: 44, origins: ['aif.notion.so'] }],
  ['Downloads/2026-11 client/Globex kickoff agenda.docx', { age: 1, used: 1 }],
  ['Downloads/2026-11 client/Globex SOW redlines.docx', { age: 1 }],
  // work names that look like a program's or a tool's at first sight (they must stay)
  ['Documents/Client_files/Acme client list 2026.xlsx', { age: 13, used: 5 }],
  ['Documents/License Agreement Acme.pdf', { age: 22 }],
  ['Documents/Go-2026 plan/Go-to-market plan.docx', { age: 17, used: 4 }],
  ['Desktop/AnnualReport2025Summary.pdf', { age: 12, used: 11 }],
  ['Documents/Reports/Q1 Report.docx', { age: 90, used: 85 }],
  ['Documents/Reports/Q2 Report.docx', { age: 45, used: 40 }],
]
for (const [p, o] of work) add(p, 'work', { ...o, used: o.used !== undefined ? NOW - o.used * D : undefined })

// junk: saved pages full of f(N).txt (from a Notion host), screenshots, installers, duplicates, a tool's tree, chat
// exports, tiny notes, programs' names
const pages = ['261009 톤브릿지 점검 _ 피드백', 'Weekly digest', 'Company wiki - Onboarding', 'Pricing page', 'Notion export']
for (const [i, page] of pages.entries()) {
  add(`Downloads/${page}.html`, 'junk', { age: 30 + i })
  for (let k = 1; k <= 40; k++) add(`Downloads/${page}_files/f(${k}).txt`, 'junk', { age: 30 + i, size: 3000 + k * 10, origins: ['aif.notion.so'] })
  for (let k = 1; k <= 6; k++) add(`Downloads/${page}_files/image00${k}.png`, 'junk', { age: 30 + i })
}
add('Downloads/Report-Dateien/f(1).txt', 'junk', { size: 4000 })
for (let k = 0; k < 25; k++) add(`Desktop/Screenshot 2026-10-${String(1 + (k % 28)).padStart(2, '0')} at 10.${k}.png`, 'junk', { age: k })
for (const n of ['Zoom.pkg', 'Slack-4.41.dmg', 'ChromeSetup.exe', 'node-v26.13.0.pkg']) add(`Downloads/${n}`, 'junk')
add('Desktop/Board deck Nov (1).pptx', 'junk', { age: 2 })
add('Desktop/Pricing sheet 2027 copy.xlsx', 'junk', { age: 5 })
add('Downloads/홍길동_1R 사업계획서 (1).pdf', 'junk', { age: 9, origins: ['docs.google.com'] })
add('Documents/Clients/Globex/Copy of Globex proposal v3.pptx', 'junk', { age: 7 })
const tool = 'Documents/nst-setup/nst-runtime/tools/node-v26.13.0-darwin-arm64'
for (const n of ['README.md', 'CHANGELOG.md', 'LICENSE', 'CONTRIBUTING.md']) add(`${tool}/${n}`, 'junk', { age: 15, size: 60_000 })
for (let k = 0; k < 60; k++) add(`${tool}/lib/node_modules/npm/docs/content/commands/npm-${k}.md`, 'junk', { age: 15, size: 6000 })
add('Documents/scripts/acme-sync/package.json', 'junk', { age: 12 })
add('Documents/scripts/acme-sync/README.md', 'junk', { age: 12, size: 5000 })
add('Documents/scripts/acme-sync/docs/Acme sync design.md', 'junk', { age: 12, size: 7000 })
for (const n of ['KakaoTalk_20261009_1530_12_345_group.txt', 'KakaoTalkChats.txt', 'WhatsApp Chat with Acme team.txt', 'Talk_2026.10.30 21_05-1.txt']) add(`Downloads/${n}`, 'junk', { size: 80_000, age: 10 })
for (const n of ['todo.txt', 'acme wifi.txt', 'call notes.txt', 'Acme ideas.md', 'memo.md']) add(`Desktop/${n}`, 'junk', { size: 400 + Math.round(rnd() * 1200), age: 3 })
for (const n of ['Untitled.docx', 'Untitled 2.docx', 'New Text Document.txt', '제목 없음.hwp', 'a8Fk2Lq9Zx01Pm3Rt7Vb.pdf', '3f2b9c1e-4a5b-4c6d-8e9f-0123456789ab.pdf']) add(`Downloads/${n}`, 'junk', { age: 6, used: NOW - 6 * D })
for (let k = 1; k <= 14; k++) add(`Downloads/statement_${k}.csv`, 'junk', { age: 20 + k, size: 9000, origins: ['docs.google.com'] })
for (let k = 1; k <= 9; k++) add(`Downloads/2026-10-${String(k).padStart(2, '0')}.pdf`, 'junk', { age: 30 + k, origins: ['drive.google.com'] })
add('Downloads/export.csv', 'junk', { age: 8, size: 30_000, origins: ['files.slack.com'] })
add('Downloads/data (2).csv', 'junk', { age: 8, size: 30_000 })
// ordinary downloads that are no work (no company sign, never opened): the rules must leave them out
for (const n of ['Menu autumn.pdf', 'Flight itinerary.pdf', 'Concert tickets.pdf', 'Apartment floor plan.pdf', 'Recipe collection.pdf', 'User manual - Dyson V15.pdf']) add(`Downloads/${n}`, 'junk', { age: 15 })
// old work (over 180 days): not counted anywhere
add('Documents/Archive/2024 사업계획서.docx', 'work', { age: 500 })
// a big Downloads: thousands of loose non-documents (videos, zips) the walk must get through
for (let k = 0; k < 6000; k++) add(`Downloads/stuff/clip-${k}.mp4`, 'junk', { age: 100, size: 2000 })
for (let k = 0; k < 40; k++) for (let j = 0; j < 60; j++) add(`Downloads/old-sites/site-${k}_files/f(${j}).txt`, 'junk', { age: 150, size: 2500 })

// ---------------------------------------------------------------- build it

const keep = process.argv.includes('--keep')
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null
const home = await realpath(await mkdtemp(join(tmpdir(), 'fwf-bench-')))
for (const f of fx) {
  const p = join(home, f.path)
  await mkdir(dirname(p), { recursive: true })
  const h = await open(p, 'w')
  await h.truncate(f.size)
  await h.close()
  const t = new Date(NOW - f.age * D)
  await utimes(p, t, t)
}
// folders get the date of their newest file (as a file added there sets it)
const dirs = new Map<string, number>()
for (const f of fx) { let d = dirname(join(home, f.path)); while (d.startsWith(home) && d !== home) { dirs.set(d, Math.max(dirs.get(d) ?? 0, NOW - f.age * D)); d = dirname(d) } }
for (const [d, t] of [...dirs].sort((a, b) => b[0].length - a[0].length)) await utimes(d, new Date(t), new Date(t))

const kindOf = (d: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): WorkStat['kind'] => (d.isSymbolicLink() ? 'link' : d.isFile() ? 'file' : d.isDirectory() ? 'dir' : 'other')
const nodeFs: WorkFs = {
  readdir: async (path, max) => {
    const out: { name: string; kind: WorkStat['kind'] }[] = []
    const d = await opendir(path)
    try { for (let e = await d.read(); e && out.length < max; e = await d.read()) out.push({ name: e.name, kind: kindOf(e) }) } finally { await d.close().catch(() => {}) }
    return out
  },
  lstat: async (path) => { const s = await lstat(path, { bigint: true }); return { kind: kindOf(s), size: Number(s.size), mtimeMs: Number(s.mtimeMs), dev: s.dev, ino: s.ino } },
  realpath: (p) => realpath(p),
  open: async (path) => { const h = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); return { stat: async () => { const s = await h.stat({ bigint: true }); return { kind: kindOf(s), size: Number(s.size), mtimeMs: Number(s.mtimeMs), dev: s.dev, ino: s.ino } }, read: async () => new Uint8Array(), close: () => h.close() } },
}
const byPath = new Map(fx.map((f) => [join(home, f.path), f]))
const known = (path: string): IndexedFile | null => {
  const f = byPath.get(path)
  if (!f) return null
  return { path, used: f.used ?? null, modified: NOW - f.age * D, useCount: f.used ? 2 : null, size: f.size, origins: f.origins ?? [], authors: f.authors ?? [], org: null, ...(f.listed ? { listed: true } : {}) }
}
const roots: WorkRoot[] = (['documents', 'desktop', 'downloads'] as const).map((id) => ({ id, path: join(home, id[0]!.toUpperCase() + id.slice(1)), oneDrive: false }))

let n = 0
const t0 = performance.now()
const scan = await lookRoots(roots, nodeFs, {
  platform: 'darwin', newId: () => `id${n++}`, index: async () => null,
  // a big Downloads at a fifth of the scale: the walk's 20,000 entries as 4,000, so it is cut as on a real Mac
  limits: { walkFiles: 4000 },
  // Spotlight: what it knows of the walk's newest files, and the files it says were opened lately in a folder
  enrich: async (paths: string[]) => paths.map(known).filter((x): x is IndexedFile => !!x),
  recentIn: async (real: string) => fx.filter((f) => (f.used || f.listed) && join(home, f.path).startsWith(real + '/')).map((f) => known(join(home, f.path))!),
} as Parameters<typeof lookRoots>[2])
const scanMs = performance.now() - t0
const docs = docsFromScan(scan.files, async () => ({ ok: false, reason: 'unknown' }))
const labelOf = (key: string) => {
  const d = docs.find((x) => x.key === key)!
  return byPath.get(join(home, d.pick, d.rel))?.label ?? 'junk'
}
const recentWork = fx.filter((f) => f.label === 'work' && f.age <= 180).length

function measure(name: string, picks: Map<string, string> | null, sent?: Set<string>) {
  const t = performance.now()
  const shown = workList(docs, words, picks, NOW, new Set(), sent).shown
  const ms = performance.now() - t
  const good = shown.filter((d) => labelOf(d.key) === 'work').length
  return { case: name, shown: shown.length, work: good, precision: shown.length ? +(good / shown.length).toFixed(3) : 1, recall: +(good / recentWork).toFixed(3), listMs: +ms.toFixed(1), junkShown: shown.filter((d) => labelOf(d.key) !== 'work').map((d) => `${d.pick}/${d.rel}`) }
}
const sent = forAiRecent(docs, words, NOW)
const sentKeys = new Set(sent.map((d) => d.key))
const results = [
  measure('none', null),
  measure('yes-all', new Map(sent.map((d) => [d.key, 'report'])), sentKeys),
  measure('names', new Map(sent.filter((d) => labelOf(d.key) === 'work').map((d) => [d.key, 'report'])), sentKeys),
]
const summary = {
  files: fx.length, recentWork, listed: scan.files.length, sentToAi: sent.length, scanMs: Math.round(scanMs),
  roots: scan.roots.map((r) => ({ id: r.id, how: r.how, cut: r.cut, checked: r.checked })),
  results,
}
console.log(JSON.stringify(summary, null, 2))
if (jsonOut) await Bun.write(jsonOut, JSON.stringify(summary, null, 2))
if (!keep) await rm(home, { recursive: true, force: true })
else console.error(`home kept at ${home}`)
