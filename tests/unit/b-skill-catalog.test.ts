// Onboarding v6: the kept skills' catalog and 내 스킬 (docs/DECISIONS.md "W6"; server/src/onboarding/skill-packs.ts,
// routes/onboarding-packs.ts, skills/share.ts stopSkillShareCheck):
//   - GET /api/onboarding/packs (owners and admins; members 403): every kept skill in the catalog's order, its title in
//     the team's language, one line in the caller's, whether the team has it (its path, or a team skill of its name),
//     the visual ones, its example (every kept skill has one in Korean and English, made from the SKILL.md it ships
//     with: an image in the web build, a text without its front matter; id, ja, es get the English one), its source
//     (the English humanizer the only link out), and whether a company profile is saved; every skill of every pack is in
//     the catalog (a skill shipped later is a row);
//   - POST /api/onboarding/packs/:id/install with `skills`: only those (a name not in the pack refused before anything
//     is written); the visual skills run the brand hook first (a hook that throws never stops the install); an owner's
//     install marks 내 스킬 done while the steps are under way (an admin's, a finished row's, an all-blocked one's: no);
//   - POST /api/skill-shares/:id/stop-check (the proposer; anyone else 404): a check still running ends now, ready with
//     nothing recommended, and a late answer changes nothing; a share no longer checking is returned as it is.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, PACK_EXAMPLE_LIMITS, type SkillShare } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { CATALOG, exampleBody, onVisualSkillInstall, PACK_EXAMPLES, packExample, SKILL_PACKS, skillPackCatalog } from '../../server/src/onboarding/skill-packs'
import { WELCOME_SETTING } from '../../server/src/onboarding/welcome'

setDefaultTimeout(60_000)
const json = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```'
const md = (n: string) => `---\nname: ${n}\ndescription: ${n} skill\n---\n# x\n1. Read the notes.\n`
const ROOT = path.join(import.meta.dir, '..', '..')

describe('the catalog (no server)', () => {
  test('every skill of every pack is in the catalog once, in the order 내 스킬 shows them; the visual ones are the general pack', () => {
    const packed = Object.entries(SKILL_PACKS).flatMap(([id, p]) => Object.keys(p.skills.en).map((n) => `${id}/${n}`)).sort()
    expect(CATALOG.map((c) => `${c.pack}/${c.name}`).sort()).toEqual(packed)
    expect(CATALOG.map((c) => c.name)).toEqual(['intro-deck', 'card-news', 'promo-video', 'humanizer'])
    expect(CATALOG.filter((c) => c.visual).map((c) => c.name)).toEqual(['intro-deck', 'card-news', 'promo-video'])
    // only the English humanizer links out (its MIT original); the Korean one is the company's own
    const humanizer = CATALOG.find((c) => c.name === 'humanizer')!
    expect(humanizer.source('ko')).toEqual({ kind: 'team_writing' })
    expect(humanizer.source('en')).toEqual({ kind: 'adapted', author: 'Siqi Chen', project: 'humanizer', license: 'MIT', url: 'https://github.com/blader/humanizer' })
    for (const c of CATALOG.filter((x) => x.name !== 'humanizer')) for (const l of ['ko', 'en'] as const) expect(c.source(l)).toEqual({ kind: 'team' })
  })

  test('an example: an image is the web build\'s file, a text loses its front matter; Korean or English (id, ja, es: English); a name without one: none', () => {
    expect(packExample('ko', 'card-news')).toEqual({ kind: 'image', url: '/skill-examples/ko/card-news.webp' })
    expect(packExample('en', 'intro-deck')).toEqual({ kind: 'image', url: '/skill-examples/en/intro-deck.webp' })
    for (const l of ['id', 'ja', 'es'] as const) {
      expect(packExample(l, 'promo-video')).toEqual({ kind: 'image', url: '/skill-examples/en/promo-video.webp' })
      expect(packExample(l, 'humanizer')).toEqual(packExample('en', 'humanizer'))
    }
    const ko = packExample('ko', 'humanizer')
    expect(ko?.kind).toBe('text')
    const md = ko!.kind === 'text' ? ko!.markdown : ''
    expect(md.startsWith('**전**')).toBe(true)
    expect(md).toContain('**후**')
    expect(md).not.toMatch(/fictional|skillHash/)
    expect(packExample('ko', 'no-such-skill')).toBeNull()
    const before = { ko: { ...PACK_EXAMPLES.ko }, en: { ...PACK_EXAMPLES.en } }
    try {
      PACK_EXAMPLES.en.humanizer = { kind: 'text', text: '---\nfictional: true\ncompany: Example Coffee\nmade: 2026-11-08\nengine: claude\nskillHash: abc\n---\n## Before\nWe deliver innovative solutions.\n\n## After\nWe roast beans every week.\n' }
      expect(packExample('ja', 'humanizer')).toEqual({ kind: 'text', markdown: '## Before\nWe deliver innovative solutions.\n\n## After\nWe roast beans every week.' })
      delete PACK_EXAMPLES.ko['card-news']
      expect(packExample('ko', 'card-news')).toBeNull()
    } finally {
      PACK_EXAMPLES.ko = before.ko
      PACK_EXAMPLES.en = before.en
    }
    expect(exampleBody('no front matter')).toBe('no front matter')
  })

  test('every kept skill has its example in Korean and English, made from the SKILL.md it ships with, within the limits (an image: WebP 1280 px wide, ≤ 90 KB; a text: ≤ 900 / 1,200 characters, its front matter complete)', () => {
    /** what an example records of its SKILL.md: the first 12 hex digits of its sha256 */
    const skillHash = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12)
    const stale = (locale: string, name: string) => `${locale}/${name}: its SKILL.md changed after the example was made. Make the example again (examples/data/example-coffee/README.md) and record the new skillHash.`
    for (const locale of ['ko', 'en'] as const) {
      expect(Object.keys(PACK_EXAMPLES[locale]).sort()).toEqual(CATALOG.map((c) => c.name).sort())
      for (const c of CATALOG) {
        const e = PACK_EXAMPLES[locale][c.name]!
        const skill = SKILL_PACKS[c.pack].skills[locale]![c.name]!
        // a picture for what is a picture anyway; the text skill draws in the page's own theme
        expect(e.kind).toBe(c.visual ? 'image' : 'text')
        if (e.kind === 'image') {
          const bytes = fs.readFileSync(path.join(ROOT, 'web/public/skill-examples', locale, `${c.name}.webp`))
          expect(bytes.length).toBeLessThanOrEqual(PACK_EXAMPLE_LIMITS.imageBytes)
          expect(webpWidth(bytes)).toBe(1280)
          if (e.skillHash !== skillHash(skill)) throw new Error(stale(locale, c.name))
        } else {
          const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(e.text)?.[1] ?? ''
          const meta = Object.fromEntries(front.split(/\r?\n/).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]))
          expect(meta).toMatchObject({ fictional: 'true', company: locale === 'ko' ? '예시커피' : 'Example Coffee' })
          expect(meta.made).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          expect(meta.engine).toBeTruthy()
          if (meta.skillHash !== skillHash(skill)) throw new Error(stale(locale, c.name))
          expect([...exampleBody(e.text)].length).toBeLessThanOrEqual(PACK_EXAMPLE_LIMITS.textChars[locale])
        }
      }
      // nothing else in the web build's example folder (a picture no skill names would ship unseen)
      expect(fs.readdirSync(path.join(ROOT, 'web/public/skill-examples', locale)).sort()).toEqual(CATALOG.filter((c) => c.visual).map((c) => `${c.name}.webp`).sort())
    }
    expect(fs.readdirSync(path.join(ROOT, 'web/public/skill-examples')).sort()).toEqual(['en', 'ko'])
  })
})

/** The width of a WebP picture (its VP8X, VP8L or VP8 header), or 0 when it is not one. */
function webpWidth(b: Buffer): number {
  if (b.subarray(0, 4).toString('latin1') !== 'RIFF' || b.subarray(8, 12).toString('latin1') !== 'WEBP') return 0
  const chunk = b.subarray(12, 16).toString('latin1')
  if (chunk === 'VP8X') return (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1
  if (chunk === 'VP8L') return ((b[21]! | (b[22]! << 8)) & 0x3fff) + 1
  if (chunk === 'VP8 ') return (b[26]! | (b[27]! << 8)) & 0x3fff
  return 0
}

describe('over the API', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness({ name: 'b-skill-catalog' })
    setSetting(h.ctx.db, 'defaultLocale', 'ko')
  })
  afterAll(async () => { await h?.close() })
  const post = (user: string, p: string, body?: unknown) => h.req(user, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const rm = (rel: string) => fs.rmSync(path.join(h.team, rel), { recursive: true, force: true })
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(h.team, rel)), { recursive: true }); fs.writeFileSync(path.join(h.team, rel), text) }

  test('members get 403; owners and admins the four kept skills: titles in the team\'s language, the caller\'s line, none in the team yet', async () => {
    expect((await h.req('alice', '/api/onboarding/packs')).status).toBe(403)
    expect((await post('bob', '/api/onboarding/packs/general/install', { skills: ['card-news'] })).status).toBe(403)
    for (const who of ['dana', 'carol']) {
      const c = await h.api(who).call(API.listSkillPacks)
      expect(c.profile).toBe(false)
      expect(c.skills.map((s) => [s.pack, s.name, s.path, s.title, s.inTeam, s.visual, s.example, s.locale])).toEqual([
        ['general', 'intro-deck', 'skills/general/intro-deck/SKILL.md', '회사 소개서', false, true, { kind: 'image', url: '/skill-examples/ko/intro-deck.webp' }, 'ko'],
        ['general', 'card-news', 'skills/general/card-news/SKILL.md', '카드뉴스', false, true, { kind: 'image', url: '/skill-examples/ko/card-news.webp' }, 'ko'],
        ['general', 'promo-video', 'skills/general/promo-video/SKILL.md', '홍보 영상', false, true, { kind: 'image', url: '/skill-examples/ko/promo-video.webp' }, 'ko'],
        ['work', 'humanizer', 'skills/work/humanizer/SKILL.md', '자연스러운 글', false, false, packExample('ko', 'humanizer'), 'ko'],
      ])
      expect(c.skills[3]!.example).toMatchObject({ kind: 'text', markdown: expect.stringContaining('11월 25일까지 hello@coffee.example') })
      expect(c.skills[0]!.description).toBe('회사 소개로 6~10장짜리 소개서를 만들어요')
      expect(c.skills[3]!.source).toEqual({ kind: 'team_writing' })
    }
    // the line in the caller's language, the title in the text the team gets
    const en = skillPackCatalog(h.ctx, 'dana', 'en')
    expect(en.skills[1]).toMatchObject({ title: '카드뉴스', description: 'Makes 5 square promo cards from the company intro' })
  })

  test('a team in a language the packs do not have: the English titles and the adapted humanizer\'s source', async () => {
    setSetting(h.ctx.db, 'defaultLocale', 'ja')
    try {
      const c = skillPackCatalog(h.ctx, 'dana', 'ja')
      expect(c.skills.map((s) => s.title)).toEqual(['Company profile', 'Promo cards', 'Promo video', 'Natural writing'])
      expect(c.skills.every((s) => s.locale === 'en')).toBe(true)
      // the English examples, made on "Example Coffee"
      expect(c.skills.map((s) => (s.example?.kind === 'image' ? s.example.url : s.example?.kind))).toEqual(['/skill-examples/en/intro-deck.webp', '/skill-examples/en/card-news.webp', '/skill-examples/en/promo-video.webp', 'text'])
      expect(c.skills[3]!.example).toMatchObject({ markdown: expect.stringContaining('hello@coffee.example') })
      expect(c.skills[3]!.source).toMatchObject({ kind: 'adapted', url: 'https://github.com/blader/humanizer' })
      expect(c.skills[3]!.description).toBe('AIが書いたように見える文章を、人が書いたように整えます')
    } finally { setSetting(h.ctx.db, 'defaultLocale', 'ko') }
  })

  test('install names its skills: only those go in; a name not in the pack is refused before anything is written; in the team by path or by name', async () => {
    const bad = await post('dana', '/api/onboarding/packs/general/install', { skills: ['card-news', 'humanizer'] })
    expect(bad.status).toBe(400)
    expect(fs.existsSync(path.join(h.team, 'skills/general/card-news'))).toBe(false)
    const r = await h.api('dana').call(API.installSkillPack, { params: { id: 'general' }, body: { skills: ['card-news'] } })
    expect(r.skills).toEqual([{ name: 'card-news', path: 'skills/general/card-news/SKILL.md', status: 'created' }])
    expect(fs.readFileSync(path.join(h.team, 'skills/general/card-news/SKILL.md'), 'utf8')).toBe(SKILL_PACKS.general.skills.ko!['card-news']!)
    expect(fs.existsSync(path.join(h.team, 'skills/general/intro-deck'))).toBe(false)
    // another team skill named "humanizer": the catalog counts it in, and an install is blocked with its path
    put('skills/mine/humanizer/SKILL.md', md('humanizer'))
    const c = await h.api('dana').call(API.listSkillPacks)
    expect(c.skills.filter((s) => s.inTeam).map((s) => s.name)).toEqual(['card-news', 'humanizer'])
    const w = await h.api('dana').call(API.installSkillPack, { params: { id: 'work' }, body: { skills: ['humanizer'] } })
    expect(w.skills).toEqual([{ name: 'humanizer', path: 'skills/work/humanizer/SKILL.md', status: 'blocked', sameNameAs: 'skills/mine/humanizer/SKILL.md' }])
    // a skill the team deleted earlier goes in again on a press that names it
    rm('skills/general/card-news')
    expect((await h.api('dana').call(API.installSkillPack, { params: { id: 'general' }, body: { skills: ['card-news'] } })).skills[0]!.status).toBe('created')
    // no body: the whole pack, as before
    expect((await h.api('dana').call(API.installSkillPack, { params: { id: 'general' }, body: {} })).skills.map((s) => [s.name, s.status])).toEqual([['card-news', 'present'], ['promo-video', 'created'], ['intro-deck', 'created']])
    const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'onboarding.pack_install' ORDER BY rowid DESC LIMIT 2").all() as { detail: string }[]
    expect(JSON.parse(audit[1]!.detail)).toMatchObject({ pack: 'general', skills: ['card-news'], created: 1 })
    expect(JSON.parse(audit[0]!.detail).skills).toBeUndefined()
    rm('skills/general'); rm('skills/work'); rm('skills/mine')
  })

  test('the visual skills run the brand hook first, once per install; natural writing does not; a hook that throws stops nothing', async () => {
    const calls: string[] = []
    let fail = false
    onVisualSkillInstall((_ctx, userId) => { calls.push(userId); if (fail) throw new Error('disk full') })
    await h.api('dana').call(API.installSkillPack, { params: { id: 'work' }, body: { skills: ['humanizer'] } })
    expect(calls).toEqual([])
    await h.api('carol').call(API.installSkillPack, { params: { id: 'general' }, body: { skills: ['intro-deck', 'promo-video'] } })
    expect(calls).toEqual(['carol'])
    fail = true
    const r = await h.api('dana').call(API.installSkillPack, { params: { id: 'general' }, body: { skills: ['card-news'] } })
    expect(r.skills[0]!.status).toBe('created')
    expect(calls).toEqual(['carol', 'dana'])
    fail = false
    rm('skills/general'); rm('skills/work')
  })

  test('a company profile saved: the catalog says so (내 스킬 checks the visual rows)', async () => {
    await h.api('dana').call(API.saveCompanyProfile, { body: { website: 'https://coffee.example', oneLine: '커피 로스터', products: '원두', audience: '사무실', tone: [], avoid: '', sources: [] } })
    expect((await h.api('dana').call(API.listSkillPacks)).profile).toBe(true)
  })

  test('the brand materials before a visual skill (a profile saved): on the owner\'s press they are placed (brandAt); an admin\'s press leaves them not done, for the owner', async () => {
    setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: new Date().toISOString(), steps: { profile: 'skipped', result: null, skills: null, files: null, invite: null } })
    const brandAt = () => (getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING) ?? {}).brandAt
    await h.api('carol').call(API.installSkillPack, { params: { id: 'general' }, body: { skills: ['promo-video'] } })
    expect(brandAt()).toBeUndefined()
    await h.api('dana').call(API.installSkillPack, { params: { id: 'general' }, body: { skills: ['card-news'] } })
    expect(typeof brandAt()).toBe('string')
    rm('skills/general')
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(WELCOME_SETTING)
  })

  test('an owner\'s install marks 내 스킬 done while the steps are under way; an admin\'s, an all-blocked one\'s and a finished row\'s do not', async () => {
    const row = (o: Record<string, unknown> = {}) => setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: new Date().toISOString(), steps: { profile: 'skipped', result: null, skills: null, files: null, invite: null }, ...o })
    const skills = () => (getSetting<{ steps: Record<string, unknown> }>(h.ctx.db, WELCOME_SETTING)!).steps.skills ?? null
    row()
    await h.api('carol').call(API.installSkillPack, { params: { id: 'work' }, body: { skills: ['humanizer'] } })
    expect(skills()).toBeNull()
    // blocked: nothing went in
    put('skills/x/card-news/SKILL.md', md('card-news'))
    expect((await h.api('dana').call(API.installSkillPack, { params: { id: 'general' }, body: { skills: ['card-news'] } })).skills[0]!.status).toBe('blocked')
    expect(skills()).toBeNull()
    await h.api('dana').call(API.installSkillPack, { params: { id: 'general' }, body: { skills: ['intro-deck'] } })
    expect(skills()).toBe('done')
    row({ finishedAt: '2026-11-01T00:00:00.000Z' })
    rm('skills/general/intro-deck')
    await h.api('dana').call(API.installSkillPack, { params: { id: 'general' }, body: { skills: ['intro-deck'] } })
    expect(skills()).toBeNull()
    rm('skills/general'); rm('skills/work'); rm('skills/x')
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(WELCOME_SETTING)
  })
})

describe('stop-check', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness({ name: 'b-skill-catalog-stop' })
    setSetting(h.ctx.db, 'defaultLocale', 'ko')
  })
  afterAll(async () => { await h?.close() })
  const post = (user: string, p: string) => h.req(user, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const judgeChat = (shareId: string) => (h.ctx.db.query('SELECT chat_id FROM skill_share_judges WHERE share_id = ?').get(shareId) as { chat_id: string } | null)?.chat_id ?? null
  /** the judge's answer message once its turn is over (the fake engine answers at once) */
  const judgeLeaf = async (shareId: string) => waitFor(() => {
    const chat = judgeChat(shareId)
    const r = chat ? h.ctx.db.query("SELECT m.id, m.status FROM chats c JOIN messages m ON m.id = c.active_leaf_id WHERE c.id = ? AND m.role = 'assistant'").get(chat) as { id: string; status: string } | null : null
    return r && r.status !== 'streaming' ? r.id : null
  }, { timeoutMs: 30_000 }) as Promise<string>
  const create = () => h.api('dana').call(API.createSkillShare, { body: { source: 'browser', where: '.claude', skills: [{ name: 'weekly-report', origin: 'user', files: [{ path: 'SKILL.md', text: md('weekly-report') }] }, { name: 'quote-draft', origin: 'user', files: [{ path: 'SKILL.md', text: md('quote-draft') }] }] } as never })

  test('a check still running ends now: ready, nothing recommended, audited; a late answer changes nothing; only its proposer', async () => {
    const s: SkillShare = await create()
    expect(s.status).toBe('checking')
    // the judge's turn still answering (as a slow engine would be at 30 seconds)
    const leaf = await judgeLeaf(s.id)
    h.ctx.db.query("UPDATE messages SET status = 'streaming', content = '' WHERE id = ?").run(leaf)
    expect((await post('carol', `/api/skill-shares/${s.id}/stop-check`)).status).toBe(404)
    expect((await post('alice', `/api/skill-shares/${s.id}/stop-check`)).status).toBe(404)
    const stopped = await h.api('dana').call(API.stopSkillShareCheck, { params: { id: s.id } })
    expect(stopped).toMatchObject({ status: 'ready', ai: 'failed' })
    expect(stopped.candidates.map((c) => [c.name, c.group, c.reason])).toEqual([['weekly-report', 'other', 'unjudged'], ['quote-draft', 'other', 'unjudged']])
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'skills.share_stop_check' AND target = ?").get(s.id)).toEqual({ n: 1 })
    // the answer arrives late: nothing is recommended by it
    h.ctx.db.query("UPDATE messages SET status = 'done', content = ? WHERE id = ?").run(json({ skills: [{ name: 'weekly-report', verdict: 'recommend', reason: 'team_any' }], rule: null }), leaf)
    const read = await h.api('dana').call(API.getSkillShare, { params: { id: s.id } })
    expect(read).toMatchObject({ status: 'ready', ai: 'failed' })
    expect(read.candidates.some((c) => c.group === 'recommended')).toBe(false)
    // it can be applied now
    const applied = await h.api('dana').call(API.applySkillShare, { params: { id: s.id }, body: { skills: [{ name: 'weekly-report', action: 'add' }], rule: false, tools: [] } })
    expect(applied.status).toBe('applied')
    // a share no longer checking comes back as it is, nothing audited again
    expect(await h.api('dana').call(API.stopSkillShareCheck, { params: { id: s.id } })).toMatchObject({ status: 'applied' })
    expect(h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'skills.share_stop_check'").get()).toEqual({ n: 1 })
  })

  test('an answer already in when the page stops: it is read, not thrown away', async () => {
    const s: SkillShare = await create()
    const leaf = await judgeLeaf(s.id)
    h.ctx.db.query("UPDATE messages SET status = 'done', content = ? WHERE id = ?").run(json({ skills: [{ name: 'quote-draft', verdict: 'recommend', reason: 'team_any' }], rule: null }), leaf)
    const r = await h.api('dana').call(API.stopSkillShareCheck, { params: { id: s.id } })
    expect(r).toMatchObject({ status: 'ready', ai: 'done' })
    expect(r.candidates.find((c) => c.name === 'quote-draft')?.group).toBe('recommended')
  })
})
