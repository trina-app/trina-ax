// Onboarding stream C: the recommended marketing skill pack (server/src/onboarding/skill-packs.ts,
// POST /api/onboarding/packs/:id/install). Installed as the admin who asks, in the team language (English when the
// pack has none), idempotent, never replacing a file someone edited, owners and admins only, and every skill loads
// with its form and no loader warning.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { checkSkill, listSkills, skillIssues } from '../../server/src/chat/skills'
import { setSetting } from '../../server/src/admin/settings'
import { earlierPackTexts, SKILL_PACKS } from '../../server/src/onboarding/skill-packs'
import { PROFILE_PATH } from '../../server/src/onboarding/profile'
import { CompanyProfileResponse, packFolderKind, profilePrefill } from '@mycel/shared/api'

let h: Harness
afterEach(async () => { await h?.close() })

const NAMES = ['ad-copy', 'brand-review', 'campaign-plan', 'competitor-brief', 'content-draft', 'seo-brief', 'weekly-report']
const install = (c: { try: (m: string, p: string, b?: unknown) => Promise<{ status: number; body: any }> }, id = 'marketing') => c.try('POST', `/api/onboarding/packs/${id}/install`)

async function setup() {
  h = await harness('c-onboarding-pack')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  return { owner, ada, mia, root: h.ctx.files.fx.root }
}

test('an admin installs the pack: Korean skills that load with their forms, and the team folders', async () => {
  const { ada, mia, root } = await setup()
  const r = await install(ada.client)
  expect(r.status).toBe(200)
  expect(r.body.locale).toBe('ko')
  expect(r.body.skills.map((s: any) => s.name).sort()).toEqual(NAMES)
  for (const s of r.body.skills) {
    expect(s).toEqual({ name: s.name, path: `skills/marketing/${s.name}/SKILL.md`, status: 'created' })
    expect(fs.readFileSync(path.join(root, s.path), 'utf8')).toBe(SKILL_PACKS.marketing.skills.ko![s.name]!)
  }
  expect(r.body.folders).toEqual(['브랜드', '캠페인', '보고서', '경쟁사'].map((f) => ({ path: `shared/${f}`, status: 'created' })))
  for (const f of r.body.folders) expect(fs.statSync(path.join(root, f.path)).isDirectory()).toBe(true)

  // a member sees all seven, each with a form, and nobody gets a loader warning
  const member = h.ctx.files.principal(mia.id)
  const skills = listSkills(h.ctx.files, member).filter((s) => s.path.startsWith('skills/marketing/'))
  expect(skills.map((s) => s.name).sort()).toEqual(NAMES)
  for (const s of skills) expect(s.inputs?.length).toBeGreaterThan(0)
  expect(skillIssues(h.ctx.files, member)).toEqual([])
  expect(skillIssues(h.ctx.files, h.ctx.files.principal(ada.id))).toEqual([])
  const listed = await mia.client.call('GET', '/api/skills')
  const comp = listed.items.find((s: any) => s.name === 'competitor-brief')
  expect(comp.inputs[0]).toMatchObject({ name: 'website', required: true })

  // written as the admin: the skills/ change audit names them, and the install has its own row
  const changes = h.ctx.db.query("SELECT actor_id, target FROM audit_log WHERE action = 'skills.change'").all() as { actor_id: string; target: string }[]
  expect(changes.filter((c) => c.target.endsWith('/SKILL.md')).map((c) => c.actor_id)).toEqual(NAMES.map(() => ada.id))
  const row = h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'onboarding.pack_install'").get() as { actor_id: string; target: string; detail: string }
  expect(row.actor_id).toBe(ada.id)
  expect(JSON.parse(row.detail)).toEqual({ pack: 'marketing', locale: 'ko', created: 11, present: 0, kept: 0, blocked: 0 })
})

test('installing again changes nothing, keeps an edited skill and brings back a deleted one', async () => {
  const { owner, root } = await setup()
  expect((await install(owner)).status).toBe(200)
  const edited = path.join(root, 'skills/marketing/ad-copy/SKILL.md')
  const mine = fs.readFileSync(edited, 'utf8').replace('# 광고 문구', '# 광고 문구 (우리 팀 버전)')
  fs.writeFileSync(edited, mine)
  fs.rmSync(path.join(root, 'skills/marketing/seo-brief'), { recursive: true })
  const versions = () => (h.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions').get() as { n: number }).n
  const before = versions()

  const again = await install(owner)
  expect(again.status).toBe(200)
  const status = Object.fromEntries(again.body.skills.map((s: any) => [s.name, s.status]))
  expect(status).toEqual({ 'ad-copy': 'kept', 'content-draft': 'present', 'campaign-plan': 'present', 'seo-brief': 'created', 'competitor-brief': 'present', 'brand-review': 'present', 'weekly-report': 'present' })
  expect(again.body.folders.every((f: any) => f.status === 'present')).toBe(true)
  expect(fs.readFileSync(edited, 'utf8')).toBe(mine)
  expect(versions()).toBe(before) // nothing was overwritten, so no old version was kept either

  const third = await install(owner)
  expect(third.body.skills.filter((s: any) => s.status !== 'present').map((s: any) => s.name)).toEqual(['ad-copy'])
})

test('a file an earlier release installed (no title line) is untouched: present, not kept, and not replaced', async () => {
  const { owner, mia, root } = await setup()
  expect((await install(owner)).status).toBe(200)
  // what the first release of the pack wrote: the same text without its title line
  const old: Record<string, string> = {}
  for (const name of NAMES) {
    const abs = path.join(root, `skills/marketing/${name}/SKILL.md`)
    const [earlier] = earlierPackTexts(SKILL_PACKS.marketing.skills.ko![name]!)
    expect(earlier, name).toBeDefined()
    expect(earlier!.includes('title:'), name).toBe(false)
    fs.writeFileSync(abs, earlier!)
    old[name] = earlier!
  }
  // and one of them edited by the team since
  const edited = path.join(root, 'skills/marketing/brand-review/SKILL.md')
  fs.writeFileSync(edited, old['brand-review']!.replace('# 브랜드 톤 검토', '# 브랜드 톤 검토 (우리 팀)'))
  const again = await install(owner)
  const status = Object.fromEntries(again.body.skills.map((s: any) => [s.name, s.status]))
  expect(status).toEqual({ ...Object.fromEntries(NAMES.map((n) => [n, 'present'])), 'brand-review': 'kept' })
  // nothing replaced: those skills show their name until someone adds the line
  expect(fs.readFileSync(path.join(root, 'skills/marketing/ad-copy/SKILL.md'), 'utf8')).toBe(old['ad-copy']!)
  const listed = await mia.client.call('GET', '/api/skills')
  expect(listed.items.find((s: any) => s.name === 'ad-copy').title).toBeUndefined()
  // a fresh install has the titles
  fs.rmSync(path.join(root, 'skills/marketing/ad-copy'), { recursive: true })
  await install(owner)
  expect((await mia.client.call('GET', '/api/skills')).items.find((s: any) => s.name === 'ad-copy').title).toBe('광고 문구')
})

test('members cannot install; an unknown pack is not found', async () => {
  const { owner, mia, root } = await setup()
  expect((await install(mia.client)).status).toBe(403)
  expect(fs.existsSync(path.join(root, 'skills/marketing'))).toBe(false)
  expect(fs.existsSync(path.join(root, 'shared/브랜드'))).toBe(false)
  expect((await install(owner, 'sales')).status).toBe(404)
})

test('a team in a language the pack does not have gets English skills and folders in its own language', async () => {
  const { owner, root } = await setup()
  setSetting(h.ctx.db, 'defaultLocale', 'ja')
  const r = await install(owner)
  expect(r.body.locale).toBe('en')
  expect(fs.readFileSync(path.join(root, 'skills/marketing/ad-copy/SKILL.md'), 'utf8')).toBe(SKILL_PACKS.marketing.skills.en['ad-copy']!)
  expect(r.body.folders.map((f: any) => f.path)).toEqual(['shared/ブランド', 'shared/キャンペーン', 'shared/レポート', 'shared/競合'])
})

test('a name taken by something else is left alone and reported', async () => {
  const { owner, root } = await setup()
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true })
  fs.writeFileSync(path.join(root, 'shared/브랜드'), 'a file, not a folder')
  fs.mkdirSync(path.join(root, 'skills/marketing/brand-review/SKILL.md'), { recursive: true })
  const r = await install(owner)
  expect(r.status).toBe(200)
  expect(r.body.folders[0]).toEqual({ path: 'shared/브랜드', status: 'blocked' })
  expect(r.body.skills.find((s: any) => s.name === 'brand-review').status).toBe('blocked')
  expect(fs.readFileSync(path.join(root, 'shared/브랜드'), 'utf8')).toBe('a file, not a folder')
  expect(r.body.skills.filter((s: any) => s.status === 'created')).toHaveLength(6)
})

test('a team skill that already has a pack skill\'s name blocks it: "/<name>" would run either one', async () => {
  const { owner, ada, root } = await setup()
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
  put('skills/ad-copy/SKILL.md', '---\nname: ad-copy\ndescription: our own ad copy\n---\nOURS\n')
  put('skills/영업/brief.md', '---\nname: SEO-Brief\ndescription: legacy, another case\n---\nOURS\n')
  // an admin's personal skill of the same name only takes the team skill's place for that admin: no clash for the team
  put(`users/${ada.id}/skills/weekly-report/SKILL.md`, '---\nname: weekly-report\ndescription: mine\n---\nMINE\n')
  const r = await install(ada.client)
  expect(r.status).toBe(200)
  const by = Object.fromEntries(r.body.skills.map((s: any) => [s.name, s]))
  expect(by['ad-copy']).toEqual({ name: 'ad-copy', path: 'skills/marketing/ad-copy/SKILL.md', status: 'blocked', sameNameAs: 'skills/ad-copy/SKILL.md' })
  expect(by['seo-brief']).toMatchObject({ status: 'blocked', sameNameAs: 'skills/영업/brief.md' })
  expect(by['weekly-report'].status).toBe('created')
  expect(fs.existsSync(path.join(root, 'skills/marketing/ad-copy'))).toBe(false)
  expect(fs.readFileSync(path.join(root, 'skills/ad-copy/SKILL.md'), 'utf8')).toContain('OURS')
  // once the other skill is renamed, installing again adds the pack's (and its own installed skills are no clash)
  fs.renameSync(path.join(root, 'skills/ad-copy'), path.join(root, 'skills/our-ads'))
  fs.writeFileSync(path.join(root, 'skills/our-ads/SKILL.md'), '---\nname: our-ads\ndescription: our own ad copy\n---\nOURS\n')
  const again = await install(owner)
  expect(again.body.skills.find((s: any) => s.name === 'ad-copy').status).toBe('created')
  expect(again.body.skills.filter((s: any) => s.status === 'present')).toHaveLength(5)
})

test('the Korean and English titles', () => {
  const titles = (locale: 'ko' | 'en') => Object.fromEntries(Object.entries(SKILL_PACKS.marketing.skills[locale]!).map(([name, text]) => [name, (checkSkill(text, `skills/marketing/${name}/SKILL.md`) as { title?: string }).title]))
  expect(titles('ko')).toEqual({ 'ad-copy': '광고 문구', 'content-draft': '블로그·SNS 초안', 'campaign-plan': '캠페인 기획', 'seo-brief': 'SEO 기획서', 'competitor-brief': '경쟁사 분석', 'brand-review': '브랜드 톤 검토', 'weekly-report': '주간 보고' })
  expect(titles('en')).toEqual({ 'ad-copy': 'Ad copy', 'content-draft': 'Blog and social draft', 'campaign-plan': 'Campaign plan', 'seo-brief': 'SEO brief', 'competitor-brief': 'Competitor brief', 'brand-review': 'Brand voice review', 'weekly-report': 'Weekly report' })
})

test('every pack text, in every language, loads as a skill with a valid form', () => {
  for (const [locale, texts] of Object.entries(SKILL_PACKS.marketing.skills)) {
    expect(Object.keys(texts!).sort(), locale).toEqual(NAMES)
    for (const [name, text] of Object.entries(texts!)) {
      const r = checkSkill(text, `skills/marketing/${name}/SKILL.md`)
      expect(r.ok && r.name === name && !r.badInputs && r.inputs!.length > 0, `${locale}/${name}`).toBe(true)
      // a title people read (the folder name stays the name "/<name>" runs), and the description starts with it
      expect(r.ok && !!r.title && r.title !== name && r.description.startsWith(`${r.title} — `), `${locale}/${name}`).toBe(true)
      // the company profile reaches the AI as its own block; a skill names it without the tag's brackets, which the
      // prompt would neutralize inside a skill
      expect(text.includes('<company_profile'), `${locale}/${name}`).toBe(false)
    }
  }
})

test('with a saved company profile: the install leaves it alone, it is no skill, and it fills every form field that asks', async () => {
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

  // what a member's form gets (GET /api/onboarding/profile through the shared contract and prefill helper)
  const prefill = profilePrefill(CompanyProfileResponse.parse(await mia.client.call('GET', '/api/onboarding/profile')).profile)
  const asked = listSkills(h.ctx.files, member).filter((s) => s.path.startsWith('skills/marketing/')).flatMap((s) => s.inputs ?? []).flatMap((i) => (i.prefill ? [i.prefill] : []))
  expect(new Set(asked)).toEqual(new Set(['company.products', 'company.audience', 'company.tone', 'company.avoid', 'company.website']))
  for (const key of asked) expect(prefill[key], key).toBeTruthy()
  expect(prefill['company.products']).toBe('Desk fans\nFan filters')
  expect(prefill['company.tone']).toBe('friendly, plain')
})

test('the team folders come from the shared table (same names, same order); the Files screen knows each one', () => {
  expect(SKILL_PACKS.marketing.folders).toEqual({
    ko: ['브랜드', '캠페인', '보고서', '경쟁사'],
    en: ['Brand', 'Campaigns', 'Reports', 'Competitors'],
    id: ['Merek', 'Kampanye', 'Laporan', 'Pesaing'],
    ja: ['ブランド', 'キャンペーン', 'レポート', '競合'],
    es: ['Marca', 'Campañas', 'Informes', 'Competencia'],
  })
  expect(packFolderKind('shared/브랜드')).toBe('brand')
  expect(packFolderKind('shared/Campaigns/')).toBe('campaigns')
  expect(packFolderKind('shared/レポート')).toBe('reports')
  // a decomposed Korean name (as a Mac may write it) is the same folder
  expect(packFolderKind('shared/' + '경쟁사'.normalize('NFD'))).toBe('competitors')
  expect(packFolderKind('shared/브랜드/로고')).toBeNull()
  expect(packFolderKind('users/ada/브랜드')).toBeNull()
  expect(packFolderKind('shared/brand')).toBeNull()
  expect(packFolderKind('')).toBeNull()
})
