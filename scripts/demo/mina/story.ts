// "Mina's first day": the story's structure (format: web/demo/script.ts), with every word taken from a strings file
// (strings/<locale>.ts) and every picture or text file from ../assets/<name>.<locale>.<ext>. Steepling is a fictional
// company; every person, number, address and file is made up (README.md).
import type { DemoAnswer, DemoAsk, DemoReply, DemoScript, DemoStep } from '../../../web/demo/script'
import type { Strings } from './strings/en'

type Mail = Strings['mail']['plain']

export function buildScript(s: Strings, locale: DemoScript['locale']): DemoScript {
  const P = s.project.name
  const inProject = (name: string) => `projects/${P}/${name}`
  const brief = `groups/${s.marketingGroup}/${s.paths.brief}`
  const leoBanner = inProject(s.paths.leoBanner)
  const bannerA = inProject(s.paths.bannerA)
  const bannerB = inProject(s.paths.bannerB)
  const backgroundB = inProject(s.paths.backgroundB)
  const final = inProject(s.paths.final)
  /** The CEO's final file. The format has no "the banner the visitor made", so it is version A, the first suggestion;
   * if the engine learns to pick the asset of the banner answer that finished, use banner-b after `banner-b`. */
  const finalAsset = `banner-a.${locale}.png`

  const link = (text: string) => text.replaceAll('{project}', '{{project:launch}}')
  const image = (alt: string, path: string) => `![${alt}]({{file:${path}}})`
  const st = s.steps
  const read = (path: string): DemoStep => ({ label: `${st.read} · ${path}`, tool: 'read' })
  const save = (path: string): DemoStep => ({ label: `${st.save} · ${path}`, tool: 'write' })

  // ---- the mail to the agency: a draft, a confirm card, a sent line

  const m = s.mail
  const draft = (mail: Mail) =>
    `**${m.labels.to}** ${m.to}\n**${m.labels.subject}** ${mail.subject}\n**${m.labels.attachment}** ${m.attachment}\n\n` +
    mail.body.map((l) => (l ? `> ${l}` : '>')).join('\n')
  const sent = (mail: Mail): DemoReply => ({
    steps: [{ label: `Gmail · ${st.gmailSend}`, tool: 'gmail', ms: 1200 }],
    text: m.sent.replaceAll('{attachment}', m.attachment).replaceAll('{subject}', mail.subject),
  })
  const confirm = (mail: Mail, offerFormal: boolean): DemoAsk => ({
    question: m.confirm,
    options: [
      { label: m.send, reply: sent(mail) },
      ...(offerFormal ? [{ label: m.makeFormal, reply: { text: `${m.formalIntro}\n\n${draft(m.formal)}`, ask: confirm(m.formal, false) } }] : []),
      { label: m.cancel, reply: { text: m.notSent } },
    ],
  })
  const mailSteps: DemoStep[] = [{ label: `Gmail · ${st.gmailSearch} "Chris"`, tool: 'gmail', ms: 1100 }, read(final)]

  // ---- the AI answers

  const a = s.answers
  const answers: DemoAnswer[] = [
    {
      id: 'company',
      where: 'home',
      prompt: a.company.prompt,
      steps: [read(s.paths.companyIntro), read(brief), { label: st.teamSkills, tool: 'glob', ms: 500 }],
      text: a.company.text,
    },
    {
      // not in the guide: there for a visitor who takes up the handover offer
      id: 'handover',
      where: 'any',
      prompt: a.handover.prompt,
      label: a.handover.label,
      steps: [{ label: `${st.useSkill} · ${st.handoverSkill}`, tool: 'read', ms: 500 }, read(brief), { label: `${st.list} · projects/${P}`, tool: 'glob' }],
      text: link(a.handover.text),
    },
    {
      id: 'banner-a',
      where: { project: 'launch' },
      prompt: a.bannerA.prompt,
      label: a.bannerA.label,
      steps: [read(s.paths.brandGuide), read(leoBanner), { label: `${st.makeBanner} · 1200×628`, tool: 'write', ms: 1600 }, save(bannerA)],
      text: `${a.bannerA.text}\n\n${image(a.bannerA.imageAlt, bannerA)}\n\n${a.bannerA.after}`,
      files: [{ path: bannerA, asset: `banner-a.${locale}.png` }],
    },
    {
      id: 'banner-b',
      where: { project: 'launch' },
      prompt: a.bannerB.prompt,
      label: a.bannerB.label,
      steps: [
        read(s.paths.brandGuide),
        { label: `Higgsfield · ${st.higgsfield}`, tool: 'higgsfield', ms: 2600 },
        save(backgroundB),
        { label: `${st.makeBanner} · 1200×628`, tool: 'write', ms: 1400 },
        save(bannerB),
      ],
      text: `${a.bannerB.text}\n\n${image(a.bannerB.imageAlt, bannerB)}\n\n${a.bannerB.after}`,
      files: [{ path: backgroundB, asset: 'bg-b.png' }, { path: bannerB, asset: `banner-b.${locale}.png` }],
    },
    {
      id: 'mail',
      where: { side: 'mkt-room' },
      prompt: a.mail.prompt,
      label: a.mail.label,
      steps: mailSteps,
      text: `${a.mail.intro}\n\n${draft(m.plain)}`,
      ask: confirm(m.plain, true),
    },
    {
      id: 'mail-formal',
      where: { side: 'mkt-room' },
      prompt: a.mailFormal.prompt,
      label: a.mailFormal.label,
      steps: mailSteps,
      text: `${a.mailFormal.intro}\n\n${draft(m.formal)}`,
      ask: confirm(m.formal, false),
    },
  ]

  const ids = ['mina', 'sara', 'daniel', 'leo', 'tom', 'aiko', 'omar'] as const
  const marketing = ['mina', 'sara', 'leo', 'daniel']
  const spaced = (msgs: { from: string; text: string }[], start: number, files?: Record<number, string[]>) =>
    msgs.map((msg, i) => ({ ...msg, minutesAgo: start - i * 3, ...(files?.[i] ? { files: files[i] } : {}) }))

  return {
    version: 1,
    locale,
    company: { name: s.company },
    visitor: 'mina',
    people: ids.map((id) => ({ id, name: s.people[id].name, title: s.people[id].title, avatar: `avatar-${id}.png` })),
    groups: [{ id: 'mkt', name: s.marketingGroup, members: marketing }],
    rooms: [
      { id: 'all', kind: 'all', members: [...ids], messages: spaced(s.rooms.everyone, 40) },
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
          turns: [{ ask: s.leoChat.ask, answer: `${s.leoChat.answer}\n\n${image(s.leoChat.title, leoBanner)}`, files: [leoBanner] }],
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
    home: { title: s.home.title, prompt: a.company.prompt },
    answers,
    events: [
      { id: 'dm-1', after: { answer: 'company' }, delayMs: 2500, room: 'dm-lead', from: 'sara', text: link(s.events.leadDm) },
      { id: 'lead-reply', after: { shared: 'mkt-room' }, delayMs: 2000, room: 'mkt-room', from: 'sara', text: s.events.leadReply },
      { id: 'leo-cheer', after: { event: 'lead-reply' }, delayMs: 1500, room: 'mkt-room', from: 'leo', text: s.events.leoCheer },
      { id: 'ceo-ok', after: { event: 'leo-cheer' }, delayMs: 2500, room: 'mkt-room', from: 'daniel', text: s.events.ceoOk, files: [final], newFiles: [{ path: final, asset: finalAsset }] },
      { id: 'gmail', after: { event: 'ceo-ok' }, delayMs: 2000, room: 'mkt-room', from: 'sara', text: s.events.leadGmail },
    ],
    guide: [
      { id: 'ask', text: s.guide.ask, go: 'home', highlight: '[data-testid="member-welcome-ask"]', until: { answer: 'company' } },
      { id: 'dm', text: s.guide.dm, go: { room: 'dm-lead' }, after: { event: 'dm-1' }, until: { opened: { project: 'launch' } } },
      { id: 'banner', text: s.guide.banner, go: { project: 'launch' }, suggest: ['banner-a', 'banner-b'], until: { answer: ['banner-a', 'banner-b'] } },
      { id: 'share', text: s.guide.share, go: { project: 'launch' }, highlight: '[data-testid="share-to-room"]', until: { shared: 'mkt-room' } },
      { id: 'mail', text: s.guide.mail, go: { side: 'mkt-room' }, after: { event: 'gmail' }, suggest: ['mail', 'mail-formal'], until: { answer: ['mail', 'mail-formal'] } },
    ],
    fallback: { text: s.fallback.text, question: s.fallback.question },
    end: {
      after: { answer: ['mail', 'mail-formal'] },
      title: s.end.title,
      body: s.end.body,
      signup: { label: s.end.signup, url: 'https://trina.app/' },
      explore: { label: s.end.explore },
    },
  }
}
