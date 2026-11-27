// The ask registry's findings, fixed under Rule A (docs/ASKS.md, docs/decisions/20261123-ask-registry-findings.md): the
// person's own "Always allow" holds in their scheduled run and in shared chats, also for the tools that refused there
// up front; taking it back in Settings › Allowed for Trina brings the card (or the refusal) back. Also the connector
// send Always in that list, the office-network card under the team switch and the full dev-site list.
// Uses the shared project chat fixture of b-always-holds-everywhere: projects/falcon, alice writes it, bob reads it.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type AiAllowance } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { CONFIRMED } from '../lib/schedule-card'
import { keepAlways, type AlwaysPlace } from '../../server/src/chat/always-allow'
import { askConfirm, type TurnPerson } from '../../server/src/tools/url-gate'
import { deleteFilesRefusal } from '../../server/src/chat/delete-files'
import { folderAccessOff } from '../../server/src/chat/folder-access-tool'
import { projectMembersRefusal } from '../../server/src/chat/project-members'
import { skillFilesRefusal } from '../../server/src/chat/skill-files'
import { grantUserSite, userSitesFull } from '../../server/src/devenv/sites'
import { DEV_ENV_MAX_USER_SITES } from '@mycel/shared'

setDefaultTimeout(90_000)

const cm = () => 'cm-' + crypto.randomUUID()
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId = ''
const db = () => h.ctx.db
const farTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + 12 * 3_600_000))
const put = (rel: string, body: string) => {
  const abs = path.join(h.ctx.files.fx.root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}
const has = (rel: string) => fs.existsSync(path.join(h.ctx.files.fx.root, ...rel.split('/')))

beforeAll(async () => {
  h = await startHarness({ name: 'ask-registry-findings', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000, timeZone: 'Asia/Seoul' })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u, { windowId: `win-findings-${u}` }); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  for (const n of [1, 2, 3, 4, 5, 6]) put(`users/alice/note-${n}.txt`, `note ${n}`)
  put('projects/falcon/old-5.txt', 'old')
})
afterAll(async () => {
  for (const s of Object.values(ws)) s.close()
  await h?.close()
})

const ownChat = async (user = 'alice', body: Record<string, unknown> = {}) => (await h.api(user).call(API.createChat, { body })).id as string
const newShared = async (user = 'alice') => (await h.api(user).call(API.createChat, { body: { projectId } })).id as string
async function turn(user: string, chatId: string, content: string) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 40_000)
  const cards = ws[user]!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === r.turnId)
  return { turnId: r.turnId as string, content: done.data.message.content as string, cards }
}
/** a shared chat alice and bob both wrote in */
async function sharedChatBobWroteIn(): Promise<string> {
  const id = await newShared()
  await turn('alice', id, fake({ say: 'hello' }))
  await turn('bob', id, fake({ say: 'noted' }) + '\nthanks')
  return id
}
/** run a task of alice's in `chatId` now; the run's turn id once its answer is done */
async function runTask(chatId: string, prompt: string, project: string | null = null): Promise<string> {
  const s = h.rt().schedules.create('alice', { title: 'T ' + crypto.randomUUID().slice(0, 6), prompt, repeat: 'daily', time: farTime(), ...(project ? { projectId: project } : {}) }, undefined, CONFIRMED, { chatId })
  db().query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), s.id)
  expect(h.rt().schedules.runDue(new Date())).toEqual([s.id])
  const t = db().query('SELECT id FROM turns WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1').get(s.id) as { id: string }
  // the run is over: its turn ended (not queued, not running) and its answer is written. Before, "not queued" and "the
  // answer is not streaming" were also true for a turn that was running with no answer row yet, and on a slow runner the
  // test read the tool's result before the tool had run (CI 2026-11-27, 47 ms)
  await waitFor(() => !['queued', 'running'].includes((db().query('SELECT status FROM turns WHERE id = ?').get(t.id) as { status: string }).status)
    && (db().query("SELECT status FROM messages WHERE turn_id = ? AND role = 'assistant'").get(t.id) as { status: string } | null)?.status !== 'streaming', { timeoutMs: 30_000 })
  h.rt().schedules.delete('alice', s.id)
  return t.id
}
const allowances = async (user = 'alice') => (await h.api(user).call(API.listAiAllowances)).items as AiAllowance[]
const removeInSettings = async (id: string, user = 'alice') => h.api(user).call(API.deleteAiAllowance, { params: { id } })
const toolResult = (turnId: string, tool: string) => {
  const r = db().query('SELECT ok, summary FROM tool_events WHERE turn_id = ? AND tool = ? ORDER BY rowid DESC LIMIT 1').get(turnId, tool) as { ok: number; summary: string | null } | null
  return r
}

// ---------------- violations 1-4: the person's own scheduled run reads their Always first ----------------
describe('violations 1-4: Always holds in the person\'s own scheduled run (move, copy, copy after a room read, big download)', () => {
  test('askConfirm: an unattended run answers yes only for a card kind whose Always is on; else nobody can be asked', async () => {
    const asked: string[] = []
    const p = (on: boolean): TurnPerson => ({ locale: 'en', unattended: true, async confirm(q) { asked.push(q); return true }, *turnUrls() {}, alwaysOn: (k) => on && k === 'move_files' })
    expect(await askConfirm(p(true), 'Move?', 'Move', 'No', { always: 'move_files' })).toBe('yes')
    expect(await askConfirm(p(false), 'Move?', 'Move', 'No', { always: 'move_files' })).toBe('unattended')
    // a card with no Always kind (a redirect echo, a connection send) never goes on unwatched
    expect(await askConfirm(p(true), 'Echo?', 'Yes', 'No')).toBe('unattended')
    // another kind's Always does not count
    expect(await askConfirm(p(true), 'Big?', 'Yes', 'No', { always: 'big_download' })).toBe('unattended')
    // a person without alwaysOn (a draft, a call outside a chat): as before
    expect(await askConfirm({ locale: 'en', unattended: true, async confirm() { return true }, *turnUrls() {} }, 'Move?', 'Move', 'No', { always: 'move_files' })).toBe('unattended')
    expect(asked).toEqual([])
  })

  test('a move that widens who can see, in the scheduled run: done under Always; refused again after removing it', async () => {
    const chat = await ownChat()
    keepAlways(db(), 'alice', 'move_files', null)
    try {
      const run = await runTask(chat, fake({ tool: 'move_files', args: { paths: ['users/alice/note-1.txt'], to_folder: 'shared/in' }, sayResult: true }))
      expect(toolResult(run, 'move_files')?.ok).toBe(1)
      expect(has('shared/in/note-1.txt')).toBe(true)
      expect((await allowances()).some((a) => a.id === 'card:move_files')).toBe(true)
    } finally { await removeInSettings('card:move_files') }
    const again = await runTask(chat, fake({ tool: 'move_files', args: { paths: ['users/alice/note-2.txt'], to_folder: 'shared/in' }, sayResult: true }))
    expect(toolResult(again, 'move_files')?.ok).toBe(0)
    expect(has('users/alice/note-2.txt')).toBe(true)
  })

  test('a copy in the scheduled run: done under Always; refused after removing it', async () => {
    const chat = await ownChat()
    keepAlways(db(), 'alice', 'move_files', null)
    try {
      const run = await runTask(chat, fake({ tool: 'copy_files', args: { paths: ['users/alice/note-3.txt'], to_folder: 'shared/copies' }, sayResult: true }))
      expect(toolResult(run, 'copy_files')?.ok).toBe(1)
      expect(has('shared/copies/note-3.txt')).toBe(true)
    } finally { await removeInSettings('card:move_files') }
    const again = await runTask(chat, fake({ tool: 'copy_files', args: { paths: ['users/alice/note-4.txt'], to_folder: 'shared/copies' }, sayResult: true }))
    expect(toolResult(again, 'copy_files')?.ok).toBe(0)
    expect(has('shared/copies/note-4.txt')).toBe(false)
  })
})

// ---------------- decisions 1 and 2: the refusals that ignored Always ----------------
describe('decisions 1 and 2: deletes, skill folders, project members and folder access under Always', () => {
  /** a TurnExec stand-in for the refusal checks: the turn's AlwaysPlace is alice's (or `user`'s) */
  const exec = (o: { user?: string; clientKind?: string; shared?: boolean; otherAuthors?: boolean; chatId?: string } = {}) => {
    const userId = o.user ?? 'alice'
    const chatId = o.chatId ?? uuidv7()
    const place: AlwaysPlace = { db: db(), userId, chatId, turnId: uuidv7(), locale: 'en', clientKind: o.clientKind ?? 'web' }
    return {
      spec: { userId, chatId, turnId: place.turnId, assistantId: uuidv7(), locale: 'en', clientKind: o.clientKind ?? 'web' },
      shared: o.shared ? { kind: 'project', project: {} } : null, restricted: false, templateRun: false, roomsSeen: false,
      otherAuthors: !!o.otherAuthors, fromSlack: false, rt: h.rt(), files: undefined, alwaysPlace: () => place,
    } as never
  }
  const places = [{ clientKind: 'schedule' }, { shared: true }, { otherAuthors: true }]

  // a shared chat and a chat others wrote in: the card as in the person's own chat since
  // docs/decisions/20261126-shared-chat-everything.md; the scheduled run still needs Always
  test('delete_files: refused in a scheduled run (not under Always); a shared chat and a chat others wrote in ask on the card', () => {
    const [sched, ...rest] = places
    expect(deleteFilesRefusal(exec(sched))).toBe('scheduled')
    for (const p of rest) expect([p, deleteFilesRefusal(exec(p))]).toEqual([p, null])
    keepAlways(db(), 'alice', 'delete_files', null)
    for (const p of places) expect([p, deleteFilesRefusal(exec(p))]).toEqual([p, null])
    db().query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run()
    expect(deleteFilesRefusal(exec({ clientKind: 'schedule' }))).toBe('scheduled')
  })

  test('project members and folder access: the scheduled run under Always (never another person\'s), the card elsewhere, never a guest', () => {
    const [sched, ...rest] = places
    expect(projectMembersRefusal(exec(sched))?.reason).toBe('scheduled run')
    expect(folderAccessOff(exec({ ...sched, user: 'carol' }))?.reason).toBe('scheduled run')
    for (const p of rest) {
      expect([p, projectMembersRefusal(exec(p))]).toEqual([p, null])
      expect([p, folderAccessOff(exec({ ...p, user: 'carol' }))]).toEqual([p, null])
    }
    keepAlways(db(), 'alice', 'project_members', null)
    keepAlways(db(), 'carol', 'folder_access', null)
    try {
      expect(projectMembersRefusal(exec(sched))).toBeNull()
      expect(folderAccessOff(exec({ ...sched, user: 'carol' }))).toBeNull()
      // bob's scheduled run: alice's and carol's Always are theirs only
      expect(projectMembersRefusal(exec({ ...sched, user: 'bob' }))).not.toBeNull()
      expect(folderAccessOff(exec({ ...sched, user: 'bob' }))).not.toBeNull()
      // a guest: refused whatever their own Always says
      db().query("UPDATE users SET guest = 1 WHERE id = 'bob'").run()
      keepAlways(db(), 'bob', 'project_members', null)
      keepAlways(db(), 'bob', 'folder_access', null)
      expect(projectMembersRefusal(exec({ user: 'bob' }))?.reason).toBe('guest')
      expect(folderAccessOff(exec({ user: 'bob' }))?.reason).toBe('guest')
      expect(projectMembersRefusal(exec({ user: 'bob', shared: true }))?.reason).toBe('guest')
    } finally {
      db().query("UPDATE users SET guest = 0 WHERE id = 'bob'").run()
      db().query("DELETE FROM card_always_allow WHERE user_id IN ('alice', 'bob', 'carol')").run()
    }
    expect(projectMembersRefusal(exec({ clientKind: 'schedule' }))?.reason).toBe('scheduled run')
    expect(folderAccessOff(exec({ clientKind: 'schedule', user: 'carol' }))?.reason).toBe('scheduled run')
  })

  test('skill_files: the shared chat asks on the card; the scheduled run only under Always', () => {
    const e = (p: Record<string, unknown>) => exec(p) as never
    const rename = { action: 'rename', path: 'skills/a', new_name: 'b' }
    expect(skillFilesRefusal(e({ shared: true }), rename)).toBeNull()
    expect(skillFilesRefusal(e({ clientKind: 'schedule' }), rename)?.summary).toContain('scheduled run')
    keepAlways(db(), 'alice', 'skill_files', null)
    try {
      expect(skillFilesRefusal(e({ clientKind: 'schedule' }), rename)).toBeNull()
    } finally { db().query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run() }
  })

  test('a real shared chat bob wrote in: the tools are offered, a delete asks on its card; under Always it goes with no card', async () => {
    const chat = await sharedChatBobWroteIn()
    const before = await turn('alice', chat, fake({ echo: 'tools' }))
    for (const t of ['change_project_members', 'skill_files', 'delete_files']) expect(before.content.split(',')).toContain(t)
    const asked = await turn('alice', chat, fake({ tool: 'delete_files', args: { paths: ['projects/falcon/old-5.txt'] }, sayResult: true }))
    expect(asked.cards.length).toBeGreaterThanOrEqual(1)
    expect(has('projects/falcon/old-5.txt')).toBe(true)
    for (const k of ['delete_files', 'project_members', 'skill_files'] as const) keepAlways(db(), 'alice', k, null)
    try {
      // another project's members are never changed from here (its name and people would show to everyone here)
      await h.api('alice').call(API.createProject, { body: { name: 'Heron', scope: 'team', instructions: '', participants: [] } })
      const other = await turn('alice', chat, fake({ tool: 'change_project_members', args: { project: 'Heron', add: [{ name: 'Erin Yoo' }] }, sayResult: true }))
      expect(toolResult(other.turnId, 'change_project_members')?.summary ?? '').toMatch(/refused: shared_other_project/)
      expect(other.content).not.toContain('Erin')
      const del = await turn('alice', chat, fake({ tool: 'delete_files', args: { paths: ['projects/falcon/old-5.txt'] }, sayResult: true }))
      expect(del.cards).toHaveLength(0)
      expect(has('projects/falcon/old-5.txt')).toBe(false)
    } finally { for (const k of ['delete_files', 'project_members', 'skill_files']) await removeInSettings(`card:${k}`) }
    const after = await turn('alice', chat, fake({ echo: 'tools' }))
    expect(after.content.split(',')).toContain('change_project_members')
  })

  test('project members in the scheduled run: changed under Always (with the project manager\'s own rights); refused after removing it', async () => {
    const p = await h.api('alice').call(API.createProject, { body: { name: 'Gull', scope: 'team', instructions: '', participants: [] } })
    const chat = await ownChat('alice', { projectId: p.id, private: true })
    const members = () => (db().query("SELECT r.subject_id FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ? AND r.subject_type = 'user' AND r.access = 'write'").all(p.folderPath) as { subject_id: string }[]).map((r) => r.subject_id).sort()
    keepAlways(db(), 'alice', 'project_members', null)
    try {
      const run = await runTask(chat, fake({ tool: 'change_project_members', args: { add: [{ name: 'Erin Yoo' }] }, sayResult: true }), p.id)
      expect(toolResult(run, 'change_project_members')?.ok).toBe(1)
      expect(members()).toContain('erin')
    } finally { await removeInSettings('card:project_members') }
    const again = await runTask(chat, fake({ tool: 'change_project_members', args: { remove: [{ name: 'Erin Yoo' }] }, sayResult: true }), p.id)
    expect(toolResult(again, 'change_project_members')?.summary ?? '').toMatch(/refused: scheduled run/)
    expect(members()).toContain('erin')
  })
})

// ---------------- decision 6: the connector send Always in Settings › Allowed for Trina ----------------
describe('decision 6: the connector send Always is listed and removable', () => {
  test('own connection set to send without asking, and a member\'s row on a team connection; removing makes the card come back', async () => {
    const at = new Date().toISOString()
    const ins = db().query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, status, write_policy, created_at, updated_at)
      VALUES (?, ?, ?, 'alice', 'mcp', ?, ?, ?, 'none', 'connected', ?, ?, ?)`)
    ins.run('int-own', 'personal', 'alice', 'Mailer', 'mailer', 'https://mailer.example/mcp', 'allow', at, at)
    ins.run('int-team', 'team', null, 'Tracker', 'tracker', 'https://tracker.example/mcp', 'ask', at, at)
    ins.run('int-bob', 'personal', 'bob', 'Bob mail', 'bob-mail', 'https://bobmail.example/mcp', 'allow', at, at)
    db().query('INSERT INTO integration_user_allow (integration_id, user_id, url, created_at) VALUES (?, ?, ?, ?)').run('int-team', 'alice', 'https://tracker.example/mcp', at)
    const sends = async (user = 'alice') => (await allowances(user)).filter((a) => a.kind === 'connector_send').map((a) => a.kind === 'connector_send' ? [a.id, a.connection, a.scope] : []).sort()
    expect(await sends()).toEqual([['send:int-own', 'Mailer', 'personal'], ['send:int-team', 'Tracker', 'team']])
    // never another person's
    expect((await sends('bob'))).toEqual([['send:int-bob', 'Bob mail', 'personal']])
    await expect(removeInSettings('send:int-bob')).rejects.toThrow()
    await removeInSettings('send:int-own')
    await removeInSettings('send:int-team')
    expect(await sends()).toEqual([])
    expect((db().query("SELECT write_policy FROM integrations WHERE id = 'int-own'").get() as { write_policy: string }).write_policy).toBe('ask')
    expect(db().query("SELECT 1 FROM integration_user_allow WHERE integration_id = 'int-team'").get()).toBeNull()
    // the team's own rule is an admin's: never changed here
    expect((db().query("SELECT write_policy FROM integrations WHERE id = 'int-team'").get() as { write_policy: string }).write_policy).toBe('ask')
    expect((db().query("SELECT write_policy FROM integrations WHERE id = 'int-bob'").get() as { write_policy: string }).write_policy).toBe('allow')
    // a moved team connection's row no longer counts and is not listed
    db().query('INSERT INTO integration_user_allow (integration_id, user_id, url, created_at) VALUES (?, ?, ?, ?)').run('int-team', 'alice', 'https://old.example/mcp', at)
    expect(await sends()).toEqual([])
    db().query("DELETE FROM integrations WHERE id IN ('int-own', 'int-team', 'int-bob')").run()
  })
})

// ---------------- side findings ----------------
describe('side findings', () => {
  test('a full dev-site list is said, not a silent "once"', () => {
    expect(userSitesFull(db(), 'erin')).toBe(false)
    const ins = db().query('INSERT OR IGNORE INTO dev_env_site_grants (user_id, host) VALUES (?, ?)')
    db().transaction(() => { for (let i = 0; i < DEV_ENV_MAX_USER_SITES; i++) ins.run('erin', `s${i}.example.com`) })()
    expect(userSitesFull(db(), 'erin')).toBe(true)
    expect(grantUserSite(db(), 'erin', 'new.example.com')).toBe('full')
    db().query("DELETE FROM dev_env_site_grants WHERE user_id = 'erin'").run()
  })
})
