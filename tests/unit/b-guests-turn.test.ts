// A guest's AI turn (docs/DECISIONS.md "Guests: only what they were invited to"; credentials/guest-ai.ts,
// chat/guest-tools.ts): real runtime and launcher, fake engine. With AI 'none' the turn ends "no AI connection" before
// anything runs, while the team-wide connection answers a member; with AI 'team' it runs on the one named connection,
// with only the guest tool list (no skills, rooms, project members, connections, web). This harness signs people in
// with test sessions (no invite page), so the guest is marked as the invite accept marks one: users.guest = 1 and
// its guests row (the invite and accept themselves are tested in tests/unit/a-guests-*.test.ts).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
let h: Harness
let erin: TestSocket, alice: TestSocket

beforeAll(async () => {
  h = await startHarness({ name: 'b-guests-turn' })
  const db = h.ctx.db
  db.query('UPDATE users SET guest = 1 WHERE id = ?').run('erin')
  db.query("INSERT INTO guests (user_id, place_kind, place_id, ai, created_at) VALUES ('erin', 'room', 'r-1', 'none', ?)").run(new Date().toISOString())
  erin = await h.ws('erin', { windowId: 'win-erin' }); await erin.next('hello')
  alice = await h.ws('alice', { windowId: 'win-alice' }); await alice.next('hello')
})
afterAll(async () => { erin?.close(); alice?.close(); await h?.close() })

const newChat = (user: string) => h.api(user).call(API.createChat, { body: { engine: 'claude-code' } })

test('AI none: the guest\'s turn ends "no AI connection"; the member\'s is answered by the team-wide connection', async () => {
  const g = await newChat('erin')
  const r = await ask(h, erin, 'erin', g.id, fake({ say: 'hello' }))
  expect(r.done.error).toMatchObject({ params: { reason: 'no_credential' } })
  const m = await newChat('alice')
  const ok = await ask(h, alice, 'alice', m.id, fake({ say: 'hello' }))
  expect(ok.done.error ?? null).toBeNull()
  expect(ok.done.content).toContain('hello')
})

test('AI team: the guest runs on the named team connection, with the guest tools only', async () => {
  const db = h.ctx.db
  const team = (db.query("SELECT id FROM engine_credentials WHERE kind = 'anthropic-api-key' AND owner_user_id IS NULL").get() as { id: string }).id
  db.query("UPDATE guests SET ai = 'team', team_credential_id = ? WHERE user_id = 'erin'").run(team)
  db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, action) VALUES ('b-erin', 'user', 'erin', 'month', 5, 'block')").run()
  const g = await newChat('erin')
  const r = await ask(h, erin, 'erin', g.id, fake({ echo: 'tools' }))
  expect(r.done.error ?? null).toBeNull()
  const tools = String(r.done.content).trim().split(',')
  expect(tools).toContain('edit_files')
  for (const no of ['find_skills', 'skill', 'post_to_room', 'change_project_members', 'connect_service', 'web_fetch', 'schedule_create', 'hwp_render']) expect(tools).not.toContain(no)
  // the member's turn keeps the team's tools
  const m = await newChat('alice')
  const mine = String((await ask(h, alice, 'alice', m.id, fake({ echo: 'tools' }))).done.content).trim().split(',')
  expect(mine).toContain('find_skills')
})
