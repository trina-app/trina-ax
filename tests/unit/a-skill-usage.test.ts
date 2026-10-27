import { beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { recordSkillRead, recordSkillUse } from '../../server/src/admin/skill-usage'
import { usage } from '../../server/src/admin/budgets'
import { UsageQuery } from '@mycel/shared/api'

const env = makeEnv('a-skill-usage')
const skill = { path: 'skills/report.md', name: 'Weekly report' }
const from = '2026-10-01T00:00:00.000Z', to = '2026-11-01T00:00:00.000Z'
beforeEach(() => {
  env.db.query("DELETE FROM turns WHERE id LIKE 'skill-%'").run()
  for (const [id, at, input, output, cost] of [['skill-one', from, 10, 3, 0.2], ['skill-two', '2026-10-15T00:00:00.000Z', 20, 7, 0.3], ['skill-outside', to, 100, 100, 10]] as const) {
    env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, model, status, started_at, input_tokens, output_tokens, cost_usd) VALUES (?, 'c', 'alice', 'claude-code', 'model-test', 'done', ?, ?, ?, ?)").run(id, at, input, output, cost)
  }
  fs.writeFileSync(path.join(env.fx.team, skill.path), '---\nname: Weekly report\ndescription: Synthetic test\n---\nDo not store this body.\n')
  fs.writeFileSync(path.join(env.fx.team, 'skills/rule.md'), 'A general rule, not a skill.\n')
})
const record = (turnId = 'skill-one', selected = skill) => recordSkillUse(env.db, { turnId, userId: 'alice', skill: selected, source: 'command' })
const report = () => usage(env.db, UsageQuery.parse({ groupBy: 'skill', from, to }))

test('skill report is an accepted admin usage grouping', () => {
  expect(UsageQuery.safeParse({ groupBy: 'skill' }).success).toBe(true)
})
test('command and repeated reads count the same skill once per turn, with no prompt or arguments stored', () => {
  record()
  recordSkillRead(env.db, env.files, env.files.principal('alice'), 'skill-one', skill.path)
  record()
  const rows = env.db.query('SELECT * FROM turn_skill_usage').all()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ turn_id: 'skill-one', skill_path: skill.path, skill_name: skill.name, source: 'command' })
  expect(JSON.stringify(rows)).not.toContain('Do not store this body')
})
test('records only existing turns belonging to that person, not paths outside team skills', () => {
  recordSkillUse(env.db, { turnId: 'skill-one', userId: 'bob', skill, source: 'command' })
  record('missing')
  record('skill-one', { path: 'users/alice/private.md', name: 'private' })
  expect(env.db.query('SELECT COUNT(*) AS n FROM turn_skill_usage').get()).toEqual({ n: 0 })
})
test('a read records a valid accessible skill, but not ordinary rules or another person’s private path', () => {
  recordSkillRead(env.db, env.files, env.files.principal('alice'), 'skill-one', 'skills/rule.md')
  recordSkillRead(env.db, env.files, env.files.principal('alice'), 'skill-one', 'users/bob/private.md')
  expect(env.db.query('SELECT COUNT(*) AS n FROM turn_skill_usage').get()).toEqual({ n: 0 })
  recordSkillRead(env.db, env.files, env.files.principal('alice'), 'skill-one', skill.path)
  expect(env.db.query('SELECT skill_path, source FROM turn_skill_usage').all()).toEqual([{ skill_path: skill.path, source: 'read' }])
})
test('skill totals use actual turn usage within the same half-open report range; shared turns may overlap rows', () => {
  record(); record('skill-two'); record('skill-outside')
  record('skill-one', { path: 'skills/review.md', name: 'Review' })
  const r = report()
  expect(r.rows).toEqual([
    { key: skill.path, label: skill.name, turns: 2, inputTokens: 30, outputTokens: 10, costUsd: 0.5 },
    { key: 'skills/review.md', label: 'Review', turns: 1, inputTokens: 10, outputTokens: 3, costUsd: 0.2 },
  ])
  expect(r.totals).toEqual({ turns: 2, inputTokens: 30, outputTokens: 10, costUsd: 0.5 })
  expect(usage(env.db, { groupBy: 'user', from, to }).totals).toEqual(r.totals)
  expect(usage(env.db, { groupBy: 'model', from, to }).totals).toEqual(r.totals)
})
test('deleting a turn removes its skill usage and there is no guessed historical backfill', () => {
  expect(report().rows).toEqual([])
  record()
  env.db.query("DELETE FROM turns WHERE id = 'skill-one'").run()
  expect(env.db.query('SELECT COUNT(*) AS n FROM turn_skill_usage').get()).toEqual({ n: 0 })
  expect(report().rows).toEqual([])
})

test('standard 64-character name is recorded for command and manifest read as the same path', () => {
  const name = 's'.repeat(64), rel = `skills/${name}/SKILL.md`
  fs.mkdirSync(path.dirname(path.join(env.fx.team, rel)), { recursive: true })
  fs.writeFileSync(path.join(env.fx.team, rel), `---\nname: ${name}\ndescription: >-\n  Synthetic report\n  when requested.\n---\nBody not stored.`)
  record('skill-one', { path: rel, name })
  recordSkillRead(env.db, env.files, env.files.principal('alice'), 'skill-one', rel)
  recordSkillRead(env.db, env.files, env.files.principal('alice'), 'skill-two', rel)
  expect(env.db.query('SELECT skill_path, skill_name, source FROM turn_skill_usage ORDER BY turn_id').all()).toEqual([
    { skill_path: rel, skill_name: name, source: 'command' }, { skill_path: rel, skill_name: name, source: 'read' },
  ])
})

test('resource reads, invalid manifests, links, traversal and oversized files do not count as skills', () => {
  const base = path.join(env.fx.team, 'skills/usage-folder')
  fs.mkdirSync(path.join(base, 'references'), { recursive: true })
  fs.writeFileSync(path.join(base, 'SKILL.md'), '---\nname: usage-folder\ndescription: Synthetic\n---\nBody')
  fs.writeFileSync(path.join(base, 'references/guide.md'), '---\nname: Accidental reference\n---\nBody')
  fs.writeFileSync(path.join(base, 'bad.md'), '---\nname: Resource\n---\nBody')
  fs.mkdirSync(path.join(env.fx.team, 'skills/invalid-manifest'), { recursive: true })
  fs.writeFileSync(path.join(env.fx.team, 'skills/invalid-manifest/SKILL.md'), '---\nname: wrong-name\ndescription: d\n---\nBody')
  fs.writeFileSync(path.join(base, 'oversize.md'), '---\nname: Big\n---\n' + 'x'.repeat(140 * 1024))
  fs.linkSync(path.join(env.fx.team, skill.path), path.join(base, 'hard.md'))
  fs.symlinkSync(path.join(env.fx.team, skill.path), path.join(base, 'linked.md'))
  for (const rel of ['skills/usage-folder/references/guide.md', 'skills/usage-folder/bad.md', 'skills/invalid-manifest/SKILL.md',
    'skills/usage-folder/oversize.md', 'skills/usage-folder/hard.md', 'skills/usage-folder/linked.md', 'skills/usage-folder/../report.md']) {
    recordSkillRead(env.db, env.files, env.files.principal('alice'), 'skill-one', rel)
  }
  expect(env.db.query('SELECT COUNT(*) AS n FROM turn_skill_usage').get()).toEqual({ n: 0 })
  fs.rmSync(path.join(base, 'hard.md'))
})
