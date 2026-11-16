// A run's report (report.md in the run's folder): the totals, one row per case and the failures by root cause.
import fs from 'node:fs'
import path from 'node:path'
import { FEATURES } from '../../../docs/features'
import { FEATURE_SCOPE } from '../feature-scope'
import { coverageMarkdown } from './catalog'
import type { Case, CaseResult } from './types'

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

export type Status = 'pass' | 'fail' | 'fail (fix in progress)' | 'blocked' | 'not judged'
export function statusOf(c: Case, r: CaseResult | undefined): Status {
  if (!r) return 'not judged'
  if (r.error?.startsWith('blocked:')) return 'blocked'
  if (!r.judge) return 'not judged'
  if (r.judge.pass) return 'pass'
  return c.fixInProgress ? 'fail (fix in progress)' : 'fail'
}

export function writeReport(cases: Case[], results: CaseResult[], dir: string, all: Case[] = cases): string {
  const byId = new Map(results.map((r) => [r.id, r]))
  const ran = cases.filter((c) => byId.has(c.id))
  const st = new Map(ran.map((c) => [c.id, statusOf(c, byId.get(c.id))]))
  const count = (s: Status) => [...st.values()].filter((x) => x === s).length
  const turns = results.flatMap((r) => r.turns)
  const sum = (f: (t: (typeof turns)[number]) => number) => turns.reduce((a, t) => a + f(t), 0)
  const autoFails = (r: CaseResult) => r.checks.filter((k) => !k.ok).map((k) => `${k.check.type}: ${k.detail}`)
  const lines: string[] = []
  const r0 = results[0]
  lines.push(`# AI scenario run ${r0?.runId ?? ''}`, '')
  lines.push(`Commit ${r0?.commit ?? '?'}. ${ran.length} cases: ${count('pass')} pass, ${count('fail')} fail, ${count('fail (fix in progress)')} fail with a fix in progress, ${count('blocked')} blocked, ${count('not judged')} not judged.`, '')
  lines.push(`Engine turns: ${turns.length}, model ${[...new Set(turns.map((t) => t.model).filter(Boolean))].join(', ') || '?'}. Tokens: ${sum((t) => t.usage.inputTokens).toLocaleString('en')} input, ${sum((t) => t.usage.outputTokens).toLocaleString('en')} output, ${sum((t) => t.usage.cacheReadTokens).toLocaleString('en')} cache read, ${sum((t) => t.usage.cacheWriteTokens).toLocaleString('en')} cache write; ${sum((t) => t.usage.apiCalls)} model calls; list-price equivalent $${sum((t) => t.usage.costUsd).toFixed(2)} (paid by this Mac's Claude subscription, not billed). Time ${Math.round(sum((t) => t.ms) / 60000)} min of turns.`, '')
  lines.push('| Case | Feature | Kind | Context | As | Install | Expected | Result | Why |', '|---|---|---|---|---|---|---|---|---|')
  for (const c of ran) {
    const r = byId.get(c.id)!
    const why = r.error?.startsWith('blocked:') ? r.error : r.judge ? `${r.judge.root_cause !== 'none' ? `[${r.judge.root_cause}] ` : ''}${r.judge.why}` : r.error ?? ''
    lines.push(`| ${c.id} ${cell(c.title)} | ${c.features[0]} | ${c.kind} | ${c.context} | ${c.as} | ${c.install} | ${c.expect.outcome} | ${st.get(c.id)} | ${cell(why)} |`)
  }
  lines.push('', '## Failures by root cause', '')
  const fails = ran.filter((c) => st.get(c.id)?.startsWith('fail'))
  const causes = new Map<string, Case[]>()
  for (const c of fails) { const k = byId.get(c.id)!.judge!.root_cause; causes.set(k, [...(causes.get(k) ?? []), c]) }
  for (const [k, l] of [...causes].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${k} (${l.length})`, '')
    for (const c of l) {
      const r = byId.get(c.id)!
      const af = autoFails(r)
      lines.push(`- **${c.id}** ${c.title}${c.fixInProgress ? ` (fix in progress: ${c.fixInProgress})` : ''}: ${r.judge!.why}${af.length ? ` Checks: ${af.join('; ')}.` : ''}${r.jargon.length ? ` Words: ${r.jargon.join(', ')}.` : ''}`)
    }
    lines.push('')
  }
  lines.push('## Flags', '')
  const flagged = (f: (r: CaseResult) => boolean) => ran.filter((c) => { const r = byId.get(c.id)!; return r.judge && f(r) }).map((c) => c.id)
  lines.push(`- Jargon (judge): ${flagged((r) => r.judge!.jargon).join(', ') || 'none'}`)
  lines.push(`- False claim: ${flagged((r) => r.judge!.false_claim).join(', ') || 'none'}`)
  lines.push(`- Unneeded question: ${flagged((r) => r.judge!.unneeded_question).join(', ') || 'none'}`)
  lines.push(`- Tone not OK: ${flagged((r) => !r.judge!.tone_ok).join(', ') || 'none'}`)
  lines.push(`- Wrong refusal (over-refusal): ${flagged((r) => r.judge!.refusal === 'wrong').join(', ') || 'none'}`)
  lines.push(`- Missing refusal (did what it must not): ${flagged((r) => r.judge!.refusal === 'missing').join(', ') || 'none'}`)
  // results per feature (a case counts for every feature it names)
  lines.push('', '## Results per feature', '', '| Feature | Reach | Pass | Fail | Fix in progress | Blocked | Failing cases |', '|---|---|---|---|---|---|---|')
  for (const f of FEATURES) {
    if (FEATURE_SCOPE[f.id]?.reach === 'none') continue
    const mine = ran.filter((c) => c.features.includes(f.id))
    if (!mine.length) { lines.push(`| ${f.id} | ${FEATURE_SCOPE[f.id]?.reach} | - | - | - | - | not in this run |`); continue }
    const k = (s: Status) => mine.filter((c) => st.get(c.id) === s).length
    lines.push(`| ${f.id} | ${FEATURE_SCOPE[f.id]?.reach} | ${k('pass')} | ${k('fail')} | ${k('fail (fix in progress)')} | ${k('blocked')} | ${mine.filter((c) => st.get(c.id)?.startsWith('fail')).map((c) => c.id).join(', ')} |`)
  }
  lines.push('', coverageMarkdown(all))
  const file = path.join(dir, 'report.md')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}
