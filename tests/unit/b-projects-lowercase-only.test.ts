// Only the lowercase projects/ folder is members-only on a case-sensitive disk (docs/DECISIONS.md "Only the lowercase
// projects/ folder on case-sensitive disks", QA TC-360). A 0.4.0 team folder Projects/ClientA that everyone could read
// keeps its normal folder rules there; projects/ClientA is a members-only project folder. On a disk that ignores case
// both names are one folder and the rule is unchanged.
// Fixture (tests/lib/fixtures.ts): alice = marketing, bob = finance (members); carol = admin; dana = owner.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { inProjectZone, isProjectsName, isProjectsTop, projectsCaseInsensitive, RuleSet, setProjectsCaseInsensitive, type Principal } from '../../server/src/policy/access'
import { cutInsideProject, insideProject, inZone, projectZoneFolders } from '../../server/src/policy/zone'
import { authorize } from '../../server/src/policy/authorize'
import { isProjectsFolder } from '../../server/src/admin/folders'
import { membersOnlyOnce } from '../../server/src/chat/members-only-once'
import type { AppContext } from '../../server/src/context'

const before = projectsCaseInsensitive()
afterEach(() => setProjectsCaseInsensitive(before))

const P = (id: string, role: Principal['role'], groups: string[] = []): Principal => ({ id, name: id, role, groups })
const dana = P('dana', 'owner'), carol = P('carol', 'admin'), alice = P('alice', 'member', ['marketing']), bob = P('bob', 'member', ['finance'])
const rules = (rows: [string, 'everyone' | 'role' | 'group' | 'user', string | null, 'none' | 'read' | 'write'][]) =>
  new RuleSet(rows.map(([p, subject_type, subject_id, access]) => ({ path: p, subject_type, subject_id, access })))
// a 0.4.0 team: Projects/ClientA everyone reads; the project projects/ClientA is alice's
const r = rules([
  ['Projects/ClientA', 'everyone', null, 'read'],
  ['projects/ClientA', 'user', 'alice', 'write'],
])
const segs = (p: string) => p.split('/')

describe('a case-sensitive disk: only projects/ is the projects root', () => {
  test('Projects/ClientA has the normal folder rules: the owner and admins write by their role, a member reads', () => {
    setProjectsCaseInsensitive(false)
    expect(r.access(dana, segs('Projects/ClientA/brief.md'))).toBe('write')
    expect(r.access(carol, segs('Projects/ClientA/brief.md'))).toBe('write')
    expect(r.access(bob, segs('Projects/ClientA/brief.md'))).toBe('read')
    expect(r.canList(carol, segs('Projects'))).toBe(true)
    expect(r.explain(carol, segs('Projects/ClientA')).reason.kind).toBe('owner-admin')
  })
  test('projects/ClientA stays members-only: the owner and admins only as members', () => {
    setProjectsCaseInsensitive(false)
    expect(r.access(dana, segs('projects/ClientA/brief.md'))).toBe('none')
    expect(r.access(carol, segs('projects/ClientA/brief.md'))).toBe('none')
    expect(r.access(alice, segs('projects/ClientA/brief.md'))).toBe('write')
    expect(r.access(bob, segs('projects/ClientA/brief.md'))).toBe('none')
  })
  test('the path helpers: projects exactly, after Unicode NFC', () => {
    setProjectsCaseInsensitive(false)
    for (const top of ['Projects', 'PROJECTS', 'pROJECTS']) {
      expect(isProjectsName(top), top).toBe(false)
      expect(inProjectZone([top, 'ClientA']), top).toBe(false)
      expect(isProjectsTop([top]), top).toBe(false)
      expect(inZone(`${top}/ClientA`), top).toBe(false)
      expect(insideProject(`${top}/ClientA/brief.md`), top).toBe(false)
      expect(cutInsideProject(`${top}/ClientA/brief.md`), top).toBe(`${top}/ClientA/brief.md`)
      expect(isProjectsFolder(`${top}/ClientA`), top).toBe(false)
    }
    expect(isProjectsName('projects'.normalize('NFD'))).toBe(true)
    expect(inProjectZone(['projects', 'ClientA'])).toBe(true)
    expect(isProjectsTop(['projects'])).toBe(true)
    expect(isProjectsFolder('projects/ClientA')).toBe(true)
    expect(cutInsideProject('projects/ClientA/brief.md')).toBe('projects/ClientA/…')
  })
  test('the project folders on disk come from projects/ only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-lower-'))
    try {
      fs.mkdirSync(path.join(root, 'Projects', 'ClientA'), { recursive: true })
      setProjectsCaseInsensitive(false)
      expect(projectZoneFolders(root)).toEqual([])
      setProjectsCaseInsensitive(true)
      expect(projectZoneFolders(root)).toEqual([['Projects', 'ClientA']])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

describe('a disk that ignores case: unchanged', () => {
  test('Projects/ is projects/: the members-only zone in any letter case', () => {
    setProjectsCaseInsensitive(true)
    for (const top of ['projects', 'Projects', 'PROJECTS']) {
      expect(isProjectsName(top), top).toBe(true)
      expect(inProjectZone([top, 'ClientA']), top).toBe(true)
      expect(isProjectsFolder(`${top}/ClientA`), top).toBe(true)
      expect(cutInsideProject(`${top}/ClientA/brief.md`), top).toBe(`${top}/ClientA/…`)
    }
    // the rule on Projects/ClientA is inside the zone now: the owner and admins are judged as members there
    expect(r.access(dana, segs('Projects/ClientA/brief.md'))).toBe('read')
    expect(r.explain(carol, segs('Projects/ClientA')).reason.kind).not.toBe('owner-admin')
    expect(r.access(carol, segs('projects/ClientA/brief.md'))).toBe('none')
    expect(r.access(alice, segs('projects/ClientA/brief.md'))).toBe('write')
  })
})

describe('the team folder on this disk (the files service sets it)', () => {
  let env: ReturnType<typeof makeEnv>
  let ci = true
  beforeAll(() => { env = makeEnv('unit-projects-lowercase-only'); ci = env.files.fx.caseInsensitive })
  afterAll(() => { try { env.db.close() } catch { /* closed */ } })

  test('the setting follows the disk', () => {
    expect(projectsCaseInsensitive()).toBe(ci)
  })

  test('Projects/ClientA: an ordinary team folder on a case-sensitive disk, the project folder where the disk ignores case', () => {
    setProjectsCaseInsensitive(ci)
    fs.mkdirSync(path.join(env.fx.team, 'Projects', 'ClientA'), { recursive: true })
    fs.writeFileSync(path.join(env.fx.team, 'Projects', 'ClientA', 'brief.md'), 'brief\n')
    // the rule on the folder's actual name: Projects/ClientA on a case-sensitive disk, projects/ClientA (the fixture's
    // projects/) where the disk ignores case
    const top = fs.readdirSync(env.fx.team).find((n) => n.toLowerCase() === 'projects' && fs.existsSync(path.join(env.fx.team, n, 'ClientA')))!
    const folder = `${top}/ClientA`
    env.db.query("INSERT INTO folders (id, path) VALUES ('f_client_a', ?)").run(folder)
    env.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_client_a', 'f_client_a', 'user', 'alice', 'write')").run()
    const rs = env.files.rules()
    const can = (who: string, op: 'read' | 'write', p = 'Projects/ClientA/brief.md') => { try { authorize(env.files.fx, rs, env.files.principal(who), p, op); return true } catch { return false } }
    if (!ci) {
      expect(top).toBe('Projects')
      expect({ dana: can('dana', 'write'), carol: can('carol', 'write'), alice: can('alice', 'write'), bob: can('bob', 'read') })
        .toEqual({ dana: true, carol: true, alice: true, bob: false })
      // the fixture's projects/falcon stays members-only
      expect({ dana: can('dana', 'read', 'projects/falcon/plan.md'), carol: can('carol', 'read', 'projects/falcon/plan.md') }).toEqual({ dana: false, carol: false })
    } else {
      expect(top).toBe('projects')
      expect({ dana: can('dana', 'read'), carol: can('carol', 'read'), alice: can('alice', 'write'), bob: can('bob', 'read') })
        .toEqual({ dana: false, carol: false, alice: true, bob: false })
    }
  })

  test('the first start keeps admins\' role rules on Projects/ on a case-sensitive disk; the shared-answers step leaves its chats alone', async () => {
    setProjectsCaseInsensitive(false)
    const db = env.db
    db.query("INSERT INTO folders (id, path) VALUES ('f_upper', 'Projects/Old'), ('f_lower', 'projects/old')").run()
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_upper', 'f_upper', 'role', 'admin', 'write'), ('r_lower', 'f_lower', 'role', 'admin', 'write')").run()
    db.query("DELETE FROM settings WHERE key = 'projectsMembersOnly.v1'").run()
    const errors: unknown[] = []
    const log = { info() {}, warn() {}, error: (...a: unknown[]) => { errors.push(a) }, debug() {} }
    await membersOnlyOnce({ db, files: env.files, log } as unknown as AppContext)
    expect(errors).toEqual([])
    expect(db.query("SELECT 1 FROM folder_rules WHERE id = 'r_upper'").get()).not.toBeNull()
    expect(db.query("SELECT 1 FROM folder_rules WHERE id = 'r_lower'").get()).toBeNull()
  })
})
