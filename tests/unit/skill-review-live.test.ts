// The Team skills count follows another reviewer's action at once (QA TC-4004): when a suggestion is registered or
// turned down, the people who could review it get one quiet event (notice `skills_changed`, no text: no banner, no
// inbox entry, no push), so their open windows read the count again. The suggester keeps their one result notice;
// a person who reviews nothing gets nothing.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { setFolderAccessAt } from '../lib/folder-access'
import { notificationsOf } from '../../server/src/notifications/service'
import { approveSuggestion, contributeSkills, createSuggestion, rejectSuggestion, skillsOverview } from '../../server/src/skills/suggestions'
import { SKILLS_CHANGED } from '../../server/src/skills/review-live'

let h: Harness
afterEach(async () => { await h?.close() })

async function setup() {
  h = await harness('skill-review-live')
  const owner = await withOwner(h)
  const ada = (await addMember(h, owner, { username: 'ada', role: 'admin' })).id
  const max = (await addMember(h, owner, { username: 'max' })).id // a member who manages skills/
  const mia = (await addMember(h, owner, { username: 'mia' })).id // suggests
  const nora = (await addMember(h, owner, { username: 'nora' })).id // reviews nothing
  const olga = (h.ctx.db.query("SELECT id FROM users WHERE username='olga'").get() as { id: string }).id
  const root = h.ctx.files.fx.root
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true })
  setFolderAccessAt(h.ctx.db, 'skills', [{ subjectType: 'everyone', subjectId: null, access: 'read' }, { subjectType: 'user', subjectId: max, access: 'write' }], olga)
  for (const id of [mia, max]) {
    fs.mkdirSync(path.join(root, 'users', id), { recursive: true })
    fs.writeFileSync(path.join(root, 'users', id, 'reply.md'), '1. Read the notes.\n')
  }
  const suggest = (by: string, name: string) => createSuggestion(h.ctx, by, { source: { kind: 'file', path: `users/${by}/reply.md` }, targetFolder: 'skills', name, description: 'Replies to a customer', content: '1. Read the notes.\n' }, 'en')
  return { olga, ada, max, mia, nora, suggest }
}
const codes = (who: string) => h.hub.events.filter((e) => e.kind === 'publish' && e.target === who).map((e) => (e.data as { data?: { code?: string } }).data?.code)
const quiet = (who: string) => codes(who).filter((c) => c === 'skills_changed').length
const waiting = (who: string) => skillsOverview(h.ctx, who).pendingReview

test('turned down by one reviewer: the others who review the folder are told once, quietly; the suggester once by their own notice; nobody else', async () => {
  const { olga, ada, max, mia, nora, suggest } = await setup()
  const s = suggest(mia, 'reply')
  for (const id of [olga, ada, max]) expect(waiting(id)).toBe(1)
  // the new suggestion: every reviewer heard of it by the notice that exists (the web reads the count on any skill_*)
  for (const id of [olga, ada, max]) expect(codes(id)).toContain('skill_suggested')
  h.hub.events.length = 0
  const inbox = () => [olga, ada, max, nora].map((id) => notificationsOf(h.ctx).list(id, {}).items.length)
  const inboxBefore = inbox()

  rejectSuggestion(h.ctx, olga, s.id, undefined, 'en')
  // the other reviewers, and the reviewer's own other windows
  for (const id of [ada, max, olga]) {
    expect(quiet(id)).toBe(1)
    expect(waiting(id)).toBe(0)
  }
  // exactly the quiet event: no text, no link (nothing to show)
  expect(h.hub.events.find((e) => e.target === ada)!.data).toEqual(SKILLS_CHANGED)
  expect(SKILLS_CHANGED).toEqual({ type: 'notice', data: { level: 'info', code: 'skills_changed', message: '' } })
  // the suggester: the result notice, once, and not the quiet one on top
  expect(codes(mia).filter((c) => c === 'skill_suggestion_reviewed')).toHaveLength(1)
  expect(quiet(mia)).toBe(0)
  // a person who reviews nothing
  expect(codes(nora)).toEqual([])
  // no inbox entry for the people who were only told to read again
  expect(inbox()).toEqual(inboxBefore)
})

test('registered: the same people are told', async () => {
  const { olga, ada, max, mia, nora, suggest } = await setup()
  const s = suggest(mia, 'reply')
  h.hub.events.length = 0
  approveSuggestion(h.ctx, max, s.id, { targetFolder: 'skills', name: 'reply', description: 'Replies to a customer', content: '1. Read the notes.\n' }, 'en')
  for (const id of [olga, ada, max]) expect(quiet(id)).toBe(1)
  expect(codes(mia).filter((c) => c === 'skill_suggestion_reviewed')).toHaveLength(1)
  expect(quiet(mia)).toBe(0)
  expect(codes(nora)).toEqual([])
})

test('a suggester who reviews the folder: told quietly of their own suggestion, and of another reviewer\'s answer by the result notice only', async () => {
  const { olga, ada, max, suggest } = await setup()
  const s = suggest(max, 'mine')
  // their own suggestion counts for them: their other windows follow, without a banner about their own doing
  expect(codes(max)).toEqual(['skills_changed'])
  expect(waiting(max)).toBe(1)
  h.hub.events.length = 0
  rejectSuggestion(h.ctx, ada, s.id, undefined, 'en')
  expect(codes(max).filter((c) => c === 'skill_suggestion_reviewed')).toHaveLength(1)
  expect(quiet(max)).toBe(0)
  expect(quiet(olga)).toBe(1)
  expect(quiet(ada)).toBe(1)
  // they turn down their own: no result notice to themselves, the quiet one for their other windows
  const own = suggest(max, 'mine-2')
  h.hub.events.length = 0
  rejectSuggestion(h.ctx, max, own.id, undefined, 'en')
  expect(codes(max)).toEqual(['skills_changed'])
})

test('a skill folder from a member\'s computer: only the owner and admins review it, so only they are told', async () => {
  const { olga, ada, max, mia, nora } = await setup()
  const out = contributeSkills(h.ctx, mia, { skills: [{ name: 'weekly', origin: 'user', files: [{ path: 'SKILL.md', text: '---\nname: weekly\ndescription: weekly skill\n---\n# x\n1. Read the notes.\n' }] }] } as never, 'en')
  expect(out.items).toHaveLength(1)
  expect(waiting(max)).toBe(0)
  h.hub.events.length = 0
  rejectSuggestion(h.ctx, ada, out.items[0]!.id, undefined, 'en')
  expect(quiet(olga)).toBe(1)
  expect(quiet(ada)).toBe(1)
  expect(codes(max)).toEqual([])
  expect(codes(nora)).toEqual([])
  expect(quiet(mia)).toBe(0)
})
