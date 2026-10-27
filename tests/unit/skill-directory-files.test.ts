import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { AppContext } from '../../server/src/context'
import type { TurnRequest } from '@mycel/shared/api'
import { makeEnv } from '../lib/env'
import { listSkills, readSkill } from '../../server/src/chat/skills'
import { teamRules } from '../../server/src/chat/prompt'
import { recordSkillChange } from '../../server/src/skills/changes'
import { TurnExec } from '../../server/src/chat/turn'
import { sha256 } from '../../server/src/files/store'

const env = makeEnv('p4-directory-files')
afterAll(() => env.db.close())
const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(env.fx.team, rel)), { recursive: true })
  fs.writeFileSync(path.join(env.fx.team, rel), text)
}
const text = (name: string) => `---\nname: ${name}\ndescription: >-\n  Creates reports\n  when requested.\n---\n1. Read references/guide.md.\n`
put('skills/report/SKILL.md', text('report'))
put('skills/report/references/guide.md', '---\nname: Resource name\n---\nPUBLIC_REFERENCE')
put('skills/report/assets/template.txt', 'PUBLIC_TEMPLATE')
put('skills/report/private/hidden.md', 'PRIVATE_REFERENCE')
env.db.query("INSERT INTO folders (id, path) VALUES ('p4-private', 'skills/report/private')").run()
env.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('p4-deny', 'p4-private', 'user', 'alice', 'none')").run()
const alice = env.files.principal('alice')

test('references and assets are read on demand, with their own rules and no extra skills', async () => {
  expect(listSkills(env.files, alice).map(s => s.path)).toEqual(['skills/report/SKILL.md'])
  const c = env.ctx('alice')
  expect((await env.files.call('read', { file_path: 'skills/report/references/guide.md' }, c)).text).toContain('PUBLIC_REFERENCE')
  expect((await env.files.call('read', { file_path: 'skills/report/assets/template.txt' }, c)).text).toContain('PUBLIC_TEMPLATE')
  const denied = await env.files.call('read', { file_path: 'skills/report/private/hidden.md' }, c)
  expect(denied.isError).toBe(true)
  expect(denied.text).not.toContain('PRIVATE_REFERENCE')
})

test('resource symlinks, hardlinks and path traversal never escape ordinary reads', async () => {
  fs.symlinkSync(path.join(env.fx.outside, 'secret.txt'), path.join(env.fx.team, 'skills/report/references/linked.txt'))
  fs.linkSync(path.join(env.fx.outside, 'secret.txt'), path.join(env.fx.team, 'skills/report/references/hard.txt'))
  fs.symlinkSync(path.join(env.fx.outside), path.join(env.fx.team, 'skills/report/assets/linked-dir'))
  for (const rel of ['skills/report/references/linked.txt', 'skills/report/references/hard.txt',
    'skills/report/assets/linked-dir/secret.txt', 'skills/report/../../../outside/secret.txt', 'users/bob/notes.md']) {
    const r = await env.files.call('read', { file_path: rel }, env.ctx('alice'))
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain('CANARY-')
  }
})

test('revoked manifest access removes discovery and direct reads', () => {
  env.db.query("INSERT INTO folders (id, path) VALUES ('p4-report', 'skills/report')").run()
  env.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('p4-report-deny', 'p4-report', 'user', 'alice', 'none')").run()
  try {
    expect(listSkills(env.files, alice)).toEqual([])
    expect(readSkill(env.files, alice, 'skills/report/SKILL.md')).toBeNull()
  } finally { env.db.query("DELETE FROM folders WHERE id='p4-report'").run() }
})

test('history classifies standard manifests, invalid headers and package resources consistently', () => {
  put('skills/mismatch/SKILL.md', text('not-matching'))
  put('skills/rule.md', '# Team rule')
  const ctx = { db: env.db, files: env.files, services: { realtime: { publish() {} } } } as unknown as AppContext
  for (const [rel, kind] of [
    ['skills/report/SKILL.md', 'skill'], ['skills/report/references/guide.md', 'other'],
    ['skills/mismatch/SKILL.md', 'other'], ['skills/rule.md', 'rule'],
  ]) {
    recordSkillChange(ctx, { path: rel!, action: 'update', userId: 'carol', turnId: null })
    const row = env.db.query("SELECT detail FROM audit_log WHERE action='skills.change' AND target=? ORDER BY id DESC LIMIT 1").get(rel!) as { detail: string }
    expect(JSON.parse(row.detail).kind).toBe(kind)
  }
})

test('the server preview validates folder identity and does not label resources as skills', async () => {
  const cards: TurnRequest[] = []
  const ctx = env.ctx('carol')
  const exec = Object.assign(Object.create(TurnExec.prototype) as TurnExec, {
    rt: { files: env.files, db: env.db, askUserTimeoutMs: () => 1000 }, spec: { locale: 'en', userId: 'carol' }, files: ctx.files,
    livePrincipal: () => env.files.principal('carol'),
    waitForPerson: async (card: TurnRequest) => { cards.push(card); return 'save' },
  })
  for (const [rel, name] of [
    ['skills/new-report/SKILL.md', 'new-report'], ['skills/new-invalid/SKILL.md', null],
    ['skills/report/references/new.md', null],
  ] as const) {
    const content = text(name ?? 'not-matching')
    await exec.confirmSkillWrite('write', { file_path: rel, content })
    expect(cards.at(-1)).toMatchObject({ origin: 'server', preview: { path: rel, skillName: name } })
    expect(ctx.files.skillApprovals.get(rel)).toBe(sha256(content))
  }
})

test('manifest writes need the same exact-byte approval and do not grant folder access', async () => {
  const rel = 'skills/approved/SKILL.md', content = text('approved')
  const turnId = 'p4-confirmed-turn'
  env.db.query("INSERT INTO chats (id,user_id) VALUES ('p4-chat','carol')").run()
  env.db.query("INSERT INTO turns (id,chat_id,user_id,engine) VALUES (?,'p4-chat','carol','claude-code')").run(turnId)
  const c = env.ctx('carol', turnId)
  expect((await env.files.call('write', { file_path: rel, content }, c)).isError).toBe(true)
  c.files.skillApprovals.set(rel, sha256(content + 'different'))
  expect((await env.files.call('write', { file_path: rel, content }, c)).isError).toBe(true)
  c.files.skillApprovals.set(rel, sha256(content))
  expect((await env.files.call('write', { file_path: rel, content }, c)).isError).toBeFalsy()
  expect(readSkill(env.files, alice, rel)?.name).toBe('approved')
  const member = env.ctx('alice', turnId)
  member.files.skillApprovals.set('skills/member/SKILL.md', sha256(text('member')))
  expect((await env.files.call('write', { file_path: 'skills/member/SKILL.md', content: text('member') }, member)).isError).toBe(true)
})

test('a readable skill below a non-readable navigation folder is still discovered', () => {
  const rootId = (env.db.query("SELECT id FROM folders WHERE path='skills'").get() as { id: string }).id
  env.db.query("INSERT INTO folder_rules (id,folder_id,subject_type,subject_id,access) VALUES ('p4-root-none',?,'user','alice','none')").run(rootId)
  env.db.query("INSERT INTO folders (id,path) VALUES ('p4-scoped-report','skills/report')").run()
  env.db.query("INSERT INTO folder_rules (id,folder_id,subject_type,subject_id,access) VALUES ('p4-scoped-read','p4-scoped-report','user','alice','read')").run()
  try { expect(listSkills(env.files, alice).map(s => s.path)).toEqual(['skills/report/SKILL.md']) }
  finally {
    env.db.query("DELETE FROM folder_rules WHERE id='p4-root-none'").run()
    env.db.query("DELETE FROM folders WHERE id='p4-scoped-report'").run()
  }
})


test('a readable ordinary rule below non-readable skills is included without leaking siblings', () => {
  put('skills/scoped-rule.md', 'P4_VISIBLE_SCOPED_RULE')
  put('skills/ungranted-rule.md', 'P4_HIDDEN_SIBLING_RULE')
  const rootId = (env.db.query("SELECT id FROM folders WHERE path='skills'").get() as { id: string }).id
  env.db.query("INSERT INTO folder_rules (id,folder_id,subject_type,subject_id,access) VALUES ('p4-rule-root-none',?,'user','alice','none')").run(rootId)
  env.db.query("INSERT INTO folders (id,path) VALUES ('p4-scoped-rule','skills/scoped-rule.md')").run()
  env.db.query("INSERT INTO folder_rules (id,folder_id,subject_type,subject_id,access) VALUES ('p4-rule-read','p4-scoped-rule','user','alice','read')").run()
  try {
    const rules = teamRules(env.files, alice)
    expect(rules).toContain('P4_VISIBLE_SCOPED_RULE')
    expect(rules).not.toContain('P4_HIDDEN_SIBLING_RULE')
  } finally {
    env.db.query("DELETE FROM folder_rules WHERE id='p4-rule-root-none'").run()
    env.db.query("DELETE FROM folders WHERE id='p4-scoped-rule'").run()
  }
})
