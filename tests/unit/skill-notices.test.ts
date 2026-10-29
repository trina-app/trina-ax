// R2-SKILL-12: skill suggestion notices are stored in the inbox (table skill_notices), so a manager who was offline
// sees them later. Metadata only, own user only, preferences apply, and one inbox over both tables.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { notificationsOf } from '../../server/src/notifications/service'
import { createSuggestion, rejectSuggestion } from '../../server/src/skills/suggestions'

let h: Harness
afterEach(async () => { await h?.close() })

async function setup() {
  h = await harness('skill-notices')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE username='olga'").get() as { id: string }).id
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(h.ctx.files.fx.root, 'users', mia.id), { recursive: true })
  fs.writeFileSync(path.join(h.ctx.files.fx.root, 'users', mia.id, 'reply.md'), 'SECRET CONTENT MUST NOT COPY')
  const suggest = (name: string) => createSuggestion(h.ctx, mia.id, { source: { kind: 'file', path: `users/${mia.id}/reply.md` }, targetFolder: 'skills', name, description: 'PRIVATE DESCRIPTION', content: 'SECRET CONTENT MUST NOT COPY' }, 'en')
  return { n: notificationsOf(h.ctx), ownerId, ada: ada.id, mia: mia.id, nora: nora.id, suggest }
}

test('a suggestion is stored for every manager, with a skills link and no content', async () => {
  const { n, ownerId, ada, mia, nora, suggest } = await setup()
  const s = suggest('QA-공용')
  for (const id of [ownerId, ada]) {
    const page = n.list(id, {})
    expect(page.unreadCount).toBe(1)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ eventType: 'skill.suggested', code: 'skill.suggested', sourceId: s.id, link: 'skills', chatId: null, outcome: null })
    expect(JSON.stringify(page)).not.toMatch(/QA-공용|PRIVATE DESCRIPTION|SECRET CONTENT/)
  }
  // the suggester and a person who does not manage skills/ get nothing
  expect(n.list(mia, {}).items).toHaveLength(0)
  expect(n.list(nora, {}).items).toHaveLength(0)
  // own user only: another person cannot get or read it
  const id = n.list(ada, {}).items[0]!.id
  expect(() => n.get(nora, id)).toThrow()
  expect(() => n.read(nora, id)).toThrow()
  expect(n.get(ada, id).readAt).toBeNull()
  expect(n.read(ada, id).readAt).toBeTruthy()
  expect(n.list(ada, {}).unreadCount).toBe(0)
  expect(n.list(ownerId, {}).unreadCount).toBe(1)
})

test('the review result goes to the suggester; the preference turns skill notices off', async () => {
  const { n, ownerId, ada, mia, suggest } = await setup()
  n.setPreferences(ada, { skillSuggestions: false })
  expect(n.preferences(ada).skillSuggestions).toBe(false)
  const s = suggest('첫 제안')
  expect(n.list(ada, {}).items).toHaveLength(0)
  n.setPreferences(ada, { skillSuggestions: true })
  expect(n.list(ada, {}).items).toHaveLength(0)
  rejectSuggestion(h.ctx, ownerId, s.id, 'not now', 'en')
  const mine = n.list(mia, {})
  expect(mine.items).toHaveLength(1)
  expect(mine.items[0]).toMatchObject({ eventType: 'skill.reviewed', sourceId: s.id, link: 'skills' })
  expect(JSON.stringify(mine)).not.toContain('not now')
})

test('skill notices and other notices list as one inbox, newest first, without duplicates across pages', async () => {
  const { n, ownerId, suggest } = await setup()
  const t0 = Date.now()
  n.connectionReconnect(ownerId, 'episode-old', new Date(t0 - 3000).toISOString())
  suggest('A')
  n.connectionReconnect(ownerId, 'episode-new', new Date(t0 + 3000).toISOString())
  const all = n.list(ownerId, {})
  expect(all.items.map(i => i.eventType)).toEqual(['connection.reconnect', 'skill.suggested', 'connection.reconnect'])
  expect(all.unreadCount).toBe(3)
  const seen: string[] = []
  let cursor: string | undefined
  do {
    const page = n.list(ownerId, { limit: 1, cursor })
    seen.push(...page.items.map(i => i.id))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(seen).toEqual(all.items.map(i => i.id))
  // retention also covers skill notices
  h.ctx.db.query("UPDATE skill_notices SET created_at=?").run(new Date(t0 - 31 * 86400_000).toISOString())
  n.reconcile()
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM skill_notices').get() as { n: number }).n).toBe(0)
})
