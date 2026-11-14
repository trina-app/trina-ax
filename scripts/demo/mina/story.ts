// "Mina's first day" (v2.1): the story's structure (format: web/demo/script.ts), with every word taken from a strings
// file (strings/<locale>.ts) and every picture or text file from ../assets/<name>.<locale>.<ext>. Steepling is a
// fictional company; every person, number, address and file is made up (README.md).
//
// Four moments: ① the AI already knows the company (3 files read, people to know), ② one prompt gives a launch set
// shot with Higgsfield (banner, square, story, captions, the photo), ③ the team reacts live in #Marketing, ④ the mail
// goes out and the agency answers.
import type { DemoAnswer, DemoAsk, DemoReply, DemoScript, DemoStep } from '../../../web/demo/script'
import type { Strings } from './strings/en'

type Mail = Strings['mail']['plain']

export function buildScript(s: Strings, locale: DemoScript['locale']): DemoScript {
  const P = s.project.name
  const inProject = (name: string) => `projects/${P}/${name}`
  const brief = `groups/${s.marketingGroup}/${s.paths.brief}`
  const leoBanner = inProject(s.paths.leoBanner)
  const banner = inProject(s.paths.banner)
  const square = inProject(s.paths.square)
  const story = inProject(s.paths.story)
  const captions = inProject(s.paths.captions)
  const photo = inProject(s.paths.photo)

  const link = (text: string) => text.replaceAll('{project}', '{{project:launch}}')
  const st = s.steps
  const read = (path: string): DemoStep => ({ label: `${st.read} · ${path}`, tool: 'read' })
  const make = (what: string, path: string, ms = 900): DemoStep => ({ label: `${what} · ${path}`, tool: 'write', ms })
  const a = s.answers

  // ---- ② the launch set, shot with Higgsfield: banner, square, story, captions, and the photo itself

  const captionsText = `# ${a.captionsTitle}\n\n${a.captions.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`
  const captionsQuote = a.captions.map((c, i) => `> ${i + 1}. ${c}`).join('\n>\n')
  const d = a.deliverables
  // the pictures in the answer itself, as a real answer shows generated images: before, after, the other sizes
  const img = (label: string, path: string) => `![${label}]({{file:${path}}})`
  const pictures = `**${a.compare.before}**\n\n${img(a.compare.before, leoBanner)}\n\n**${a.compare.after}**\n\n${img(d.banner, banner)}\n\n` +
    `${a.otherSizes}\n\n${img(d.square, square)}\n\n${img(d.story, story)}`
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
  })
  const confirm = (mail: Mail, offerFormal: boolean): DemoAsk => ({
    question: m.confirm,
    options: [
      { label: m.send, reply: sent(mail) },
      // two buttons on every card (AskCard shows two as buttons, more as a list)
      offerFormal
        ? { label: m.makeFormal, reply: { text: `${m.formalIntro}\n\n${draft(m.formal)}`, ask: confirm(m.formal, false) } }
        : { label: m.sendShort, reply: sent(m.plain) },
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
      text: `${a.company.text}\n\n**${a.company.peopleTitle}**\n${(['sara', 'leo', 'daniel'] as const).map((id) => `- **${s.people[id].name}**, ${s.people[id].title}: ${a.company.people[id]}`).join('\n')}`,
      // the app's own "sources" under the answer
      sources: [s.paths.companyIntro, brief, s.paths.brandGuide],
    },
    {
      id: 'banner',
      where: { project: 'launch' },
      prompt: a.banner.prompt,
      steps: [
        read(s.paths.brandGuide),
        read(leoBanner),
        { label: `Higgsfield · ${st.higgsfieldHero}`, tool: 'higgsfield', ms: 3200 },
        { label: `Higgsfield · ${st.higgsfieldCrops}`, tool: 'higgsfield', ms: 2600 },
        make(st.save, photo, 500),
        make(`${st.makeBanner} 1200×628`, banner, 1500),
        make(`${st.makeSquare} 1080×1080`, square),
        make(`${st.makeStory} 1080×1920`, story),
        make(st.writeCaptions, captions, 700),
      ],
      text: `${a.banner.text}\n\n${pictures}\n\n${captionsQuote}\n\n${a.banner.after}`,
      files: [
        { path: banner, asset: `campaign-banner.${locale}.jpg` },
        { path: square, asset: `campaign-square.${locale}.jpg` },
        { path: story, asset: `campaign-story.${locale}.jpg` },
        { path: captions, text: captionsText },
        { path: photo, asset: 'higgsfield-photo.jpg' },
      ],
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
      ...team.map((id) => ({ id, name: pp[id].name, title: pp[id].title, avatar: `avatar-${id}.jpg` })),
      { id: 'chris', name: pp.chris.name, title: pp.chris.title, org: pp.chris.org, outside: true as const, avatar: 'avatar-chris.jpg' },
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
    home: { title: s.home.title, inviter: 'sara', prompt: a.company.prompt },
    answers,
    events: [
      // Sara's DM right after the company answer (the app's own unread mark tells it)
      { id: 'dm-1', after: { answer: 'company' }, delayMs: 2000, typingMs: 1400, room: 'dm-lead', from: 'sara', text: link(s.events.leadDm) },
      // ③ #Marketing reacts to Mina's post
      { id: 'ceo-ship', after: { shared: 'mkt-room' }, delayMs: 1500, typingMs: 2200, room: 'mkt-room', from: 'daniel', text: s.events.ceoShip },
      { id: 'leo-how', after: { event: 'ceo-ship' }, delayMs: 1200, typingMs: 1500, room: 'mkt-room', from: 'leo', text: s.events.leoHow },
      {
        id: 'reactions', after: { event: 'leo-how' }, delayMs: 600, room: 'mkt-room', from: 'tom', on: 'visitor',
        reactions: [{ from: 'tom', emoji: '👏', afterMs: 0 }, { from: 'aiko', emoji: '🔥', afterMs: 700 }, { from: 'omar', emoji: '🙌', afterMs: 700 }],
      },
      { id: 'gmail', after: { event: 'reactions' }, delayMs: 2200, typingMs: 1300, room: 'mkt-room', from: 'sara', text: s.events.leadGmail },
      // ④ the agency answers the mail
      // ④ the agency answers the mail: Sara passes it on in #Marketing
      { id: 'chris-reply', after: { answer: 'mail' }, delayMs: 3000, typingMs: 1200, room: 'mkt-room', from: 'sara', text: s.events.chrisRelayed.replace('{reply}', s.events.chrisReply) },
      // ⑤ the close: the CEO's shoutout in #Everyone (its unread mark pulls the visitor in), the team piles on
      { id: 'ceo-shoutout', after: { event: 'chris-reply' }, delayMs: 2500, typingMs: 1800, room: 'all', from: 'daniel', text: s.events.ceoShoutout },
      // (the visitor is in #Everyone after the shoutout: the reactions start where they can be seen)
      { id: 'everyone-seen', after: { opened: { room: 'all' } }, requires: { event: 'ceo-shoutout' }, delayMs: 700, room: 'all', from: 'daniel' },
      {
        id: 'shout-reactions', after: { event: 'everyone-seen' }, delayMs: 200, room: 'all', from: 'tom', on: { event: 'ceo-shoutout' },
        reactions: [{ from: 'tom', emoji: '🎉', afterMs: 0 }, { from: 'aiko', emoji: '🔥', afterMs: 550 }, { from: 'omar', emoji: '👏', afterMs: 550 }, { from: 'leo', emoji: '🙌', afterMs: 550 }, { from: 'sara', emoji: '🎉', afterMs: 550 }],
      },
      { id: 'sara-welcome', after: { event: 'shout-reactions' }, delayMs: 700, typingMs: 1400, room: 'all', from: 'sara', text: s.events.saraWelcome },
    ],
    guide: [
      { id: 'ask', text: s.guide.ask.text, away: s.guide.ask.away, go: 'home', highlight: '[data-testid="member-welcome-ask"]', until: { answer: 'company' } },
      { id: 'dm', text: s.guide.dm.text, away: s.guide.dm.away, go: { room: 'dm-lead' }, after: { event: 'dm-1' }, until: { opened: { room: 'dm-lead' } } },
      { id: 'project', text: s.guide.project.text, away: s.guide.project.away, go: { room: 'dm-lead' }, highlight: '[data-testid="room-message"] a[href^="/projects/"]', until: { opened: { project: 'launch' } } },
      { id: 'banner', text: s.guide.banner.text, away: s.guide.banner.away, go: { project: 'launch' }, suggest: ['banner'], until: { answer: 'banner' } },
      { id: 'share', text: s.guide.share.text, away: s.guide.share.away, go: { project: 'launch' }, highlight: '[data-testid="share-to-room"]', until: { shared: 'mkt-room' } },
      { id: 'room', text: s.guide.room.text, away: s.guide.room.away, go: { room: 'mkt-room' }, until: { opened: { room: 'mkt-room' } } },
      { id: 'mail', text: s.guide.mail.text, away: s.guide.mail.away, go: { side: 'mkt-room' }, after: { event: 'gmail' }, suggest: ['mail'], until: { answer: 'mail' } },
      { id: 'everyone', text: s.guide.everyone.text, away: s.guide.everyone.away, go: { room: 'all' }, after: { event: 'ceo-shoutout' }, until: { event: 'everyone-seen' } },
    ],
    fallback: { text: s.fallback.text, question: s.fallback.question },
    end: {
      after: { event: 'sara-welcome' },
      delayMs: 2000,
      title: s.end.title,
      contrast: s.end.usually,
      signup: { label: s.end.signup, url: 'https://ax.trina.app/pricing' },
    },
  }
}
