// Onboarding stream C: the recommended skill packs (server/src/onboarding/skill-packs.ts,
// POST /api/onboarding/packs/:id/install; since docs/DECISIONS.md "DS3" the general pack and the work pack, the four
// skills with a known origin). Installed as the admin who asks, in the team language (English when the pack has none),
// idempotent, never replacing a file someone edited, owners and admins only, and every skill loads with its form and
// no loader warning. The marketing and hr packs are gone: their ids are not found.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { checkSkill, listSkills, skillIssues } from '../../server/src/chat/skills'
import { setSetting } from '../../server/src/admin/settings'
import { earlierPackTexts, SKILL_PACKS } from '../../server/src/onboarding/skill-packs'
import { PROFILE_PATH } from '../../server/src/onboarding/profile'

let h: Harness
afterEach(async () => { await h?.close() })

const NAMES = ['card-news', 'intro-deck', 'promo-video']
const install = (c: { try: (m: string, p: string, b?: unknown) => Promise<{ status: number; body: any }> }, id = 'general') => c.try('POST', `/api/onboarding/packs/${id}/install`)

async function setup() {
  h = await harness('c-onboarding-pack')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  return { owner, ada, mia, root: h.ctx.files.fx.root }
}

test('an admin installs the pack: Korean skills that load with their forms, no team folders', async () => {
  const { ada, mia, root } = await setup()
  const r = await install(ada.client)
  expect(r.status).toBe(200)
  expect(r.body.locale).toBe('ko')
  expect(r.body.skills.map((s: any) => s.name).sort()).toEqual(NAMES)
  for (const s of r.body.skills) {
    expect(s).toEqual({ name: s.name, path: `skills/general/${s.name}/SKILL.md`, status: 'created' })
    expect(fs.readFileSync(path.join(root, s.path), 'utf8')).toBe(SKILL_PACKS.general.skills.ko![s.name]!)
  }
  expect(r.body.folders).toBeUndefined()
  expect(fs.existsSync(path.join(root, 'shared/브랜드'))).toBe(false)

  // a member sees all three, each with a form, and nobody gets a loader warning
  const member = h.ctx.files.principal(mia.id)
  const skills = listSkills(h.ctx.files, member).filter((s) => s.path.startsWith('skills/general/'))
  expect(skills.map((s) => s.name).sort()).toEqual(NAMES)
  for (const s of skills) expect(s.inputs?.length).toBeGreaterThan(0)
  expect(skillIssues(h.ctx.files, member)).toEqual([])
  expect(skillIssues(h.ctx.files, h.ctx.files.principal(ada.id))).toEqual([])

  // written as the admin: the skills/ change audit names them, and the install has its own row
  const changes = h.ctx.db.query("SELECT actor_id, target FROM audit_log WHERE action = 'skills.change'").all() as { actor_id: string; target: string }[]
  expect(changes.filter((c) => c.target.endsWith('/SKILL.md')).map((c) => c.actor_id)).toEqual(NAMES.map(() => ada.id))
  const row = h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'onboarding.pack_install'").get() as { actor_id: string; target: string; detail: string }
  expect(row.actor_id).toBe(ada.id)
  expect(JSON.parse(row.detail)).toEqual({ pack: 'general', locale: 'ko', created: 3, present: 0, kept: 0, blocked: 0 })
})

test('the work pack: natural writing, with its form', async () => {
  const { owner, root } = await setup()
  const r = await install(owner, 'work')
  expect(r.status).toBe(200)
  expect(r.body.skills).toEqual([{ name: 'humanizer', path: 'skills/work/humanizer/SKILL.md', status: 'created' }])
  expect(fs.readFileSync(path.join(root, 'skills/work/humanizer/SKILL.md'), 'utf8')).toBe(SKILL_PACKS.work.skills.ko!.humanizer!)
})

test('installing again changes nothing, keeps an edited skill and brings back a deleted one', async () => {
  const { owner, root } = await setup()
  expect((await install(owner)).status).toBe(200)
  const edited = path.join(root, 'skills/general/card-news/SKILL.md')
  const mine = fs.readFileSync(edited, 'utf8').replace('# 카드뉴스', '# 카드뉴스 (우리 팀 버전)')
  expect(mine).not.toBe(fs.readFileSync(edited, 'utf8'))
  fs.writeFileSync(edited, mine)
  fs.rmSync(path.join(root, 'skills/general/promo-video'), { recursive: true })
  const versions = () => (h.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions').get() as { n: number }).n
  const before = versions()

  const again = await install(owner)
  expect(again.status).toBe(200)
  const status = Object.fromEntries(again.body.skills.map((s: any) => [s.name, s.status]))
  expect(status).toEqual({ 'card-news': 'kept', 'intro-deck': 'present', 'promo-video': 'created' })
  expect(fs.readFileSync(edited, 'utf8')).toBe(mine)
  expect(versions()).toBe(before) // nothing was overwritten, so no old version was kept either

  const third = await install(owner)
  expect(third.body.skills.filter((s: any) => s.status !== 'present').map((s: any) => s.name)).toEqual(['card-news'])
})

test('a file an earlier release installed (no title line) is untouched: present, not kept, and not replaced', async () => {
  const { owner, mia, root } = await setup()
  expect((await install(owner)).status).toBe(200)
  // what an earlier release of the pack wrote: the same text without its title line
  const old: Record<string, string> = {}
  for (const name of NAMES) {
    const abs = path.join(root, `skills/general/${name}/SKILL.md`)
    const [earlier] = earlierPackTexts(SKILL_PACKS.general.skills.ko![name]!)
    expect(earlier, name).toBeDefined()
    expect(earlier!.includes('title:'), name).toBe(false)
    fs.writeFileSync(abs, earlier!)
    old[name] = earlier!
  }
  // and one of them edited by the team since
  const edited = path.join(root, 'skills/general/promo-video/SKILL.md')
  fs.writeFileSync(edited, old['promo-video']!.replace('# 홍보 영상', '# 홍보 영상 (우리 팀)'))
  const again = await install(owner)
  const status = Object.fromEntries(again.body.skills.map((s: any) => [s.name, s.status]))
  expect(status).toEqual({ ...Object.fromEntries(NAMES.map((n) => [n, 'present'])), 'promo-video': 'kept' })
  // nothing replaced: those skills show their name until someone adds the line
  expect(fs.readFileSync(path.join(root, 'skills/general/card-news/SKILL.md'), 'utf8')).toBe(old['card-news']!)
  const listed = await mia.client.call('GET', '/api/skills')
  expect(listed.items.find((s: any) => s.name === 'card-news').title).toBeUndefined()
  // a fresh install has the titles
  fs.rmSync(path.join(root, 'skills/general/card-news'), { recursive: true })
  await install(owner)
  expect((await mia.client.call('GET', '/api/skills')).items.find((s: any) => s.name === 'card-news').title).toBe('카드뉴스')
})

test('members cannot install; an unknown pack, the removed marketing and hr packs included, is not found', async () => {
  const { owner, mia, root } = await setup()
  expect((await install(mia.client)).status).toBe(403)
  expect(fs.existsSync(path.join(root, 'skills/general'))).toBe(false)
  for (const id of ['sales', 'marketing', 'hr']) expect((await install(owner, id)).status).toBe(404)
  expect(fs.existsSync(path.join(root, 'skills/marketing'))).toBe(false)
  expect(fs.existsSync(path.join(root, 'skills/hr'))).toBe(false)
})

test('a team in a language the pack does not have gets English skills', async () => {
  const { owner, root } = await setup()
  setSetting(h.ctx.db, 'defaultLocale', 'ja')
  const r = await install(owner)
  expect(r.body.locale).toBe('en')
  expect(fs.readFileSync(path.join(root, 'skills/general/card-news/SKILL.md'), 'utf8')).toBe(SKILL_PACKS.general.skills.en['card-news']!)
})

test('a name taken by something else is left alone and reported', async () => {
  const { owner, root } = await setup()
  fs.mkdirSync(path.join(root, 'skills/general/promo-video/SKILL.md'), { recursive: true })
  const r = await install(owner)
  expect(r.status).toBe(200)
  expect(r.body.skills.find((s: any) => s.name === 'promo-video').status).toBe('blocked')
  expect(r.body.skills.filter((s: any) => s.status === 'created')).toHaveLength(2)
})

test('a team skill that already has a pack skill\'s name blocks it: "/<name>" would run either one', async () => {
  const { owner, ada, root } = await setup()
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
  put('skills/card-news/SKILL.md', '---\nname: card-news\ndescription: our own cards\n---\nOURS\n')
  put('skills/영업/deck.md', '---\nname: Intro-Deck\ndescription: legacy, another case\n---\nOURS\n')
  // an admin's personal skill of the same name only takes the team skill's place for that admin: no clash for the team
  put(`users/${ada.id}/skills/promo-video/SKILL.md`, '---\nname: promo-video\ndescription: mine\n---\nMINE\n')
  const r = await install(ada.client)
  expect(r.status).toBe(200)
  const by = Object.fromEntries(r.body.skills.map((s: any) => [s.name, s]))
  expect(by['card-news']).toEqual({ name: 'card-news', path: 'skills/general/card-news/SKILL.md', status: 'blocked', sameNameAs: 'skills/card-news/SKILL.md' })
  expect(by['intro-deck']).toMatchObject({ status: 'blocked', sameNameAs: 'skills/영업/deck.md' })
  expect(by['promo-video'].status).toBe('created')
  expect(fs.existsSync(path.join(root, 'skills/general/card-news'))).toBe(false)
  expect(fs.readFileSync(path.join(root, 'skills/card-news/SKILL.md'), 'utf8')).toContain('OURS')
  // once the other skill is renamed, installing again adds the pack's (and its own installed skills are no clash)
  fs.renameSync(path.join(root, 'skills/card-news'), path.join(root, 'skills/our-cards'))
  fs.writeFileSync(path.join(root, 'skills/our-cards/SKILL.md'), '---\nname: our-cards\ndescription: our own cards\n---\nOURS\n')
  const again = await install(owner)
  expect(again.body.skills.find((s: any) => s.name === 'card-news').status).toBe('created')
  expect(again.body.skills.filter((s: any) => s.status === 'present')).toHaveLength(1)
})

test('the Korean and English titles', () => {
  const titles = (id: 'general' | 'work', locale: 'ko' | 'en') => Object.fromEntries(Object.entries(SKILL_PACKS[id].skills[locale]!).map(([name, text]) => [name, (checkSkill(text, `skills/${id}/${name}/SKILL.md`) as { title?: string }).title]))
  expect(titles('general', 'ko')).toEqual({ 'card-news': '카드뉴스', 'promo-video': '홍보 영상', 'intro-deck': '회사 소개서' })
  expect(titles('general', 'en')).toEqual({ 'card-news': 'Promo cards', 'promo-video': 'Promo video', 'intro-deck': 'Company profile' })
  expect(titles('work', 'ko')).toEqual({ humanizer: '자연스러운 글' })
  expect(titles('work', 'en')).toEqual({ humanizer: 'Natural writing' })
})

test('every pack text, in every language, loads as a skill with a valid form', () => {
  for (const id of ['general', 'work'] as const) {
    for (const [locale, texts] of Object.entries(SKILL_PACKS[id].skills)) {
      for (const [name, text] of Object.entries(texts!)) {
        const r = checkSkill(text, `skills/${id}/${name}/SKILL.md`)
        expect(r.ok && r.name === name && !r.badInputs && r.inputs!.length > 0, `${locale}/${name}`).toBe(true)
        // a title people read (the folder name stays the name "/<name>" runs), and the description starts with it
        expect(r.ok && !!r.title && r.title !== name && r.description.startsWith(`${r.title} — `), `${locale}/${name}`).toBe(true)
        // the company profile reaches the AI as its own block; a skill names it without the tag's brackets, which the
        // prompt would neutralize inside a skill
        expect(text.includes('<company_profile'), `${locale}/${name}`).toBe(false)
      }
    }
  }
})

test('with a saved company profile: the install leaves it alone, and it is no skill', async () => {
  const { owner, ada, mia, root } = await setup()
  const saved = await owner.try('PUT', '/api/onboarding/profile', {
    website: 'https://www.acme.example/', oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans\nFan filters', audience: 'Small offices',
    tone: ['friendly', 'plain'], avoid: 'Superlatives', sources: [],
  })
  expect(saved.status).toBe(200)
  const file = path.join(root, PROFILE_PATH)
  const before = fs.readFileSync(file, 'utf8')
  expect((await install(ada.client)).status).toBe(200)
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
  const member = h.ctx.files.principal(mia.id)
  expect(listSkills(h.ctx.files, member).some((s) => s.path === PROFILE_PATH)).toBe(false)
  expect(skillIssues(h.ctx.files, member)).toEqual([])
})
