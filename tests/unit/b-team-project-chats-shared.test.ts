// Team project chats shared by default (docs/DECISIONS.md "Team project chats shared by default", owner 2026-11-13;
// QA TC-946..961). A chat started in a team project is seen and continued by its members unless it starts "Only me"
// (POST /api/chats `private`); a private chat becomes shared only through POST /api/chats/:id/share; the switch is gone
// (PATCH {shareChats:false} 409 share_chats_always); migration 292 sets the stored setting for every team project and
// never touches a chat; the Projects panel counts what the viewer can open, never another person's private chat; a
// member removed while their turn runs in a shared chat has it stopped. Also the owner's report of 2026-11-13 (QA
// TC-919/920, from the unmerged fix/project-chat-share-not-found): a chat brought into a project stays private, and
// its link is the 404 of a missing chat for a member.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiError, uuidv7 } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { legacyProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)
let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-team-project-chats-shared', turnTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
const listIds = async (user: string, projectId: string) => (await h.api(user).call(API.listChats, { query: { projectId } })).items.map((c) => c.id)
const activity = async (user: string, projectId: string) => (await h.api(user).call(API.listChatGroups, {})).projectActivity?.find((a) => a.projectId === projectId)?.count ?? 0
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
async function ask(user: string, chatId: string, content: string) {
  const started = await send(user, chatId, content)
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return started
}
/** a team project made through the API: projects/<name>, bob a member */
const teamProject = (name: string) => h.api('alice').call(API.createProject, { body: { name, scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })

describe('a team project shares its new chats; "Only me" keeps one private', () => {
  test('new chat shared, private chat hidden from members (lists, counts, 404 body as a missing chat)', async () => {
    const p = await teamProject('Launch')
    expect(p.shareChats).toBe(true)
    expect(db().query('SELECT share_chats FROM projects WHERE id = ?').get(p.id)).toEqual({ share_chats: 1 })
    const shared = await h.api('alice').call(API.createChat, { body: { projectId: p.id } })
    expect(shared.shared).toMatchObject({ by: { id: 'alice' }, mine: true })
    const mine = await h.api('alice').call(API.createChat, { body: { projectId: p.id, private: true } })
    expect(mine.shared).toBeUndefined()
    await ask('alice', shared.id, 'shared q\n' + fake({ say: 'shared a' }))
    await ask('alice', mine.id, 'private q\n' + fake({ say: 'private a' }))
    // bob lists and opens the shared one only; the private one is the same 404 as a chat that was never there
    expect(await listIds('bob', p.id)).toEqual([shared.id])
    const hidden = await errOf(h.api('bob').call(API.getChat, { params: { id: mine.id } }))
    const missing = await errOf(h.api('bob').call(API.getChat, { params: { id: uuidv7() } }))
    expect(hidden.status).toBe(404)
    const bare = (e: ApiError) => ({ ...e.body, requestId: undefined })
    expect(bare(hidden)).toEqual(bare(missing))
    expect((await errOf(h.api('bob').call(API.listMessages, { params: { id: mine.id }, query: {} }))).status).toBe(404)
    // search finds nothing of it for bob
    expect((await h.api('bob').call(API.listChats, { query: { q: 'private' } })).items.map((c) => c.id)).not.toContain(mine.id)
    // the Projects panel (QA TC-946/947): bob never wrote there and still sees 1; alice sees both
    expect(await activity('bob', p.id)).toBe(1)
    expect(await activity('alice', p.id)).toBe(2)
    // a private chat never becomes shared on its own: only its creator's share
    expect((await errOf(h.api('bob').call(API.shareChat, { params: { id: mine.id }, body: {} }))).status).toBe(404)
    const r = await h.api('alice').call(API.shareChat, { params: { id: mine.id }, body: {} })
    expect(r.status).toBe('shared')
    expect(await activity('bob', p.id)).toBe(2)
    expect((await h.api('bob').call(API.getChat, { params: { id: mine.id } })).shared).toMatchObject({ by: { id: 'alice' }, mine: false })
  })

  test('the switch is gone: shareChats false is 409 share_chats_always, true changes nothing', async () => {
    const p = await teamProject('Harbor')
    const e = await errOf(h.api('alice').call(API.updateProject, { params: { id: p.id }, body: { shareChats: false } }))
    expect([e.status, e.body.params?.reason]).toEqual([409, 'share_chats_always'])
    expect((await h.api('alice').call(API.updateProject, { params: { id: p.id }, body: { shareChats: true } })).shareChats).toBe(true)
    expect(db().query('SELECT share_chats FROM projects WHERE id = ?').get(p.id)).toEqual({ share_chats: 1 })
    // a personal project: never shared, the lock changes nothing, the old answer for turning it on
    const notes = await h.api('alice').call(API.createProject, { body: { name: 'Notes', scope: 'personal', participants: [], instructions: '' } })
    expect(notes.shareChats).toBe(false)
    expect((await h.api('alice').call(API.createChat, { body: { projectId: notes.id } })).shared).toBeUndefined()
    expect((await h.api('alice').call(API.createChat, { body: { projectId: notes.id, private: true } })).shared).toBeUndefined()
    expect((await errOf(h.api('alice').call(API.updateProject, { params: { id: notes.id }, body: { shareChats: true } }))).body.params?.reason).toBe('project_personal')
  })

  test('safe operations on: new chats in a team project are private', async () => {
    const p = await teamProject('Vault')
    process.env.MYCEL_SAFE_OPS_1A = '1'
    try {
      expect((await h.api('alice').call(API.createChat, { body: { projectId: p.id } })).shared).toBeUndefined()
    } finally { delete process.env.MYCEL_SAFE_OPS_1A }
    expect((await h.api('alice').call(API.createChat, { body: { projectId: p.id } })).shared).toBeDefined()
  })
})

describe('chats from before stay private', () => {
  test('a chat brought into a personal project stays private after the project is shared (TC-919/920); new ones are shared', async () => {
    const alice = h.api('alice')
    const p = await alice.call(API.createProject, { body: { name: 'Harbor2', scope: 'personal', participants: [], instructions: '' } })
    const loose = await alice.call(API.createChat, { body: {} })
    // "Bring in chats": one PATCH per chat; it arrives private
    expect((await alice.call(API.updateChat, { params: { id: loose.id }, body: { projectId: p.id } })).shared).toBeUndefined()
    await alice.call(API.shareProject, { params: { id: p.id }, body: { participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
    const team = await alice.call(API.getProject, { params: { id: p.id } })
    expect([team.folderPath.startsWith('projects/'), team.shareChats]).toEqual([true, true])
    expect(await listIds('bob', p.id)).not.toContain(loose.id)
    expect((await errOf(h.api('bob').call(API.getChat, { params: { id: loose.id } }))).status).toBe(404)
    expect(await listIds('alice', p.id)).toContain(loose.id)
    // a new chat there is shared; the old one is shared only by its creator, one at a time (no setting needed)
    expect((await alice.call(API.createChat, { body: { projectId: p.id } })).shared).toBeDefined()
    expect((await alice.call(API.shareChat, { params: { id: loose.id }, body: {} })).status).toBe('shared')
    expect(await listIds('bob', p.id)).toContain(loose.id)
  })

  test('migration 292: every team project shares its new chats (one audit row each), no chat changes, personal projects stay', async () => {
    // as the update finds them: a team project whose setting was off (a build before this one), a personal one
    const team = (await teamProject('Old team')).id
    db().query('UPDATE projects SET share_chats = 0 WHERE id = ?').run(team)
    const personal = legacyProject(db(), h.team, 'alice', { name: 'Old mine', folderPath: 'users/alice/projects/old-mine' })
    // the column does not decide any more (a team project shares its new chats, review S1); chats from before are private
    expect((await h.api('alice').call(API.getProject, { params: { id: team } })).shareChats).toBe(true)
    const old = await h.api('alice').call(API.createChat, { body: { projectId: team, private: true } })
    expect(old.shared).toBeUndefined()
    // its creator may share one chat there (the setting does not gate it); the other stays private
    const earlier = await h.api('alice').call(API.createChat, { body: { projectId: team, private: true } })
    expect((await h.api('alice').call(API.shareChat, { params: { id: earlier.id }, body: {} })).status).toBe('shared')
    expect(db().query('SELECT share_chats FROM projects WHERE id = ?').get(team)).toEqual({ share_chats: 0 })
    const sql = fs.readFileSync(path.join(import.meta.dir, '../../server/migrations/292_b_team_project_chats_shared.sql'), 'utf8')
    db().exec(sql)
    expect(db().query('SELECT share_chats FROM projects WHERE id = ?').get(team)).toEqual({ share_chats: 1 })
    expect(db().query('SELECT share_chats FROM projects WHERE id = ?').get(personal)).toEqual({ share_chats: 0 })
    expect(db().query("SELECT shared_at FROM chats WHERE id = ?").get(old.id)).toEqual({ shared_at: null })
    const rows = db().query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'project.share_chats' AND actor_id IS NULL AND target IN (?, ?)").all(team, personal)
    expect(rows).toEqual([{ actor_id: null, target: team, detail: '{"on":true,"reason":"default"}' }])
    // once: a second run changes and audits nothing
    db().exec(sql)
    expect(db().query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project.share_chats' AND actor_id IS NULL AND target = ?").get(team)).toEqual({ n: 1 })
    // the next new chat there is shared
    expect((await h.api('alice').call(API.createChat, { body: { projectId: team } })).shared).toBeDefined()
  })
})

describe('every team project shares, whatever the column says (review S1)', () => {
  test('a personal project moved out of users/ by Files shares its new chats, and the column follows (audited)', async () => {
    const mine = await h.api('alice').call(API.createProject, { body: { name: 'Roamer', scope: 'personal', participants: [], instructions: '' } })
    const r = await h.api('alice').call(API.move, { body: { from: mine.folderPath, to: 'shared/roamer', onExists: 'fail', confirm: true } }).then(() => 'moved', (e: ApiError) => e.body.params?.reason ?? e.status)
    // (Files lets it go: the project follows its folder)
    expect(r).toBe('moved')
    const now = await h.api('alice').call(API.getProject, { params: { id: mine.id } })
    expect([now.folderPath, now.shareChats]).toEqual(['shared/roamer', true])
    expect(db().query('SELECT share_chats FROM projects WHERE id = ?').get(mine.id)).toEqual({ share_chats: 1 })
    expect(db().query("SELECT actor_id, detail FROM audit_log WHERE action = 'project.share_chats' AND target = ?").all(mine.id)).toEqual([{ actor_id: 'alice', detail: '{"on":true,"reason":"moved"}' }])
    expect((await h.api('alice').call(API.createChat, { body: { projectId: mine.id } })).shared).toBeDefined()
  })

  test('a rollback build turned the column off: new chats are still shared; at start the column comes back (audited once)', async () => {
    const p = await teamProject('Rolled')
    // a chat of alice's own there from before (private): the start-up step never shares it
    const before = await h.api('alice').call(API.createChat, { body: { projectId: p.id, private: true } })
    db().query('UPDATE projects SET share_chats = 0 WHERE id = ?').run(p.id)
    expect((await h.api('alice').call(API.createChat, { body: { projectId: p.id } })).shared).toBeDefined()
    const { markTeamShares } = await import('../../server/src/chat/team-shares')
    expect(markTeamShares(db(), null, 'default')).toBeGreaterThanOrEqual(1)
    expect(markTeamShares(db(), null, 'default')).toBe(0)
    expect(db().query('SELECT share_chats FROM projects WHERE id = ?').get(p.id)).toEqual({ share_chats: 1 })
    expect(db().query("SELECT detail FROM audit_log WHERE action = 'project.share_chats' AND target = ? AND actor_id IS NULL").all(p.id)).toEqual([{ detail: '{"on":true,"reason":"default"}' }])
    // chats that exist keep their state: the private one stays private
    expect(db().query('SELECT shared_at FROM chats WHERE id = ?').get(before.id)).toEqual({ shared_at: null })
  })

  test('creating and sharing a project write the column with an audit row', async () => {
    const p = await teamProject('Audited')
    expect(db().query("SELECT actor_id, detail FROM audit_log WHERE action = 'project.share_chats' AND target = ?").all(p.id)).toEqual([{ actor_id: 'alice', detail: '{"on":true,"reason":"created"}' }])
    const mine = await h.api('alice').call(API.createProject, { body: { name: 'Later', scope: 'personal', participants: [], instructions: '' } })
    await h.api('alice').call(API.shareProject, { params: { id: mine.id }, body: { participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
    expect(db().query("SELECT actor_id, detail FROM audit_log WHERE action = 'project.share_chats' AND target = ?").all(mine.id)).toEqual([{ actor_id: 'alice', detail: '{"on":true,"reason":"shared"}' }])
  })
})

describe('a member removed while their turn runs (QA TC-961)', () => {
  test('their turn in a shared chat stops; nothing more of it reaches them', async () => {
    const p = await teamProject('Pier')
    const chat = await h.api('alice').call(API.createChat, { body: { projectId: p.id } })
    const slow = await send('bob', chat.id, 'slow\n' + fake({ sleep: 8000 }, { say: 'too late for bob' }))
    await waitFor(() => h.rt().activeTurnUser(chat.id) === 'bob', { timeoutMs: 5000 })
    const access = await h.api('alice').call(API.getProjectAccess, { params: { id: p.id } })
    await h.api('alice').call(API.putProjectParticipants, { params: { id: p.id }, body: { participants: [], expectedHash: access.rulesHash! } })
    // stopped at once (well before the 8 s answer), and bob's window was told the chat is gone
    await waitFor(() => h.rt().activeTurnUser(chat.id) === null, { timeoutMs: 3000 })
    expect((db().query('SELECT status FROM turns WHERE id = ?').get(slow.turnId) as { status: string }).status).toBe('stopped')
    await ws.bob!.next('chat.updated', (f) => f.data.chatId === chat.id && f.data.change === 'deleted', 5000)
    expect((await errOf(h.api('bob').call(API.getChat, { params: { id: chat.id } }))).status).toBe(404)
    const answer = db().query('SELECT content FROM messages WHERE id = ?').get(slow.assistantMessage.id) as { content: string | null }
    expect(answer.content ?? '').not.toContain('too late for bob')
  })
})
