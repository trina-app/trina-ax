// A guest accepts an invite to a project while its page is open (chat/project-joins.ts PROJECT_PEOPLE_CHANGED): the
// project's people get the quiet notice that names the project, so its member list and "Includes 1 guest" are read
// again (web pages/Projects.tsx). Nobody outside the project gets it.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { PROJECT_PEOPLE_CHANGED } from '../../server/src/chat/project-joins'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, teamProject } from './guest-lib'

setDefaultTimeout(90_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('a guest joins a project: its people are told (with its id), a member outside it is not', async () => {
  h = await harness('a-guests-project-people-live')
  const owner = await withOwner(h)
  const ownerId = (await owner.call('GET', '/api/me')).user.id as string
  const pia = await addMember(h, owner, { username: 'pia' })
  const p = await teamProject(owner, 'Acme bid')
  const told: { to: string; message: string }[] = []
  // every window open: publishEach is asked for each person (the hub asks only for people with a window)
  const everyone = () => (h.ctx.db.query('SELECT id FROM users').all() as { id: string }[]).map((r) => r.id)
  const rt = h.ctx.services.realtime
  rt.publishEach = (build) => {
    for (const to of everyone()) {
      const ev = build(to)
      if (ev && ev.type === 'notice' && ev.data.code === PROJECT_PEOPLE_CHANGED) told.push({ to, message: ev.data.message })
    }
  }
  const gus = await addGuest(h, owner, { username: 'gus', place: { kind: 'project', id: p.id } })
  expect(told.filter((x) => x.to === ownerId).map((x) => x.message)).toContain(p.id)
  expect(told.some((x) => x.to === gus.id)).toBe(true)
  expect(told.some((x) => x.to === pia.id)).toBe(false)
})
