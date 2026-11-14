// "Mina's first day" (v2): the story's structure (format: web/demo/script.ts), with every word taken from a strings
// file (strings/<locale>.ts) and every picture or text file from ../assets/<name>.<locale>.<ext>. Steepling is a
// fictional company; every person, number, address and file is made up (README.md).
//
// Four moments: ① the AI already knows the company (3 files read, people to know), ② one prompt gives a launch set of
// five deliverables, ③ the team reacts live in #Marketing, ④ the mail goes out and the agency answers.
import type { DemoAnswer, DemoAsk, DemoFile, DemoReply, DemoScript, DemoStep } from '../../../web/demo/script'
import type { Strings } from './strings/en'

type Mail = Strings['mail']['plain']

export function buildScript(s: Strings, locale: DemoScript['locale']): DemoScript {
  const P = s.project.name
  const inProject = (name: string) => `projects/${P}/${name}`
  const brief = `groups/${s.marketingGroup}/${s.paths.brief}`
  const leoBanner = inProject(s.paths.leoBanner)
  // version A and B save under the same names: whatever the visitor made last is what gets mailed
  const banner = inProject(s.paths.banner)
  const square = inProject(s.paths.square)
  const story = inProject(s.paths.story)
  const captions = inProject(s.paths.captions)
  const brandCheck = inProject(s.paths.brandCheck)
  const background = inProject(s.paths.background)

  const link = (text: string) => text.replaceAll('{project}', '{{project:launch}}')
  const st = s.steps
  const read = (path: string): DemoStep => ({ label: `${st.read} · ${path}`, tool: 'read' })
  const make = (what: string, path: string, ms = 900): DemoStep => ({ label: `${what} · ${path}`, tool: 'write', ms })
  const a = s.answers

  // ---- ② the launch set: banner, square, story, captions, and brand check (A) or the background (B)

  const captionsText = `# ${a.captionsTitle}\n\n${a.captions.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`
  const captionsQuote = a.captions.map((c, i) => `> ${i + 1}. ${c}`).join('\n>\n')
  const brandCheckText = `# ${a.brandCheck.title}\n\n${a.brandCheck.lines.map((l) => `- ${l}`).join('\n')}\n`
  const d = a.deliverables
  const set = (v: 'a' | 'b'): DemoFile[] => [
    { path: banner, asset: `banner-${v}.${locale}.png` },
    { path: square, asset: `square-${v}.${locale}.png` },
    { path: story, asset: `story-${v}.${locale}.png` },
    { path: captions, text: captionsText },
  ]
  const tiles = [{ path: banner, label: d.banner }, { path: square, label: d.square }, { path: story, label: d.story }, { path: captions, label: d.captions }]
  const compare = { before: leoBanner, after: banner, beforeLabel: a.compare.before, afterLabel: a.compare.after }
  const sendTo = { room: 'mkt-room', label: a.sendTo }
  const makeSet: DemoStep[] = [
    make(`${st.makeBanner} 1200×628`, banner, 1500),
    make(`${st.makeSquare} 1080×1080`, square),
    make(`${st.makeStory} 1080×1920`, story),
    make(st.writeCaptions, captions, 700),
  ]

  // ---- ④ the mail to the agency: a draft with the banner and the square, a confirm card, a sent line

  const m = s.mail
  const attachments = [banner, square]
  const draft = (mail: Mail) =>
    // (a backslash at a line's end: a line break in Markdown, so To, Subject and Attached stay on their own lines)
    `**${m.labels.to}** ${m.to}\\\n**${m.labels.subject}** ${mail.subject}\\\n**${m.labels.attachments}** ${s.paths.banner}, ${s.paths.square}\n\n` +
    mail.body.map((l) => (l ? `> ${l}` : '>')).join('\n')
  const sent = (mail: Mail): DemoReply => ({
    steps: [{ label: `Gmail · ${st.gmailSend}`, tool: 'gmail', ms: 1200 }],
    text: m.sent.replaceAll('{subject}', mail.subject),
    attachments,
  })
  const confirm = (mail: Mail, offerFormal: boolean): DemoAsk => ({
    question: m.confirm,
    options: [
      { label: m.send, reply: sent(mail) },
      ...(offerFormal ? [{ label: m.makeFormal, reply: { text: `${m.formalIntro}\n\n${draft(m.formal)}`, attachments, ask: confirm(m.formal, false) } }] : []),
    ],
  })

  // ---- the AI answers

  const answers: DemoAnswer[] = [
    {
      // ① three files read, then the company, Mina's job, this week, and people to know
      id: 'company',
      where: 'home',
      prompt: a.company.prompt,
      steps: [read(s.paths.companyIntro), read(brief), read(s.paths.brandGuide)],
      text: a.company.text,
      sources: [s.paths.companyIntro, brief, s.paths.brandGuide],
      people: (['sara', 'leo', 'daniel'] as const).map((id) => ({ id, why: a.company.people[id] })),
    },
    {
      id: 'banner-a',
      where: { project: 'launch' },
      prompt: a.bannerA.prompt,
      steps: [read(s.paths.brandGuide), read(leoBanner), ...makeSet, make(d.brandCheck, brandCheck, 500)],
      text: `${a.bannerA.text}\n\n${captionsQuote}\n\n${a.bannerA.after}`,
      files: [...set('a'), { path: brandCheck, text: brandCheckText }],
      compare,
      deliverables: [...tiles, { path: brandCheck, label: d.brandCheck }],
      sendTo,
    },
    {
      id: 'banner-b',
      where: { project: 'launch' },
      prompt: a.bannerB.prompt,
      steps: [read(s.paths.brandGuide), { label: `Higgsfield · ${st.higgsfield}`, tool: 'higgsfield', ms: 2600 }, make(st.save, background, 500), ...makeSet],
      text: `${a.bannerB.text}\n\n${captionsQuote}\n\n${a.bannerB.after}`,
      files: [...set('b'), { path: background, asset: 'bg-b.png' }],
      compare,
      deliverables: [...tiles, { path: background, label: d.background }],
      sendTo,
    },
    {
      id: 'mail',
      where: { side: 'mkt-room' },
      prompt: a.mail.prompt,
      steps: [{ label: `Gmail · ${st.gmailSearch} "Chris"`, tool: 'gmail', ms: 1100 }, read(banner), read(square)],
      text: `${a.mail.intro}\n\n${draft(m.plain)}`,
      ask: confirm(m.plain, true),
    },
  ]

  const team = ['mina', 'sara', 'daniel', 'leo', 'tom', 'aiko', 'omar'] as const
  const marketing = ['mina', 'sara', 'leo', 'daniel']
  const spaced = (msgs: { from: string; text: string }[], start: number, files?: Record<number, string[]>) =>
    msgs.map((msg, i) => ({ ...msg, minutesAgo: start - i * 3, ...(files?.[i] ? { files: files[i] } : {}) }))
  const pp = s.people

  return {
    version: 1,
    locale,
    company: { name: s.company },
    visitor: 'mina',
    people: [
      ...team.map((id) => ({ id, name: pp[id].name, title: pp[id].title, avatar: `avatar-${id}.png` })),
      { id: 'chris', name: pp.chris.name, title: pp.chris.title, org: pp.chris.org, outside: true as const, avatar: 'avatar-chris.png' },
    ],
    groups: [{ id: 'mkt', name: s.marketingGroup, members: marketing }],
    rooms: [
      { id: 'all', kind: 'all', members: [...team], messages: spaced(s.rooms.everyone, 40) },
      { id: 'mkt-room', kind: 'team', group: 'mkt', members: marketing, messages: spaced(s.rooms.marketing, 70, { 0: [leoBanner] }) },
      { id: 'dm-lead', kind: 'dm', members: ['mina', 'sara'] },
    ],
    projects: [
      {
        id: 'launch',
        name: P,
        description: s.project.description,
        members: marketing,
        chats: [{
          id: 'leo-banner',
          title: s.leoChat.title,
          by: 'leo',
          turns: [{ ask: s.leoChat.ask, answer: `${s.leoChat.answer}\n\n![${s.leoChat.title}]({{file:${leoBanner}}})`, files: [leoBanner] }],
        }],
      },
    ],
    files: [
      { path: s.paths.companyIntro, asset: `company-intro.${locale}.md` },
      { path: s.paths.brandGuide, asset: `brand-guide.${locale}.md` },
      { path: brief, asset: `launch-brief.${locale}.md` },
      { path: leoBanner, asset: `banner-leo.${locale}.png` },
      // team skills, where the product keeps them (skills/<name>/SKILL.md)
      ...['social-posts', 'press-release', 'competitor-roundup', 'handover'].map((k) => ({ path: `skills/${k}/SKILL.md`, asset: `skill-${k}.${locale}.md` })),
    ],
    home: { title: s.home.title, subtitle: s.home.subtitle, inviter: 'sara', prompt: a.company.prompt },
    answers,
    events: [
      // Sara's DM slides in as a toast right after the company answer
      {
        id: 'dm-1', after: { answer: 'company' }, delayMs: 2000, typingMs: 1400, room: 'dm-lead', from: 'sara', text: link(s.events.leadDm),
        toast: { text: s.events.leadDmToast, open: { room: 'dm-lead' } },
      },
      // ③ #Marketing reacts to Mina's post
      { id: 'ceo-ship', after: { shared: 'mkt-room' }, delayMs: 1500, typingMs: 2200, room: 'mkt-room', from: 'daniel', text: s.events.ceoShip },
      { id: 'leo-how', after: { event: 'ceo-ship' }, delayMs: 1200, typingMs: 1500, room: 'mkt-room', from: 'leo', text: s.events.leoHow },
      {
        id: 'reactions', after: { event: 'leo-how' }, delayMs: 600, room: 'mkt-room', from: 'tom', on: 'visitor',
        reactions: [{ from: 'tom', emoji: '👏', afterMs: 0 }, { from: 'aiko', emoji: '🔥', afterMs: 700 }, { from: 'omar', emoji: '🙌', afterMs: 700 }],
      },
      { id: 'gmail', after: { event: 'reactions' }, delayMs: 2200, typingMs: 1300, room: 'mkt-room', from: 'sara', text: s.events.leadGmail },
      // ④ the agency answers the mail
      { id: 'chris-reply', after: { answer: 'mail' }, delayMs: 3500, typingMs: 0, from: 'chris', text: s.events.chrisReply, toast: true },
    ],
    guide: [
      { id: 'ask', text: s.guide.ask.text, away: s.guide.ask.away, go: 'home', highlight: '[data-testid="member-welcome-ask"]', until: { answer: 'company' } },
      { id: 'dm', text: s.guide.dm.text, away: s.guide.dm.away, go: { room: 'dm-lead' }, after: { event: 'dm-1' }, highlight: '[data-testid="demo-toast"]', until: { opened: { room: 'dm-lead' } } },
      { id: 'project', text: s.guide.project.text, away: s.guide.project.away, go: { room: 'dm-lead' }, highlight: '[data-testid="demo-project-card"]', until: { opened: { project: 'launch' } } },
      { id: 'banner', text: s.guide.banner.text, away: s.guide.banner.away, go: { project: 'launch' }, suggest: ['banner-a', 'banner-b'], until: { answer: ['banner-a', 'banner-b'] } },
      { id: 'share', text: s.guide.share.text, away: s.guide.share.away, go: { project: 'launch' }, highlight: '[data-testid="demo-send-to"]', until: { shared: 'mkt-room' } },
      { id: 'mail', text: s.guide.mail.text, away: s.guide.mail.away, go: { side: 'mkt-room' }, after: { event: 'gmail' }, suggest: ['mail'], until: { answer: 'mail' } },
    ],
    fallback: { text: s.fallback.text, question: s.fallback.question },
    end: {
      after: { event: 'chris-reply' },
      delayMs: 2500,
      title: s.end.title,
      body: s.end.body,
      stats: [
        { label: s.end.stats.time, value: 'elapsed' },
        { label: s.end.stats.filesRead, value: 3 },
        { label: s.end.stats.deliverables, value: 5 },
        { label: s.end.stats.approvals, value: 1 },
        { label: s.end.stats.emails, value: 1 },
      ],
      signup: { label: s.end.signup, url: 'https://trina.app/' },
      explore: { label: s.end.explore },
    },
  }
}
