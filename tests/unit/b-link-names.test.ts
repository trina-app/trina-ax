// Named app links (docs/decisions/20261118-named-app-links.md, server/src/link-names/resolve.ts): POST /api/link-names
// names a link only for a caller who could open the thing now, with its page's own check; no access, not there and a
// malformed id all answer `name: null` alike. Chats, projects, rooms, file links (live, stopped, trashed, a guest),
// folders and files, a guest's own narrower access, dedupe, the batch cap, plain one-line names.
// Fixture: olga = owner; mia, nora = design; otto; a guest of mia's project.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { LINK_NAME_MAX, LINK_NAMES_MAX } from '@mycel/shared/api'
import { cleanName } from '../../server/src/link-names/resolve'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

let h: Harness
let owner: Client, mia: Client, nora: Client, otto: Client, guest: Client
let ids: Record<'mia' | 'nora' | 'otto', string>
let design: string
/** an id of the right shape that names nothing here */
const NOWHERE = '019a5f00-0000-7000-8000-0000000fffff'
type Ref = { kind: 'chat' | 'project' | 'room' | 'share' | 'folder' | 'file'; id: string }
const names = async (c: Client, links: Ref[]) => (await c.call('POST', '/api/link-names', { links })).items as { kind: string; id: string; name: string | null; folder?: true; room?: any }[]
const one = async (c: Client, l: Ref) => (await names(c, [l]))[0]!
const put = (c: Client, p: string, content = 'x') => c.call('PUT', '/api/files/content', { path: p, content, baseSha256: null })

let miaChat: string, projectId: string, privateChatInProject: string, sharedChatInProject: string
let teamRoom: string, dm: string, group: string

beforeAll(async () => {
  h = await harness('b-link-names')
  owner = await withOwner(h)
  const m = await addMember(h, owner, { username: 'mia' })
  const n = await addMember(h, owner, { username: 'nora' })
  const o = await addMember(h, owner, { username: 'otto' })
  mia = m.client; nora = n.client; otto = o.client
  ids = { mia: m.id, nora: n.id, otto: o.id }
  design = (await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [m.id, n.id] })).id
  miaChat = (await mia.call('POST', '/api/chats', { title: 'Q3 budget notes' })).id
  const p = await mia.call('POST', '/api/projects', { name: 'Launch plan', scope: 'team', participants: [{ subjectType: 'user', subjectId: n.id }] })
  projectId = p.id
  sharedChatInProject = (await mia.call('POST', '/api/chats', { projectId, title: 'Launch checklist' })).id
  privateChatInProject = (await mia.call('POST', '/api/chats', { projectId, title: 'My own draft', private: true })).id
  const rooms = (await mia.call('GET', '/api/rooms')).items as any[]
  teamRoom = rooms.find((r) => r.kind === 'team' && r.groupId === design).id
  dm = (await mia.call('POST', '/api/rooms', { kind: 'dm', userId: n.id })).id
  group = (await mia.call('POST', '/api/rooms', { kind: 'group', userIds: [n.id], name: 'Lunch crew' })).id
  guest = (await addGuest(h, mia, { username: 'gus', place: { kind: 'project', id: projectId } })).client
}, 120_000)
afterAll(() => h.close())

describe('chats', () => {
  test('its creator gets the title; anyone else, a missing id and a malformed id get null alike', async () => {
    expect((await one(mia, { kind: 'chat', id: miaChat })).name).toBe('Q3 budget notes')
    for (const c of [nora, otto, owner, guest]) expect((await one(c, { kind: 'chat', id: miaChat })).name).toBeNull()
    expect(await one(mia, { kind: 'chat', id: NOWHERE })).toEqual({ kind: 'chat', id: NOWHERE, name: null })
    expect(await one(mia, { kind: 'chat', id: 'not-an-id' })).toEqual({ kind: 'chat', id: 'not-an-id', name: null })
  })

  test('a shared project chat: its project\'s members; a private one in the project: its creator only', async () => {
    expect((await one(nora, { kind: 'chat', id: sharedChatInProject })).name).toBe('Launch checklist')
    expect((await one(otto, { kind: 'chat', id: sharedChatInProject })).name).toBeNull()
    expect((await one(nora, { kind: 'chat', id: privateChatInProject })).name).toBeNull()
    // a guest of the project opens no shared chat but their own (chat/shared.ts chatFor)
    expect((await one(guest, { kind: 'chat', id: sharedChatInProject })).name).toBeNull()
  })

  test('a chat in the trash names nothing, even to its creator', async () => {
    const c = (await mia.call('POST', '/api/chats', { title: 'Old idea' })).id
    expect((await one(mia, { kind: 'chat', id: c })).name).toBe('Old idea')
    await mia.call('DELETE', `/api/chats/${c}`)
    expect((await one(mia, { kind: 'chat', id: c })).name).toBeNull()
  })
})

describe('projects', () => {
  test('members (and a guest of it) get the name; the owner who is not a member, others and a missing id get null', async () => {
    for (const c of [mia, nora, guest]) expect((await one(c, { kind: 'project', id: projectId })).name).toBe('Launch plan')
    for (const c of [otto, owner]) expect((await one(c, { kind: 'project', id: projectId })).name).toBeNull()
    expect((await one(mia, { kind: 'project', id: NOWHERE })).name).toBeNull()
  })
})

describe('rooms', () => {
  test('members get how the room is named to them; others get null with no room field', async () => {
    const t = await one(nora, { kind: 'room', id: teamRoom })
    expect(t.name).toBe('design')
    expect(t.room.kind).toBe('team')
    const d = await one(nora, { kind: 'room', id: dm })
    expect(d.room.kind).toBe('dm')
    expect(d.room.peers.map((p: any) => p.id)).toEqual([ids.mia])
    expect((await one(mia, { kind: 'room', id: group })).name).toBe('Lunch crew')
    for (const id of [teamRoom, dm, group]) {
      const x = await one(otto, { kind: 'room', id })
      expect(x).toEqual({ kind: 'room', id, name: null })
    }
    // the owner is no exception for a DM or a group chat she is not in
    expect(await one(owner, { kind: 'room', id: dm })).toEqual({ kind: 'room', id: dm, name: null })
    expect(await one(mia, { kind: 'room', id: NOWHERE })).toEqual({ kind: 'room', id: NOWHERE, name: null })
  })

  test('a guest: not in the team room', async () => {
    expect((await one(guest, { kind: 'room', id: teamRoom })).name).toBeNull()
  })
})

describe('file links (/f/<token>)', () => {
  test('a link that opens for the caller names its file; no access, a guest and an unknown token get null', async () => {
    await put(mia, 'shared/plan-v2.txt')
    const l = await mia.call('POST', '/api/files/link', { path: 'shared/plan-v2.txt' })
    // shared/ is read by every member: it opens for them by the folder rules
    for (const c of [mia, nora, otto]) expect((await one(c, { kind: 'share', id: l.id })).name).toBe('plan-v2.txt')
    // a guest never gets anything through a link (files/shares.ts open)
    expect((await one(guest, { kind: 'share', id: l.id })).name).toBeNull()
    expect((await one(mia, { kind: 'share', id: 'A'.repeat(22) })).name).toBeNull()
    expect((await one(mia, { kind: 'share', id: 'short' })).name).toBeNull()
  })

  test('a file in someone\'s own folder: the people it is shared with; stopped sharing: null again', async () => {
    const own = `users/${ids.mia}/offer.txt`
    await put(mia, own)
    const l = await mia.call('POST', '/api/files/link', { path: own })
    expect((await one(nora, { kind: 'share', id: l.id })).name).toBeNull()
    await mia.call('PUT', '/api/files/shares', { path: own, add: [{ subjectType: 'user', subjectId: ids.nora }], remove: [] })
    expect((await one(nora, { kind: 'share', id: l.id })).name).toBe('offer.txt')
    expect((await one(otto, { kind: 'share', id: l.id })).name).toBeNull()
    await mia.call('PUT', '/api/files/shares', { path: own, add: [], remove: [{ subjectType: 'user', subjectId: ids.nora }] })
    expect((await one(nora, { kind: 'share', id: l.id })).name).toBeNull()
  })

  test('a file in the trash (an expired link): null for others, and it does not open for its owner either', async () => {
    const own = `users/${ids.mia}/gone.txt`
    await put(mia, own)
    const l = await mia.call('POST', '/api/files/link', { path: own })
    await mia.call('PUT', '/api/files/shares', { path: own, add: [{ subjectType: 'user', subjectId: ids.nora }], remove: [] })
    expect((await one(nora, { kind: 'share', id: l.id })).name).toBe('gone.txt')
    await mia.call('DELETE', '/api/files?path=' + encodeURIComponent(own))
    expect((await one(nora, { kind: 'share', id: l.id })).name).toBeNull()
    expect((await one(mia, { kind: 'share', id: l.id })).name).toBeNull()
  })

  test('naming a link does not mark its "shared with you" notice read (only opening its page does)', async () => {
    const own = `users/${ids.mia}/note.txt`
    await put(mia, own)
    const l = await mia.call('POST', '/api/files/link', { path: own })
    await mia.call('PUT', '/api/files/shares', { path: own, add: [{ subjectType: 'user', subjectId: ids.nora }], remove: [] })
    const unread = async () => ((await nora.call('GET', '/api/notifications?limit=50')).items as any[]).filter((x) => String(x.eventType).startsWith('file.') && !x.readAt).length
    const before = await unread()
    expect(before).toBeGreaterThan(0)
    expect((await one(nora, { kind: 'share', id: l.id })).name).toBe('note.txt')
    expect(await unread()).toBe(before)
  })
})

describe('folders and files in Files', () => {
  beforeAll(async () => {
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'secret'), { recursive: true })
    await owner.call('POST', '/api/admin/folders', { path: 'secret', limited: true, rules: [{ subjectType: 'group', subjectId: design, access: 'write' }] })
    await put(mia, 'secret/salaries.csv')
    await put(mia, 'shared/reports/week 1.md')
  })

  test('the name (never the path) for someone who may open it; null for others, missing paths and the wrong kind', async () => {
    expect((await one(nora, { kind: 'folder', id: 'secret' })).name).toBe('secret')
    expect((await one(nora, { kind: 'file', id: 'secret/salaries.csv' })).name).toBe('salaries.csv')
    expect((await one(otto, { kind: 'folder', id: 'secret' })).name).toBeNull()
    expect((await one(otto, { kind: 'file', id: 'secret/salaries.csv' })).name).toBeNull()
    expect((await one(otto, { kind: 'file', id: 'secret/nothing.csv' })).name).toBeNull()
    expect((await one(nora, { kind: 'file', id: 'secret/nothing.csv' })).name).toBeNull()
    expect((await one(otto, { kind: 'file', id: 'shared/reports/week 1.md' })).name).toBe('week 1.md')
    expect((await one(otto, { kind: 'folder', id: 'shared/reports' })).name).toBe('reports')
    // a folder asked as a file, a file as a folder
    expect((await one(otto, { kind: 'file', id: 'shared/reports' })).name).toBeNull()
    expect((await one(otto, { kind: 'folder', id: 'shared/reports/week 1.md' })).name).toBeNull()
    // the team folder itself, a way out of it and someone's own folder
    for (const id of ['/', '../etc/passwd', 'shared/../../x', `users/${ids.mia}/offer.txt`]) expect((await one(otto, { kind: 'file', id })).name).toBeNull()
  })

  test('a guest: their project\'s folder only', async () => {
    const folder = (await mia.call('GET', `/api/projects/${projectId}`)).folderPath as string
    await put(mia, `${folder}/brief.md`)
    expect((await one(guest, { kind: 'file', id: `${folder}/brief.md` })).name).toBe('brief.md')
    expect((await one(guest, { kind: 'file', id: 'shared/reports/week 1.md' })).name).toBeNull()
    expect((await one(guest, { kind: 'folder', id: 'shared' })).name).toBeNull()
  })
})

describe('the batch', () => {
  test('one answer per distinct link, in the order asked; more than the cap is refused', async () => {
    const r = await names(mia, [{ kind: 'chat', id: miaChat }, { kind: 'project', id: projectId }, { kind: 'chat', id: miaChat }, { kind: 'room', id: NOWHERE }])
    expect(r.map((x) => [x.kind, x.name])).toEqual([['chat', 'Q3 budget notes'], ['project', 'Launch plan'], ['room', null]])
    const many = Array.from({ length: LINK_NAMES_MAX + 1 }, (_, i) => ({ kind: 'chat' as const, id: `x${i}` }))
    expect((await mia.try('POST', '/api/link-names', { links: many })).status).toBe(400)
    expect((await mia.try('POST', '/api/link-names', { links: [] })).status).toBe(400)
  })

  test('signed out: 401', async () => {
    expect((await h.client().try('POST', '/api/link-names', { links: [{ kind: 'chat', id: miaChat }] })).status).toBe(401)
  })

  test('names are one plain line, cut at LINK_NAME_MAX', async () => {
    expect(cleanName('a\nb\u202Ec\u200Fd\te')).toBe('a b c d e')
    const long = cleanName('x'.repeat(500))
    expect(long.length).toBe(LINK_NAME_MAX + 1)
    expect(long.endsWith('…')).toBe(true)
    // never half an emoji at the cut
    expect(cleanName('x'.repeat(LINK_NAME_MAX - 1) + '😀😀').endsWith('\ud83d…')).toBe(false)
  })
})
