import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { newId } from '../../server/src/db'
import { recordSkillUse } from '../../server/src/admin/skill-usage'
import { popularSkills } from '../../server/src/skills/popular'

const e = makeEnv('popular-skills'), now = new Date('2026-10-27T00:00:00.000Z')
afterAll(() => e.db.close())
const put = (name: string) => {
  const rel = `skills/${name}/SKILL.md`, file = path.join(e.fx.team, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: Current description\n---\nPRIVATE_BODY`)
  return { path: rel, name }
}
function use(skill: { path: string; name: string }, userId: string, at = '2026-10-20T00:00:00.000Z') {
  const id = newId()
  e.db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,started_at) VALUES(?,'c',?,'claude-code','done',?)").run(id, userId, at)
  for (let i = 0; i < 3; i++) recordSkillUse(e.db, { turnId: id, userId, skill, source: 'read' })
}
test('ranks actual usage once per turn, deduplicates people, applies half-open dates and uses current metadata', () => {
  const first = put('first'), second = put('second')
  use(first, 'alice'); use(first, 'alice'); use(first, 'bob'); use(second, 'bob')
  use(second, 'bob', '2026-09-01T00:00:00.000Z'); use(second, 'bob', now.toISOString())
  const result = popularSkills(e.db, e.files, e.files.principal('alice'), now)
  expect(result.items.map(({ name, uses, users }) => ({ name, uses, users }))).toEqual([
    { name: 'first', uses: 3, users: 2 }, { name: 'second', uses: 1, users: 1 },
  ])
  expect(JSON.stringify(result)).not.toContain('PRIVATE_BODY')
  expect(JSON.stringify(result)).not.toContain('alice')
})
test('revoked and removed skills disappear immediately, even when their recorded count is highest', () => {
  const skill = put('hidden')
  use(skill, 'bob'); use(skill, 'bob'); use(skill, 'bob'); use(skill, 'bob')
  e.db.query("INSERT INTO folders(id,path) VALUES('popular-hidden','skills/hidden')").run()
  e.db.query("INSERT INTO folder_rules(id,folder_id,subject_type,subject_id,access) VALUES('popular-hidden-rule','popular-hidden','user','alice','none')").run()
  expect(JSON.stringify(popularSkills(e.db, e.files, e.files.principal('alice'), now))).not.toContain('hidden')
  expect(popularSkills(e.db, e.files, e.files.principal('bob'), now).items[0]?.name).toBe('hidden')
  fs.rmSync(path.join(e.fx.team, skill.path))
  expect(JSON.stringify(popularSkills(e.db, e.files, e.files.principal('bob'), now))).not.toContain('hidden')
})
