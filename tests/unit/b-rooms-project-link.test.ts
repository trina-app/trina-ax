// What is left of 0.5.21's private channel linked to a project (docs/decisions/20261119-channel-project-link.md, retired
// by docs/decisions/20261120-project-is-room.md): its four endpoints answer 410 gone for everyone, before any check and
// naming nothing, and change nothing; Room.canLinkProject, Project.channel and Project.canLinkChannel are never sent;
// the old project_linked / project_unlinked lines still render (the project's name only to a viewer who can open it);
// a 'linked' row of a channel archived before the start pass goes with it, audited by the project only.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

const user = (id: string) => ({ subjectType: 'user', subjectId: id })

async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const launch = await mia.client.call('POST', '/api/projects', { name: 'Launch site', participants: [user(nora.id)] })
  const channel = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id], name: 'Launch talk' })
  return { owner, ada, mia, nora, otto, launch, channel }
}
const linkRows = () => (h.ctx.db.query('SELECT COUNT(*) n FROM room_project_links').get() as { n: number }).n

test('the retired endpoints: 410 gone for everyone, naming nothing, changing nothing', async () => {
  const { owner, ada, mia, nora, otto, launch, channel } = await setup('b-rooms-project-link-gone')
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'project', id: launch.id } })
  const calls: [string, string, unknown][] = [
    ['PUT', `/api/rooms/${channel.id}/project`, { projectId: launch.id }],
    ['DELETE', `/api/rooms/${channel.id}/project`, undefined],
    ['POST', `/api/projects/${launch.id}/channel`, { name: 'Plan talk', userIds: [nora.id] }],
    ['POST', `/api/rooms/${channel.id}/save-undo`, { token: 'never-given-token-0000000000' }],
  ]
  for (const c of [mia.client, nora.client, otto.client, ada.client, owner, g.client] as Client[]) {
    for (const [m, p, body] of calls) {
      const r = await c.try(m, p, body)
      // a guest reaches none of them at all (403 before the handler, as before); everyone else: 410
      const want = c === g.client ? [403] : [410]
      expect(`${m} ${p} ${want.includes(r.status)}`).toBe(`${m} ${p} true`)
      if (r.status === 410) expect(r.body.error?.code).toBe('gone')
      const text = JSON.stringify(r.body)
      for (const secret of ['Launch', channel.id, launch.id]) expect(text).not.toContain(secret)
    }
  }
  expect(linkRows()).toBe(0)
  // and the fields that went with them are never sent
  for (const c of [mia, nora, otto]) expect((await c.client.call('GET', `/api/rooms/${channel.id}`)).canLinkProject).toBeUndefined()
  const pj = await mia.client.call('GET', `/api/projects/${launch.id}`)
  expect(pj.channel).toBeUndefined()
  expect(pj.canLinkChannel).toBeUndefined()
})

test('old project_linked / project_unlinked lines still render: the name for who can open the project, else none', async () => {
  const { mia, otto, launch, channel } = await setup('b-rooms-project-link-old-lines')
  const add = h.ctx.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, event)
    VALUES (?, ?, (SELECT last_seq + 1 FROM rooms WHERE id = ?), 'user', ?, 'room', '', '[]', ?, ?)`)
  for (const type of ['project_linked', 'project_unlinked']) {
    add.run(uuidv7(), channel.id, channel.id, mia.id, new Date().toISOString(), JSON.stringify({ type, projectId: launch.id }))
    h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ?').run(channel.id)
  }
  const lines = async (c: Client) => ((await c.call('GET', `/api/rooms/${channel.id}/messages`)).items as any[]).filter((m) => m.event?.type?.startsWith('project_')).map((m) => m.event)
  expect(await lines(mia.client)).toEqual([
    { type: 'project_linked', project: { id: launch.id, name: 'Launch site' } },
    { type: 'project_unlinked', project: { id: launch.id, name: 'Launch site' } },
  ])
  expect(await lines(otto.client)).toEqual([{ type: 'project_linked', project: null }, { type: 'project_unlinked', project: null }])
})

test('a linked row whose channel is archived before the start pass goes with it, audited by the project only', async () => {
  const { mia, nora, otto, launch, channel } = await setup('b-rooms-project-link-archive')
  h.ctx.db.query('INSERT INTO room_project_links (room_id, project_id, linked_by, linked_at) VALUES (?, ?, ?, ?)').run(channel.id, launch.id, mia.id, new Date().toISOString())
  for (const c of [otto, nora, mia]) expect((await c.client.try('POST', `/api/rooms/${channel.id}/leave`)).status).toBe(204)
  expect(linkRows()).toBe(0)
  const arch = h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'project.channel_unlink' ORDER BY id DESC LIMIT 1").get() as { actor_id: string | null; target: string; detail: string }
  expect([arch.actor_id, arch.target, JSON.parse(arch.detail)]).toEqual([null, launch.id, { room: { kind: 'group' }, via: 'room_archived', replaced: false }])
  expect(JSON.stringify(arch)).not.toContain(channel.id)
})
