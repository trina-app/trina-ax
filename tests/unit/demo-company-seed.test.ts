// `bun run demo:company` / `bun run demo:seed --content <dir>` (scripts/demo/company/): a fictional company from a demo
// content folder (scripts/demo/company/README.md; docs/DECISIONS.md "Demo content: the mechanism is open, a company's
// content is a folder"). Seeds a real app (all route modules, temp team folder) from the open example, Acme, and checks
// what the content promises (company.json `checks`: who opens which file, who sees which team skills), the owner
// account, a second run, the demo file, the format's refusals, and the starter's options and environment.
//
// MYCEL_DEMO_CONTENT=<dir> runs the same seed checks on that content too (a company's private content, say).
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, ApiClient, ApiError, DemoFile } from '../../shared/src/api'
import { checkSkill } from '../../server/src/chat/skills'
import { DEMO_PASSWORD, ensureOwnerPassword, seedDemo } from '../../scripts/demo/seed'
import { CONTENT_ENV, contentDir, DEFAULT_CONTENT, loadContent, type DemoContent } from '../../scripts/demo/company/content'
import { dataHome, demoEnv, lanAddresses, NETWORK_WARNING, options, PRIVATE_CONTENT, resolveContent } from '../../scripts/demo/company/start'
import { harness, SETUP_TOKEN, type Harness } from './a-lib'
import { seedStoryState } from '../../scripts/demo/company/story-state'
import { STEEPLING_LOCALES, STEEPLING_SKILLS, steeplingWords, writeSteepling } from '../../scripts/demo/steepling/make'
import { en as steeplingEn } from '../../scripts/demo/steepling/strings/en'
import { FREE_ROAM_LOCALES } from '../../web/src/lib/freeRoam'
import { FLOORS, MESSAGES, NEW_PEOPLE } from '../../scripts/demo/steepling/rich'

const OWNER_PASSWORD = 'a random owner password for tests 1'
const BASE = 'http://team.localhost'
const CONTENTS = [DEFAULT_CONTENT, ...(process.env[CONTENT_ENV] ? [path.resolve(process.env[CONTENT_ENV]!)] : [])]

/** can this person open the file (read its bytes)? */
async function opens(api: ApiClient, file: string): Promise<boolean> {
  try { await api.call(API.download, { query: { path: file, disposition: 'attachment' } }); return true } catch { return false }
}
const skillNames = async (api: ApiClient) => (await api.call(API.listSkills)).items.map((s) => s.name).sort()

for (const dir of CONTENTS) {
  describe(`seeding the demo content ${path.basename(dir)}`, () => {
    let h: Harness
    let c: DemoContent
    const appFetch = ((url: string | URL | Request, init?: RequestInit) => h.app.fetch(new Request(url, init), { ip: '127.0.0.1', via: 'test' })) as typeof fetch
    const as = async (username: string) => {
      const password = username === c.company.owner.username ? OWNER_PASSWORD : DEMO_PASSWORD
      const r = await new ApiClient({ baseUrl: BASE, fetch: appFetch }).call(API.login, { body: { username, password, client: 'web', tokenMode: 'bearer' } })
      return new ApiClient({ baseUrl: BASE, fetch: appFetch, token: r.token! })
    }
    afterAll(async () => { await h?.close() })

    test('the team, its owner account and its people, the groups, every file, the profile and the memories', async () => {
      c = loadContent(dir)
      h = await harness(`demo-content-${c.company.id}`)
      const r = await seedDemo({ baseUrl: BASE, setupToken: SETUP_TOKEN, fetch: appFetch, company: c.seed, ownerPassword: OWNER_PASSWORD, locale: c.company.locale })
      expect(r.createdTeam).toBe(true)
      expect(r.people.length).toBe(c.company.people.length + 1)
      // the owner is an account of its own, never a demo person; nobody else is an owner or an admin
      expect(r.people.filter((p) => p.role !== 'member').map((p) => `${p.username}:${p.role}`)).toEqual([`${c.company.owner.username}:owner`])
      expect(c.demoFile().personas.map((p) => p.username)).not.toContain(c.company.owner.username)
      expect(r.groups).toEqual(c.company.groups.map((g) => g.name))
      expect(r.files.map((f) => f.path).sort()).toEqual([...c.files].sort())
      expect(r.files.every((f) => f.uploaded)).toBe(true)
      for (const f of r.files) expect(f.by, f.path).toBe(c.seed.uploaderOf(f.path))
      expect(r.profile).toBe(!!c.company.profile)
      const owner = await as(c.company.owner.username)
      const me = await owner.call(API.me)
      expect([me.team.name, me.user.role]).toEqual([c.company.teamName, 'owner'])
      if (c.company.profile) expect((await owner.call(API.getCompanyProfile)).profile?.oneLine).toBe(c.company.profile.oneLine)
      for (const m of c.company.memories) expect((await (await as(m.username)).call(API.listMemories, { query: { limit: 20 } })).items.map((x) => x.text)).toContain(m.text)
      // every demo person is a member: the public password reaches nothing an owner or admin could do
      for (const p of c.company.demo.personas) {
        const api = await as(p.username)
        expect((await api.call(API.me)).user.role, p.username).toBe('member')
        await expect(api.call(API.listUsers)).rejects.toThrow()
      }
      // the owner's password is not the public one
      await expect(new ApiClient({ baseUrl: BASE, fetch: appFetch }).call(API.login, { body: { username: c.company.owner.username, password: DEMO_PASSWORD, client: 'web', tokenMode: 'bearer' } })).rejects.toThrow()
    }, 180_000)

    test('what the content promises: who opens which file, who sees which team skills', async () => {
      expect(c.company.checks.length).toBeGreaterThan(0)
      for (const k of c.company.checks) {
        const api = await as(k.username)
        for (const f of k.opens) expect(await opens(api, f), `${k.username} opens ${f}`).toBe(true)
        for (const f of k.closed) expect(await opens(api, f), `${k.username} must not open ${f}`).toBe(false)
        if (k.skills) expect(await skillNames(api), k.username).toEqual([...k.skills].sort())
      }
    }, 120_000)

    test('the team skills in the files are skills', () => {
      for (const rel of c.files.filter((f) => /^skills\/.+\/SKILL\.md$/.test(f) && !f.startsWith('skills/work/'))) {
        const parsed = checkSkill(fs.readFileSync(path.join(c.filesDir, rel), 'utf8'), rel)
        expect(parsed.ok && parsed.title, rel).toBeTruthy()
      }
    })

    test('a second run only fills in what is missing; without its owner password it stops', async () => {
      const r = await seedDemo({ baseUrl: BASE, setupToken: null, fetch: appFetch, company: c.seed, ownerPassword: OWNER_PASSWORD, locale: c.company.locale })
      expect(r.createdTeam).toBe(false)
      expect(r.people.every((p) => !p.created)).toBe(true)
      expect(r.files.every((f) => !f.uploaded)).toBe(true)
      expect(r.profile).toBe(false)
      for (const m of c.company.memories) expect((await (await as(m.username)).call(API.listMemories, { query: { limit: 20 } })).items.filter((x) => x.text === m.text).length).toBe(1)
      expect((await (await as(c.company.owner.username)).call(API.listUsers)).items.length).toBe(c.company.people.length + 1)
      await expect(seedDemo({ baseUrl: BASE, setupToken: null, fetch: appFetch, company: c.seed })).rejects.toThrow(/cannot sign in/)
    }, 120_000)

    test('the demo file: the personas, the same question first for the lead and the CEO, a showcase prompt once recorded', () => {
      const d = DemoFile.parse(c.demoFile({ replays: null }))
      expect(d.password).toBe(DEMO_PASSWORD)
      expect(d.company).toBe(c.company.teamName)
      expect(d.replays).toBeUndefined()
      expect(d.personas.map((p) => p.questions)).toEqual(c.company.demo.personas.map((p) => p.questions))
      for (const p of d.personas.filter((x) => x.key !== 'newHire')) if (d.sameQuestion) expect(p.questions[0]).toBe(d.sameQuestion)
      const withReplays = c.demoFile()
      expect(withReplays.replays).toBe(c.recordingsDir)
      for (const p of withReplays.personas) {
        const shown = c.company.scenarios.filter((s) => s.kind === 'showcase' && s.username === p.username && fs.existsSync(path.join(c.recordingsDir, `${s.slug}.json`)))
        expect(p.questions).toEqual([...c.company.demo.personas.find((x) => x.key === p.key)!.questions, ...shown.map((s) => s.prompt)])
      }
    })
  })
}

// Steepling at the end of the scripted story "Mina's first day" (scripts/demo/steepling; the free-roam demo's snapshot is
// seeded from it). The content is made from the scripted demo's own strings, so the cast and names are the same; the
// seed here also runs the state a story ends in (rooms, chats, connections, the welcome inviter) through the builder's
// routes, which answer only with the demo file's builder: true (English; Korean is checked for the same structure).
for (const locale of STEEPLING_LOCALES) {
  describe(`Steepling at the end of the story (${locale})`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `steepling-${locale}-`))
    const c = loadContent(writeSteepling(locale, path.join(tmp, 'content')))
    const { story, more, rich } = steeplingWords(locale)
    let h: Harness
    const appFetch = ((url: string | URL | Request, init?: RequestInit) => h.app.fetch(new Request(url, init), { ip: '127.0.0.1', via: 'test' })) as typeof fetch
    const as = async (username: string) => {
      const password = username === c.company.owner.username ? OWNER_PASSWORD : DEMO_PASSWORD
      const r = await new ApiClient({ baseUrl: BASE, fetch: appFetch }).call(API.login, { body: { username, password, client: 'web', tokenMode: 'bearer' } })
      return new ApiClient({ baseUrl: BASE, fetch: appFetch, token: r.token! })
    }
    afterAll(async () => { await h?.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

    test('the scripted demo\'s cast, company, project and skills; the CEO owns the team; every address is .example', () => {
      expect(c.company.teamName).toBe(story.company)
      expect(c.company.locale).toBe(locale)
      const names = [c.company.owner.name, ...c.company.people.map((p) => p.name)].sort()
      expect(names).toEqual([...(['daniel', 'mina', 'sara', 'leo', 'tom', 'aiko', 'omar'] as const).map((id) => story.people[id].name), ...(Object.keys(NEW_PEOPLE) as (keyof typeof NEW_PEOPLE)[]).map((id) => rich[`${id}.name`])].sort())
      expect(c.company.owner).toMatchObject({ username: 'daniel', group: story.marketingGroup })
      expect(c.company.projects.map((p) => p.name)).toEqual([story.project.name, rich['p3.name'], rich['p4.name'], rich['p5.name']])
      expect(c.files).toContain(`projects/${story.project.name}/${story.paths.banner}`)
      expect(c.files.filter((f) => f.startsWith('skills/')).sort()).toEqual(STEEPLING_SKILLS.map((k) => `skills/${k}/SKILL.md`).sort())
      expect(c.company.freeRoam?.suggestions.length).toBeGreaterThanOrEqual(2)
      const text = JSON.stringify([c.company, c.fakes])
      for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) expect(m[0]).toMatch(/\.example$/)
      // the mail to Chris is in Mina's Sent, his reply in her inbox
      const box = c.fakes.gmail!
      expect(box.me.email).toBe('mina.lee@steepling.example')
      expect(box.messages.find((m) => m.labels?.includes('SENT'))?.subject).toBe(story.mail.plain.subject)
      expect(box.messages.some((m) => m.labels?.includes('INBOX') && m.body.includes(story.events.chrisReply))).toBe(true)
      expect(c.fakes.pictures.length).toBeGreaterThan(0)
      for (const rel of c.files.filter((f) => /^skills\/.+\/SKILL\.md$/.test(f))) {
        const parsed = checkSkill(fs.readFileSync(path.join(c.filesDir, rel), 'utf8'), rel)
        expect(parsed.ok && parsed.title, rel).toBeTruthy()
        // the language's own title, never the folder name (QA TC-5553: the ko team skill showed "social-posts")
        const slug = rel.split('/')[1]! as keyof typeof steeplingEn.skillTitles
        expect(parsed.ok && parsed.title, rel).not.toBe(slug)
        expect(parsed.ok && parsed.title, rel).toBe(more.skillTitles[slug])
      }
      if (locale === 'ko') expect(fs.readFileSync(path.join(c.filesDir, 'skills/social-posts/SKILL.md'), 'utf8')).toContain('\n  title: SNS 글 쓰기\n')
    })

    // the server seed runs for English only (CI time: it is the slow part); every other language has the same structure, checked
    // without a server below ("the richer Steepling, without a server": the same ids, people, rooms, messages, threads,
    // chats, files and fakes), and its own words, skills and paths here and there
    if (locale !== 'en') return
    test('seeded with the end of the story: checks, rooms, projects, shared chats, connections, the inviter', async () => {
      h = await harness(`demo-steepling-${locale}`, { demo: c.demoFile({ replays: null, builder: true }) })
      const r = await seedDemo({ baseUrl: BASE, setupToken: SETUP_TOKEN, fetch: appFetch, company: c.seed, ownerPassword: OWNER_PASSWORD, locale: c.company.locale })
      expect(r.files.every((f) => f.uploaded)).toBe(true)
      const s = await seedStoryState({ baseUrl: BASE, content: c, ownerPassword: OWNER_PASSWORD, fetch: appFetch })
      expect(Object.keys(s.rooms).sort()).toEqual(c.company.rooms.map((x) => x.slug).sort())
      expect(s.connections.length).toBe(c.company.connections.length)

      for (const k of c.company.checks) {
        const api = await as(k.username)
        for (const f of k.opens) expect(await opens(api, f), `${k.username} opens ${f}`).toBe(true)
        for (const f of k.closed) expect(await opens(api, f), `${k.username} must not open ${f}`).toBe(false)
        if (k.skills) expect(await skillNames(api), k.username).toEqual([...k.skills].sort())
      }

      const mina = await as('mina')
      // her rooms: everyone, #Marketing, the DMs, the private channels, the handover group DM. Read but for what the content
      // marks unread: Nadia's mention in Customer voice, Sara's reply in the Social calendar thread, Omar's DM
      // plus each project's own chat room (the seed opens one per project), which is not in the content's room list
      const listed = (await mina.call(API.listRooms)).items
      const rooms = listed.filter((r) => r.project?.room !== true)
      expect(rooms.length).toBe(c.company.rooms.length)
      expect(listed.length - rooms.length).toBe(c.company.projects.length)
      const unread = (slug: string) => { const r = rooms.find((x) => x.id === s.rooms[slug]!.id)!; return [r.unreadCount, r.threadsUnread] }
      for (const x of c.company.rooms) expect(unread(x.slug), x.slug).toEqual(x.slug === 'customer-voice' || x.slug === 'dm-omar' ? [1, 0] : x.slug === 'social-calendar' ? [0, 1] : [0, 0])
      // Activity 1 (Sara's reply under the banner answer) + Chats › Mentions & threads 2 (those two) + Omar's DM, by
      // design: the room rows are not in Activity (QA TC-5700); nothing at the build's time
      const inbox = await mina.call(API.listNotifications, { query: { limit: 100 } })
      expect(inbox.noticeUnreadCount).toBe(1)
      expect(inbox.roomUnreadCount).toBe(2)
      expect(inbox.unreadCount).toBe(3)
      expect(inbox.items.every((n) => Date.parse(n.createdAt) < Date.now() - 10 * 60_000)).toBe(true)
      // the thread replies are in their threads
      const cv = (await mina.call(API.listRoomMessages, { params: { id: s.rooms['customer-voice']!.id }, query: { limit: 200 } })).items
      expect(cv.reduce((n, m) => n + (m.thread?.replyCount ?? 0), 0)).toBe(2)
      const texts = async (id: string) => (await mina.call(API.listRoomMessages, { params: { id }, query: { limit: 200 } })).items.map((m) => m.body)
      const all = await texts(s.rooms.everyone!.id)
      expect(all.some((t) => t.includes(story.events.ceoShoutout))).toBe(true)
      const mkt = await texts(s.rooms.marketing!.id)
      expect(mkt.some((t) => t.includes(story.events.ceoShip))).toBe(true)
      expect(mkt.some((t) => t.includes(story.events.chrisReply))).toBe(true)
      const dm = await texts(s.rooms['dm-sara']!.id)
      expect(dm.join('\n')).toMatch(/\]\(\/projects\/[0-9a-f-]+\)/)
      // the seed's "joined the team" lines are gone; the times are the story's (the shoutout came after the welcome)
      const everyone = (await mina.call(API.listRoomMessages, { params: { id: s.rooms.everyone!.id }, query: { limit: 200 } })).items
      const times = everyone.map((m) => Date.parse(m.createdAt))
      expect([...times].sort((a, b) => a - b)).toEqual(times)
      expect(Date.now() - times[0]!).toBeGreaterThan(24 * 3600_000)

      // the project, and the others' chats shared in it
      const projects = (await mina.call(API.listProjects)).items
      expect(projects.map((p) => p.name).sort()).toEqual(c.company.projects.map((p) => p.name).sort())
      for (const x of c.company.chats.filter((y) => y.project)) {
        const project = projects.find((p) => p.name === x.project)!
        const inProject = (await mina.call(API.listChats, { query: { limit: 50, projectId: project.id } })).items.map((y) => y.title)
        expect(inProject, x.slug).toContain(x.title)
      }
      const mine = (await mina.call(API.listChats, { query: { limit: 50 } })).items.map((x) => x.title)
      expect(mine).toContain(story.answers.company.prompt)
      expect(mine).toContain(story.answers.mail.prompt)

      // her connections and her welcome card's inviter
      const rows = h.ctx.db.query("SELECT google_app, scope FROM integrations WHERE owner_user_id = 'mina' OR scope = 'team'").all() as { google_app: string | null; scope: string }[]
      expect(rows.map((x) => x.google_app ?? x.scope).sort()).toEqual(['gmail', 'team'])
      expect((h.ctx.db.query("SELECT count(*) n FROM drive_connections WHERE user_id = 'mina'").get() as { n: number }).n).toBe(1)
      expect((await mina.call(API.getMemberWelcome)).welcome?.inviter?.name).toBe(story.people.sara.name)
      // no secret of a connection is a real one
      expect(JSON.stringify(h.ctx.db.query('SELECT secret_enc FROM integrations').all())).not.toMatch(/sk-ant|ya29\./)
    }, 240_000)

    test('the builder\'s routes: the owner only', async () => {
      const mina = await as('mina')
      await expect(mina.call(API.demoBuilderWelcome, { body: { userId: 'mina', inviterId: 'sara' } })).rejects.toThrow()
      // GET /api/demo says the builder is on (demo-gate never takes such an instance)
      expect((await mina.call(API.demoInfo)).builder).toBe(true)
    })
  })
}

// The richer Steepling (scripts/demo/steepling/rich.ts and strings/rich.<locale>.ts): one structure for both languages,
// words that fit a chat, a file or an answer, skills that name files that are there, and enough of everything
describe('the richer Steepling, without a server', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'steepling-rich-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const made = Object.fromEntries(STEEPLING_LOCALES.map((l) => [l, loadContent(writeSteepling(l, path.join(tmp, l)))])) as Record<(typeof STEEPLING_LOCALES)[number], DemoContent>
  const shape = (c: DemoContent) => ({
    people: c.company.people.map((p) => p.username),
    rooms: c.company.rooms.map((r) => [r.slug, r.kind, r.people ?? null, r.messages.map((m) => [m.from, m.minutesAgo, m.reactions.length, m.files.length, m.unread ?? false, (m.thread ?? []).map((t) => [t.from, t.minutesAgo, t.unread ?? false])])]),
    chats: c.company.chats.map((x) => [x.slug, x.username, x.turns.length, x.thread?.length ?? 0]),
    projects: c.company.projects.map((p) => [p.by, p.members.length, p.channel]),
    files: c.files.length, gmail: c.fakes.gmail?.messages.map((m) => [m.threadId, m.labels]), drive: c.fakes.drive?.files.length,
  })

  test('every language has the structure of en; no empty line or TODO in any', () => {
    expect(STEEPLING_LOCALES).toEqual(['en', 'ko', 'ja', 'zh', 'es', 'id'])
    for (const l of STEEPLING_LOCALES) expect(shape(made[l]), l).toEqual(shape(made.en))
    // the free-roam sign-in page offers the languages a snapshot can be in
    expect([...FREE_ROAM_LOCALES]).toEqual([...STEEPLING_LOCALES])
    for (const l of STEEPLING_LOCALES) for (const [k, v] of Object.entries(steeplingWords(l).rich)) {
      expect(v.trim(), k).not.toBe('')
      expect(v, k).not.toMatch(/\bTODO\b/)
    }
    // every id the words name became a name or a path
    for (const l of STEEPLING_LOCALES) expect(JSON.stringify(made[l].company)).not.toMatch(/@\{|\{file:[^}/]+\}|\{project:p\d\}/)
  })

  test('short enough to be cheap to read: messages, answers, files', () => {
    for (const l of STEEPLING_LOCALES) {
      const c = made[l]
      const words = Object.keys(MESSAGES).map((id) => steeplingWords(l).rich[id as keyof typeof MESSAGES])
      for (const t of words) expect(t.length, t).toBeLessThanOrEqual(300)
      for (const id of ['c.p3.1', 'c.p4.1', 'c.p5.1', 'c.p5.2', 'c.who.1'] as const) expect(steeplingWords(l).rich[`${id}.answer`].length, `${l} ${id}`).toBeLessThanOrEqual(1500)
      for (const f of c.files.filter((x) => /\.(md|csv)$/.test(x))) expect(fs.statSync(path.join(c.filesDir, f)).size, `${l} ${f}`).toBeLessThanOrEqual(4096)
    }
  })

  test('every team path a skill names is there, in its language', () => {
    for (const l of STEEPLING_LOCALES) {
      const c = made[l]
      for (const rel of c.files.filter((f) => f.startsWith('skills/'))) {
        for (const [, p] of fs.readFileSync(path.join(c.filesDir, rel), 'utf8').matchAll(/`((?:shared|groups|projects)\/[^`]+)`/g)) {
          expect(c.files.includes(p!) || c.files.some((f) => f.startsWith(p!.endsWith('/') ? p! : `${p}/`)), `${l} ${rel}: ${p}`).toBe(true)
        }
      }
    }
  })

  test('the content clears the snapshot\'s floors (a thin build fails there too)', () => {
    for (const l of STEEPLING_LOCALES) {
      const c = made[l].company
      const mine = c.rooms.filter((r) => r.kind === 'all' || r.kind === 'team' || r.people?.includes('mina'))
      expect(c.projects.length).toBeGreaterThanOrEqual(FLOORS.projects)
      expect(mine.length).toBeGreaterThanOrEqual(FLOORS.rooms)
      expect(mine.filter((r) => r.kind !== 'dm' && (r.kind !== 'group' || r.name)).length).toBeGreaterThanOrEqual(FLOORS.channels)
      expect(mine.reduce((n, r) => n + r.messages.length, 0)).toBeGreaterThanOrEqual(FLOORS.roomMessages)
      expect(mine.reduce((n, r) => n + r.messages.filter((m) => m.thread?.length).length, 0)).toBeGreaterThanOrEqual(FLOORS.threads)
      expect(mine.reduce((n, r) => n + r.messages.reduce((x, m) => x + (m.thread?.length ?? 0), 0), 0)).toBeGreaterThanOrEqual(FLOORS.threadReplies)
      expect(c.checks[0]!.opens.length).toBeGreaterThanOrEqual(FLOORS.filesOpened)
      expect(c.checks[0]!.skills?.length).toBe(FLOORS.skills)
      expect(new Set(made[l].fakes.gmail!.messages.map((m) => m.threadId)).size).toBeGreaterThanOrEqual(FLOORS.gmailThreads)
      // the planned unread: Nadia's mention, Sara's thread reply, Omar's DM; nothing else
      const unread = c.rooms.flatMap((r) => r.messages.flatMap((m) => [...(m.unread ? [r.slug] : []), ...(m.thread ?? []).filter((t) => t.unread).map(() => `${r.slug} thread`)]))
      expect(unread.sort()).toEqual(['customer-voice', 'dm-omar', 'social-calendar thread'])
    }
  })

  // the bar's chips are what a visitor would type: short, no file names, no "skill" (QA 2026-11-22 F13)
  test('the suggestion prompts are short plain requests in every language', () => {
    for (const l of STEEPLING_LOCALES) {
      const list = made[l].company.freeRoam?.suggestions ?? []
      expect(list.length).toBeGreaterThanOrEqual(2)
      for (const s of list) {
        expect(s.prompt.length).toBeLessThanOrEqual(80)
        expect(s.prompt).not.toMatch(/\.(md|csv|xlsx)\b/i)
        expect(s.prompt).not.toMatch(/스킬|skill|スキル|技能|habilidad|keahlian/i)
      }
    }
  })

  test('the English strings use US spelling', () => {
    expect(JSON.stringify(made.en)).not.toMatch(/summaris|finalis|flavour|favourite/i)
  })

  test('es calls the posts "Publicaciones", not "Posts", in the chip label', () => {
    for (const s of made.es.company.freeRoam?.suggestions ?? []) expect(s.label).not.toMatch(/\bposts?\b/i)
  })
})

describe('the builder\'s routes are not there without the demo file\'s builder: true', () => {
  test('404 for the owner on a demo server without it, and on a server without a demo', async () => {
    const c = loadContent(DEFAULT_CONTENT)
    for (const demo of [c.demoFile({ replays: null }), undefined]) {
      const h = await harness(`demo-no-builder-${demo ? 'demo' : 'none'}`, demo ? { demo } : {})
      try {
        const appFetch = ((url: string | URL | Request, init?: RequestInit) => h.app.fetch(new Request(url, init), { ip: '127.0.0.1', via: 'test' })) as typeof fetch
        await seedDemo({ baseUrl: BASE, setupToken: SETUP_TOKEN, fetch: appFetch, company: c.seed, ownerPassword: OWNER_PASSWORD, locale: 'en' })
        const r = await new ApiClient({ baseUrl: BASE, fetch: appFetch }).call(API.login, { body: { username: c.company.owner.username, password: OWNER_PASSWORD, client: 'web', tokenMode: 'bearer' } })
        const owner = new ApiClient({ baseUrl: BASE, fetch: appFetch, token: r.token! })
        const users = (await owner.call(API.listUsers)).items
        const err = await owner.call(API.demoBuilderWelcome, { body: { userId: users[1]!.id, inviterId: users[2]!.id } }).then(() => null, (e) => e as ApiError)
        expect(err?.status).toBe(404)
        // the free-roam audit's two (QA TC-5614, TC-5618): not there either
        const id = '01a1f758-2656-7058-84d5-497e9999f691'
        for (const call of [
          () => owner.call(API.demoBuilderThreadTimes, { body: { chatId: id, times: [{ replyId: id, at: new Date().toISOString() }] } }),
          () => owner.call(API.demoBuilderFileTimes, { body: { times: [{ path: 'shared/a.md', at: new Date().toISOString() }], hideFromRecent: ['skills'] } }),
        ]) expect((await call().then(() => null, (e) => e as ApiError))?.status).toBe(404)
      } finally { await h.close() }
    }
  }, 180_000)
})

describe('the open example, Acme', () => {
  const c = loadContent(DEFAULT_CONTENT)
  test('has none of the end-of-story sections', () => {
    expect([c.company.projects, c.company.rooms, c.company.chats, c.company.connections, c.company.welcome]).toEqual([[], [], [], [], []])
    expect(c.company.freeRoam).toBeUndefined()
    expect(c.fakes).toEqual({ gmail: null, drive: null, pictures: [], banner: false })
    expect(c.avatars).toEqual([])
  })
  test('is small, plain English, every person and file fictional, and the default', () => {
    expect(contentDir(null, {})).toBe(DEFAULT_CONTENT)
    expect(c.company.locale).toBe('en')
    expect(c.company.people.length).toBeLessThanOrEqual(8)
    expect(c.company.groups.map((g) => g.name)).toEqual(['Marketing', 'Sales'])
    expect(c.company.demo.personas.map((p) => p.key)).toEqual(['newHire', 'lead', 'ceo'])
    // one restricted folder: the same question gives the CEO, the lead and the new hire different answers
    expect(c.company.demo.sameQuestion).toBe("Summarize this quarter's budget")
    // no brand of this product's editions in the open example
    const all = [JSON.stringify(c.company), ...c.files.filter((f) => f.endsWith('.md') && !f.startsWith('skills/work/')).map((f) => fs.readFileSync(path.join(c.filesDir, f), 'utf8')),
      ...fs.readdirSync(c.recordingsDir).map((n) => fs.readFileSync(path.join(c.recordingsDir, n), 'utf8'))].join('\n')
    expect(all).not.toMatch(/트리나|trina/i)
    expect(c.files.filter((f) => /\.(png|jpe?g|gif|webp|pptx)$/i.test(f))).toEqual([])
  })
})

describe('the format refuses a content folder that does not hold together', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-content-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const base = JSON.parse(fs.readFileSync(path.join(DEFAULT_CONTENT, 'company.json'), 'utf8'))
  let n = 0
  /** a copy of Acme with company.json changed (and files/recordings as given) */
  const variant = (change: (j: any) => void, o: { files?: Record<string, string>; recordings?: Record<string, unknown> } = {}) => {
    const dir = path.join(tmp, `v${++n}`)
    fs.cpSync(path.join(DEFAULT_CONTENT, 'files'), path.join(dir, 'files'), { recursive: true })
    for (const [rel, text] of Object.entries(o.files ?? {})) { fs.mkdirSync(path.dirname(path.join(dir, 'files', rel)), { recursive: true }); fs.writeFileSync(path.join(dir, 'files', rel), text) }
    if (o.recordings) {
      fs.mkdirSync(path.join(dir, 'recordings'))
      for (const [name, r] of Object.entries(o.recordings)) fs.writeFileSync(path.join(dir, 'recordings', name), JSON.stringify(r))
    }
    const j = structuredClone(base)
    change(j)
    fs.writeFileSync(path.join(dir, 'company.json'), JSON.stringify(j))
    return dir
  }
  const problems = (dir: string) => { try { loadContent(dir); return '' } catch (e) { return (e as Error).message } }

  test('a copy loads; a missing folder or company.json, an unknown field, another format do not', () => {
    expect(problems(variant(() => {}))).toBe('')
    expect(problems(path.join(tmp, 'nothing'))).toMatch(/there is no folder/)
    const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty)
    expect(problems(empty)).toMatch(/company\.json cannot be read/)
    expect(problems(variant((j) => { j.extra = 1 }))).toMatch(/company\.json/)
    expect(problems(variant((j) => { j.format = 2 }))).toMatch(/format/)
  })

  test('every name it uses must be one of its people, groups or demo people', () => {
    expect(problems(variant((j) => { j.people[0].group = 'Finance' }))).toContain('dana: no group "Finance"')
    expect(problems(variant((j) => { j.rules[0].rules[0].user = 'nobody' }))).toContain('rule groups: no person "nobody"')
    expect(problems(variant((j) => { j.rules[0].rules[0] = { group: 'Finance', access: 'read' } }))).toContain('no group "Finance"')
    expect(problems(variant((j) => { j.uploaders[0].username = 'nobody' }))).toContain('no account "nobody"')
    expect(problems(variant((j) => { j.memories = [{ username: 'nobody', text: 'x' }] }))).toContain('memories: no person "nobody"')
    expect(problems(variant((j) => { j.people.push({ username: 'Sam', name: 'Twice', group: null }) }))).toContain('is there twice')
    expect(problems(variant((j) => { j.scenarios[0].username = 'leo' }))).toContain('"leo" is not a demo persona')
    expect(problems(variant((j) => { delete j.scenarios[2].daysAgo }))).toContain('needs daysAgo')
    expect(problems(variant((j) => { j.scenarios.push({ ...j.scenarios[0] }) }))).toContain('is there twice')
  })

  test('the owner can never be a demo person, a person never the owner or an admin', () => {
    expect(problems(variant((j) => { j.demo.personas[0].username = 'acme-admin' }))).toContain('the owner can never be a demo person')
    expect(problems(variant((j) => { j.people[0].role = 'admin' }))).toMatch(/company\.json people\.0/)
    expect(problems(variant((j) => { j.demo.personas[1].username = j.demo.personas[0].username }))).toContain('each person once')
  })

  test('files only at team paths the seed can upload to; pack skills that exist', () => {
    expect(problems(variant(() => {}, { files: { 'other/x.md': 'x' } }))).toContain('files/other/x.md: sample files go under')
    // a person's own files: under users/<an account>/ only (QA TC-5886)
    expect(problems(variant(() => {}, { files: { 'users/alex/x.md': 'x' } }))).toBe('')
    expect(problems(variant(() => {}, { files: { 'users/nobody/x.md': 'x' } }))).toContain('files/users/nobody/x.md: no account "nobody"')
    expect(problems(variant(() => {}, { files: { 'users/x.md': 'x' } }))).toContain('files/users/x.md: sample files go under')
    expect(problems(variant(() => {}, { files: { 'groups/Finance/x.md': 'x' } }))).toContain('no group "Finance"')
    expect(problems(variant((j) => { j.packSkills[0].skills.push('no-such-skill') }))).toContain('resources/skill-packs/work/en/no-such-skill/SKILL.md is not in this repository')
    expect(problems(variant((j) => { j.settings.answerStepLimit = 3 }))).toMatch(/settings/)
    expect(problems(variant((j) => { j.rules[0].path = '../outside' }))).toMatch(/a team path/)
  })

  test('recordings: each one of a scenario, by its person, with its prompt', () => {
    const rec = JSON.parse(fs.readFileSync(path.join(DEFAULT_CONTENT, 'recordings', 'lead-tasks.json'), 'utf8'))
    expect(problems(variant(() => {}, { recordings: { 'lead-tasks.json': rec } }))).toBe('')
    expect(problems(variant(() => {}, { recordings: { 'other.json': rec } }))).toContain('recordings/other.json: no scenario "other"')
    expect(problems(variant(() => {}, { recordings: { 'lead-tasks.json': { ...rec, prompt: 'something else' } } }))).toContain('(record it again)')
    expect(problems(variant(() => {}, { recordings: { 'lead-tasks.json': { ...rec, events: [] } } }))).toContain('recordings/lead-tasks.json: not a recording')
    expect(problems(variant((j) => { j.demo.personas[1].questions = ['a', 'b', 'c', 'd', 'e', 'f'] }))).toContain('at most 6')
  })
})

describe('the starter', () => {
  test('options: the default ports, --content, --local, --record, refusals', () => {
    expect(options([])).toEqual({ port: 19830, relayPort: 19831, data: null, content: null, requireContent: null, local: false, record: false })
    expect(options(['--port', '19900', '--relay-port', '19901', '--local', '--content', 'x', '--data', '/d'])).toMatchObject({ port: 19900, relayPort: 19901, local: true, content: 'x', data: '/d' })
    expect(options(['--record']).record).toBe(true)
    for (const a of [['--port', '80'], ['--port', '19830', '--relay-port', '19830'], ['--port'], ['--content'], ['--what', '1']]) expect(() => options(a)).toThrow()
  })

  test('the content: --content, else MYCEL_DEMO_CONTENT, else Acme; the data folder follows the content', () => {
    expect(resolveContent(options([]), {})).toBe(DEFAULT_CONTENT)
    expect(resolveContent(options([]), { [CONTENT_ENV]: '/env/content' })).toBe('/env/content')
    expect(resolveContent(options(['--content', '/flag/content']), { [CONTENT_ENV]: '/env/content' })).toBe('/flag/content')
    const acme = loadContent(DEFAULT_CONTENT)
    expect(dataHome(options([]), acme, '/home/x')).toBe('/home/x/.acmedemo')
    expect(dataHome(options(['--data', '/d']), acme, '/home/x')).toBe('/d')
  })

  test('`bun run demo:trina` needs its content and says where it is (not in this repository)', () => {
    const o = options(['--require-content', 'trina'])
    expect(() => resolveContent(o, {})).toThrow(PRIVATE_CONTENT.trina!)
    expect(PRIVATE_CONTENT.trina).toContain('trina-ax-core')
    expect(PRIVATE_CONTENT.trina).toContain('editions/trina/demo')
    expect(resolveContent(o, { [CONTENT_ENV]: '/private/demo' })).toBe('/private/demo')
    expect(resolveContent(options(['--require-content', 'trina', '--content', '/c']), {})).toBe('/c')
    expect(() => resolveContent(options(['--require-content', 'other']), {})).toThrow(/needs its content/)
    expect(JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', '..', 'package.json'), 'utf8')).scripts['demo:trina']).toContain('--require-content trina')
  })

  test('the owner\'s password: random, kept in the demo folder for this Mac user only, the same on the next start', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-owner-'))
    try {
      const a = ensureOwnerPassword(home)
      expect(a.created).toBe(true)
      expect(a.password.length).toBeGreaterThanOrEqual(20)
      expect(a.password).not.toBe(DEMO_PASSWORD)
      expect(fs.statSync(a.file).mode & 0o777).toBe(0o600)
      expect(ensureOwnerPassword(home)).toEqual({ ...a, created: false })
      expect(ensureOwnerPassword(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-owner-'))).password).not.toBe(a.password)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('the start-up warning names every network, not only the Wi-Fi', () => {
    expect(NETWORK_WARNING).toContain("anyone on any network this Mac is on (Wi-Fi, VPN, Tailscale) can use this demo with this Mac's Claude login")
  })

  test('environment: the demo flag and LAN origins; nothing of another server\'s configuration, not even the content variable', () => {
    const o = { ...options([]), home: '/home/x/.acmedemo', id: 'acme' }
    const env = demoEnv(o, '/home/x/.acmedemo/demo.json', ['192.168.0.12'], { PATH: '/bin', MYCEL_MODE: 'prod', MYCEL_CONFIG: '/etc/x.json', [CONTENT_ENV]: '/c', TEAM_AX_DEV_DIR: '/other', HOME: '/home/x' })
    for (const k of ['MYCEL_MODE', 'MYCEL_CONFIG', CONTENT_ENV]) expect(env[k]).toBeUndefined()
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/x', TEAM_AX_DEV_DIR: '/home/x/.acmedemo', TEAM_AX_DEV_PORT: '19830', TEAM_AX_DEV_RELAY_PORT: '19831', MYCEL_HOST: '0.0.0.0', MYCEL_DEMO: '/home/x/.acmedemo/demo.json' })
    expect(env.MYCEL_PUBLIC_ORIGINS!.split(',')).toEqual(['http://localhost:19830', 'http://127.0.0.1:19830', 'http://acme.localhost:19831', 'http://192.168.0.12:19830'])
    const local = demoEnv({ ...o, local: true }, 'f', ['192.168.0.12'], {})
    expect(local.MYCEL_HOST).toBe('127.0.0.1')
    expect(local.MYCEL_PUBLIC_ORIGINS).not.toContain('192.168.0.12')
  })

  test('LAN addresses: IPv4, not loopback or link-local, private ranges first', () => {
    const i = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }) as never
    expect(lanAddresses({ lo0: [i('127.0.0.1', true)], en0: [i('100.64.1.2'), i('192.168.1.20')], en1: [i('169.254.3.4')], utun: [{ address: 'fe80::1', family: 'IPv6', internal: false } as never] })).toEqual(['192.168.1.20', '100.64.1.2'])
  })
})
