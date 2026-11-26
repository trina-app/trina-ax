// Figure fidelity eval (QA A-11-M; plan docs/AGENTS/plan/20261125-0851-research-figure-fidelity.md): research requests
// that ask for a cited brief, through the real team AI on this tool's own server (`bun run ai:scenarios up`), then
// every figure in the answer is checked against the text of the page it cites.
//
//   AISCEN_HOME=… AISCEN_PORT=… bun tests/ai-scenarios/figure-eval.ts run [--only F1,F2] [--repeat 1] [--jobs 3] [--tag before]
//   AISCEN_HOME=… bun tests/ai-scenarios/figure-eval.ts judge <run.json>   (also done at the end of run)
//
// The checker is general, never keyed to a case: the cited pages are fetched again (web_fetch's own reader), and
// `claude -p --model sonnet` (no tools) lists each figure with a citation and says whether the cited page states it
// with the same value, unit and population. Links: each URL in the answer is looked for in the turn's own tool calls
// and results (from a search or a fetched page, not made up) and opened (dead or not).
// Results: tests/.work/ai-scenarios/figure-eval-<tag>-<time>.json and .md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { webFetch } from '../../server/src/tools/web-fetch'
import { login, oneTurn, type Env } from './lib/run-case'
import type { FixtureState } from './fixture/seed'
import type { Case, TurnRecord } from './lib/types'

const HOME = path.resolve(process.env.AISCEN_HOME ?? path.join(os.homedir(), '.trina-aiscen'))
const PORT = Number(process.env.AISCEN_PORT ?? 19871)
const BASE = `http://127.0.0.1:${PORT}`
const DATA = path.join(HOME, 'data')
const OUT = path.resolve(import.meta.dir, '../.work/ai-scenarios')
const args = process.argv.slice(2)
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }

interface EvalCase { id: string; lang: 'en' | 'ko'; prompt: string; heldOut: boolean }
/** Held-out: none is the QA case's topic. Each asks for figures of a different kind (a share of a population, a rate,
 * a ratio, money, a date) from different publishers, in English and Korean. A0 is the QA case itself (reported apart). */
export const CASES: EvalCase[] = [
  { id: 'A0', lang: 'en', heldOut: false, prompt: "Research the topic 'four-day work week trials and their results' and write a 400-word brief with inline citations to real sources (with links). Note the limits of the evidence." },
  { id: 'F1', lang: 'en', heldOut: true, prompt: 'Research the latest Gallup State of the Global Workplace findings on employee engagement and write a 250-word brief with inline citations to real sources (with links).' },
  { id: 'F2', lang: 'en', heldOut: true, prompt: "Research the UK gender pay gap in 2024 and write a 250-word brief with inline citations to real sources (with links). Say how it's measured." },
  { id: 'F3', lang: 'ko', heldOut: true, prompt: '한국 합계출산율의 최근 추이를 조사해서, 출처 링크를 문장마다 단 300단어 내외 브리핑을 써줘.' },
  { id: 'F4', lang: 'ko', heldOut: true, prompt: '2025년 최저임금이 어떻게 결정됐는지 조사해서 출처 링크를 붙인 짧은 브리핑을 써줘. 인상률과 월 환산액도 넣어줘.' },
  { id: 'F5', lang: 'en', heldOut: true, prompt: 'Research how many workers use generative AI at work, using surveys from 2024-2025, and write a 300-word brief with inline citations to real sources (with links). Note the limits of the evidence.' },
  { id: 'F6', lang: 'en', heldOut: true, prompt: 'Research the global e-waste figures in the latest Global E-waste Monitor and write a 250-word brief with inline citations to real sources (with links).' },
  { id: 'F7', lang: 'ko', heldOut: true, prompt: '한국의 고령화 현황(65세 이상 인구 비중, 초고령사회 진입 시점)을 조사해서 출처 링크가 달린 브리핑으로 정리해줘.' },
  { id: 'F8', lang: 'en', heldOut: true, prompt: 'Research how much it costs to train frontier AI models (for example the Stanford AI Index estimates) and write a 250-word brief with inline citations to real sources (with links).' },
  { id: 'F9', lang: 'ko', heldOut: true, prompt: '국내 전기차 보급 현황(누적 등록 대수, 전체 자동차 중 비중)을 조사해서 출처 링크를 단 브리핑으로 써줘.' },
  { id: 'F10', lang: 'en', heldOut: true, prompt: 'Research how common working from home is in the United States now (share of paid workdays from home, share of workers who are hybrid or fully remote) and write a 250-word brief with inline citations to real sources (with links).' },
]

interface Result { id: string; rep: number; chatId: string | null; turn: TurnRecord | null; error: string | null; urlsSeen?: string[]; judge?: Judged }
interface Figure { figure: string; claim: string; url: string; verdict: 'supported' | 'misstated' | 'not_in_cited' | 'unverifiable'; note?: string }
interface Judged { figures: Figure[]; links: { url: string; fromTools: boolean; opens: boolean; why?: string }[] }

/** Every URL a turn's tool calls and results named (the session transcript, untruncated) */
function urlsInTranscript(chatId: string): string[] {
  const dir = path.join(DATA, 'sessions', chatId)
  let text = ''
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) text += fs.readFileSync(path.join(dir, f), 'utf8') } catch {}
  // only what tools gave or took: tool_use inputs and tool_result contents, not the assistant's own text
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    const c = o.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b.type !== 'tool_use' && b.type !== 'tool_result') continue
      for (const u of urlsIn(JSON.stringify(b.type === 'tool_use' ? b.input : b.content).replace(/\\"/g, '"').replace(/\\n/g, ' '))) out.add(u)
    }
  }
  return [...out]
}
export function urlsIn(s: string): string[] {
  const out = new Set<string>()
  for (const m of s.matchAll(/https?:\/\/[^\s)<>"'\]\\]+/g)) out.add(m[0].replace(/[.,;:]+$/, ''))
  return [...out]
}
const norm = (u: string) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}${x.search}`.toLowerCase() } catch { return u.toLowerCase() } }

async function runAll(tag: string) {
  const fixture = JSON.parse(fs.readFileSync(path.join(HOME, 'fixture.json'), 'utf8')) as FixtureState
  const env: Env = { base: BASE, dataDir: DATA, teamRoot: path.join(HOME, 'team'), fixture, runId: tag, commit: '', log: (s) => console.log(`[figure-eval] ${s}`) }
  const only = opt('--only')?.split(',')
  const repeat = Number(opt('--repeat') ?? 1)
  const jobs = Number(opt('--jobs') ?? 3)
  const todo = CASES.filter((c) => !only || only.includes(c.id)).flatMap((c) => Array.from({ length: repeat }, (_, rep) => ({ c, rep })))
  const results: Result[] = []
  const worker = async () => {
    for (let x = todo.shift(); x; x = todo.shift()) {
      const { c, rep } = x
      const asCase = { id: c.id, lang: c.lang, as: 'daniel', context: 'personal', followUps: [], expect: { outcome: 'do', good: '', checks: [] } } as unknown as Case
      const r: Result = { id: c.id, rep, chatId: null, turn: null, error: null }
      try {
        const api = await login(BASE, 'daniel')
        const chat = await api.call((await import('../../shared/src/api')).API.createChat, { body: {} })
        r.chatId = chat.id
        r.turn = (await oneTurn(api, env, asCase, chat.id, c.prompt, 0)).rec
        r.urlsSeen = urlsInTranscript(chat.id)
        env.log(`${c.id}#${rep}: ${r.turn.status} in ${Math.round(r.turn.ms / 1000)} s, ${r.turn.tools.length} tools (${r.turn.tools.filter((t) => t.name === 'web_fetch' && !t.ok).length} failed fetches)`)
      } catch (e) { r.error = e instanceof Error ? e.message : String(e); env.log(`${c.id}#${rep}: ERROR ${r.error}`) }
      results.push(r)
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker))
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `figure-eval-${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify(results, null, 1))
  console.log(`[figure-eval] answers: ${file}`)
  await judgeFile(file)
}

const pageCache = new Map<string, Promise<{ ok: boolean; text: string; why?: string }>>()
function page(url: string) {
  if (!pageCache.has(url)) pageCache.set(url, webFetch(url, { maxChars: 400_000 }).then((r) => ({ ok: true, text: r.text })).catch((e) => ({ ok: false, text: '', why: (e as Error).message })))
  return pageCache.get(url)!
}

/** the part of a page that matters for the answer's figures: paragraphs with a number, up to `max` characters */
function excerpt(text: string, max = 40_000): string {
  if (text.length <= max) return text
  const paras = text.split(/\n{1,}/).filter((p) => /\d/.test(p))
  let out = ''
  for (const p of paras) { if (out.length + p.length > max) break; out += p + '\n' }
  return out
}

async function judgeOne(r: Result): Promise<Judged> {
  const answer = r.turn?.answer ?? ''
  const cited = urlsIn(answer)
  const seen = new Set((r.urlsSeen ?? []).map(norm))
  const links: Judged['links'] = []
  for (const u of cited) {
    const p = await page(u)
    // a site that refuses robots is not a dead link: only a 404/410 or a name that does not resolve counts as dead
    const dead = !p.ok && /HTTP (404|410)|could not resolve/.test(p.why ?? '')
    links.push({ url: u, fromTools: seen.has(norm(u)), opens: !dead, ...(p.ok ? {} : { why: p.why }) })
  }
  const pages: string[] = []
  for (const u of cited) {
    const p = await page(u)
    pages.push(p.ok ? `<page url="${u}">\n${excerpt(p.text)}\n</page>` : `<page url="${u}" unavailable="${p.why}"/>`)
  }
  const prompt = [
    'You check a research brief against its sources. Below is the brief, then the text of each page it links to.',
    'List EVERY figure in the brief (a number with what it measures: a percentage, a count, an amount of money, a rate, a ratio, a year-specific value; skip plain years used as dates and list numbering) that has a link in the same sentence or bullet.',
    'For each, compare with the linked page text and give a verdict:',
    '- "supported": the page states this value AND the brief keeps what it counts (unit, base, population, percent vs percentage points, currency and year, period, hedges such as "about" / "up to"). A correct rounding or a correct translation is fine.',
    '- "misstated": the page states the figure but the brief changes its value, unit, base, population or meaning (e.g. "71% of staff reported less burnout" written as "71% less burnout"; "rose 1.7%" for "rose 1.7 percentage points"; a share of firms given as a share of workers).',
    '- "not_in_cited": the page text is available but does not state this figure.',
    '- "unverifiable": the page is unavailable or its text is cut so the figure cannot be checked.',
    'Answer with JSON only: {"figures":[{"figure":"…","claim":"short quote from the brief","url":"…","verdict":"…","note":"for misstated: what the page says"}]}',
    '',
    '<brief>', answer, '</brief>', '', ...pages,
  ].join('\n')
  const p = Bun.spawn(['claude', '-p', '--model', 'sonnet', '--output-format', 'text', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence'], { stdin: new TextEncoder().encode(prompt), stdout: 'pipe', stderr: 'pipe', cwd: '/tmp' })
  const out = await new Response(p.stdout).text()
  await p.exited
  const m = /\{[\s\S]*\}/.exec(out)
  let figures: Figure[] = []
  try { figures = m ? JSON.parse(m[0]).figures ?? [] : [] } catch { figures = [] }
  return { figures, links }
}

function summary(rs: Result[]) {
  const f = rs.flatMap((r) => r.judge?.figures ?? [])
  const l = rs.flatMap((r) => r.judge?.links ?? [])
  const n = (v: Figure['verdict']) => f.filter((x) => x.verdict === v).length
  const checkable = n('supported') + n('misstated') + n('not_in_cited')
  return {
    answers: rs.length, answered: rs.filter((r) => r.turn?.status === 'done' && r.turn.answer.trim()).length,
    figures: f.length, supported: n('supported'), misstated: n('misstated'), notInCited: n('not_in_cited'), unverifiable: n('unverifiable'),
    faithfulShare: checkable ? +(n('supported') / checkable).toFixed(3) : null,
    links: l.length, linksFromTools: l.filter((x) => x.fromTools).length, deadLinks: l.filter((x) => !x.opens).length,
    failedFetches: rs.reduce((s, r) => s + (r.turn?.tools.filter((t) => t.name === 'web_fetch' && !t.ok).length ?? 0), 0),
    fetches: rs.reduce((s, r) => s + (r.turn?.tools.filter((t) => t.name === 'web_fetch').length ?? 0), 0),
  }
}

async function judgeFile(file: string) {
  const rs = JSON.parse(fs.readFileSync(file, 'utf8')) as Result[]
  const q = rs.filter((r) => r.turn?.answer && (!r.judge || args.includes('--again')))
  await Promise.all(Array.from({ length: 3 }, async () => { for (let r = q.shift(); r; r = q.shift()) { r.judge = await judgeOne(r); console.log(`[figure-eval] judged ${r.id}#${r.rep}: ${r.judge.figures.length} figures, ${r.judge.figures.filter((x) => x.verdict === 'misstated').length} misstated`) } }))
  fs.writeFileSync(file, JSON.stringify(rs, null, 1))
  const held = summary(rs.filter((r) => r.id !== 'A0')), qa = summary(rs.filter((r) => r.id === 'A0'))
  const md = [
    `# Figure fidelity eval: ${path.basename(file, '.json')}`, '',
    '| | held-out (F1-F10) | QA case (A0) |', '|---|---|---|',
    ...Object.keys(held).map((k) => `| ${k} | ${(held as any)[k]} | ${(qa as any)[k]} |`), '',
    '## Misstated or not in the cited page', '',
    ...rs.flatMap((r) => (r.judge?.figures ?? []).filter((x) => x.verdict === 'misstated' || x.verdict === 'not_in_cited').map((x) => `- ${r.id}#${r.rep} **${x.verdict}** ${x.figure}: "${x.claim}" (${x.url})${x.note ? ` — ${x.note}` : ''}`)),
    '', '## Links not from a tool result, or dead', '',
    ...rs.flatMap((r) => (r.judge?.links ?? []).filter((x) => !x.fromTools || !x.opens).map((x) => `- ${r.id}#${r.rep} ${x.url}${x.fromTools ? '' : ' (not in any tool call or result)'}${x.opens ? '' : ` (dead: ${x.why})`}`)),
  ].join('\n')
  fs.writeFileSync(file.replace(/\.json$/, '.md'), md + '\n')
  console.log(md)
}

if (args[0] === 'run') await runAll(opt('--tag') ?? 'run')
else if (args[0] === 'judge') await judgeFile(args[1]!)
else console.log('usage: figure-eval.ts run [--only F1,F2] [--repeat N] [--jobs N] [--tag name] | judge <file.json> [--again]')
