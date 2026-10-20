// Path fuzz cases (port of the prototype fuzz.mjs + linux-cases.mjs + Windows name rules), all as user alice.
// A case FAILS if a canary string appears in the output, if list/glob reveal hidden names, or (writes) if a
// file appears outside alice's writable areas — checked by scanForPwn() after the run.
import fs from 'node:fs'
import path from 'node:path'
import { CANARY_RE } from '../lib/fixtures'

export interface Case { tool: string; args: any; label: string; expect?: 'deny' | 'allow'; okRe?: RegExp }

const HIDDEN_NAMES = /\bfinance\b|users\/bob|salaries|atlas|급여|hr-private|\.system|users\/ALICE|users\/Bob|Groups\//

export function judge(c: Case, text: string, isError: boolean): string | null {
  if (CANARY_RE.test(text)) return 'canary leaked'
  if ((c.tool === 'list' || c.tool === 'glob' || c.tool === 'grep') && !isError && HIDDEN_NAMES.test(text)) return 'hidden name revealed'
  if (c.expect === 'deny' && !isError) return 'expected denial'
  if (c.expect === 'allow' && (isError || (c.okRe && !c.okRe.test(text)))) return 'expected success: ' + text.slice(0, 120)
  return null
}

export function buildCases(base: string, team: string, linux: boolean): Case[] {
  const targets = ['groups/finance/budget.md', 'users/bob/notes.md', 'users/bob/급여메모.md', 'groups/marketing/salaries/2026.md', 'projects/atlas/notes.md']
  const variants = new Set<string>()
  for (const t of targets) {
    const [a, ...b] = t.split('/'); const rest = b.join('/')
    ;[t, './' + t, '/' + t, '//' + t, a + '//' + rest, a.toUpperCase() + '/' + rest, t.toUpperCase(), t.normalize('NFD'), t.normalize('NFKD'),
      a + './' + rest, a + ' /' + rest, a + '%2f' + rest, encodeURIComponent(t), t.replace(/\//g, '\\'), 'shared/../' + t, 'shared/./../' + t,
      'users/alice/../../' + t, 'groups/marketing/finance-dir/budget.md', 'groups/marketing/budget-link.md', 'GROUPS/MARKETING/BUDGET-LINK.MD',
      'groups/marketing/secret-link.txt', 'groups/marketing/margin-copy.md', 'users/alice/audit-copy.md', 'shared/abs-budget.md', 'shared/etc-link/hosts',
      'shared/..', '..', '../outside/secret.txt', './../outside/secret.txt', 'team/' + t, team + '/' + t, 'file://' + team + '/' + t,
      a.replace('r', 'г') + '/' + rest, a.replace('o', 'о') + '/' + rest, 'ｇｒｏｕｐｓ/finance/budget.md', 'groups／finance／budget.md', 'groups∕finance∕budget.md',
      t + '\0.md', t + '/', t + '/.', t + ' ', t + '.', t + '::$DATA', t + ':stream', 'users/alice/../bob/notes.md', 'users/ALICE/../bob/notes.md', '~alice/../../' + t,
      '~/' + t, 'C:/' + t, 'C:' + t, '\\\\server\\share\\' + t, t.replace('/', '/\u200b'), t.replace('/', '/\u202e'), '\u202e' + t, t.replace('.md', '.md\u0000'),
      '.system/history/old.bin', '.SYSTEM/history/old.bin', '.system', 'CLAUDE.md', 'AGENTS.md', 'proc/self/root' + team + '/' + t, '/proc/self/root' + team + '/' + t,
      '/proc/self/cwd/' + t, '/etc/passwd', '/dev/stdin', 'groups/marketing/../finance', 'groups/finance', 'users/bob', 'projects/atlas',
    ].forEach((v) => variants.add(v))
  }
  const cases: Case[] = []
  for (const v of variants) for (const tool of ['read', 'list', 'grep', 'glob']) {
    const args = tool === 'read' ? { file_path: v } : tool === 'list' ? { path: v } : tool === 'grep' ? { pattern: 'CANARY', path: v, output_mode: 'content' } : { pattern: '**/*', path: v }
    cases.push({ tool, args, label: `${tool} ${JSON.stringify(v).slice(0, 80)}` })
  }
  // grep / glob patterns that try to escape
  for (const a of [{ pattern: 'CANARY', glob: '../**' }, { pattern: 'CANARY', glob: '**/finance/**' }, { pattern: 'CANARY', path: '.' }, { pattern: 'CANARY', path: 'users' },
    { pattern: 'CANARY', path: 'groups' }, { pattern: 'CANARY', output_mode: 'content', '-i': true }, { pattern: '(?:)', output_mode: 'files_with_matches' }, { pattern: 'CANARY', type: 'md' },
    { pattern: 'CANARY', output_mode: 'count' }, { pattern: 'CANARY', multiline: true, output_mode: 'content' }, { pattern: 'CANARY', glob: '*.{md,txt,docx,xlsx,pdf,pptx}', output_mode: 'content' }])
    cases.push({ tool: 'grep', args: a, label: 'grep ' + JSON.stringify(a) })
  for (const a of [{ pattern: '../**' }, { pattern: '**/finance/*' }, { pattern: '/**/*' }, { pattern: '**/bob/**' }, { pattern: '**/*', path: 'users' }, { pattern: '**/.system/**' }, { pattern: '**/*' }])
    cases.push({ tool: 'glob', args: a, label: 'glob ' + JSON.stringify(a) })
  // writes into hidden or read-only areas (and Windows / look-alike names) — must all be refused
  for (const v of [...variants].map((x) => x.replace(/budget\.md|notes\.md|급여메모\.md|2026\.md|secret\.txt|old\.bin|hosts/, 'pwn.md')))
    cases.push({ tool: 'write', args: { file_path: v, content: 'pwn' }, label: `write ${JSON.stringify(v).slice(0, 80)}` })
  for (const v of ['skills/pwn.md', 'pwn.md', 'groups/pwn.md', 'projects/pwn.md', 'projects/falcon/public/pwn.md', 'users/pwn.md', 'groups/finance/pwn.md',
    'users/alice/CON', 'users/alice/con.txt', 'users/alice/NUL.md', 'users/alice/COM1', 'users/alice/lpt9.log', 'users/alice/PROGRA~1', 'users/alice/REPORT~2.DOC',
    'users/alice/pwn.md:secret', 'users/alice/pwn.md::$DATA', 'users/alice/pwn. ', 'users/alice/pwn.', 'users/alice/ pwn', 'users/alice/a\u202egnp.md', 'users/alice/a\u200bb.md',
    'users/alice/a<b.md', 'users/alice/a|b.md', 'users/alice/a?.md', 'users/alice/a*.md', 'users/alice/a"b.md', 'users/alice/.mycel-tmp-x', 'users/alice/' + 'x'.repeat(256)])
    cases.push({ tool: 'write', args: { file_path: v, content: 'pwn' }, label: `write ${JSON.stringify(v).slice(0, 60)}`, expect: 'deny' })
  cases.push({ tool: 'edit', args: { file_path: 'skills/team-rules.md', old_string: 'Korean', new_string: 'pwn' }, label: 'edit read-only skills', expect: 'deny' })
  cases.push({ tool: 'edit', args: { file_path: 'groups/marketing/margin-copy.md', old_string: '81', new_string: '1' }, label: 'edit hard link', expect: 'deny' })
  cases.push({ tool: 'edit', args: { file_path: 'groups/marketing/budget-link.md', old_string: 'CANARY', new_string: 'x' }, label: 'edit symlink', expect: 'deny' })
  // long paths
  cases.push({ tool: 'read', args: { file_path: 'shared/' + 'a'.repeat(256) }, label: 'long segment', expect: 'deny' })
  cases.push({ tool: 'read', args: { file_path: 'shared/' + 'b'.repeat(1 << 20) }, label: '1MB path', expect: 'deny' })
  cases.push({ tool: 'read', args: { file_path: 'shared' + '/'.repeat(100000) + 'glossary.md' }, label: '100k slashes', expect: 'deny' })
  cases.push({ tool: 'write', args: { file_path: 'shared/' + Array.from({ length: 70 }, () => 'x').join('/') + '/f.md', content: 'x' }, label: 'too deep', expect: 'deny' })
  cases.push({ tool: 'read', args: { file_path: 'shared/deep/' + Array.from({ length: 40 }, (_, i) => 'd' + (i + 1)).join('/') + '/leaf.md' }, label: 'deep legit', expect: 'allow', okRe: /deep-ok/ })
  // positive controls (the fuzzer must not pass by denying everything)
  cases.push({ tool: 'read', args: { file_path: 'shared/glossary.md' }, label: 'control read', expect: 'allow', okRe: /ARR/ })
  cases.push({ tool: 'read', args: { file_path: 'SHARED/GLOSSARY.MD' }, label: 'control case-mapped read', expect: linux ? 'deny' : 'allow' })
  cases.push({ tool: 'grep', args: { pattern: 'Pretendard', output_mode: 'content' }, label: 'control grep office', expect: 'allow', okRe: /brand-guidelines\.docx/ })
  cases.push({ tool: 'list', args: { path: 'groups' }, label: 'control list groups', expect: 'allow', okRe: /^marketing\/$/ })
  if (linux) {
    // case-sensitive file system: siblings that differ only by case are DIFFERENT folders
    for (const [v, tool] of [['groups/Marketing/hr-private.md', 'read'], ['Groups/marketing/hr-private.md', 'read'], ['users/ALICE/notes.md', 'read'], ['users/Bob/notes.md', 'read'],
      ['groups/Marketing', 'list'], ['users/ALICE', 'list']] as const)
      cases.push({ tool, args: tool === 'read' ? { file_path: v } : { path: v }, label: `linux case ${tool} ${v}`, expect: 'deny' })
    cases.push({ tool: 'write', args: { file_path: 'groups/Marketing/pwn.md', content: 'x' }, label: 'linux write into case sibling', expect: 'deny' })
    cases.push({ tool: 'write', args: { file_path: 'GROUPS/MARKETING/pwn.md', content: 'x' }, label: 'linux create case-only sibling folder', expect: 'deny' })
    cases.push({ tool: 'write', args: { file_path: 'users/alice/TODO.md', content: 'x' }, label: 'linux create case-only sibling file', expect: 'deny' })
    cases.push({ tool: 'write', args: { file_path: 'users/alice/ｔｏｄｏ.md', content: 'x' }, label: 'linux create width-only sibling file', expect: 'deny' })
    cases.push({ tool: 'write', args: { file_path: 'shared/' + 'ㅎ'.normalize('NFD') + 'x.md', content: 'x' }, label: 'linux NFD new name ok', expect: 'allow' })
    cases.push({ tool: 'read', args: { file_path: 'shared/회의록/x.md' }, label: 'linux NFC/NFD sibling folders -> exact match', expect: 'allow', okRe: /form=nfc/ })
    cases.push({ tool: 'read', args: { file_path: 'shared/회의록/x.md'.normalize('NFD') }, label: 'linux NFD input -> exact NFD folder', expect: 'allow', okRe: /form=nfd/ })
    cases.push({ tool: 'read', args: { file_path: 'groups/marketing/보고서.md' }, label: 'linux NFC input maps to NFD file', expect: 'allow', okRe: /nfd-named/ })
    cases.push({ tool: 'read', args: { file_path: 'groups/marketing/procroot-fin/budget.md' }, label: 'linux /proc/self/root symlink', expect: 'deny' })
    cases.push({ tool: 'read', args: { file_path: 'groups/marketing/proc-cwd/groups/finance/budget.md' }, label: 'linux /proc/self/cwd symlink', expect: 'deny' })
    cases.push({ tool: 'grep', args: { pattern: 'CANARY-CASE', output_mode: 'content' }, label: 'linux grep case siblings' })
    cases.push({ tool: 'glob', args: { pattern: '**/hr-private.md' }, label: 'linux glob case siblings' })
  }
  return cases
}

/** files named pwn* that ended up outside alice's writable areas */
export function scanForPwn(team: string): string[] {
  const bad: string[] = []
  const allowed = /^(shared|groups\/marketing|projects\/falcon|users\/alice)\//
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d, e.name), r)
      else if (/pwn/i.test(e.name) && (!allowed.test(r) || r.startsWith('groups/marketing/salaries/'))) bad.push(r)
    }
  }
  walk(team, '')
  return bad
}
