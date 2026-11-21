// Steepling at the END of "Mina's first day" (README.md): the demo content folder the free-roam demo's snapshot is
// seeded from (scripts/demo/free-roam/build-snapshot.ts), made from the scripted story's own words and pictures
// (scripts/demo/mina/strings/<locale>.ts, scripts/demo/mina/assets/) so the cast, names, rooms, project, skills, files and
// pictures are the scripted demo's by construction, plus the end of the story and a few lived-in rooms, chats and files
// (strings/<locale>.ts). The folder it writes is plain data in the format of scripts/demo/company/README.md.
//
//   bun scripts/demo/steepling/make.ts --locale en|ko|ja|zh|es|id --out <dir>
//
// Every person, company, number, address and file is fictional; every address is a reserved `.example` one.
import fs from 'node:fs'
import path from 'node:path'
import type { DemoContentCompany } from '../../../shared/src/api'
import type { FakeDrive, FakeGmail } from '../company/fakes'
import { TEMPLATES_FOLDER } from '../../../shared/src/folder-labels'
import { en as minaEn, type Strings } from '../mina/strings/en'
import { es as minaEs } from '../mina/strings/es'
import { id as minaId } from '../mina/strings/id'
import { ja as minaJa } from '../mina/strings/ja'
import { ko as minaKo } from '../mina/strings/ko'
import { zh as minaZh } from '../mina/strings/zh'
import { en, type FreeRoamStrings } from './strings/en'
import { es } from './strings/es'
import { id } from './strings/id'
import { ja } from './strings/ja'
import { ko } from './strings/ko'
import { zh } from './strings/zh'
import { richEn } from './strings/rich.en'
import { richEs } from './strings/rich.es'
import { richId } from './strings/rich.id'
import { richJa } from './strings/rich.ja'
import { richKo } from './strings/rich.ko'
import { richZh } from './strings/rich.zh'
import { writeBannerKit } from './banner/kit'
import { CHATS, CONTACTS, DRIVE, DRIVE_FOLDERS, EVERYONE, FILES, LAUNCH_DAY_ADD, MAIL, MESSAGES, NEW_PEOPLE, OWN_SKILLS, PROJECTS, ROOMS, type ChatId, type DriveId, type FileId, type MailId, type MessageId, type Msg, type NewPerson, type ProjectId, type RichWords, type RoomSlug, type TurnId, type Who } from './rich'

const MINA = path.resolve(import.meta.dir, '..', 'mina')
const ASSETS = path.join(MINA, 'assets')

/** the languages Steepling is written in: one snapshot each (demo-gate's pool.locales picks the live ones), and the
 * free-roam sign-in page's languages (web/src/lib/freeRoam.ts FREE_ROAM_LOCALES, kept equal by a unit test; one instance offers its own and English) */
export const STEEPLING_LOCALES = ['en', 'ko', 'ja', 'zh', 'es', 'id'] as const
export type SteeplingLocale = (typeof STEEPLING_LOCALES)[number]
export interface SteeplingWords { story: Strings; more: FreeRoamStrings; rich: RichWords }
/** every language's words in one map: a language without its strings files is a type error here, not a silent gap */
const WORDS: Record<SteeplingLocale, SteeplingWords> = {
  en: { story: minaEn, more: en, rich: richEn },
  ko: { story: minaKo, more: ko, rich: richKo },
  ja: { story: minaJa, more: ja, rich: richJa },
  zh: { story: minaZh, more: zh, rich: richZh },
  es: { story: minaEs, more: es, rich: richEs },
  id: { story: minaId, more: id, rich: richId },
}
/** one language's words (the scripted story's, the free roam's, the richer team's) */
export function steeplingWords(locale: SteeplingLocale): SteeplingWords {
  const w = WORDS[locale]
  if (!w) throw new Error(`Steepling has ${STEEPLING_LOCALES.join(', ')}, not ${locale}`)
  return w
}
/** the story's company answer says 12 people; the richer team is 10 (each language's own words) */
const TEAM_SIZE: Record<SteeplingLocale, [from: string, to: string]> = {
  en: ['12 of us', '10 of us'], ko: ['12명이', '10명이'], ja: ['12人で', '10人で'], zh: ['12 个人', '10 个人'], es: ['Somos 12', 'Somos 10'], id: ['12 orang', '10 orang'],
}
/** the team's time zone where one language has one (English and Spanish are spoken across many) */
const TIME_ZONE: Partial<Record<SteeplingLocale, string>> = { ko: 'Asia/Seoul', ja: 'Asia/Tokyo', zh: 'Asia/Shanghai', id: 'Asia/Jakarta' }
const OWN_ASSETS = path.join(import.meta.dir, 'assets')

/** the story's people (scripts/demo/mina/story.ts), as accounts; Daniel, the CEO, owns the team */
const PEOPLE = ['mina', 'sara', 'leo', 'tom', 'aiko', 'omar'] as const
export const STEEPLING_SKILLS = ['brand-guide', 'social-posts', 'press-release', 'competitor-roundup', 'handover', 'review-digest'] as const
const englishName = (id: keyof Strings['people'] | Who) => (id in NEW_PEOPLE ? richEn[`${id as keyof typeof NEW_PEOPLE}.name`] : minaEn.people[id as keyof Strings['people']].name)
const email = (id: keyof Strings['people'] | Who) => `${englishName(id).toLowerCase().replace(/\s+/g, '.')}@${id === 'chris' ? 'fieldnote' : 'steepling'}.example`
/** the fake Higgsfield's story picture: `00-` first, so it wins a tie (the picker takes the first), with the story's
 * words in English and Korean. A prompt that shares no word with any picture's name gets no picture (QA 11-22 A4). */
export const HIGGSFIELD_PICTURE = '00-yuzu-ginger-tea-pouch-iced-glass-frosted-window-morning-light-유자-진저-파우치-아이스-창가-아침-햇살.jpg'

/** minutes before the build: the story happened this morning, the rest in the days before */
const T = {
  everyoneWelcome: 240, homeChat: 205, leoDm: 200, saraDm: 195, bannerChat: 150, share: 140, ceoShip: 138, leoHow: 136, gmailHint: 133,
  mailAsk: 125, mailSend: 123, chrisReply: 110, chrisRelayed: 105, shoutout: 100, saraWelcome: 98, launchDay: 90,
  leoChat: 2 * 1440 + 90, leoPost: 2 * 1440 + 80, saraThanks: 2 * 1440 + 60, pressRelease: 1440 + 120, specs: 21 * 1440,
  bannerThread: 137, brief: 3 * 1440, teamFiles: 7 * 1440, leadership: 10 * 1440, skills: 30 * 1440,
}

export interface Steepling { company: DemoContentCompany; files: Record<string, string | { asset: string }>; gmail: FakeGmail; drive: FakeDrive; avatars: Record<string, string>; pictures: Record<string, string> }

/**
 * A team skill's SKILL.md with its title (`metadata.title`, what the Skills page, the skill menu and the AI show) set to
 * `title`, the language's own words (strings/<locale>.ts skillTitles; QA TC-5553: the ko team skill showed its folder
 * name "social-posts"). The frontmatter's other lines stay; a file without `metadata:` gets one.
 */
export function skillWithTitle(md: string, title: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m || !title.trim() || /[\r\n]/.test(title)) throw new Error(`skill title: no frontmatter, or a bad title (${JSON.stringify(title)})`)
  const lines = m[1]!.split(/\r?\n/).filter((l) => !/^\s+title:/.test(l))
  const at = lines.findIndex((l) => /^metadata:\s*$/.test(l))
  if (at < 0) lines.push('metadata:', `  title: ${title}`)
  else lines.splice(at + 1, 0, `  title: ${title}`)
  return `---\n${lines.join('\n')}\n---${md.slice(m[0].length)}`
}

/** The content of one language (what writeSteepling puts on disk). */
export function steepling(locale: SteeplingLocale): Steepling {
  const { story: s, more: x, rich: w } = steeplingWords(locale)
  const a = s.answers, m = s.mail, ev = s.events, pp = s.people
  const MKT = s.marketingGroup
  const P = s.project.name
  const inProject = (name: string) => `projects/${P}/${name}`
  const brief = `groups/${MKT}/${s.paths.brief}`
  const leoBanner = inProject(s.paths.leoBanner)
  const banner = inProject(s.paths.banner), square = inProject(s.paths.square), story = inProject(s.paths.story)
  const captions = inProject(s.paths.captions), photo = inProject(s.paths.photo)
  const img = (label: string, p: string) => `![${label}]({file:${p}})`
  const link = (text: string) => text.replaceAll('{project}', `{project:${P}}`)

  // ---- the richer team (rich.ts): names, groups, projects, file paths in this language
  const groupName = { marketing: MKT, operations: x.groups.operations.name, sales: x.groups.sales.name, shop: x.groups.shop.name } as const
  const nameOf = (id: Who) => (id in NEW_PEOPLE ? w[`${id as NewPerson}.name`] : pp[id as keyof Strings['people']].name)
  const projectName = (id: ProjectId) => w[`${id}.name`]
  const fileAt = (id: FileId): string => {
    if (id === 'intro') return s.paths.companyIntro
    const f = FILES[id]
    const folder = f.in === 'mina' ? 'users/mina' : f.in === 'shared' ? 'shared' : f.in === 'templates' ? `shared/${TEMPLATES_FOLDER[locale]}` : f.in === 'marketing' ? `groups/${MKT}` : `projects/${projectName(f.in)}`
    return `${folder}/${w[`${id}.name`]}`
  }
  if (path.basename(s.paths.companyIntro) !== w['intro.name']) throw new Error(`steepling ${locale}: intro.name is not the story's company intro (${s.paths.companyIntro})`)
  /** `@{id}`, `{file:<id>}`, `{project:<id>}` of rich.ts made into the content format's words */
  const words = (text: string) => text
    .replace(/@\{(\w+)\}/g, (_m, id: string) => { if (!EVERYONE.includes(id as Who)) throw new Error(`steepling ${locale}: no person "${id}"`); return `@${nameOf(id as Who)}` })
    // a file is a link with its name: the content format's bare `{file:<path>}` is only the address (QA TC-5884)
    .replace(/\{file:([\w.-]+)\}/g, (_m, id: string) => { if (!(id in FILES)) throw new Error(`steepling ${locale}: no file "${id}"`); const at = fileAt(id as FileId); return `[${path.basename(at)}]({file:${at}})` })
    .replace(/\{project:(\w+)\}/g, (_m, id: string) => { if (!(id in PROJECTS)) throw new Error(`steepling ${locale}: no project "${id}"`); return `{project:${projectName(id as ProjectId)}}` })

  // ---- the files: the story's, the launch set Mina's AI made, the other teams', the CEO's folder, the richer team's
  // (the company intro is the richer team's: 10 people)
  const files: Steepling['files'] = {
    [brief]: { asset: `launch-brief.${locale}.md` },
    [leoBanner]: { asset: `banner-leo.${locale}.png` },
    [banner]: { asset: `campaign-banner.${locale}.jpg` },
    [square]: { asset: `campaign-square.${locale}.jpg` },
    [story]: { asset: `campaign-story.${locale}.jpg` },
    [captions]: `# ${a.captionsTitle}\n\n${a.captions.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`,
    [photo]: { asset: 'higgsfield-photo.jpg' },
    ...Object.fromEntries(STEEPLING_SKILLS.map((k) => {
      const own = (OWN_SKILLS as readonly string[]).includes(k)
      const md = fs.readFileSync(path.join(own ? OWN_ASSETS : ASSETS, `skill-${k}.${locale}.md`), 'utf8')
      return [`skills/${k}/SKILL.md`, skillWithTitle(md, x.skillTitles[k])]
    })),
    ...Object.fromEntries(x.files.map((f) => [f.path, f.text])),
    ...Object.fromEntries(x.leadership.files.map((f) => [`${x.leadership.folder}/${f.name}`, f.text])),
    ...Object.fromEntries((Object.keys(FILES) as FileId[]).map((id) => [fileAt(id), w[`${id}.text`]])),
  }

  // ---- the AI answers of the story, as they ended (the team is 10 people: the story's company answer says 12)
  const sized = (text: string) => {
    const out = text.replace(...TEAM_SIZE[locale])
    if (out === text) throw new Error(`steepling ${locale}: the company answer no longer says the team's size`)
    return out
  }
  const company = `${sized(a.company.text)}\n\n**${a.company.peopleTitle}**\n${(['sara', 'leo', 'daniel'] as const).map((id) => `- ${a.company.personLine.replace('{name}', `**${pp[id].name}**`).replace('{title}', pp[id].title).replace('{text}', a.company.people[id])}`).join('\n')}`
  const d = a.deliverables
  const pictures = `**${a.compare.before}**\n\n${img(a.compare.before, leoBanner)}\n\n**${a.compare.after}**\n\n${img(d.banner, banner)}\n\n${a.otherSizes}\n\n${img(d.square, square)}\n\n${img(d.story, story)}`
  const captionsQuote = a.captions.map((c, i) => `> ${i + 1}. ${c}`).join('\n>\n')
  const bannerAnswer = `${a.banner.text}\n\n${pictures}\n\n${captionsQuote}\n\n${a.banner.after}`
  const draft = `**${m.labels.to}** ${m.to}\\\n**${m.labels.subject}** ${m.plain.subject}\\\n**${m.labels.attachments}** ${s.paths.banner}, ${s.paths.square}\n\n${m.plain.body.map((l) => (l ? `> ${l}` : '>')).join('\n')}`

  type RoomMsg = DemoContentCompany['rooms'][number]['messages'][number]
  const msg = (from: string, minutesAgo: number, text: string, more: Partial<RoomMsg> = {}): RoomMsg =>
    ({ from, minutesAgo, text, files: [], reactions: [], ...more })
  // the richer team's messages of a room (rich.ts MESSAGES), each thread reply under its root
  const reactionsOf = (r: Readonly<Partial<Record<string, readonly Who[]>>> | undefined) => Object.entries(r ?? {}).flatMap(([emoji, by]) => (by ?? []).map((from) => ({ from, emoji })))
  const entries = Object.entries(MESSAGES) as [MessageId, Msg][]
  const richOf = (room: RoomSlug): RoomMsg[] => entries.filter(([, e]) => e.room === room && !e.thread).map(([id, e]) => {
    const replies = entries.filter(([, r]) => r.thread === id).sort((p, q) => q[1].ago - p[1].ago)
    return msg(e.from, e.ago, words(w[id]), {
      reactions: reactionsOf(e.react),
      files: (e.files ?? []).map(fileAt),
      ...(e.unread ? { unread: true as const } : {}),
      ...(replies.length ? { thread: replies.map(([rid, r]) => ({ from: r.from, text: words(w[rid]), minutesAgo: r.ago, reactions: reactionsOf(r.react), ...(r.unread ? { unread: true as const } : {}) })) } : {}),
    })
  })
  /** a room's messages oldest first: the story's and the richer team's */
  const timeline = (room: RoomSlug, own: RoomMsg[]) => [...own, ...richOf(room)].sort((p, q) => q.minutesAgo - p.minutesAgo)
  const people = (id: keyof typeof ROOMS) => [...ROOMS[id].people]

  const opens = (p: string) => !p.startsWith(`${x.leadership.folder}/`) && !(['operations', 'sales', 'shop'] as const).some((g) => p.startsWith(`groups/${groupName[g]}/`))
  const all = Object.keys(files)
  const leadershipFile = all.find((f) => f.startsWith(`${x.leadership.folder}/`))!
  const groupFile = (g: keyof typeof groupName) => all.find((f) => f.startsWith(`groups/${groupName[g]}/`))!

  const c: DemoContentCompany = {
    format: 1,
    id: locale === 'en' ? 'steepling' : `steepling-${locale}`,
    teamName: s.company,
    locale,
    owner: { username: 'daniel', name: pp.daniel.name, group: MKT, title: pp.daniel.title, email: email('daniel') },
    people: [
      { username: 'mina', name: pp.mina.name, group: MKT, note: 'the visitor: new marketing hire, first day', title: pp.mina.title, email: email('mina') },
      { username: 'sara', name: pp.sara.name, group: MKT, note: 'Marketing lead, invited Mina', title: pp.sara.title, email: email('sara') },
      { username: 'leo', name: pp.leo.name, group: MKT, note: 'made the first banner, moving to Sales', title: pp.leo.title, email: email('leo') },
      { username: 'tom', name: pp.tom.name, group: x.groups.operations.name, note: 'Operations lead', title: pp.tom.title, email: email('tom') },
      { username: 'aiko', name: pp.aiko.name, group: x.groups.sales.name, title: pp.aiko.title, email: email('aiko') },
      { username: 'omar', name: pp.omar.name, group: x.groups.shop.name, title: pp.omar.title, email: email('omar') },
      ...(Object.keys(NEW_PEOPLE) as NewPerson[]).map((id) => ({ username: id, name: w[`${id}.name`], group: groupName[NEW_PEOPLE[id].group], note: 'shown with initials (no photo)', title: w[`${id}.title`], email: email(id) })),
    ],
    groups: [
      { name: MKT, description: x.groups.marketing },
      { name: x.groups.operations.name, description: x.groups.operations.description },
      { name: x.groups.sales.name, description: x.groups.sales.description },
      { name: x.groups.shop.name, description: x.groups.shop.description },
    ],
    rules: [{ path: x.leadership.folder, rules: [], limited: true, why: 'the CEO only (he owns the team; nobody else opens it)' }],
    uploaders: [
      { path: `${inProject(s.paths.leoBanner)}`, username: 'leo' },
      { path: `projects/${P}`, username: 'mina' },
      { path: `projects/${projectName('p3')}`, username: 'nadia' },
      { path: `projects/${projectName('p4')}`, username: 'aiko' },
      { path: `projects/${projectName('p5')}`, username: 'leo' },
      { path: `groups/${MKT}`, username: 'sara' },
      { path: `groups/${x.groups.operations.name}`, username: 'tom' },
      { path: `groups/${x.groups.sales.name}`, username: 'aiko' },
      { path: `groups/${x.groups.shop.name}`, username: 'omar' },
      { path: 'skills', username: 'daniel' },
    ],
    defaultUploader: 'daniel',
    packSkills: [],
    settings: { aiSubagents: false, ...(TIME_ZONE[locale] ? { timeZone: TIME_ZONE[locale] } : {}) },
    // saved on her first morning (QA TC-5743: it said the build's time)
    memories: [{ username: 'mina', text: x.memory, minutesAgo: T.everyoneWelcome }],
    profile: { website: 'https://steepling.example', name: s.company, oneLine: x.profile.oneLine, products: x.profile.products, audience: x.profile.audience, tone: x.profile.tone, avoid: x.profile.avoid, sources: [] },
    demo: {
      personas: [
        { key: 'newHire', username: 'mina', intro: x.personas.mina, questions: x.suggestions.map((q) => q.prompt) },
        { key: 'lead', username: 'sara', intro: x.personas.sara, questions: [] },
      ],
    },
    scenarios: [],
    // who opens what, made from where the files are (not their order): Mina everything but the CEO's folder and the
    // other teams' folders
    checks: [
      { username: 'mina', opens: all.filter(opens), closed: all.filter((f) => !opens(f)), skills: [...STEEPLING_SKILLS] },
      { username: 'sara', opens: [brief, banner], closed: [leadershipFile, groupFile('operations')] },
      { username: 'tom', opens: [s.paths.companyIntro, groupFile('operations'), fileAt('p3.reviews')], closed: [banner, brief, leadershipFile] },
      { username: 'daniel', opens: [leadershipFile, banner, groupFile('sales')], closed: [] },
    ],
    // each project gets its own chat room (`channel`: the seed opens it, docs/decisions/20261120-project-is-room.md); the
    // group chats named there (the launch day one, each new project's) stay group chats
    projects: [
      { name: P, instructions: s.project.description, by: 'sara', members: [{ group: MKT }], channel: 'launch-day' },
      ...(Object.keys(PROJECTS) as ProjectId[]).map((id) => ({
        name: projectName(id), instructions: w[`${id}.about`], by: PROJECTS[id].by, channel: PROJECTS[id].channel,
        members: [...PROJECTS[id].groups.map((g) => ({ group: groupName[g] })), ...PROJECTS[id].users.map((u) => ({ user: u }))],
      })),
    ],
    rooms: [
      {
        slug: 'everyone', kind: 'all', messages: timeline('everyone', [
          ...x.everyoneBefore.map((e) => msg(e.from, e.minutesAgo, e.text)),
          ...s.rooms.everyone.map((e, i) => msg(e.from, T.everyoneWelcome - i * 3, e.text)),
          msg('daniel', T.shoutout, ev.ceoShoutout, { reactions: [{ from: 'tom', emoji: '🎉' }, { from: 'aiko', emoji: '🔥' }, { from: 'omar', emoji: '👏' }, { from: 'leo', emoji: '🙌' }, { from: 'sara', emoji: '🎉' }, { from: 'nadia', emoji: '🎉' }, { from: 'grace', emoji: '💛' }] }),
          msg('sara', T.saraWelcome, ev.saraWelcome),
        ]),
      },
      {
        slug: 'marketing', kind: 'team', group: MKT, messages: timeline('marketing', [
          ...x.marketingBefore.map((e) => msg(e.from, e.minutesAgo, e.text)),
          msg('leo', T.leoPost, s.rooms.marketing[0]!.text, { files: [leoBanner] }),
          msg(s.rooms.marketing[1]!.from, T.saraThanks, s.rooms.marketing[1]!.text),
          // the story's moment ③: Mina sends her answer, the team reacts (a room's reactions are its members')
          msg('mina', T.share, x.shareNote, { shareChat: 'banner', reactions: [{ from: 'leo', emoji: '👏' }, { from: 'sara', emoji: '🔥' }, { from: 'daniel', emoji: '🙌' }, { from: 'ben', emoji: '😍' }] }),
          msg('daniel', T.ceoShip, ev.ceoShip),
          msg('leo', T.leoHow, ev.leoHow),
          msg('sara', T.gmailHint, ev.leadGmail),
          msg('sara', T.chrisRelayed, ev.chrisRelayed.replace('{reply}', ev.chrisReply)),
        ]),
      },
      { slug: 'dm-sara', kind: 'dm', people: ['sara', 'mina'], messages: timeline('dm-sara', [msg('sara', T.saraDm, link(ev.leadDm))]) },
      { slug: 'dm-leo', kind: 'dm', people: ['leo', 'mina'], messages: timeline('dm-leo', [msg('leo', T.leoDm, x.leoDm)]) },
      { slug: 'dm-daniel', kind: 'dm', people: people('dm-daniel'), messages: timeline('dm-daniel', []) },
      { slug: 'dm-omar', kind: 'dm', people: people('dm-omar'), messages: timeline('dm-omar', []) },
      {
        slug: 'launch-day', kind: 'group', people: ['omar', 'sara', 'mina', 'tom', ...LAUNCH_DAY_ADD], name: x.launchDay.name,
        messages: timeline('launch-day', x.launchDay.messages.map((e, i) => msg(e.from, T.launchDay - i * 2, e.text))),
      },
      ...(['customer-voice', 'cafe-partners', 'social-calendar', 'tea-break'] as const).map((slug) => ({ slug, kind: 'group' as const, people: people(slug), name: w[`room.${slug}`], messages: timeline(slug, []) })),
      { slug: 'handover', kind: 'group', people: people('handover'), messages: timeline('handover', []) },
    ],
    chats: [
      { slug: 'company', username: 'mina', title: a.company.prompt, turns: [{ ask: a.company.prompt, answer: company, minutesAgo: T.homeChat }] },
      { slug: 'leo-banner', username: 'leo', project: P, title: s.leoChat.title, turns: [{ ask: s.leoChat.ask, answer: `${s.leoChat.answer}\n\n${img(s.leoChat.title, leoBanner)}`, minutesAgo: T.leoChat }] },
      { slug: 'press-release', username: 'sara', project: P, title: x.pressRelease.title, turns: [{ ask: x.pressRelease.ask, answer: x.pressRelease.answer, minutesAgo: T.pressRelease }] },
      { slug: 'banner', username: 'mina', project: P, title: a.banner.prompt, turns: [{ ask: a.banner.prompt, answer: bannerAnswer, minutesAgo: T.bannerChat }],
        // Sara answers in its thread, naming Mina: her notice in Activity (the free-roam audit, QA TC-5614)
        thread: [{ from: 'sara', text: x.bannerThread, minutesAgo: T.bannerThread }] },
      {
        slug: 'mail-chris', username: 'mina', sideRoom: 'marketing', title: a.mail.prompt, turns: [
          { ask: a.mail.prompt, answer: `${a.mail.intro}\n\n${draft}`, minutesAgo: T.mailAsk },
          { ask: m.send, answer: m.sent.replaceAll('{subject}', m.plain.subject), minutesAgo: T.mailSend },
        ],
      },
      ...(Object.keys(CHATS) as ChatId[]).map((id) => {
        const k: { by: Who; project?: ProjectId; turns: Record<string, number> } = CHATS[id]
        return {
          slug: id.replace('.', '-'), username: k.by, ...(k.project ? { project: projectName(k.project) } : {}), title: w[`${id}.title`],
          turns: (Object.entries(k.turns) as [TurnId, number][]).map(([t, at]) => ({ ask: w[`${t}.ask`], answer: words(w[`${t}.answer`]), minutesAgo: at })),
        }
      }),
    ],
    connections: [
      { service: 'gmail', username: 'mina', account: { name: pp.mina.name, email: email('mina') } },
      { service: 'google-drive', username: 'mina', account: { name: pp.mina.name, email: email('mina') } },
      { service: 'higgsfield', account: { name: s.company, email: 'team@steepling.example' } },
    ],
    welcome: [{ username: 'mina', inviter: 'sara', asked: true }],
    // the files' times in the story, not the build's (the free-roam audit, QA TC-5618): the launch set this morning,
    // Leo's banner two days ago, the richer team's files each at its own time, the rest older; the first entry that
    // matches a file wins
    fileTimes: [
      { path: leoBanner, minutesAgo: T.leoChat },
      ...(Object.keys(FILES) as FileId[]).map((id) => ({ path: fileAt(id), minutesAgo: FILES[id].ago })),
      { path: `projects/${P}`, minutesAgo: T.bannerChat },
      { path: brief, minutesAgo: T.brief },
      { path: x.leadership.folder, minutesAgo: T.leadership },
      { path: 'groups', minutesAgo: T.teamFiles },
      { path: 'shared', minutesAgo: T.specs },
      { path: 'skills', minutesAgo: T.skills },
    ],
    // the team skills and the company profile were set up with the team, not changed lately
    recentHidden: ['skills'],
    // the scripted demo's own sign-up address (scripts/demo/mina/story.ts end.signup)
    freeRoam: { suggestions: x.suggestions, signupUrl: 'https://demo.trina.app/__demo/go/start-free' },
  }

  // ---- the fake Gmail (server/src/demo/fakes/gmail.ts): Mina's mailbox. The mail to Chris in Sent, his reply in the
  // inbox (unread), Sara's forward of his older mail, her welcome; then the richer team's threads (rich.ts MAIL)
  const who = (id: keyof Strings['people'] | Who) => `${id in NEW_PEOPLE ? nameOf(id as Who) : pp[id as keyof Strings['people']].name} <${email(id)}>`
  const party = (id: string) => (id === 'sam' ? `${w['contact.sam']} <${CONTACTS.sam}>` : id === 'marketing' || id === 'all' ? CONTACTS[id] : who(id as Who | 'chris'))
  const g = x.gmail
  const reply = `${g.replyPrefix}${m.plain.subject}`
  const gmail: FakeGmail = {
    me: { name: pp.mina.name, email: email('mina') },
    messages: [
      { id: 'chris-reply', threadId: 'launch-banner', from: who('chris'), to: who('mina'), cc: who('sara'), subject: reply, date: ago(T.chrisReply), body: g.replyBody.replace('{reply}', ev.chrisReply), labels: ['INBOX', 'UNREAD', 'IMPORTANT'] },
      { id: 'to-chris', threadId: 'launch-banner', from: who('mina'), to: who('chris'), cc: who('sara'), subject: m.plain.subject, date: ago(T.mailSend), body: m.plain.body.join('\n'), labels: ['SENT'], attachments: [s.paths.banner, s.paths.square] },
      { id: 'specs-fwd', threadId: 'specs', from: who('sara'), to: who('mina'), subject: `${g.forwardPrefix}${g.specs.subject}`, date: ago(T.everyoneWelcome + 20), labels: ['INBOX'],
        body: `${g.forwardNote}\n\n${g.forwarded}\n${who('chris')}\n${g.specs.subject}\n\n${g.specs.body}` },
      { id: 'welcome', threadId: 'welcome', from: who('sara'), to: who('mina'), subject: g.welcome.subject, date: ago(T.everyoneWelcome + 30), body: g.welcome.body, labels: ['INBOX'] },
      ...(Object.keys(MAIL) as MailId[]).map((id) => {
        const k: { thread: string; from: string; to: readonly string[]; cc?: readonly string[]; ago: number; labels: readonly string[] } = MAIL[id]
        return { id: id.replace('gm.', ''), threadId: k.thread, from: party(k.from), to: k.to.map(party).join(', '), ...(k.cc ? { cc: k.cc.map(party).join(', ') } : {}), subject: w[`${id}.subject`], date: ago(k.ago), body: w[`${id}.body`], labels: [...k.labels] }
      }),
    ],
  }
  // ---- the fake Drive (server/src/demo/fakes/drive.ts): Mina's, with Fieldnote's plan and report in a folder, the
  // price tracker, her first-week checklist
  const driveFiles = [
    ...x.drive,
    ...(Object.keys(DRIVE) as DriveId[]).map((id) => {
      const k: { folder?: (typeof DRIVE_FOLDERS)[number]; mime: string; ago: number } = DRIVE[id]
      return { id: id.replace('dr.', ''), name: w[`${id}.name`], mimeType: k.mime, folder: k.folder ? w[`folder.${k.folder}`] : '', minutesAgo: k.ago, text: w[`${id}.text`] }
    }),
  ]
  const folders = [...new Set(driveFiles.map((f) => f.folder).filter(Boolean))]
  const drive: FakeDrive = {
    me: { name: pp.mina.name, email: email('mina') },
    files: [
      ...folders.map((name, i) => ({ id: `folder-${i + 1}`, name, mimeType: 'application/vnd.google-apps.folder' })),
      ...driveFiles.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, text: f.text, modifiedTime: ago(f.minutesAgo), ...(f.folder ? { parent: `folder-${folders.indexOf(f.folder) + 1}` } : {}) })),
    ],
  }
  // the story's seven have photos; the three new people show initials
  const avatars = Object.fromEntries(['daniel', ...PEOPLE].map((id) => [id, `avatar-${id}.jpg`]))
  // ---- the fake Higgsfield's picture (server/src/demo/fakes/higgsfield.ts picks one by the words of its name): the
  // story's photo
  const higgsfield = { [HIGGSFIELD_PICTURE]: 'higgsfield-photo.jpg' }
  return { company: c, files, gmail, drive, avatars, pictures: higgsfield }
}

/** "-<n>d" / "-<n>h" / "-<n>m", the fakes' own way to say a time before the instance (at most four digits) */
function ago(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `-${minutes / 1440}d`
  if (minutes < 10_000) return `-${minutes}m`
  return `-${Math.round(minutes / 60)}h`
}

/** Write the content folder of one language to `out` (made empty first). Returns `out`. */
export function writeSteepling(locale: SteeplingLocale, out: string): string {
  const st = steepling(locale)
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const put = (rel: string, data: string | Buffer) => {
    const p = path.join(out, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, data)
  }
  put('company.json', JSON.stringify(st.company, null, 2) + '\n')
  for (const [rel, v] of Object.entries(st.files)) put(path.join('files', rel), typeof v === 'string' ? v : fs.readFileSync(path.join(ASSETS, v.asset)))
  put('fakes/gmail.json', JSON.stringify(st.gmail, null, 2) + '\n')
  put('fakes/drive.json', JSON.stringify(st.drive, null, 2) + '\n')
  for (const [name, asset] of Object.entries(st.pictures)) put(`fakes/higgsfield/${name}`, fs.readFileSync(path.join(ASSETS, asset)))
  for (const [u, asset] of Object.entries(st.avatars)) put(`avatars/${u}.jpg`, fs.readFileSync(path.join(ASSETS, asset)))
  // the launch banner as layers (text-free photos + words) for the server's change_banner_text (banner/kit.ts)
  writeBannerKit(locale, out)
  put('README.md', `# Steepling (${locale}), made by scripts/demo/steepling/make.ts\n\nA fictional company at the end of the scripted story "Mina's first day". Do not edit: run make.ts again. Every person, file and address is made up.\n`)
  return out
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (import.meta.main) {
  const locale = (arg('locale') ?? 'en') as SteeplingLocale
  const out = arg('out')
  if (!STEEPLING_LOCALES.includes(locale) || !out) {
    console.error(`Usage: bun scripts/demo/steepling/make.ts --locale ${STEEPLING_LOCALES.join('|')} --out <dir>`)
    process.exit(1)
  }
  console.log(`[steepling] ${writeSteepling(locale, path.resolve(out))}`)
}
