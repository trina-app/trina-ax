// One room for the whole team (docs/DECISIONS.md "One room for the whole team", owner 2026-11-11): the welcome steps'
// team group gets no team room (the everyone room is the team's one room); a team that has one from before keeps it
// only when somebody wrote in it, else it is archived (never deleted). Other groups still get their rooms.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { setupWelcomeTeam, WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { roomsOf } from '../../server/src/rooms/service'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

const kinds = async (c: Client) => ((await c.call('GET', '/api/rooms')).items as { kind: string }[]).map((r) => r.kind).sort()
const teamRoomOf = (groupId: string) => h.ctx.db.query("SELECT id, archived_at FROM rooms WHERE kind = 'team' AND group_id = ?").get(groupId) as { id: string; archived_at: string | null } | null

/** A team from before this rule: its welcome team group was made by hand with a live room, then recorded in the row. */
async function olderTeam(written = false) {
  h = await harness('b-rooms-one-room')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'Acme', memberIds: ['olga', mia.id] })
  const room = teamRoomOf(group.id)!
  expect(room.archived_at).toBeNull()
  expect(await kinds(mia.client)).toEqual(['all', 'team'])
  if (written) await mia.client.call('POST', `/api/rooms/${room.id}/messages`, { body: 'hello team', clientMessageId: 'cm-hello-team' })
  h.ctx.db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(WELCOME_SETTING, JSON.stringify({ teamGroup: { id: group.id, name: 'Acme', folder: 'groups/Acme', notesFolder: 'shared/회의록', home: 'shared' } }))
  return { owner, mia, group, room }
}

test('a new team: the welcome team group gets no room, only the everyone room; other groups still get theirs', async () => {
  h = await harness('b-rooms-one-room')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const teamGroup = setupWelcomeTeam(h.ctx, 'olga', 'ko').progress.teamGroup!
  // the joiners are put in the group (team link, lead invite): still one room
  await owner.call('PATCH', `/api/admin/groups/${teamGroup.id}`, { memberIds: ['olga', mia.id] })
  roomsOf(h.ctx).sync()
  expect(await kinds(owner)).toEqual(['all'])
  expect(await kinds(mia.client)).toEqual(['all'])
  // its row is written archived with the group, with nobody in it: sync never makes a live one
  const row = teamRoomOf(teamGroup.id)!
  expect(row.archived_at).not.toBeNull()
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_members WHERE room_id = ?').get(row.id)).toEqual({ n: 0 })
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'room.create' AND detail LIKE '%\"team\"%'").get()).toEqual({ n: 0 })
  // the group itself is kept (the team link and the welcome steps read it)
  expect(h.ctx.db.query('SELECT name FROM groups WHERE id = ?').get(teamGroup.id)).toEqual({ name: teamGroup.name })
  // run again: nothing changes
  expect(setupWelcomeTeam(h.ctx, 'olga', 'ko').progress.teamGroup!.id).toBe(teamGroup.id)
  roomsOf(h.ctx).sync()
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM rooms WHERE kind = 'team' AND group_id = ?").get(teamGroup.id)).toEqual({ n: 1 })
  // any other group gets its room as before
  const design = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id] })
  expect(teamRoomOf(design.id)!.archived_at).toBeNull()
  expect(await kinds(mia.client)).toEqual(['all', 'team'])
  expect(await kinds(owner)).toEqual(['all'])
})

test('an older team: an empty team-group room is archived (kept, nobody in it), once', async () => {
  const { owner, mia, group, room } = await olderTeam()
  roomsOf(h.ctx).sync()
  const after = teamRoomOf(group.id)!
  expect(after.id).toBe(room.id)
  expect(after.archived_at).not.toBeNull()
  expect(await kinds(mia.client)).toEqual(['all'])
  expect(await kinds(owner)).toEqual(['all'])
  expect((await mia.client.try('GET', `/api/rooms/${room.id}`)).status).toBe(404)
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'room.archive' AND target = ?").get(room.id)).toEqual({ n: 1 })
  // again: nothing new
  roomsOf(h.ctx).sync()
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'room.archive' AND target = ?").get(room.id)).toEqual({ n: 1 })
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM rooms WHERE kind = 'team'").get()).toEqual({ n: 1 })
})

test('an older team: a team-group room somebody wrote in is left alone', async () => {
  const { owner, mia, group, room } = await olderTeam(true)
  roomsOf(h.ctx).sync()
  roomsOf(h.ctx).sync()
  expect(teamRoomOf(group.id)!.archived_at).toBeNull()
  expect(await kinds(mia.client)).toEqual(['all', 'team'])
  expect(await kinds(owner)).toEqual(['all', 'team'])
  expect((await mia.client.call('GET', `/api/rooms/${room.id}/messages`)).items.map((m: { body: string }) => m.body)).toEqual(['hello team'])
})
