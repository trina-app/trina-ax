// ReDoS: catastrophic patterns must neither hang the server nor take long (ripgrep's Rust regex is linear time;
// no PCRE2). While each search runs, a second tool call must still be answered quickly (server not blocked).
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'

export async function runRedos() {
  const env = makeEnv('redos')
  const T = env.fx.team
  fs.mkdirSync(path.join(T, 'shared/redos'), { recursive: true })
  fs.writeFileSync(path.join(T, 'shared/redos/aaaa.txt'), 'x\n' + 'a'.repeat(40) + 'b\n' + ('a'.repeat(5000) + '!\n').repeat(200))
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(T, `shared/redos/f${i}.txt`), ('a'.repeat(3000) + '!\n').repeat(20))
  const ctx = env.ctx('alice')
  const cases: [string, any, 'ok' | 'error'][] = [
    ['(a+)+$', { pattern: '(a+)+$', output_mode: 'count' }, 'ok'],
    ['(a|aa)+b', { pattern: '(a|aa)+b', output_mode: 'count' }, 'ok'],
    ['(\\w+\\s?)+$', { pattern: '(\\w+\\s?)+$', output_mode: 'count' }, 'ok'],
    ['(.*a){20}', { pattern: '(.*a){20}', output_mode: 'count' }, 'ok'],
    ['huge repetition (size limit)', { pattern: '((a{100}){100}){100}' }, 'error'],
    ['backreference (no PCRE2)', { pattern: '(a)\\1' }, 'error'],
    ['look-ahead (no PCRE2)', { pattern: 'Falcon(?= kickoff)' }, 'error'],
    ['multiline (.|\\n)*', { pattern: '(.|\\n)*!', multiline: true, output_mode: 'count' }, 'ok'],
  ]
  const rows: any[] = []
  for (const [label, args, want] of cases) {
    const t0 = performance.now()
    const p = env.files.call('grep', args, ctx)
    await Bun.sleep(20)
    const t1 = performance.now(); await env.files.call('list', { path: 'shared' }, ctx); const pingMs = Math.round(performance.now() - t1)
    const r = await p
    const ms = Math.round(performance.now() - t0)
    rows.push({ label, ms, pingDuringMs: pingMs, result: r.isError ? 'error' : 'ok', ok: (r.isError ? 'error' : 'ok') === want && ms < 5000 && pingMs < 200, out: r.text.slice(0, 80).replace(/\n/g, ' | ') })
  }
  env.db.close()
  fs.rmSync(env.fx.base, { recursive: true, force: true })
  return { rows, fails: rows.filter((r) => !r.ok).length }
}
if (import.meta.main) { const r = await runRedos(); console.table(r.rows); process.exit(r.fails ? 1 : 0) }
