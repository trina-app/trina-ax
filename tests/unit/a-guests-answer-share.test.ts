// "Send to the room" and sharing a project chat check who could not see what the answer used (chat/answer-share.ts,
// part B). A guest counts as someone who cannot see (docs/DECISIONS.md "Guests: only what they were invited to"): the
// team's files by the folder policy, and skills/ material too, which the check otherwise leaves out as something every
// member reads (withSkillReads). With members only, a skill read stays left out as before. Real guest.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { provenanceChecker, withSkillReads, type BranchUse } from '../../server/src/chat/answer-share'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('a skill the answer read: left out for members, counted as unseen for the guest; a shared team file the same', async () => {
  h = await harness('a-guests-answer-share')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const room = await groupChat(owner, [mia.id, nora.id])
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const root = h.ctx.config.teamRoot
  const write = (rel: string, text: string) => { fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); return crypto.createHash('sha256').update(text).digest('hex') }
  const skillSha = write('skills/quote/SKILL.md', '# Quote\nHow we price.')
  const fileSha = write('shared/prices.txt', 'internal prices')
  // what one answer read (its source list), without a chat around it
  h.ctx.db.exec('PRAGMA foreign_keys = OFF')
  try {
    h.ctx.db.query("INSERT INTO message_sources (message_id, ord, path, sha256, via) VALUES ('m-1', 0, 'skills/quote/SKILL.md', ?, 'read')").run(skillSha)
    h.ctx.db.query("INSERT INTO message_sources (message_id, ord, path, sha256, via) VALUES ('m-2', 0, 'shared/prices.txt', ?, 'read')").run(fileSha)
  } finally { h.ctx.db.exec('PRAGMA foreign_keys = ON') }
  const useOf = (id: string, files: BranchUse['files']): BranchUse => ({ answers: [id], files, other: [], known: true, roomsUnseen: false })
  const missing = async (use: BranchUse, audience: string[]) => [...(await provenanceChecker(h.ctx, mia.id, audience, use.answers).of([withSkillReads(h.ctx.db, use, audience)], new Set())).missing].sort()

  // the skill: members only -> nothing added, nobody misses it; with the guest -> the guest misses it
  const skill = useOf('m-1', [])
  expect(withSkillReads(h.ctx.db, skill, [nora.id])).toBe(skill)
  expect(await missing(skill, [nora.id])).toEqual([])
  expect(await missing(skill, [nora.id, g.id])).toEqual([g.id])
  // a team file every member reads (shared/): the guest misses it, members do not
  const file = useOf('m-2', [{ path: 'shared/prices.txt', sha256: fileSha }])
  expect(await missing(file, [nora.id])).toEqual([])
  expect(await missing(file, [nora.id, g.id])).toEqual([g.id])
})

test('the team rules and company profile every prompt carries count as "can\'t see" for a guest audience', async () => {
  const { withSkillReads } = await import('../../server/src/chat/answer-share')
  const { addMember: add, harness: mk, withOwner: own } = await import('./a-lib')
  const { addGuest: guest, groupChat: chat } = await import('./guest-lib')
  const hh = await mk('a-guests-answer-share-prompt')
  try {
    const owner = await own(hh)
    const mia = await add(hh, owner, { username: 'mia' }), nora = await add(hh, owner, { username: 'nora' }), otto = await add(hh, owner, { username: 'otto' })
    const room = await chat(mia.client, [nora.id, otto.id])
    const g = await guest(hh, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
    const use = { answers: ['a1'], files: [], other: [], known: true, roomsUnseen: false }
    const carried = ['skills/pricing.md', 'skills/company-profile.json']
    // a guest among the audience: the carried instruction files are counted (no hash: never matched as a copy)
    expect(withSkillReads(hh.ctx.db, use, [nora.id, g.id], carried).files.map((f) => f.path)).toEqual(carried)
    // members only: nothing added (every member reads skills/)
    expect(withSkillReads(hh.ctx.db, use, [nora.id, otto.id], carried).files).toEqual([])
  } finally { await hh.close() }
})

test("a project channel's linked folder: left out while every member opens it, counted for a guest who cannot (QA, send to room)", async () => {
  h = await harness('a-guests-answer-share-project')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const project = await mia.client.call('POST', '/api/projects', { name: 'Lumanesis', participants: [{ subjectType: 'user', subjectId: nora.id }] })
  const folder = (h.ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(project.id) as { folder_path: string }).folder_path
  const room = await groupChat(mia.client, [nora.id], 'Lumanesis talk')
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const rel = `${folder}/warranty.md`
  fs.mkdirSync(path.join(h.ctx.config.teamRoot, folder), { recursive: true })
  fs.writeFileSync(path.join(h.ctx.config.teamRoot, rel), 'warranty: 3 years')
  const use: BranchUse = { answers: ['m-p'], files: [{ path: rel, sha256: null }], other: [], known: true, roomsUnseen: false }
  const missing = async (audience: string[]) => [...(await provenanceChecker(h.ctx, mia.id, audience, use.answers).of([use], new Set())).missing].sort()
  // nora is in the project: nothing is at stake; the guest, invited to the channel only, cannot open the folder
  expect(await missing([nora.id])).toEqual([])
  expect(await missing([nora.id, g.id])).toEqual([g.id])
})
