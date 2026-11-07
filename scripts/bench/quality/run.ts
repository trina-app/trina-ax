// The search quality test (README.md; plan docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md, step 15):
// keyword-only search against combined search (keyword plus meaning, fused by rank) on the same questions.
//
// - Builds a temporary DocumentIndex (the server's own class, its own extraction) from the made-up Acme documents and
//   the downloaded Wikipedia distractors, in a fixed shuffled order, then copies it for the smaller sizes and takes the
//   files that are not in them out again (so the pieces keep their order and their vectors).
// - Asks every question through DocumentIndex.search the way the AI's lookup does (service.ts docPassages: the
//   question's distinctive words, questionTerms, joined; limit 45; passages of 1,500 characters), in each mode:
//   keyword-only, and combined (`meaning: true`; meaning.ts), which is skipped with the reason when the meaning code,
//   the vectors or the model are missing.
// - Metrics per type and overall: Recall@8 by file (an expected file among the files of the first 8 hits), first place
//   (the first hit's file is expected), MRR (1 / the rank of the first expected file among the distinct files, in hit
//   order); the two modes compared question by question (exact McNemar test, paired bootstrap 95% intervals); a curve
//   over about 50, 500 and all files.
// - Cost: pieces indexed per second, peak memory, query time p50 / p95; embedding speed in meaning mode.
// - Writes results/<out>.json and .md: ids, file paths and numbers only, never a document's text.
//
//   bun scripts/bench/quality/run.ts [--modes keyword,combined] [--sizes 50,500,full] [--words message|search]
//     [--out <name>] [--label <text>] [--max-distractors <n>] [--model-dir <dir>] [--embed-threads <n>]
//     [--embed-batch <n>] [--keep <dir>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DocumentIndex, questionTerms, type DocHit } from '../../../server/src/knowledge-graph/documents/index'
import { CACHE, hashKey, loadQuestions, REPO, RESULTS, ROOT_ID, TARGET_PREFIX, targetFiles, TYPES, WIKI_DIR, WIKI_PREFIX, wikiArticles, type QType, type Question } from './lib'
import { fillVectors, hasVecColumn, openMeaning, vectorCount, type MeaningIndexOptions, type MeaningSearchOptions } from './meaning'
import type { Embedder } from '../../../server/src/knowledge-graph/meaning/vectors'

// ---------------------------------------------------------------- options
const args = process.argv.slice(2)
const opt = (name: string, d: string) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1]! : d }
type Mode = 'keyword' | 'combined'
const MODES = opt('modes', 'keyword,combined').split(',').map((s) => s.trim()).filter(Boolean) as Mode[]
for (const m of MODES) if (m !== 'keyword' && m !== 'combined') throw new Error(`unknown mode ${m}`)
const SIZES_ASKED = opt('sizes', '50,500,full').split(',').map((s) => s.trim())
const WORDS = opt('words', 'message') as 'message' | 'search'
if (WORDS !== 'message' && WORDS !== 'search') throw new Error('--words is message or search')
const MAX_DISTRACTORS = Number(opt('max-distractors', 'Infinity'))
const MODEL_DIR = path.resolve(opt('model-dir', path.join(CACHE, 'models')))
const EMBED_THREADS = Number(opt('embed-threads', String(Math.min(4, os.availableParallelism()))))
const EMBED_BATCH = Number(opt('embed-batch', '16'))
const KEEP = opt('keep', '')
const LABEL = opt('label', '')
const today = new Date().toISOString().slice(0, 10)
const OUT = opt('out', `${today}-${MODES.join('-')}-${os.platform()}`)
/** what the AI's lookup asks the index for: service.ts docPassages, limit min(100, max(40, (LOOKUP_LONG 3 + LOOKUP_SHORT 12)
 * * 3)) and passages of LOOKUP_LONG_CHARS (not imported: service.ts brings the whole server with it) */
const LIMIT = 45
const LOOKUP_LONG_CHARS = 1500
const TOP = 8
const BOOTSTRAP = Number(opt('bootstrap', '10000'))

const log = (s: string) => console.error(`[${((performance.now() - T0) / 1000).toFixed(1)}s] ${s}`)
const T0 = performance.now()

// ---------------------------------------------------------------- memory: peak RSS per phase
const peaks: Record<string, number> = {}
let phase = 'setup'
const sample = () => { const r = process.memoryUsage().rss; if (r > (peaks[phase] ?? 0)) peaks[phase] = r }
const sampler = setInterval(sample, 100)
const enter = (p: string) => { sample(); phase = p; sample() }
const mb = (b: number) => Math.round(b / 1024 / 1024)

// ---------------------------------------------------------------- the files
const questions = loadQuestions()
const targets = targetFiles()
const targetNames = new Set(targets.map((t) => t.name))
for (const q of questions) for (const f of q.expectFiles) if (!targetNames.has(f)) throw new Error(`${q.id}: expected file ${f} is not a target document`)
const wiki = wikiArticles()
if (!wiki?.length) throw new Error(`no distractors in ${path.relative(process.cwd(), WIKI_DIR)}: run bun scripts/bench/quality/fetch.ts first`)
interface CorpusFile { rel: string; abs: string; kind: 'target' | 'wiki'; lang?: 'ko' | 'en' }
const wikiFiles: CorpusFile[] = wiki.map((a) => ({ rel: WIKI_PREFIX + a.file, abs: path.join(WIKI_DIR, a.file), kind: 'wiki' as const, lang: a.lang }))
  .sort((a, b) => hashKey(a.rel).localeCompare(hashKey(b.rel))).slice(0, MAX_DISTRACTORS)
const targetCorpus: CorpusFile[] = targets.map((t) => ({ rel: t.rel, abs: t.abs, kind: 'target' as const }))
/** every file in one shuffled but fixed order (sha256 of the path): the full-text index lists matches by row order */
const allFiles = [...targetCorpus, ...wikiFiles].sort((a, b) => hashKey(a.rel).localeCompare(hashKey(b.rel)))

/** the sizes: targets plus the first distractors in their fixed order; "full" is all of them */
const sizes = [...new Set(SIZES_ASKED.map((s) => s === 'full' ? allFiles.length : Math.max(targets.length, Math.min(allFiles.length, Number(s)))))].sort((a, b) => a - b)
const subsetOf = (n: number) => new Set([...targetCorpus.map((f) => f.rel), ...wikiFiles.slice(0, n - targets.length).map((f) => f.rel)])
const sizeName = (n: number) => n === allFiles.length ? `full (${n})` : String(n)

// ---------------------------------------------------------------- machine
function cgroup(): { cpuMax?: string; memoryMax?: string } {
  const read = (f: string) => { try { return fs.readFileSync(f, 'utf8').trim() } catch { return undefined } }
  return { cpuMax: read('/sys/fs/cgroup/cpu.max'), memoryMax: read('/sys/fs/cgroup/memory.max') }
}
function gitCommit(): string | null {
  if (process.env.QUALITY_COMMIT) return process.env.QUALITY_COMMIT
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: REPO, stdout: 'pipe', stderr: 'ignore' })
    return r.exitCode === 0 ? r.stdout.toString().trim() : null
  } catch { return null }
}
const machine = {
  platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model ?? '?', cores: os.availableParallelism(),
  memoryGb: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10, bun: Bun.version, ...cgroup(),
}

// ---------------------------------------------------------------- build the full index
const tmp = KEEP ? path.resolve(KEEP) : fs.mkdtempSync(path.join(os.tmpdir(), 'kg-quality-'))
fs.mkdirSync(tmp, { recursive: true })
const fullDir = path.join(tmp, 'full')
fs.rmSync(fullDir, { recursive: true, force: true })
log(`${questions.length} questions; ${targets.length} target documents + ${wikiFiles.length} distractors (ko ${wikiFiles.filter((f) => f.lang === 'ko').length}, en ${wikiFiles.filter((f) => f.lang === 'en').length}); index in ${tmp}`)

enter('index')
const build = { files: 0, ok: 0, failed: [] as { rel: string; reason: string }[], chunks: 0, bytes: 0, ms: 0, diskBytes: 0 }
{
  const idx = DocumentIndex.open(fullDir)
  const t = performance.now()
  for (const f of allFiles) {
    const bytes = new Uint8Array(fs.readFileSync(f.abs))
    const st = fs.statSync(f.abs)
    const r = await idx.update(ROOT_ID, f.rel, { bytes, size: st.size, mtimeMs: st.mtimeMs })
    build.files++
    build.bytes += bytes.byteLength
    if (r.ok) { build.ok++; build.chunks += r.chunks } else build.failed.push({ rel: f.rel, reason: r.reason })
    if (build.files % 500 === 0) log(`indexed ${build.files}/${allFiles.length} files, ${build.chunks} pieces`)
  }
  build.ms = performance.now() - t
  build.diskBytes = idx.diskBytes()
  idx.close()
}
const targetFailed = build.failed.filter((f) => f.rel.startsWith(TARGET_PREFIX))
if (targetFailed.length) throw new Error(`target documents failed to index: ${JSON.stringify(targetFailed)}`)
log(`index built: ${build.ok} files, ${build.chunks} pieces in ${(build.ms / 1000).toFixed(1)} s (${Math.round(build.chunks / (build.ms / 1000))} pieces/s); ${build.failed.length} distractors failed`)

// ---------------------------------------------------------------- meaning: the embedder and the vectors
let embedder: Embedder | null = null
const meaning: { asked: boolean; ready: boolean; skipped?: string; openMs?: number; embed?: { pieces: number; already: number; ms: number; perSecond: number; threads: number; batch: number }; ignored?: boolean } = { asked: MODES.includes('combined'), ready: false }
if (meaning.asked) {
  enter('meaning-open')
  const dbFile = path.join(fullDir, 'documents.db')
  if (!hasVecColumn(dbFile)) meaning.skipped = 'documents.db has no chunks.vec column: the meaning index (wave 2) is not merged into this checkout yet'
  else {
    const m = await openMeaning({ modelDir: MODEL_DIR, sharedDir: process.env.MYCEL_MODELS_DIR ? path.join(process.env.MYCEL_MODELS_DIR, 'semantic') : null, threads: EMBED_THREADS })
    if (!m.ok) meaning.skipped = `the embedder did not open: ${m.reason}`
    else {
      embedder = m.embedder
      meaning.openMs = Math.round(m.ms)
      log(`embedder open in ${(m.ms / 1000).toFixed(1)} s; embedding pieces (${EMBED_THREADS} threads, batches of ${EMBED_BATCH})`)
      enter('embed')
      let last = 0
      const e = await fillVectors(dbFile, m.embedder, { batch: EMBED_BATCH, onProgress: (done, total) => { if (done - last >= 1000 || done === total) { last = done; log(`embedded ${done}/${total} pieces`) } } })
      const vc = vectorCount(dbFile)
      if (vc.withVec < vc.chunks) meaning.skipped = `only ${vc.withVec} of ${vc.chunks} pieces have a vector`
      else {
        meaning.ready = true
        meaning.embed = { ...e, ms: Math.round(e.ms), perSecond: e.pieces ? Math.round(e.pieces / (e.ms / 1000) * 10) / 10 : 0, threads: EMBED_THREADS, batch: EMBED_BATCH }
      }
    }
  }
  if (meaning.skipped) log(`meaning mode SKIPPED: ${meaning.skipped}`)
}
const modes: Mode[] = MODES.filter((m) => m === 'keyword' || meaning.ready)

// ---------------------------------------------------------------- ask
interface Answer { rank: number | null; r8: boolean; top1: boolean; ms: number; hits: number; top: string[] }
const words = (q: string) => WORDS === 'message' ? questionTerms(q).join(' ') : q
const expected = (q: Question) => new Set(q.expectFiles.map((f) => TARGET_PREFIX + f))

function score(q: Question, hits: DocHit[], ms: number): Answer {
  const want = expected(q)
  const files: string[] = []
  for (const h of hits) if (!files.includes(h.relPath)) files.push(h.relPath)
  const first8 = new Set(hits.slice(0, TOP).map((h) => h.relPath))
  const i = files.findIndex((f) => want.has(f))
  return { rank: i >= 0 ? i + 1 : null, r8: [...first8].some((f) => want.has(f)), top1: !!files[0] && want.has(files[0]), ms, hits: hits.length, top: files.slice(0, TOP) }
}

const results = new Map<number, Record<Mode, Map<string, Answer>>>()
const sizeInfo: { files: number; chunks: number; prepMs: number }[] = []
for (const n of sizes) {
  enter('prepare')
  const dir = n === allFiles.length ? fullDir : path.join(tmp, `n${n}`)
  const t = performance.now()
  if (dir !== fullDir) { fs.rmSync(dir, { recursive: true, force: true }); fs.cpSync(fullDir, dir, { recursive: true }) }
  const o: MeaningIndexOptions = embedder ? { embedder } : {}
  const idx = DocumentIndex.open(dir, o)
  if (dir !== fullDir) { const keep = subsetOf(n); for (const f of allFiles) if (!keep.has(f.rel)) idx.remove(ROOT_ID, f.rel) }
  const st = idx.stats(ROOT_ID)
  sizeInfo.push({ files: st.documents, chunks: st.chunks, prepMs: Math.round(performance.now() - t) })
  log(`size ${sizeName(n)}: ${st.documents} files, ${st.chunks} pieces`)
  const per = {} as Record<Mode, Map<string, Answer>>
  for (const mode of modes) {
    enter(`query-${mode}`)
    const m = new Map<string, Answer>()
    const so: MeaningSearchOptions = { rootIds: [ROOT_ID], limit: LIMIT, passage: LOOKUP_LONG_CHARS, ...(mode === 'combined' ? { meaning: true } : {}) }
    // one search first, not counted: the first query opens statements and warms caches
    await idx.search('warm up', so)
    for (const q of questions) {
      const w = words(q.q)
      const t1 = performance.now()
      // await: the combined search may answer with a promise (the question is embedded first)
      const hits: DocHit[] = w ? await idx.search(w, so) : []
      m.set(q.id, score(q, hits, performance.now() - t1))
    }
    per[mode] = m
  }
  results.set(n, per)
  idx.close()
  if (dir !== fullDir && !KEEP) fs.rmSync(dir, { recursive: true, force: true })
}
enter('report')
await embedder?.dispose()
clearInterval(sampler)
if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true })

// combined results that never differ from keyword-only ones: the option was most likely ignored
if (modes.includes('combined')) {
  const full = results.get(allFiles.length)!
  meaning.ignored = questions.every((q) => JSON.stringify(full.combined.get(q.id)!.top) === JSON.stringify(full.keyword?.get(q.id)?.top))
  if (meaning.ignored) log('WARNING: combined results equal keyword-only results for every question: the meaning option was most likely ignored (see meaning.ts)')
}

// ---------------------------------------------------------------- statistics
function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
/** exact two-sided McNemar test: b questions only mode A answered, c only mode B */
function mcnemar(b: number, c: number): number {
  const n = b + c
  if (!n) return 1
  let p = 0, term = Math.pow(0.5, n)
  for (let i = 0; i <= Math.min(b, c); i++) { p += term; term = term * (n - i) / (i + 1) }
  return Math.min(1, 2 * p)
}
/** paired bootstrap: 95% interval of the mean difference (questions resampled with replacement) */
function bootstrap(diffs: number[], seed: number): [number, number] {
  if (!diffs.length) return [0, 0]
  const rnd = mulberry32(seed)
  const means: number[] = []
  for (let b = 0; b < BOOTSTRAP; b++) { let s = 0; for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rnd() * diffs.length)]!; means.push(s / diffs.length) }
  means.sort((x, y) => x - y)
  return [means[Math.floor(0.025 * (BOOTSTRAP - 1))]!, means[Math.ceil(0.975 * (BOOTSTRAP - 1))]!]
}
const rr = (a: Answer) => a.rank ? 1 / a.rank : 0
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d
interface Summary { n: number; r8: number; top1: number; mrr: number; r8Count: number; top1Count: number }
function summarize(ans: Answer[]): Summary {
  const n = ans.length
  return { n, r8Count: ans.filter((a) => a.r8).length, top1Count: ans.filter((a) => a.top1).length,
    r8: round(ans.filter((a) => a.r8).length / n), top1: round(ans.filter((a) => a.top1).length / n), mrr: round(ans.reduce((s, a) => s + rr(a), 0) / n) }
}
const groups: { name: string; qs: Question[] }[] = [
  { name: 'overall', qs: questions },
  ...TYPES.map((t) => ({ name: t, qs: questions.filter((q) => q.type === t) })),
  { name: 'ko', qs: questions.filter((q) => q.lang === 'ko') },
  { name: 'en', qs: questions.filter((q) => q.lang === 'en') },
]
const metricsAt = (n: number) => Object.fromEntries(modes.map((m) => [m, Object.fromEntries(groups.map((g) => [g.name, summarize(g.qs.map((q) => results.get(n)![m].get(q.id)!))]))])) as Record<Mode, Record<string, Summary>>

function compareAt(n: number) {
  if (!modes.includes('combined') || !modes.includes('keyword')) return null
  const r = results.get(n)!
  return Object.fromEntries(groups.map((g, gi) => {
    const k = g.qs.map((q) => r.keyword.get(q.id)!), c = g.qs.map((q) => r.combined.get(q.id)!)
    const pair = (f: (a: Answer) => boolean) => ({ onlyKeyword: k.filter((a, i) => f(a) && !f(c[i]!)).length, onlyCombined: k.filter((a, i) => !f(a) && f(c[i]!)).length })
    const r8 = pair((a) => a.r8), t1 = pair((a) => a.top1)
    const d = (f: (a: Answer) => number) => k.map((a, i) => f(c[i]!) - f(a))
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1)
    const dr8 = d((a) => +a.r8), dt1 = d((a) => +a.top1), dmrr = d(rr)
    return [g.name, {
      r8: { delta: round(mean(dr8)), ci95: bootstrap(dr8, 1000 + gi).map((x) => round(x)), ...r8, mcnemarP: round(mcnemar(r8.onlyKeyword, r8.onlyCombined), 4) },
      top1: { delta: round(mean(dt1)), ci95: bootstrap(dt1, 2000 + gi).map((x) => round(x)), ...t1, mcnemarP: round(mcnemar(t1.onlyKeyword, t1.onlyCombined), 4) },
      mrr: { delta: round(mean(dmrr)), ci95: bootstrap(dmrr, 3000 + gi).map((x) => round(x)) },
    }]
  }))
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! : 0 }
const queryCost = (n: number) => Object.fromEntries(modes.map((m) => { const ms = questions.map((q) => results.get(n)![m].get(q.id)!.ms); return [m, { p50: round(pct(ms, 0.5), 2), p95: round(pct(ms, 0.95), 2), max: round(Math.max(...ms), 2) }] }))

const full = allFiles.length
const out = {
  label: LABEL || null, date: new Date().toISOString(), commit: gitCommit(), machine,
  settings: { words: WORDS, limit: LIMIT, top: TOP, passage: LOOKUP_LONG_CHARS, sizes, modesAsked: MODES, modesRun: modes, bootstrap: BOOTSTRAP },
  corpus: { questions: questions.length, targets: targets.length, distractors: wikiFiles.length, distractorsKo: wikiFiles.filter((f) => f.lang === 'ko').length, distractorsEn: wikiFiles.filter((f) => f.lang === 'en').length, failedDistractors: build.failed.length, chunks: build.chunks, bytes: build.bytes },
  cost: {
    index: { files: build.files, pieces: build.chunks, seconds: round(build.ms / 1000, 1), piecesPerSecond: Math.round(build.chunks / (build.ms / 1000)), filesPerSecond: Math.round(build.files / (build.ms / 1000)), diskMb: mb(build.diskBytes) },
    peakRssMb: Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, mb(v)])),
    maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    query: Object.fromEntries(sizes.map((n) => [sizeName(n), queryCost(n)])),
  },
  meaning,
  sizes: sizes.map((n, i) => ({ name: sizeName(n), ...sizeInfo[i]! })),
  metrics: Object.fromEntries(sizes.map((n) => [sizeName(n), metricsAt(n)])),
  comparison: Object.fromEntries(sizes.map((n) => [sizeName(n), compareAt(n)])),
  questions: questions.map((q) => ({
    id: q.id, lang: q.lang, type: q.type, expectFiles: q.expectFiles, words: words(q.q),
    results: Object.fromEntries(sizes.map((n) => [sizeName(n), Object.fromEntries(modes.map((m) => {
      const a = results.get(n)![m].get(q.id)!
      return [m, n === full ? { rank: a.rank, r8: a.r8, top1: a.top1, ms: round(a.ms, 2), hits: a.hits, top: a.top } : { rank: a.rank, r8: a.r8, top1: a.top1 }]
    }))])),
  })),
}

// ---------------------------------------------------------------- write
fs.mkdirSync(RESULTS, { recursive: true })
fs.writeFileSync(path.join(RESULTS, `${OUT}.json`), JSON.stringify(out, null, 1) + '\n')
fs.writeFileSync(path.join(RESULTS, `${OUT}.md`), markdown())
log(`wrote ${path.relative(process.cwd(), path.join(RESULTS, OUT))}.json and .md`)

function markdown(): string {
  const L: string[] = []
  const p = (x: number) => `${Math.round(x * 1000) / 10}%`
  const fmt = (s: Summary) => `${p(s.r8)} (${s.r8Count}/${s.n}) | ${p(s.top1)} (${s.top1Count}/${s.n}) | ${s.mrr.toFixed(3)}`
  L.push(`# Search quality test: ${OUT}`, '')
  L.push(`- Date: ${out.date}${LABEL ? `; label: ${LABEL}` : ''}; commit ${out.commit ?? 'unknown'}`)
  L.push(`- Machine: ${machine.cpu}, ${machine.cores} cores, ${machine.memoryGb} GB, ${machine.platform}/${machine.arch}, bun ${machine.bun}` +
    (machine.cpuMax ? `; cgroup cpu.max ${machine.cpuMax}, memory.max ${machine.memoryMax}` : ''))
  L.push(`- Corpus: ${targets.length} made-up Acme documents + ${wikiFiles.length} Wikipedia articles (ko ${out.corpus.distractorsKo}, en ${out.corpus.distractorsEn}); ${build.chunks} pieces; ${build.failed.length} distractors not indexed`)
  L.push(`- Questions: ${questions.length} (${TYPES.map((t) => `${t} ${questions.filter((q) => q.type === t).length}`).join(', ')}); words: ${WORDS === 'message' ? "the AI's lookup (questionTerms)" : 'every word typed (queryTerms)'}; ${LIMIT} hits asked, Recall and first place over the first ${TOP} hits`)
  L.push(`- Modes run: ${modes.join(', ')}` + (meaning.asked && !meaning.ready ? `. **Combined skipped:** ${meaning.skipped}` : '') + (meaning.ignored ? '. **Warning: combined results equal keyword-only for every question; the meaning option was most likely ignored.**' : ''))
  L.push('')
  L.push('## Results on the full set', '')
  L.push(`| Group | ${modes.map((m) => `${m}: Recall@8 | first | MRR`).join(' | ')} |`)
  L.push(`|---|${modes.map(() => '---|---|---').join('|')}|`)
  const mf = out.metrics[sizeName(full)]!
  for (const g of groups) L.push(`| ${g.name} | ${modes.map((m) => fmt(mf[m]![g.name]!)).join(' | ')} |`)
  L.push('')
  const cmp = out.comparison[sizeName(full)]
  if (cmp) {
    L.push('## Combined minus keyword-only, same questions (full set)', '')
    L.push('Δ is the change in share of questions; [95% paired bootstrap interval]; McNemar: questions only keyword / only combined got right, exact two-sided p.', '')
    L.push('| Group | Δ Recall@8 | McNemar R@8 | Δ first | McNemar first | Δ MRR |')
    L.push('|---|---|---|---|---|---|')
    for (const g of groups) {
      const c = cmp[g.name]!
      L.push(`| ${g.name} | ${c.r8.delta >= 0 ? '+' : ''}${p(c.r8.delta)} [${p(c.r8.ci95[0]!)}, ${p(c.r8.ci95[1]!)}] | ${c.r8.onlyKeyword}/${c.r8.onlyCombined}, p=${c.r8.mcnemarP} | ` +
        `${c.top1.delta >= 0 ? '+' : ''}${p(c.top1.delta)} [${p(c.top1.ci95[0]!)}, ${p(c.top1.ci95[1]!)}] | ${c.top1.onlyKeyword}/${c.top1.onlyCombined}, p=${c.top1.mcnemarP} | ` +
        `${c.mrr.delta >= 0 ? '+' : ''}${c.mrr.delta.toFixed(3)} [${c.mrr.ci95[0]!.toFixed(3)}, ${c.mrr.ci95[1]!.toFixed(3)}] |`)
    }
    L.push('')
  }
  L.push('## Curve: Recall@8 / first / MRR by number of files', '')
  L.push(`| Files | Pieces | ${modes.map((m) => `${m}`).join(' | ')} | ${modes.map((m) => `${m} R@8 by type (${TYPES.map((t) => t.slice(0, 4)).join(' / ')})`).join(' | ')} |`)
  L.push(`|---|---|${modes.map(() => '---').join('|')}|${modes.map(() => '---').join('|')}|`)
  sizes.forEach((n, i) => {
    const m = out.metrics[sizeName(n)]!
    L.push(`| ${sizeName(n)} | ${sizeInfo[i]!.chunks} | ${modes.map((x) => `${p(m[x]!.overall!.r8)} / ${p(m[x]!.overall!.top1)} / ${m[x]!.overall!.mrr.toFixed(3)}`).join(' | ')} | ` +
      `${modes.map((x) => TYPES.map((t) => p(m[x]![t]!.r8)).join(' / ')).join(' | ')} |`)
  })
  L.push('')
  L.push('## Cost', '')
  L.push(`- Indexing (keyword, one thread, text extraction included): ${build.files} files, ${build.chunks} pieces in ${out.cost.index.seconds} s = ${out.cost.index.piecesPerSecond} pieces/s; documents.db ${out.cost.index.diskMb} MB`)
  if (meaning.embed) L.push(`- Embedding: ${meaning.embed.pieces} pieces in ${round(meaning.embed.ms / 1000, 1)} s = ${meaning.embed.perSecond} pieces/s (${meaning.embed.threads} threads, batches of ${meaning.embed.batch}); embedder opened in ${round((meaning.openMs ?? 0) / 1000, 1)} s`)
  L.push(`- Peak RSS by phase (MB, sampled every 100 ms): ${Object.entries(out.cost.peakRssMb).map(([k, v]) => `${k} ${v}`).join(', ')}; process max ${out.cost.maxRssMb} MB`)
  L.push(`- Query time (ms, one search, the server's own thread): ${sizes.map((n) => `${sizeName(n)}: ${modes.map((m) => `${m} p50 ${out.cost.query[sizeName(n)]![m]!.p50} / p95 ${out.cost.query[sizeName(n)]![m]!.p95}`).join(', ')}`).join('; ')}`)
  L.push('')
  L.push('## Misses on the full set (ids)', '')
  for (const m of modes) {
    const miss = questions.filter((q) => !results.get(full)![m].get(q.id)!.r8)
    L.push(`- ${m}, not in the first ${TOP} (${miss.length}): ${TYPES.map((t) => { const ids = miss.filter((q) => q.type === t).map((q) => q.id); return ids.length ? `${t}: ${ids.join(', ')}` : '' }).filter(Boolean).join('; ') || 'none'}`)
  }
  L.push('')
  return L.join('\n')
}
