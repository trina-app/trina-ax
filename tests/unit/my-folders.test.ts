// my_folders (server/src/chat/my-folders.ts; docs/decisions/20261122-demo-permission-scene.md): the folders a person's
// AI can see, each with its access, for the card under an answer that could not find a folder ("Show me the management
// folder"). The owner (2026-11-22): the person must not even learn that a folder hidden from them exists. So the list
// never names one, and the answer (the file tool's refusal, then this list) is the same for a folder that is not there
// and one that is there but not open to them.
// The fixture team (tests/lib/fixtures.ts): alice in Marketing (shared/ write, skills/ read, groups/marketing write,
// groups/marketing/salaries limited to nobody), bob in Finance, carol admin, dana owner.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { myFolders, myFoldersOff, myFoldersText, MY_FOLDERS_DESCRIPTION, MY_FOLDERS_TOOL } from '../../server/src/chat/my-folders'
import { MY_FOLDERS_RULE } from '../../server/src/chat/prompt'
import { RuleSet } from '../../server/src/policy/access'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { ROOMS_SEEN_READ_ONLY_TOOLS } from '../../server/src/rooms/ai-tools'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('my-folders') })
afterAll(async () => { await A.close() })

type Who = 'alice' | 'bob' | 'carol' | 'dana' | 'erin'
const P = (u: Who) => A.ctx.files.principal(u)
const answer = async (u: Who, asked: string) => {
  const ctx = A.toolCtx(u, A.turn(u, A.chat(u)))
  const refusal = await A.ctx.files.call('list', { path: asked }, ctx)
  const list = myFolders(A.ctx.files, P(u))
  return { refusal: refusal.text.split(asked).join('<ASKED>'), isError: refusal.isError, list, text: myFoldersText(list, `users/${u}`) }
}

describe('the list', () => {
  test('each folder the person can open with its access: shared/, groups, projects, skills, their own folder last', () => {
    const alice = myFolders(A.ctx.files, P('alice'))
    expect(alice[0]).toEqual({ path: 'shared', access: 'edit' })
    expect(alice).toContainEqual({ path: 'groups/marketing', access: 'edit' })
    expect(alice).toContainEqual({ path: 'skills', access: 'view' })
    expect(alice.at(-1)).toEqual({ path: 'users/alice', access: 'edit' })
    const bob = myFolders(A.ctx.files, P('bob'))
    expect(bob).toContainEqual({ path: 'groups/finance', access: 'edit' })
    expect(bob).toContainEqual({ path: 'skills', access: 'view' })
    // the text the AI gets says the same, in the words the other tools take
    const t = myFoldersText(alice, 'users/alice')
    expect(t).toContain('- shared/ (can edit)')
    expect(t).toContain('- skills/ (read only)')
    expect(t).toContain("- users/alice/ (can edit): the user's own folder")
  })

  test('never a folder the person cannot open: another group, a limited folder, another person\'s own folder', () => {
    const paths = myFolders(A.ctx.files, P('alice')).map((f) => f.path)
    expect(paths).not.toContain('groups/finance')
    expect(paths).not.toContain('groups/marketing/salaries')
    expect(paths.some((p) => p.startsWith('users/') && p !== 'users/alice')).toBe(false)
    const text = myFoldersText(myFolders(A.ctx.files, P('alice')), 'users/alice')
    expect(text).not.toMatch(/salaries|finance/i)
    // a folder inside one listed at the same level adds nothing
    expect(paths.filter((p) => p.startsWith('shared/'))).toEqual([])
  })

  test('the owner and admins see every team folder', () => {
    const dana = myFolders(A.ctx.files, P('dana')).map((f) => f.path)
    expect(dana).toContain('groups/finance')
    expect(dana).toContain('groups/marketing')
  })
})

describe('a hidden folder answers exactly like a missing one', () => {
  test('the refusal, the list and the text are the same before and after a "management" folder hidden from alice appears', async () => {
    const before = await answer('alice', 'shared/management')
    // an admin makes shared/management, limited to dana (the CEO's folder of the demo)
    const r = await A.json('/api/admin/folders', { as: 'dana', ...jsonBody({ path: 'shared/management', create: true, limited: true, rules: [{ subjectType: 'user', subjectId: 'dana', access: 'write' }] }) })
    expect(r.status).toBeLessThan(300)
    fs.writeFileSync(path.join(A.team, 'shared', 'management', '2027 plan.md'), 'TOP-SECRET-PLAN\n')
    const after = await answer('alice', 'shared/management')
    expect(after).toEqual(before)
    expect(JSON.stringify(after)).not.toMatch(/TOP-SECRET-PLAN|2027 plan/)
    // and the same as a name that was never there
    const never = await answer('alice', 'shared/managemenz')
    expect(never).toEqual(after)
    // the folder is there for its owner, so the test is about a real hidden folder
    const owner = await A.ctx.files.call('list', { path: 'shared/management' }, A.toolCtx('dana', A.turn('dana', A.chat('dana'))))
    expect(owner.isError).toBeFalsy()
    expect(owner.text).toContain('2027 plan.md')
    expect(myFolders(A.ctx.files, P('alice')).map((f) => f.path)).not.toContain('shared/management')
  })
})

describe('where it is offered', () => {
  test('a read-only tool of the main AI: no sub-agent, no card after a room read', () => {
    expect(MY_FOLDERS_TOOL).toBe('my_folders')
    expect(PARENT_ONLY_TOOLS.has(MY_FOLDERS_TOOL)).toBe(true)
    expect(ROOMS_SEEN_READ_ONLY_TOOLS.has(MY_FOLDERS_TOOL)).toBe(true)
    expect(MY_FOLDERS_DESCRIPTION).toContain('never lists a folder the user cannot open')
    // the answer names only the word the person used, never that it exists
    expect(MY_FOLDERS_RULE).toContain('If it exists, ask its owner or an admin')
    expect(MY_FOLDERS_RULE).toContain('never say or guess that it exists')
  })

  test('off in a scheduled run, Slack, a restricted run (a shared chat and one others wrote in: behind the read card)', () => {
    const base = { rt: { db: A.ctx.db }, spec: { userId: 'alice', chatId: A.chat('alice'), clientKind: 'web' }, shared: null, restricted: null, templateRun: null, otherAuthors: false } as never as Parameters<typeof myFoldersOff>[0]
    expect(myFoldersOff(base)).toBeNull()
    expect(myFoldersOff({ ...base, shared: {} as never })).toBeNull()
    expect(myFoldersOff({ ...base, otherAuthors: true })).toBeNull()
    expect(myFoldersOff({ ...base, spec: { ...base.spec, clientKind: 'schedule' } } as never)).toBe('a scheduled run')
    expect(myFoldersOff({ ...base, spec: { ...base.spec, clientKind: 'slack' } } as never)).toBe('a question from Slack')
    expect(myFoldersOff({ ...base, restricted: {} as never })).toBe('a run limited to one task')
  })
})

describe('the access it shows is the access the person has (review of #353)', () => {
  test('a folder with less access than the folder it is in stays: shared/ Can edit, shared/policies Read only', async () => {
    const r = await A.json('/api/admin/folders', { as: 'dana', ...jsonBody({ path: 'shared/policies', create: true, limited: true, rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }] }) })
    expect(r.status).toBeLessThan(300)
    const alice = myFolders(A.ctx.files, P('alice'))
    expect(alice).toContainEqual({ path: 'shared', access: 'edit' })
    expect(alice).toContainEqual({ path: 'shared/policies', access: 'view' })
    expect(myFoldersText(alice, 'users/alice')).toContain('- shared/policies/ (read only)')
    // a folder inside one with the same access still adds nothing
    expect(alice.filter((f) => f.path.startsWith('groups/marketing/'))).toEqual([])
  })

  test('a folder a plugin manages is Read only, even to an admin who can edit skills/', () => {
    fs.mkdirSync(path.join(A.team, 'skills', 'pack-x'), { recursive: true })
    const before = A.ctx.files.fx.managed
    A.ctx.files.fx.managed = { managerOf: (s) => (s[0] === 'skills' && s[1] === 'pack-x' ? 'pack-x' : null), heldBelow: () => null }
    try {
      const carol = myFolders(A.ctx.files, P('carol'))
      expect(carol).toContainEqual({ path: 'skills', access: 'edit' })
      expect(carol).toContainEqual({ path: 'skills/pack-x', access: 'view' })
      expect(carol.some((f) => f.path === 'skills/pack-x' && f.access === 'edit')).toBe(false)
      // a member reads skills/ and the plugin's folder alike: one row
      const alice = myFolders(A.ctx.files, P('alice'))
      expect(alice).toContainEqual({ path: 'skills', access: 'view' })
      expect(alice.map((f) => f.path)).not.toContain('skills/pack-x')
    } finally { A.ctx.files.fx.managed = before }
  })

  test('a team-root rule: the top-level folders it opens are listed, a limited one closed to the person is not', () => {
    fs.mkdirSync(path.join(A.team, 'handbook'), { recursive: true })
    fs.mkdirSync(path.join(A.team, 'board'), { recursive: true })
    const w = A.ctx.files.rules().world()
    const rules = RuleSet.fromWorld({ ...w, rows: [...w.rows, { path: '', subject_type: 'everyone', subject_id: null, access: 'read' }, { path: 'board', subject_type: 'user', subject_id: 'dana', access: 'write' }], limited: [...w.limited, 'board'] })
    const files = { rules: () => rules, cfg: A.ctx.files.cfg, fx: A.ctx.files.fx } as never as typeof A.ctx.files
    const alice = myFolders(files, P('alice'))
    expect(alice).toContainEqual({ path: 'handbook', access: 'view' })
    expect(alice.map((f) => f.path)).not.toContain('board')
    expect(alice.some((f) => f.path === 'users' || (f.path.startsWith('users/') && f.path !== 'users/alice'))).toBe(false)
    expect(myFolders(files, P('dana'))).toContainEqual({ path: 'board', access: 'edit' })
  })
})
