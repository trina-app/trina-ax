// Sharing to a group (docs/DECISIONS.md "Group skills", phase 2): a share proposal (내 스킬 가져오기, share_skills) goes
// to the team or to one of the proposer's groups, stored with it; its checks and the AI's judgement compare it with the
// group's skills and the team's; the group's members who may write its skills folder see it in their review list,
// hear of it and apply it (into groups/<folder>/skills/ as themselves, audited); anyone else gets 404; the proposer
// moves it between targets before anything went in; a deleted group leaves nothing to apply.
//
// Fixture (tests/lib/fixtures.ts): alice + erin = marketing, bob = finance, carol = admin, dana = owner. Here dana
// joins marketing (an owner proposes to their own group), and the fixture's groups get their folder rows linked.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type SkillShare } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { shareJudgeOf } from '../../server/src/skills/share-judge'
import { shareSkills } from '../../server/src/connectors/remote-mcp/share'
import { deleteGroupAs } from '../../server/src/admin/groups'
import type { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { MIGRATIONS_DIR } from '../../server/src/db'

setDefaultTimeout(60_000)
const md = (n: string, body = '# x\n1. Read the notes.\n') => `---\nname: ${n}\ndescription: ${n} skill\n---\n${body}`
const skill = (name: string) => ({ name, origin: 'user', files: [{ path: 'SKILL.md', text: md(name) }] })

let h: Harness
const socks: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'group-skill-shares' })
  for (const g of ['marketing', 'finance']) h.ctx.db.query('UPDATE groups SET folder_id = (SELECT id FROM folders WHERE path = ?) WHERE id = ?').run(`groups/${g}`, g)
  h.ctx.db.query("INSERT INTO group_members (group_id, user_id) VALUES ('marketing', 'dana')").run()
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(h.team, rel)), { recursive: true }); fs.writeFileSync(path.join(h.team, rel), text) }
  put('groups/marketing/skills/weekly/SKILL.md', md('weekly'))
  put('skills/quote/SKILL.md', md('quote'))
  for (const u of ['alice', 'erin', 'bob']) {
    socks[u] = await h.ws(u, { windowId: `win-gss-${u}` })
    await socks[u]!.next('hello')
  }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

const status = async (p: Promise<unknown>) => { try { await p; return 200 } catch (e) { return (e as { status: number }).status } }
const create = (body: Record<string, unknown>, user = 'dana') => h.api(user).call(API.createSkillShare, { body: { source: 'browser', ...body } as never })
/** the share once the judgement is over (the fake engine's answer is no judgement: nothing pre-ticked) */
const ready = (id: string, user = 'dana') => waitFor(async () => {
  const s = await h.api(user).call(API.getSkillShare, { params: { id } })
  return s.status !== 'checking' ? s : null
}, { timeoutMs: 30_000 }) as Promise<SkillShare>
const cand = (s: SkillShare, name: string) => s.candidates.find((c) => c.name === name)!

describe('a share proposal to a group', () => {
  let s: SkillShare
  test('targeting a group: stored with it; the checks see the group\'s skills and the team\'s', async () => {
    s = await create({ group: 'marketing', skills: [skill('weekly'), skill('quote'), skill('fresh-one')] })
    expect(s.targetGroup).toEqual({ id: 'marketing', name: 'Marketing' })
    expect(s).toMatchObject({ mine: true, canApply: true, proposer: { id: 'dana' } })
    expect(h.ctx.db.query('SELECT target_group_id FROM skill_shares WHERE id = ?').get(s.id)).toEqual({ target_group_id: 'marketing' })
    // the group's own skill and the team's both count as "the same name"
    expect(cand(s, 'weekly').sameName).toEqual({ path: 'groups/marketing/skills/weekly/SKILL.md', title: 'weekly' })
    expect(cand(s, 'quote').sameName).toEqual({ path: 'skills/quote/SKILL.md', title: 'quote' })
    expect(cand(s, 'fresh-one').sameName).toBeNull()
    // the AI's judgement reads the group's skills too
    const chat = (h.ctx.db.query('SELECT chat_id FROM skill_share_judges WHERE share_id = ?').get(s.id) as { chat_id: string } | null)?.chat_id
    if (chat) expect(shareJudgeOf(h.ctx, chat)!.material.team.map((t) => t.name)).toEqual(expect.arrayContaining(['weekly', 'quote']))
    // audited with the group
    expect(JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'skills.share_create' AND target = ?").get(s.id) as { detail: string }).detail).group).toBe('marketing')
    s = await ready(s.id)
  })

  test('its members who may write the group\'s skills hear of it; nobody else does', async () => {
    await socks.alice!.next('notice', (f) => f.data.code === 'skill_share' && f.data.link === `/skills/share/${s.id}`)
    await socks.erin!.next('notice', (f) => f.data.code === 'skill_share' && f.data.link === `/skills/share/${s.id}`)
    expect(socks.bob!.frames.some((f) => f.type === 'notice' && (f.data as { link?: string }).link === `/skills/share/${s.id}`)).toBe(false)
  })

  test('reviewers: the review list and the share for its members; 404 for a member outside the group and an admin', async () => {
    expect((await h.api('alice').call(API.listSkillShares, { query: { scope: 'review' } })).items.map((x) => x.id)).toEqual([s.id])
    expect((await h.api('alice').call(API.listSkillShares, { query: {} })).items).toEqual([])
    expect((await h.api('alice').call(API.skillsOverview)).sharesToReview).toBe(1)
    expect(await h.api('alice').call(API.getSkillShare, { params: { id: s.id } })).toMatchObject({ mine: false, canApply: true, targets: [] })
    for (const u of ['bob', 'carol']) {
      expect(await status(h.api(u).call(API.getSkillShare, { params: { id: s.id } }))).toBe(404)
      expect(await status(h.api(u).call(API.applySkillShare, { params: { id: s.id }, body: { skills: [{ name: 'fresh-one', action: 'add' }] } }))).toBe(404)
      expect(await status(h.api(u).call(API.dismissSkillShare, { params: { id: s.id } }))).toBe(404)
      expect((await h.api(u).call(API.listSkillShares, { query: { scope: 'review' } })).items).toEqual([])
    }
    // the proposer's own list has it; a member cannot make one (their way is 스킬로 제안)
    expect((await h.api('dana').call(API.listSkillShares, { query: {} })).items.map((x) => x.id)).toContain(s.id)
    expect(await status(create({ group: 'marketing', skills: [skill('x')] }, 'alice'))).toBe(403)
  })

  test('apply by a member of the group: into groups/<folder>/skills/ as them, audited; a team rule or tools are refused', async () => {
    expect(await status(h.api('alice').call(API.applySkillShare, { params: { id: s.id }, body: { skills: [], rule: true } }))).toBe(400)
    // the group's own skill of the same name: add is refused, separate goes beside it
    expect(await status(h.api('alice').call(API.applySkillShare, { params: { id: s.id }, body: { skills: [{ name: 'weekly', action: 'add' }] } }))).toBe(409)
    const done = await h.api('alice').call(API.applySkillShare, { params: { id: s.id }, body: { skills: [{ name: 'fresh-one', action: 'add' }, { name: 'weekly', action: 'separate' }] } })
    expect(cand(done, 'fresh-one').applied).toMatchObject({ status: 'added', path: 'groups/marketing/skills/fresh-one/SKILL.md' })
    expect(cand(done, 'weekly').applied).toMatchObject({ status: 'added', path: 'groups/marketing/skills/weekly-2/SKILL.md' })
    expect(done.landing).toBeNull()
    expect(fs.existsSync(path.join(h.team, 'groups/marketing/skills/fresh-one/SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(h.team, 'skills/fresh-one'))).toBe(false)
    const a = JSON.parse((h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'skills.share_apply' AND target = ? ORDER BY id DESC LIMIT 1").get(s.id) as { detail: string }).detail)
    expect(a.group).toBe('marketing')
    const change = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'skills.change' AND target = 'groups/marketing/skills/fresh-one/SKILL.md' ORDER BY id DESC LIMIT 1").get() as { actor_id: string; detail: string }
    expect(change.actor_id).toBe('alice')
    expect(JSON.parse(change.detail).group).toMatchObject({ id: 'marketing' })
    // the group's members have it now; bob does not
    expect((await h.api('erin').call(API.listSkills)).items.find((x) => x.path === 'groups/marketing/skills/fresh-one/SKILL.md')?.group?.id).toBe('marketing')
    expect(JSON.stringify((await h.api('bob').call(API.listSkills)).items)).not.toContain('fresh-one')
  })
})

describe('the target: chosen, moved, refused, gone', () => {
  test('a group that is not the proposer\'s (or not writable): refused, nothing made', async () => {
    const before = (h.ctx.db.query('SELECT COUNT(*) AS n FROM skill_shares').get() as { n: number }).n
    expect(await status(create({ group: 'finance', skills: [skill('x')] }))).toBe(400)
    expect(await status(create({ group: 'no-such-group', skills: [skill('x')] }))).toBe(400)
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM skill_shares').get() as { n: number }).n).toBe(before)
  })

  test('PATCH moves the proposer\'s own share to a group and back; the checks run again; only the proposer', async () => {
    let s = await ready((await create({ skills: [skill('weekly'), skill('other-one')] })).id)
    expect(s.targetGroup ?? null).toBeNull()
    expect(s.targets).toEqual([{ id: 'marketing', name: 'Marketing' }])
    expect(cand(s, 'weekly').sameName).toBeNull() // the team has no "weekly"
    s = await h.api('dana').call(API.setSkillShareTarget, { params: { id: s.id }, body: { group: 'marketing' } })
    expect(s.targetGroup).toEqual({ id: 'marketing', name: 'Marketing' })
    expect(cand(s, 'weekly')).toMatchObject({ sameName: { path: 'groups/marketing/skills/weekly/SKILL.md' }, action: 'merge' })
    await socks.alice!.next('notice', (f) => f.data.code === 'skill_share' && f.data.link === `/skills/share/${s.id}`)
    s = await h.api('dana').call(API.setSkillShareTarget, { params: { id: s.id }, body: { group: null } })
    expect(s.targetGroup ?? null).toBeNull()
    expect(cand(s, 'weekly')).toMatchObject({ sameName: null, action: 'add' })
    expect(await status(h.api('dana').call(API.setSkillShareTarget, { params: { id: s.id }, body: { group: 'finance' } }))).toBe(400)
    // another admin: none of theirs (404); a member: no proposals at all (403)
    expect(await status(h.api('carol').call(API.setSkillShareTarget, { params: { id: s.id }, body: { group: null } }))).toBe(404)
    expect(await status(h.api('alice').call(API.setSkillShareTarget, { params: { id: s.id }, body: { group: 'marketing' } }))).toBe(403)
    // once something went in, where it goes is fixed
    await h.api('dana').call(API.applySkillShare, { params: { id: s.id }, body: { skills: [{ name: 'other-one', action: 'add' }] } })
    expect(await status(h.api('dana').call(API.setSkillShareTarget, { params: { id: s.id }, body: { group: 'marketing' } }))).toBe(409)
    expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'skills.share_target' AND target = ?").get(s.id)).toEqual({ n: 2 })
  })

  test('share_skills: "group" by name sends it to that group; a group not the user\'s is refused with their groups', async () => {
    const oauth = { rate: () => {}, enabled: () => 'https://team.example' } as unknown as RemoteOAuth
    const dana = h.ctx.files.principal('dana')
    const ok = shareSkills(h.ctx, oauth, dana, { group: 'marketing', skills: [skill('from-code')] })
    expect(ok.isError).toBeUndefined()
    const id = JSON.parse(ok.text.split('\n')[0]!).proposalId as string
    expect(h.ctx.db.query('SELECT target_group_id FROM skill_shares WHERE id = ?').get(id)).toEqual({ target_group_id: 'marketing' })
    expect(ok.audit.group).toBe('marketing')
    const no = shareSkills(h.ctx, oauth, dana, { group: 'Finance', skills: [skill('from-code')] })
    expect(no.isError).toBe(true)
    expect(no.text).toContain('"Marketing"')
  })

  test('a member who leaves the group is refused as reviewer at once', async () => {
    const s = await ready((await create({ group: 'marketing', skills: [skill('leave-test')] })).id)
    expect((await h.api('erin').call(API.getSkillShare, { params: { id: s.id } })).canApply).toBe(true)
    h.ctx.db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'erin'").run()
    try {
      expect(await status(h.api('erin').call(API.getSkillShare, { params: { id: s.id } }))).toBe(404)
      expect(await status(h.api('erin').call(API.applySkillShare, { params: { id: s.id }, body: { skills: [{ name: 'leave-test', action: 'add' }] } }))).toBe(404)
    } finally { h.ctx.db.query("INSERT INTO group_members (group_id, user_id) VALUES ('marketing', 'erin')").run() }
  })

  test('migration 258 is additive (reader 1), and its number is the only one', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '258_b_skill_share_targets.sql'), 'utf8')
    expect(sql.split('\n')[0]).toBe('-- min_compatible_reader: 1')
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME/i)
    expect(fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('258_'))).toEqual(['258_b_skill_share_targets.sql'])
  })

  test('a deleted group: nothing can be applied (409), the proposer still sees it', async () => {
    const s = await ready((await create({ group: 'marketing', skills: [skill('late-one')] })).id)
    deleteGroupAs(h.ctx, 'dana', 'marketing')
    const seen = await h.api('dana').call(API.getSkillShare, { params: { id: s.id } })
    expect(seen.targetGroup).toEqual({ id: 'marketing', name: null })
    expect(seen.canApply).toBe(false)
    expect(await status(h.api('dana').call(API.applySkillShare, { params: { id: s.id }, body: { skills: [{ name: 'late-one', action: 'add' }] } }))).toBe(409)
    expect(await status(h.api('alice').call(API.getSkillShare, { params: { id: s.id } }))).toBe(404)
  })
})
