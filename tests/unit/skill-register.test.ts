// Review finding on R2-SKILL-04: a registered suggestion is saved only in a form that the skill reader loads. A value
// with a quote or bracket that does not close still makes a working skill, and a file that would not load is refused.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { checkSkill } from '../../server/src/chat/skills'
import { approveSuggestion, createSuggestion } from '../../server/src/skills/suggestions'

let h: Harness
afterEach(async () => { await h?.close() })

async function setup() {
  h = await harness('skill-register')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const root = h.ctx.files.fx.root
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(root, 'users', mia.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'users', mia.id, 'reply.md'), 'Steps')
  const suggest = (name: string) => createSuggestion(h.ctx, mia.id, { source: { kind: 'file', path: `users/${mia.id}/reply.md` }, targetFolder: 'skills', name, description: 'd', content: 'Steps' }, 'en')
  return { root, ada: ada.id, suggest }
}

test('a registered suggestion with an open quote or bracket in its values loads as a skill', async () => {
  const { root, ada, suggest } = await setup()
  for (const [name, description] of [['[팀 보고', "'til month end, summarize sales"], ['초안', '"Draft mode'], ['고객', '{고객명 placeholder']]) {
    const s = suggest(name!)
    const done = approveSuggestion(h.ctx, ada, s.id, { targetFolder: 'skills', name: name!, description: description!, content: 'Steps\n' }, 'en')
    expect(done.status).toBe('approved')
    const text = fs.readFileSync(path.join(root, done.resultPath!), 'utf8')
    expect(checkSkill(text, done.resultPath!)).toEqual({ ok: true, name: name!, description: description!, body: 'Steps\n' })
  }
})

test('a registered suggestion that would not load is refused and nothing is saved', async () => {
  const { root, ada, suggest } = await setup()
  const s = suggest('manifest')
  // fileName "SKILL" makes skills/SKILL.md: a manifest must be in its own folder, so it would never load
  let err: any
  try { approveSuggestion(h.ctx, ada, s.id, { targetFolder: 'skills', name: 'manifest', description: 'd', content: 'Steps', fileName: 'SKILL' }, 'en') } catch (e) { err = e }
  expect(err?.code).toBe('validation')
  expect(err?.message).toContain('would not load')
  expect(err?.extra).toEqual({ fields: { 'body.fileName': 'location' } })
  expect(fs.existsSync(path.join(root, 'skills/SKILL.md'))).toBe(false)
  expect((h.ctx.db.query('SELECT status FROM skill_suggestions WHERE id = ?').get(s.id) as { status: string }).status).toBe('pending')
})
