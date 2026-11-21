// The richer Steepling (the free-roam demo's team after "Mina's first day"): the shape of everything beyond the scripted
// story, with no words. Who sent what, when, in which room or thread, with which reactions, which files and chats each
// project holds, what is still unread for Mina, the fake Gmail's and Drive's extra items. The words are in
// strings/rich.<locale>.ts, one flat record per language keyed by the ids here (`satisfies Record<RichTextId, string>`),
// so a missing or extra line in a language fails to compile. make.ts resolves the ids into each language's paths,
// project names and @names.
//
// In a text: `@{mina}` mentions a person (make.ts writes `@<their name>`), `{file:<file id>}` links a file of FILES,
// `{project:<project id>}` a project of PROJECTS. Times are minutes before the snapshot is built (`ago`): the story's
// day one is today, so new copy says "today", "last week", never a date that follows the build day. Every person,
// company and number here is made up.

/** minutes before the build: `days` days and `hours` hours earlier (the story's morning is the last ~4 hours) */
const ago = (days: number, hours = 0, minutes = 0) => days * 1440 + hours * 60 + minutes
const m = (minutes: number) => minutes

/** the accounts: the story's seven plus three new people (initials, no photo) */
export const NEW_PEOPLE = {
  ben: { group: 'marketing' },
  nadia: { group: 'operations' },
  grace: { group: 'operations' },
} as const
export type NewPerson = keyof typeof NEW_PEOPLE
export type Who = 'daniel' | 'mina' | 'sara' | 'leo' | 'tom' | 'aiko' | 'omar' | NewPerson
export const EVERYONE: readonly Who[] = ['daniel', 'mina', 'sara', 'leo', 'ben', 'tom', 'nadia', 'grace', 'aiko', 'omar']

/** the projects beyond the story's launch project ("p1", the story's own). Members: the maker's own group (a maker
 * picks only groups they are in: marketing, operations, sales, shop) and people by name */
export const PROJECTS = {
  p3: { by: 'tom', groups: ['operations'], users: ['sara', 'mina', 'omar', 'daniel'], channel: 'customer-voice' },
  p4: { by: 'aiko', groups: ['sales'], users: ['leo', 'sara', 'mina', 'daniel'], channel: 'cafe-partners' },
  p5: { by: 'leo', groups: ['marketing'], users: [], channel: 'social-calendar' },
} as const satisfies Record<string, { by: Who; groups: readonly ('marketing' | 'operations' | 'sales' | 'shop')[]; users: readonly Who[]; channel: string }>
export type ProjectId = keyof typeof PROJECTS

/** the new rooms (the story's everyone, marketing, launch-day, dm-sara, dm-leo get more messages too). A named group
 * room is a private channel (people[0] makes it); `handover` has no name: a group DM */
export const ROOMS = {
  'customer-voice': { people: ['tom', 'nadia', 'omar', 'sara', 'mina', 'grace'], named: true },
  'cafe-partners': { people: ['aiko', 'leo', 'sara', 'mina', 'daniel'], named: true },
  'social-calendar': { people: ['leo', 'sara', 'ben', 'mina'], named: true },
  'tea-break': { people: ['grace', 'daniel', 'mina', 'sara', 'leo', 'ben', 'tom', 'nadia', 'aiko', 'omar'], named: true },
  handover: { people: ['sara', 'leo', 'mina'], named: false },
  'dm-daniel': { people: ['daniel', 'mina'], named: false },
  'dm-omar': { people: ['omar', 'mina'], named: false },
} as const satisfies Record<string, { people: readonly Who[]; named: boolean }>
/** every room a message can be in: the story's and the new ones */
export type RoomSlug = 'everyone' | 'marketing' | 'launch-day' | 'dm-sara' | 'dm-leo' | keyof typeof ROOMS
/** the story's launch-day group chat gets Daniel too */
export const LAUNCH_DAY_ADD: readonly Who[] = ['daniel']

/** the new files: where each goes (a group folder, `shared`, the company-wide templates folder shared/<Templates in
 * the team's language>, a project, or Mina's own folder) and when it was last changed. Mina opens all of them (none is in another team's
 * folder) */
export const FILES = {
  directory: { in: 'shared', ago: ago(4) },
  intro: { in: 'shared', ago: ago(21) },
  retro: { in: 'marketing', ago: ago(35) },
  kickoff: { in: 'marketing', ago: ago(33) },
  handoverNotes: { in: 'marketing', ago: ago(1, 3) },
  'p3.reviews': { in: 'p3', ago: ago(3) },
  'p3.summary': { in: 'p3', ago: ago(19) },
  'p4.cafes': { in: 'p4', ago: ago(3, 2) },
  'p4.menu': { in: 'p4', ago: ago(11) },
  'p5.calendar': { in: 'p5', ago: ago(2) },
  'p5.past': { in: 'p5', ago: ago(13) },
  'p5.rules': { in: 'p5', ago: ago(20) },
  // the one page the social posts skill reads for next week's posts (QA TC-5713: one read, not six)
  'p5.next': { in: 'p5', ago: ago(2) },
  // Company-wide › Templates was empty (QA TC-5746)
  'tpl.post': { in: 'templates', ago: ago(30) },
  'tpl.meeting': { in: 'templates', ago: ago(34) },
  'tpl.visit': { in: 'templates', ago: ago(26) },
  // Mina's own (Files › Personal › My files was empty, QA TC-5886): started this morning
  'mina.notes': { in: 'mina', ago: ago(0, 3, 20) },
  'mina.setup': { in: 'mina', ago: ago(0, 3, 40) },
} as const satisfies Record<string, { in: 'shared' | 'templates' | 'marketing' | 'mina' | ProjectId; ago: number }>
export type FileId = keyof typeof FILES

type Reactions = Readonly<Partial<Record<string, readonly Who[]>>>
export interface Msg { room: RoomSlug; from: Who; ago: number; react?: Reactions; files?: readonly FileId[]; thread?: string; unread?: true }

/** every new room message and thread reply, by id (its text is the same id in strings/rich.<locale>.ts). `thread`: a
 * reply under that message. `unread`: Mina has not read it when the visitor arrives (only at the end of a room or of a
 * thread). Within a room the order here does not matter: make.ts sorts by time */
export const MESSAGES = {
  // ---- #Everyone: company life over five weeks, then day one
  'all.wrap': { room: 'everyone', from: 'daniel', ago: ago(36, 2), react: { '🙌': ['sara', 'leo', 'tom', 'aiko'] } },
  'all.receipts': { room: 'everyone', from: 'grace', ago: ago(34, 4) },
  'all.pouch': { room: 'everyone', from: 'tom', ago: ago(31, 3), react: { '👍': ['nadia', 'omar', 'grace'] } },
  'all.pouch.r1': { room: 'everyone', from: 'nadia', ago: ago(31, 2), thread: 'all.pouch' },
  'all.pouch.r2': { room: 'everyone', from: 'tom', ago: ago(31, 1), thread: 'all.pouch' },
  'all.price': { room: 'everyone', from: 'daniel', ago: ago(27, 5), react: { '🎉': ['sara', 'aiko', 'omar', 'ben', 'leo'] } },
  'all.news': { room: 'everyone', from: 'daniel', ago: ago(24, 2), react: { '🎉': ['sara', 'tom', 'nadia', 'grace', 'omar'], '👏': ['aiko', 'ben'] } },
  'all.news.r1': { room: 'everyone', from: 'aiko', ago: ago(24, 1, 40) , thread: 'all.news' },
  'all.news.r2': { room: 'everyone', from: 'leo', ago: ago(24, 1, 20), thread: 'all.news' },
  'all.reviews': { room: 'everyone', from: 'nadia', ago: ago(20, 3), react: { '🍃': ['sara', 'tom'] } },
  'all.subs': { room: 'everyone', from: 'omar', ago: ago(17, 2), react: { '📈': ['daniel', 'aiko', 'grace'] } },
  'all.heating': { room: 'everyone', from: 'grace', ago: ago(14, 5), react: { '🥶': ['ben', 'leo'] } },
  'all.tasting': { room: 'everyone', from: 'aiko', ago: ago(10, 4) },
  'all.packs': { room: 'everyone', from: 'grace', ago: ago(4, 2), react: { '😍': ['sara', 'nadia'] } },
  'all.slot': { room: 'everyone', from: 'omar', ago: ago(1, 4) },
  'all.hi-nadia': { room: 'everyone', from: 'nadia', ago: m(226) },
  'all.hi-ben': { room: 'everyone', from: 'ben', ago: m(221) },
  'all.hi-grace': { room: 'everyone', from: 'grace', ago: m(216) },
  'all.lunch': { room: 'everyone', from: 'aiko', ago: m(60), react: { '🍜': ['tom', 'grace'] } },

  // ---- #Marketing: the summer retro, the Yuzu Ginger kickoff and shoot, Leo's move, the launch
  'mkt.retro-call': { room: 'marketing', from: 'sara', ago: ago(36, 5) },
  'mkt.retro-leo': { room: 'marketing', from: 'leo', ago: ago(36, 4), react: { '💯': ['sara', 'daniel'] } },
  'mkt.retro-notes': { room: 'marketing', from: 'sara', ago: ago(35, 3), files: ['retro'], react: { '🙏': ['leo', 'ben'] } },
  'mkt.retro-notes.r1': { room: 'marketing', from: 'daniel', ago: ago(35, 2), thread: 'mkt.retro-notes' },
  'mkt.retro-notes.r2': { room: 'marketing', from: 'sara', ago: ago(35, 1, 30), thread: 'mkt.retro-notes' },
  'mkt.retro-notes.r3': { room: 'marketing', from: 'ben', ago: ago(35, 1), thread: 'mkt.retro-notes' },
  'mkt.kickoff': { room: 'marketing', from: 'sara', ago: ago(33, 5) },
  'mkt.mood': { room: 'marketing', from: 'ben', ago: ago(33, 3), react: { '😍': ['sara', 'leo'] } },
  'mkt.plan': { room: 'marketing', from: 'leo', ago: ago(32, 4) },
  'mkt.shoot': { room: 'marketing', from: 'sara', ago: ago(29, 5) },
  'mkt.shoot.r1': { room: 'marketing', from: 'leo', ago: ago(29, 4, 30), thread: 'mkt.shoot' },
  'mkt.shoot.r2': { room: 'marketing', from: 'ben', ago: ago(29, 4), thread: 'mkt.shoot' },
  'mkt.shoot.r3': { room: 'marketing', from: 'sara', ago: ago(29, 3, 50), thread: 'mkt.shoot' },
  'mkt.price': { room: 'marketing', from: 'daniel', ago: ago(27, 4) },
  'mkt.shot': { room: 'marketing', from: 'ben', ago: ago(26, 2), react: { '🔥': ['sara', 'leo', 'daniel'] } },
  'mkt.move': { room: 'marketing', from: 'sara', ago: ago(24, 3) },
  'mkt.move.r1': { room: 'marketing', from: 'leo', ago: ago(24, 2, 40), thread: 'mkt.move' },
  'mkt.move.r2': { room: 'marketing', from: 'sara', ago: ago(24, 2, 30), thread: 'mkt.move' },
  'mkt.move.r3': { room: 'marketing', from: 'daniel', ago: ago(24, 2), thread: 'mkt.move' },
  'mkt.calendar': { room: 'marketing', from: 'leo', ago: ago(21, 3) },
  'mkt.quotes': { room: 'marketing', from: 'sara', ago: ago(19, 4) },
  'mkt.quotes-ask': { room: 'marketing', from: 'ben', ago: ago(19, 3) },
  'mkt.quotes-yes': { room: 'marketing', from: 'sara', ago: ago(19, 2) },
  'mkt.track': { room: 'marketing', from: 'daniel', ago: ago(15, 5) },
  'mkt.track-yes': { room: 'marketing', from: 'sara', ago: ago(15, 4) },
  'mkt.numbers': { room: 'marketing', from: 'leo', ago: ago(13, 3), react: { '👀': ['sara', 'ben'] } },
  'mkt.media': { room: 'marketing', from: 'sara', ago: ago(9, 4) },
  'mkt.away': { room: 'marketing', from: 'ben', ago: ago(8, 2) },
  'mkt.font': { room: 'marketing', from: 'leo', ago: ago(5, 3), react: { '😅': ['ben'] } },
  'mkt.font-tip': { room: 'marketing', from: 'sara', ago: ago(4, 5) },
  'mkt.font-thanks': { room: 'marketing', from: 'leo', ago: ago(4, 4) },
  'mkt.eyes': { room: 'marketing', from: 'daniel', ago: ago(1, 23) },
  'mkt.press': { room: 'marketing', from: 'sara', ago: ago(1, 3) },
  'mkt.press-ok': { room: 'marketing', from: 'daniel', ago: ago(1, 2) },
  'mkt.today': { room: 'marketing', from: 'sara', ago: m(250), react: { '😂': ['leo', 'ben'] } },
  'mkt.handover': { room: 'marketing', from: 'leo', ago: m(214) },
  'mkt.crop': { room: 'marketing', from: 'ben', ago: m(95), react: { '👍': ['sara'] } },
  'mkt.crop.r1': { room: 'marketing', from: 'mina', ago: m(92), thread: 'mkt.crop' },
  'mkt.crop.r2': { room: 'marketing', from: 'ben', ago: m(91), thread: 'mkt.crop' },
  'mkt.next': { room: 'marketing', from: 'sara', ago: m(80) },
  'mkt.tags': { room: 'marketing', from: 'leo', ago: m(75) },
  'mkt.morning': { room: 'marketing', from: 'daniel', ago: m(50), react: { '🚀': ['sara', 'leo', 'ben', 'mina'] } },

  // ---- Launch day (the story's group chat, the launch project's channel): the run of Monday morning
  'ld.start': { room: 'launch-day', from: 'omar', ago: ago(9, 3) },
  'ld.stock': { room: 'launch-day', from: 'tom', ago: ago(9, 2) },
  'ld.times': { room: 'launch-day', from: 'sara', ago: ago(6, 4) },
  'ld.coffee': { room: 'launch-day', from: 'daniel', ago: ago(6, 3), react: { '😄': ['omar', 'tom'] } },
  'ld.in': { room: 'launch-day', from: 'tom', ago: ago(2, 5), react: { '📦': ['omar', 'sara'] } },
  'ld.final': { room: 'launch-day', from: 'sara', ago: m(70), react: { '🎉': ['omar', 'tom', 'daniel'] } },
  'ld.ready': { room: 'launch-day', from: 'tom', ago: m(65) },

  // ---- Customer voice (project p3's channel): weekly reviews, the torn-bag fix, the sampler idea
  'cv.start': { room: 'customer-voice', from: 'tom', ago: ago(30, 5) },
  'cv.week1': { room: 'customer-voice', from: 'nadia', ago: ago(30, 4) },
  'cv.batch': { room: 'customer-voice', from: 'tom', ago: ago(29, 3) },
  'cv.sampler': { room: 'customer-voice', from: 'nadia', ago: ago(23, 4), react: { '💡': ['sara', 'omar'] } },
  'cv.sampler.r1': { room: 'customer-voice', from: 'omar', ago: ago(23, 3), thread: 'cv.sampler' },
  'cv.sampler.r2': { room: 'customer-voice', from: 'sara', ago: ago(23, 2), thread: 'cv.sampler' },
  'cv.october': { room: 'customer-voice', from: 'nadia', ago: ago(19, 5), files: ['p3.summary'] },
  'cv.quote-ask': { room: 'customer-voice', from: 'sara', ago: ago(19, 4) },
  'cv.quote-ok': { room: 'customer-voice', from: 'nadia', ago: ago(18, 3) },
  'cv.courier': { room: 'customer-voice', from: 'omar', ago: ago(16, 2) },
  'cv.refunds': { room: 'customer-voice', from: 'grace', ago: ago(12, 3) },
  'cv.november': { room: 'customer-voice', from: 'nadia', ago: ago(9, 4), react: { '🎉': ['tom', 'sara', 'omar'] } },
  'cv.works': { room: 'customer-voice', from: 'tom', ago: ago(9, 3) },
  'cv.file': { room: 'customer-voice', from: 'nadia', ago: ago(3, 1), files: ['p3.reviews'] },
  'cv.faq': { room: 'customer-voice', from: 'omar', ago: ago(1, 5) },
  'cv.mina': { room: 'customer-voice', from: 'nadia', ago: m(40), unread: true },

  // ---- Café partners (project p4's channel): reorders, cafés at risk, the winter menu card
  'cp.start': { room: 'cafe-partners', from: 'aiko', ago: ago(30, 3) },
  'cp.asks': { room: 'cafe-partners', from: 'leo', ago: ago(30, 2) },
  'cp.harbour': { room: 'cafe-partners', from: 'aiko', ago: ago(25, 4) },
  'cp.card': { room: 'cafe-partners', from: 'sara', ago: ago(25, 3) },
  'cp.card.r1': { room: 'cafe-partners', from: 'leo', ago: ago(25, 2), thread: 'cp.card' },
  'cp.card.r2': { room: 'cafe-partners', from: 'aiko', ago: ago(25, 1), thread: 'cp.card' },
  'cp.risk': { room: 'cafe-partners', from: 'aiko', ago: ago(16, 4) },
  'cp.samples': { room: 'cafe-partners', from: 'daniel', ago: ago(16, 3), react: { '👍': ['aiko'] } },
  'cp.sketch': { room: 'cafe-partners', from: 'leo', ago: ago(11, 2), files: ['p4.menu'] },
  'cp.back': { room: 'cafe-partners', from: 'aiko', ago: ago(10, 3), react: { '🎉': ['leo', 'sara', 'daniel'] } },
  'cp.when': { room: 'cafe-partners', from: 'aiko', ago: ago(3, 3) },
  'cp.handover': { room: 'cafe-partners', from: 'leo', ago: m(200) },
  'cp.mina': { room: 'cafe-partners', from: 'mina', ago: m(180), react: { '🙌': ['aiko', 'leo'] } },
  'cp.thanks': { room: 'cafe-partners', from: 'aiko', ago: m(172) },

  // ---- Social calendar (project p5's channel): slots, numbers, the handover to Mina
  'sc.start': { room: 'social-calendar', from: 'leo', ago: ago(21, 2) },
  'sc.finally': { room: 'social-calendar', from: 'sara', ago: ago(21, 1), react: { '😂': ['leo'] } },
  'sc.rules': { room: 'social-calendar', from: 'leo', ago: ago(20, 3) },
  'sc.sizes': { room: 'social-calendar', from: 'ben', ago: ago(18, 2) },
  'sc.numbers': { room: 'social-calendar', from: 'leo', ago: ago(13, 2), files: ['p5.past'], react: { '👀': ['sara', 'ben'] } },
  'sc.slots': { room: 'social-calendar', from: 'leo', ago: ago(6, 3) },
  'sc.crops': { room: 'social-calendar', from: 'ben', ago: ago(5, 4) },
  'sc.yours': { room: 'social-calendar', from: 'leo', ago: ago(2, 4), files: ['p5.calendar'] },
  'sc.yours.r1': { room: 'social-calendar', from: 'mina', ago: m(160), thread: 'sc.yours' },
  'sc.yours.r2': { room: 'social-calendar', from: 'sara', ago: m(30), thread: 'sc.yours', unread: true },
  'sc.best': { room: 'social-calendar', from: 'sara', ago: ago(1, 4) },
  'sc.hi': { room: 'social-calendar', from: 'ben', ago: m(190) },
  'sc.tags': { room: 'social-calendar', from: 'leo', ago: m(168) },

  // ---- Tea break (a private channel for everyone, no project): lunch, plants, cake
  'tb.start': { room: 'tea-break', from: 'grace', ago: ago(35, 5) },
  'tb.first': { room: 'tea-break', from: 'aiko', ago: ago(35, 4), react: { '😂': ['omar', 'leo'] } },
  'tb.basil': { room: 'tea-break', from: 'tom', ago: ago(28, 3), react: { '🌿': ['grace', 'nadia', 'ben'] } },
  'tb.bake': { room: 'tea-break', from: 'omar', ago: ago(22, 5) },
  'tb.bars': { room: 'tea-break', from: 'nadia', ago: ago(22, 4), react: { '🍋': ['aiko', 'grace'] } },
  'tb.sunrise': { room: 'tea-break', from: 'ben', ago: ago(15, 6), react: { '🌅': ['sara', 'nadia'] } },
  'tb.tasting': { room: 'tea-break', from: 'aiko', ago: ago(10, 3), react: { '✋': ['grace', 'leo', 'tom'] } },
  'tb.tasting.r1': { room: 'tea-break', from: 'grace', ago: ago(10, 2, 40), thread: 'tb.tasting' },
  'tb.tasting.r2': { room: 'tea-break', from: 'leo', ago: ago(10, 2, 20), thread: 'tb.tasting' },
  'tb.tasting.r3': { room: 'tea-break', from: 'tom', ago: ago(10, 2), thread: 'tb.tasting' },
  'tb.cake': { room: 'tea-break', from: 'sara', ago: ago(7, 3), react: { '😂': ['ben', 'aiko', 'omar'] } },
  'tb.beans': { room: 'tea-break', from: 'grace', ago: ago(3, 5) },
  'tb.read': { room: 'tea-break', from: 'daniel', ago: ago(3, 4), react: { '😂': ['grace', 'tom', 'aiko', 'sara', 'omar'] } },
  'tb.vote': { room: 'tea-break', from: 'aiko', ago: m(55), react: { '🍜': ['sara', 'tom', 'nadia'], '🍕': ['omar', 'ben', 'leo'] } },
  'tb.mina': { room: 'tea-break', from: 'mina', ago: m(45), react: { '👋': ['grace', 'aiko', 'nadia'] } },

  // ---- DMs and the handover group DM: day one only (Mina had nothing before today)
  'dm.sara.1': { room: 'dm-sara', from: 'mina', ago: m(190) },
  'dm.sara.2': { room: 'dm-sara', from: 'sara', ago: m(62) },
  'dm.sara.3': { room: 'dm-sara', from: 'mina', ago: m(58) },
  'dm.leo.1': { room: 'dm-leo', from: 'mina', ago: m(186) },
  'dm.leo.2': { room: 'dm-leo', from: 'leo', ago: m(183) },
  'dm.daniel.1': { room: 'dm-daniel', from: 'daniel', ago: m(246) },
  'dm.daniel.2': { room: 'dm-daniel', from: 'mina', ago: m(229) },
  'dm.omar.1': { room: 'dm-omar', from: 'omar', ago: m(25), unread: true },
  'ho.1': { room: 'handover', from: 'sara', ago: m(262) },
  'ho.2': { room: 'handover', from: 'leo', ago: m(256) },
  'ho.3': { room: 'handover', from: 'leo', ago: m(255) },
  'ho.4': { room: 'handover', from: 'mina', ago: m(170) },
  'ho.5': { room: 'handover', from: 'sara', ago: m(166) },
} as const satisfies Record<string, Msg>
export type MessageId = keyof typeof MESSAGES

/** the new AI chats (plain finished answers): one shared in each new project, and Mina's own "who's who" */
export const CHATS = {
  'c.p3': { by: 'nadia', project: 'p3', turns: { 'c.p3.1': ago(19, 6) } },
  'c.p4': { by: 'aiko', project: 'p4', turns: { 'c.p4.1': ago(11, 5) } },
  'c.p5': { by: 'leo', project: 'p5', turns: { 'c.p5.1': ago(6, 5), 'c.p5.2': ago(6, 4, 50) } },
  'c.who': { by: 'mina', turns: { 'c.who.1': m(212) } },
} as const satisfies Record<string, { by: Who; project?: ProjectId; turns: Record<string, number> }>
export type ChatId = keyof typeof CHATS
type TurnsOf<C> = C extends { turns: infer T } ? keyof T & string : never
export type TurnId = TurnsOf<(typeof CHATS)[ChatId]>

/** outside contacts (mail only; reserved .example addresses) */
export const CONTACTS = {
  chris: 'chris.walker@fieldnote.example',
  sam: 'sam.ortiz@harbourbeans.example',
  marketing: 'marketing@steepling.example',
  all: 'all@steepling.example',
} as const
type Party = Who | keyof typeof CONTACTS

/** Mina's mailbox: the new threads (the story's four are made in make.ts). Older mail reaches her through the
 * marketing@ and all@ lists */
export const MAIL = {
  'gm.accounts': { thread: 'accounts', from: 'grace', to: ['mina'], ago: m(300), labels: ['INBOX'] },
  'gm.weekly': { thread: 'weekly', from: 'chris', to: ['marketing'], cc: ['sara'], ago: ago(6), labels: ['INBOX'] },
  'gm.menu-ask': { thread: 'menu-card', from: 'sam', to: ['aiko'], cc: ['marketing'], ago: ago(3, 6), labels: ['INBOX'] },
  'gm.menu-reply': { thread: 'menu-card', from: 'aiko', to: ['sam'], cc: ['marketing'], ago: ago(3, 3), labels: ['INBOX'] },
  'gm.fan': { thread: 'fan-mail', from: 'nadia', to: ['mina'], ago: m(52), labels: ['INBOX'] },
  'gm.lunch': { thread: 'lunch', from: 'aiko', to: ['all'], ago: m(57), labels: ['INBOX', 'UNREAD'] },
} as const satisfies Record<string, { thread: string; from: Party; to: readonly Party[]; cc?: readonly Party[]; ago: number; labels: readonly string[] }>
export type MailId = keyof typeof MAIL

/** Mina's Drive: the new files (folder: a DRIVE_FOLDERS id, or none for My Drive) */
export const DRIVE_FOLDERS = ['fieldnote', 'competitors'] as const
export const DRIVE = {
  'dr.tracker': { folder: 'competitors', mime: 'application/vnd.google-apps.spreadsheet', ago: ago(5) },
  'dr.weekly': { folder: 'fieldnote', mime: 'application/vnd.google-apps.document', ago: ago(6) },
  'dr.checklist': { mime: 'application/vnd.google-apps.document', ago: m(280) },
} as const satisfies Record<string, { folder?: (typeof DRIVE_FOLDERS)[number]; mime: string; ago: number }>
export type DriveId = keyof typeof DRIVE

/** the team skills in their Steepling versions (scripts/demo/steepling/assets/skill-<name>.<locale>.md); the story's
 * brand-guide and press-release stay as they are */
export const OWN_SKILLS = ['social-posts', 'competitor-roundup', 'handover', 'review-digest'] as const

/** what a snapshot of the richer Steepling must at least hold (build-snapshot.ts verifySnapshot): a thin build fails */
export const FLOORS = {
  projects: 4, channels: 7, rooms: 12, roomMessages: 120, threads: 9, threadReplies: 20, reactions: 40,
  chats: 9, filesOpened: 25, skills: 6, gmailThreads: 8, driveFiles: 5, oldestDays: 35,
} as const

/** every text the languages give (strings/rich.<locale>.ts): a message's, a file's name and body, a project's name and
 * instructions, a room's name, a person's name and title, a chat's title and its turns, a mail's subject and body, a
 * Drive file's name and text */
export type RichTextId =
  | MessageId
  | `${FileId}.name` | `${FileId}.text`
  | `${ProjectId}.name` | `${ProjectId}.about`
  | `room.${'customer-voice' | 'cafe-partners' | 'social-calendar' | 'tea-break'}`
  | `${NewPerson}.name` | `${NewPerson}.title`
  | `${ChatId}.title` | `${TurnId}.ask` | `${TurnId}.answer`
  | `${MailId}.subject` | `${MailId}.body`
  | `${DriveId}.name` | `${DriveId}.text` | `folder.${(typeof DRIVE_FOLDERS)[number]}`
  | 'contact.sam'
export type RichWords = Record<RichTextId, string>
