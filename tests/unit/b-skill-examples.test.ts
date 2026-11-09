// What the team prepared, as each person sees it (docs/DECISIONS.md "W6.3 — What a new member sees first";
// server/src/skills/examples.ts, GET /api/skills/examples): Home's "팀에 준비된 것", the invite step's empty-team line and
// the Files screen's way into 팀 파일.
//   - every role gets it, read as the caller: a member their own skills (personal ones left out), the owner theirs;
//     nothing owner-only (no profile, nothing installable, no file names); the welcome state and the install stay 403;
//   - the kept skills at their own pack path carry Trina's example and source, in a member's order (자연스러운 글,
//     카드뉴스, 홍보 영상, 회사 소개서); an owner's own skill of the same name elsewhere carries neither and comes after;
//   - the team folder: counted as the caller, all levels down, at most 100; the steps' brand folder, the group's skills,
//     dot files, lock files and system files do not count; a folder hidden from the caller does not count for them;
//     null for a member outside the team group (and for a team without one);
//   - the landing skill only when the caller can use it (then first); a team skill run in a finished answer.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, TEAM_FOLDER_COUNT_MAX, type TeamPrepared } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { packExample } from '../../server/src/onboarding/skill-packs'
import { readWelcome, WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { countDocuments, DOCUMENT_COUNT_CACHE, forgetDocumentCounts, MEMBER_ORDER } from '../../server/src/skills/examples'

setDefaultTimeout(90_000)

let h: Harness
let folder = ''
let brand = ''
beforeAll(async () => {
  h = await startHarness({ name: 'b-skill-examples' })
  setSetting(h.ctx.db, 'defaultLocale', 'ko')
})
afterAll(async () => { await h?.close() })

/** the answer as it is now: the tests change files on disk, not through the file layer, so no count is reused */
const get = async (user: string): Promise<TeamPrepared> => { forgetDocumentCounts(h.ctx); return h.api(user).call(API.skillExamples) }
/** the answer, a count reused where there is one */
const getCached = async (user: string): Promise<TeamPrepared> => h.api(user).call(API.skillExamples)
const WITHOUT = ['브랜드', 'skills']
const put = (rel: string, text = 'x') => { const p = path.join(h.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const rm = (rel: string) => fs.rmSync(path.join(h.team, rel), { recursive: true, force: true })
const md = (name: string, description = `${name} — does ${name}`) => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n1. Read.\n`
/** a folder rule, as Admin › 폴더 권한 writes it (tests/lib/fixtures.ts seed) */
function rule(p: string, subjectType: 'everyone' | 'group' | 'user', subjectId: string | null, access: 'none' | 'read' | 'write') {
  let f = h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string } | null
  if (!f) { f = { id: `f_${crypto.randomUUID()}` }; h.ctx.db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(f.id, p) }
  h.ctx.db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), f.id, subjectType, subjectId, access)
}
/** one answer of a person in a new chat of theirs, the team skill it ran */
function ran(userId: string, skill: string, status = 'done', scheduleId: string | null = null) {
  const chatId = crypto.randomUUID(), messageId = crypto.randomUUID(), turnId = crypto.randomUUID()
  h.ctx.db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(chatId, userId)
  h.ctx.db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'assistant', 'Done.', 'done')").run(messageId, chatId)
  h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, message_id, schedule_id) VALUES (?, ?, ?, 'claude', ?, ?, ?)").run(turnId, chatId, userId, status, messageId, scheduleId)
  h.ctx.db.query("INSERT INTO turn_skill_runs (turn_id, skill_path, skill_name, source) VALUES (?, ?, ?, 'command')").run(turnId, skill, skill.split('/').at(-2)!)
}

describe('before the team has a group', () => {
  test('no team folder for anyone; no skills, nothing run, no profile', async () => {
    for (const who of ['bob', 'dana']) expect(await get(who)).toEqual({ skills: [], teamFolder: null, landing: null, ranTeamSkill: false, hasProfile: false })
  })
})

describe('the team as each person sees it', () => {
  beforeAll(async () => {
    // the owner's start: the team group with its folder, the meeting notes and brand folders; bob joined with the team
    // link (its group), alice another way (no group)
    await h.api('dana').call(API.updateWelcome, { body: {} })
    await h.api('dana').call(API.setupWelcomeTeam)
    const g = readWelcome(h.ctx)!.teamGroup!
    folder = g.folder
    brand = g.brandFolder!
    h.ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(g.id, 'bob')
  })

  test('an empty team: a member in the group and the owner read 0 documents; a member outside it gets null', async () => {
    expect(brand.startsWith(`${folder}/`)).toBe(true)
    for (const who of ['bob', 'dana', 'carol']) expect((await get(who)).teamFolder).toEqual({ path: folder, files: 0, more: false, without: WITHOUT })
    expect((await get('alice')).teamFolder).toBeNull()
    expect((await get('erin')).teamFolder).toBeNull()
  })

  test('the brand folder, the group\'s skills, dot files, lock files and system files do not count; the rest counts all levels down', async () => {
    put(`${brand}/회사 소개.md`, '# 회사 소개')
    put(`${brand}/이미지/site-1.png`, 'png')
    put(`${folder}/.DS_Store`)
    put(`${folder}/._보고서.pdf`)
    put(`${folder}/.hidden-notes.md`)
    put(`${folder}/회사 자료/Thumbs.db`)
    put(`${folder}/회사 자료/~$견적서.docx`)
    put(`${folder}/skills/weekly/SKILL.md`, md('weekly'))
    for (const who of ['bob', 'dana']) expect((await get(who)).teamFolder?.files).toBe(0)
    put(`${folder}/회의록/2026-11-03.md`, '# 회의')
    put(`${folder}/회사 자료/견적서.docx`)
    put(`${folder}/회사 자료/2026/상반기/매출.xlsx`)
    for (const who of ['bob', 'dana']) expect((await get(who)).teamFolder).toEqual({ path: folder, files: 3, more: false, without: WITHOUT })
    // a link is not a document (as on the file screen)
    fs.symlinkSync(path.join(h.team, `${folder}/회의록/2026-11-03.md`), path.join(h.team, `${folder}/link.md`))
    expect((await get('bob')).teamFolder?.files).toBe(3)
    rm(`${folder}/link.md`)
  })

  test('a folder hidden from a member counts for the owner only', async () => {
    put(`${folder}/임원/연봉.xlsx`)
    put(`${folder}/임원/평가/2026.md`)
    rule(`${folder}/임원`, 'group', readWelcome(h.ctx)!.teamGroup!.id, 'none')
    expect((await get('bob')).teamFolder?.files).toBe(3)
    expect((await get('dana')).teamFolder?.files).toBe(5)
    rm(`${folder}/임원`)
  })

  test('the count stops at 100 ("100개 넘게"); countDocuments says the same', async () => {
    for (let i = 0; i < TEAM_FOLDER_COUNT_MAX + 20; i++) put(`${folder}/많은 자료/${String(i).padStart(3, '0')}.txt`)
    expect((await get('bob')).teamFolder).toEqual({ path: folder, files: TEAM_FOLDER_COUNT_MAX, more: true, without: WITHOUT })
    const me = h.ctx.files.principal('bob')
    expect(countDocuments(h.ctx, me, `${folder}/많은 자료`)).toEqual({ path: `${folder}/많은 자료`, files: TEAM_FOLDER_COUNT_MAX, more: true })
    expect(countDocuments(h.ctx, h.ctx.files.principal('alice'), folder)).toBeNull()
    rm(`${folder}/많은 자료`)
    expect((await get('bob')).teamFolder).toEqual({ path: folder, files: 3, more: false, without: WITHOUT })
  })

  test('the kept skills at their pack path: Trina\'s example and source, in a member\'s order; an owner\'s own one of the same name elsewhere has neither', async () => {
    for (const [pack, skills] of [['general', ['intro-deck', 'card-news']], ['work', ['humanizer']]] as const)
      await h.api('dana').call(API.installSkillPack, { params: { id: pack }, body: { skills: [...skills] } })
    // the owner's own promo video (another folder, the kept skill's name): not Trina's
    put('skills/mine/promo-video/SKILL.md', md('promo-video', '우리 회사 홍보 영상 — 우리 방식대로 만들어요'))
    put('skills/report/SKILL.md', md('report', '주간 보고 — 한 주의 일을 정리해요'))
    // bob's own skill: his alone, never "prepared by the team"
    put('users/bob/skills/mine/SKILL.md', md('mine'))
    const bob = await get('bob')
    expect(bob.skills.map((s) => s.path)).toEqual([
      'skills/work/humanizer/SKILL.md', 'skills/general/card-news/SKILL.md', 'skills/general/intro-deck/SKILL.md',
      // the others in the list's order (by name): the group's own skill too
      'skills/mine/promo-video/SKILL.md', 'skills/report/SKILL.md', `${folder}/skills/weekly/SKILL.md`,
    ])
    const [humanizer, cards, deck] = bob.skills
    expect(humanizer).toEqual({ path: 'skills/work/humanizer/SKILL.md', name: 'humanizer', title: '자연스러운 글', summary: 'AI가 쓴 티가 나는 글을 사람이 쓴 것처럼 다듬어요', example: packExample('ko', 'humanizer')!, locale: 'ko', source: { kind: 'team_writing' } })
    expect(cards).toEqual({ path: 'skills/general/card-news/SKILL.md', name: 'card-news', title: '카드뉴스', summary: '회사 소개로 정사각형 카드 5장을 만들어요', example: { kind: 'image', url: '/skill-examples/ko/card-news.webp' }, locale: 'ko', source: { kind: 'team' } })
    expect(deck!.name).toBe('intro-deck')
    const own = bob.skills.find((s) => s.path === 'skills/mine/promo-video/SKILL.md')!
    expect(own).toEqual({ path: 'skills/mine/promo-video/SKILL.md', name: 'promo-video', title: 'promo-video', summary: '우리 회사 홍보 영상 — 우리 방식대로 만들어요' })
    expect(bob.skills.find((s) => s.name === 'report')!.summary).toBe('주간 보고 — 한 주의 일을 정리해요')
    expect(bob.skills.some((s) => s.path.startsWith('users/'))).toBe(false)
    // the one lines in the caller's language (alice reads English); the title is the team's text
    const alice = await get('alice')
    expect(alice.skills[0]).toMatchObject({ name: 'humanizer', title: '자연스러운 글', summary: 'Rewrites text that reads as AI-written so a person seems to have written it' })
    // alice is outside the team group: its skills are not hers
    expect(alice.skills.some((s) => s.path.startsWith(`${folder}/`))).toBe(false)
    expect(MEMBER_ORDER).toEqual(['humanizer', 'card-news', 'promo-video', 'intro-deck'])
  })

  test('a personal skill of a kept name takes its place for that person: not listed as Trina\'s for them', async () => {
    put('users/bob/skills/humanizer/SKILL.md', md('humanizer'))
    const bob = await get('bob')
    expect(bob.skills.some((s) => s.name === 'humanizer')).toBe(false)
    expect((await get('dana')).skills[0]!.name).toBe('humanizer')
    rm('users/bob/skills/humanizer')
  })

  test('the landing skill: first, only for someone who can use it', async () => {
    rule('skills/lead', 'everyone', null, 'none')
    put('skills/lead/plan/SKILL.md', md('plan'))
    const shareTo = (landing: string) => setSetting(h.ctx.db, WELCOME_SETTING, { ...getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING), shared: { at: '2026-11-08T00:00:00.000Z', skills: [{ path: landing, title: landing }], landing } })
    shareTo('skills/lead/plan/SKILL.md')
    const bob = await get('bob')
    expect(bob.landing).toBeNull()
    expect(bob.skills.some((s) => s.path === 'skills/lead/plan/SKILL.md')).toBe(false)
    const dana = await get('dana')
    expect(dana.landing).toBe('skills/lead/plan/SKILL.md')
    expect(dana.skills[0]!.path).toBe('skills/lead/plan/SKILL.md')
    shareTo('skills/report/SKILL.md')
    const now = await get('bob')
    expect(now.landing).toBe('skills/report/SKILL.md')
    expect(now.skills.map((s) => s.path).slice(0, 2)).toEqual(['skills/report/SKILL.md', 'skills/work/humanizer/SKILL.md'])
  })

  test('ranTeamSkill: a team skill in an answer that finished (a failed one and a scheduled one do not count); each person their own', async () => {
    ran('bob', 'skills/general/card-news/SKILL.md', 'error')
    expect((await get('bob')).ranTeamSkill).toBe(false)
    ran('bob', 'skills/general/card-news/SKILL.md', 'done', 'sched-examples')
    expect((await get('bob')).ranTeamSkill).toBe(false)
    ran('bob', 'skills/general/card-news/SKILL.md')
    expect((await get('bob')).ranTeamSkill).toBe(true)
    expect((await get('erin')).ranTeamSkill).toBe(false)
    expect((await get('dana')).ranTeamSkill).toBe(false)
  })

  test('nothing owner-only: a saved profile is one boolean; no file names; the welcome state and the install stay 403 for a member', async () => {
    await h.api('dana').call(API.saveCompanyProfile, { body: { website: 'https://canary-profile.example', oneLine: '원두를 매주 볶는 로스터리 CANARY-PROFILE-1', products: '원두', audience: '사무실', tone: [], avoid: '', sources: [] } })
    for (const who of ['bob', 'alice', 'dana']) {
      const r = await h.req(who, '/api/skills/examples')
      expect(r.status).toBe(200)
      const text = await r.text()
      const body = JSON.parse(text) as TeamPrepared
      expect(Object.keys(body).sort()).toEqual(['hasProfile', 'landing', 'ranTeamSkill', 'skills', 'teamFolder'])
      expect(body.hasProfile).toBe(true)
      for (const leak of ['CANARY-PROFILE-1', 'canary-profile.example', '회사 소개.md', '견적서', '회의록', 'site-1.png', brand]) expect({ who, leak, found: text.includes(leak) }).toEqual({ who, leak, found: false })
    }
    expect((await h.req('bob', '/api/onboarding/welcome')).status).toBe(403)
    expect((await h.req('bob', '/api/onboarding/packs')).status).toBe(403)
    expect((await h.req('bob', '/api/onboarding/packs/work/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skills: ['humanizer'] }) })).status).toBe(403)
    expect((await h.req(null, '/api/skills/examples')).status).toBe(401)
  })

  test('a count is reused for a while: a change made around the file layer waits; the person\'s own change drops theirs at once, someone else\'s does not', async () => {
    const before = { ...DOCUMENT_COUNT_CACHE }
    try {
      expect((await get('bob')).teamFolder?.files).toBe(3)
      expect((await getCached('dana')).teamFolder?.files).toBe(3)
      // on disk only (no change anyone hears of): the reused counts stand
      put(`${folder}/회사 자료/새 자료.md`)
      expect((await getCached('bob')).teamFolder?.files).toBe(3)
      // dana saves a file in the team folder through the file screen: her count is read again, bob's is reused
      await h.api('dana').call(API.saveContent, { body: { path: `${folder}/회의록/2026-11-10.md`, content: '# 회의', baseSha256: null } })
      expect((await getCached('dana')).teamFolder?.files).toBe(5)
      expect((await getCached('bob')).teamFolder?.files).toBe(3)
      // bob's own save drops his
      await h.api('bob').call(API.saveContent, { body: { path: `${folder}/회의록/2026-11-11.md`, content: '# 회의', baseSha256: null } })
      expect((await getCached('bob')).teamFolder?.files).toBe(6)
      // a save elsewhere is no change of the team folder
      put(`${folder}/회사 자료/또 다른 자료.md`)
      await h.api('bob').call(API.saveContent, { body: { path: 'users/bob/memo.md', content: 'x', baseSha256: null } })
      expect((await getCached('bob')).teamFolder?.files).toBe(6)
      // after the time: read again
      DOCUMENT_COUNT_CACHE.ttlMs = 0
      expect((await getCached('bob')).teamFolder?.files).toBe(7)
    } finally {
      Object.assign(DOCUMENT_COUNT_CACHE, before)
      for (const f of ['회사 자료/새 자료.md', '회사 자료/또 다른 자료.md', '회의록/2026-11-10.md', '회의록/2026-11-11.md']) rm(`${folder}/${f}`)
      rm('users/bob/memo.md')
    }
  })

  test('a team group that is gone: no team folder', async () => {
    const g = readWelcome(h.ctx)!.teamGroup!
    const keep = h.ctx.db.query('SELECT folder_id FROM groups WHERE id = ?').get(g.id) as { folder_id: string }
    h.ctx.db.query('UPDATE groups SET folder_id = NULL WHERE id = ?').run(g.id)
    try {
      expect((await get('dana')).teamFolder).toBeNull()
    } finally { h.ctx.db.query('UPDATE groups SET folder_id = ? WHERE id = ?').run(keep.folder_id, g.id) }
  })
})
