// Connections and shared Drives stay off for guests (docs/DECISIONS.md "Guests: only what they were invited to"; owner
// decision 2026-11-14): a team connection or a shared Drive whose rule is "everyone" (or names the guest) is usable by a
// member and never by a guest (integrations/connections/store.ts mayUse, integrations/google-drive/shares.ts
// shareCovers). The guest's turn gets no connection tools at all (tests/unit/b-guests-turn.test.ts). Real guest.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { mayUse } from '../../server/src/integrations/connections/store'
import { shareCovers } from '../../server/src/integrations/google-drive/shares'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

async function setup() {
  h = await harness('a-guests-connectors')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const room = await groupChat(owner, [mia.id, nora.id])
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  // the rule rows alone (the connection and share rows are not what is under test)
  h.ctx.db.exec('PRAGMA foreign_keys = OFF')
  try {
    for (const [t, s] of [['everyone', ''], ['user', g.id]] as const) {
      h.ctx.db.query('INSERT INTO integration_access (integration_id, subject_type, subject_id) VALUES (?, ?, ?)').run('int-1', t, s)
      h.ctx.db.query('INSERT INTO drive_team_share_access (share_id, subject_type, subject_id) VALUES (?, ?, ?)').run('share-1', t, s)
    }
  } finally { h.ctx.db.exec('PRAGMA foreign_keys = ON') }
  return { mia, g }
}

test('a team connection for everyone (and naming the guest): a member may use it, the guest never', async () => {
  const { mia, g } = await setup()
  const row = { id: 'int-1', scope: 'team', google_app: null, owner_user_id: null, template_id: null } as never
  expect(mayUse(h.ctx.db, row, mia.id)).toBe(true)
  expect(mayUse(h.ctx.db, row, g.id)).toBe(false)
  // nor a personal connection of their own
  expect(mayUse(h.ctx.db, { id: 'int-2', scope: 'personal', google_app: null, owner_user_id: g.id, template_id: null } as never, g.id)).toBe(false)
})

test('a Drive shared with everyone (and naming the guest): a member is covered, the guest never', async () => {
  const { mia, g } = await setup()
  expect(shareCovers(h.ctx.db, 'share-1', mia.id)).toBe(true)
  expect(shareCovers(h.ctx.db, 'share-1', g.id)).toBe(false)
})

test('connection and Drive endpoints are closed to the guest, open to the member', async () => {
  const { mia, g } = await setup()
  for (const p of ['/api/integrations', '/api/integrations/google-drive', '/api/integration-templates', '/api/connectors/remote']) {
    expect((await g.client.try('GET', p)).status).toBe(403)
    expect((await mia.client.try('GET', p)).status).not.toBe(403)
  }
})
