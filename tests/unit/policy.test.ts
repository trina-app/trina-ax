import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { EXPECTED } from '../lib/fixtures'
import { RuleSet } from '../../server/src/policy/access'
import { badSegment, foldKey } from '../../server/src/policy/names'
import { parseInput } from '../../server/src/policy/resolve'
import { authorize } from '../../server/src/policy/authorize'

const env = makeEnv('unit-policy')
const rules = RuleSet.load(env.db)

describe('expected-permission table', () => {
  for (const [u, p, want] of EXPECTED) test(`${u} ${p} = ${want}`, () => expect(rules.access(env.files.principal(u), p.split('/'))).toBe(want))
})

describe('listing visibility', () => {
  const alice = env.files.principal('alice')
  test('root and users/ listable as ancestors', () => { expect(rules.canList(alice, [])).toBe(true); expect(rules.canList(alice, ['users'])).toBe(true) })
  test('groups/finance not listable', () => expect(rules.canList(alice, ['groups', 'finance'])).toBe(false))
  test('projects listable because falcon is', () => expect(rules.canList(alice, ['projects'])).toBe(true))
  test('erin sees projects only via falcon/public', () => expect(rules.canList(env.files.principal('erin'), ['projects', 'falcon'])).toBe(true))
})

describe('name rules', () => {
  const bad = ['CON', 'con.txt', 'NUL', 'Com1', 'LPT9.log', 'COM¹', 'PROGRA~1', 'REPORT~2.DOC', 'a:b', 'x::$DATA', 'end.', 'end ', ' start', 'a\u202eb', 'a\u200bb', 'a\u2066b', 'x\ufeff',
    'a／b', 'a∕b', 'a\\b', 'a<b', 'a>b', 'a|b', 'a?b', 'a*b', 'a"b', '.', '..', 'x'.repeat(256), '.mycel-tmp-1', 'ｆｉｎａｎｃｅ', 'a\u0007b', 'a\u0085b']
  for (const n of bad) test(`rejects ${JSON.stringify(n).slice(0, 30)}`, () => expect(badSegment(n)).not.toBeNull())
  const good = ['report.md', '회의록', '보고서 v2.docx', 'Q4 (final).xlsx', '.hidden', 'a.b.c', 'CONSOLE.md', 'com10', '~notes', 'résumé.pdf', '日本語.txt']
  for (const n of good) test(`accepts ${n}`, () => expect(badSegment(n)).toBeNull())
  test('fold key catches case/NFD/width-only siblings', () => {
    expect(foldKey('Marketing')).toBe(foldKey('marketing'))
    expect(foldKey('회의록'.normalize('NFD'))).toBe(foldKey('회의록'))
    expect(foldKey('ＴＯＤＯ.md')).toBe(foldKey('todo.md'))
  })
})

describe('path parsing', () => {
  for (const p of ['/etc/passwd', '~/x', 'C:/x', 'file:///etc', '..', 'a/../b', 'a\\b', 'a\0b', 'https://x/y', '.system/x'])
    test(`rejects ${JSON.stringify(p)}`, () => expect(() => parseInput(p)).toThrow())
  test('drops empty and dot segments', () => expect(parseInput('./shared//./x.md')).toEqual(['shared', 'x.md']))
})

describe('authorize: actual names, symlinks, collisions', () => {
  const alice = env.files.principal('alice')
  test('maps case on case-insensitive fs to the actual name (macOS) or refuses (Linux)', () => {
    if (env.files.fx.caseInsensitive) expect(authorize(env.files.fx, rules, alice, 'SHARED/GLOSSARY.MD', 'read').rel).toBe('shared/glossary.md')
    else expect(() => authorize(env.files.fx, rules, alice, 'SHARED/GLOSSARY.MD', 'read')).toThrow()
  })
  test('symlink anywhere in the path is refused', () => {
    expect(() => authorize(env.files.fx, rules, alice, 'groups/marketing/finance-dir/budget.md', 'read')).toThrow(/symbolic|no access/)
    expect(() => authorize(env.files.fx, rules, alice, 'shared/etc-link/hosts', 'read')).toThrow(/symbolic/)
  })
  test('creating a case-only sibling is refused', () => {
    if (!env.files.fx.caseInsensitive) expect(() => authorize(env.files.fx, rules, alice, 'shared/GLOSSARY.md', 'write')).toThrow(/almost the same name/)
    expect(() => authorize(env.files.fx, rules, alice, 'shared/ｇｌｏｓｓａｒｙ.md', 'write')).toThrow()
  })
  test('denied path and missing path give the same message', () => {
    const m1 = (() => { try { authorize(env.files.fx, rules, alice, 'groups/finance/budget.md', 'read') } catch (e: any) { return e.message } })()
    const m2 = (() => { try { authorize(env.files.fx, rules, alice, 'groups/finance/nope.md', 'read') } catch (e: any) { return e.message } })()
    expect(m1.replace(/'.*'/, '')).toBe(m2.replace(/'.*'/, ''))
  })
})

// A listing walk (chat/skills.ts, prompt.ts teamRuleFiles) passes one memo of folder listings to its authorize calls so
// a folder of 1,000 skills is read once. The memo only says which names a folder had: every step is still lstat'ed and
// realpath-checked, and access is decided on the names found on disk. A write never uses it.
describe('authorize: the folder listing memo of one scan (resolve.ts walk `dirs`)', () => {
  const alice = env.files.principal('alice')
  const team = env.files.fx.root
  test('a stale listing never authorizes: a folder swapped for a link is refused, a removed entry is not found', () => {
    const dir = path.join(team, 'shared', 'memo-probe')
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sub', 'a.md'), 'x')
    try {
      const dirs = new Map<string, string[]>()
      expect(authorize(env.files.fx, rules, alice, 'shared/memo-probe/sub/a.md', 'read', { dirs }).rel).toBe('shared/memo-probe/sub/a.md')
      expect(dirs.get(dir)).toEqual(['sub'])
      // "sub" becomes a link to a folder alice cannot read; the memo still lists it
      fs.rmSync(path.join(dir, 'sub'), { recursive: true })
      fs.symlinkSync(path.join(team, 'groups', 'finance'), path.join(dir, 'sub'))
      expect(() => authorize(env.files.fx, rules, alice, 'shared/memo-probe/sub/budget.md', 'read', { dirs })).toThrow(/symbolic|no access/)
      expect(() => authorize(env.files.fx, rules, alice, 'shared/memo-probe/sub', 'list', { dirs })).toThrow(/symbolic|no access/)
      // gone: the memo's name is looked up on disk again
      fs.rmSync(path.join(dir, 'sub'))
      expect(() => authorize(env.files.fx, rules, alice, 'shared/memo-probe/sub/a.md', 'read', { dirs })).toThrow()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('a write never uses it', () => {
    // a memo that lists a name the folder does not have
    const dirs = new Map([[path.join(team, 'users', 'alice'), ['made-up.md']]])
    expect(authorize(env.files.fx, rules, alice, 'users/alice/made-up.md', 'write', { dirs }).exists).toBe(false)
    expect(() => authorize(env.files.fx, rules, alice, 'users/alice/made-up.md', 'read', { dirs })).toThrow()
  })
})
