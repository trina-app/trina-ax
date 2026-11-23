// Demo mode (docs/DECISIONS.md "Demo company: a new hire at 트리나"): a development server started by `bun run demo:company`
// with MYCEL_DEMO=<demo file>. Only then do these endpoints exist (404 otherwise), and the server refuses to start with
// the flag in production, on the hosted service or in office mode (server/src/app-config.ts). The product itself has
// no "sign in as someone else" (docs/WORKPLAN.md A): switching to another demo person is a normal sign-in of that
// seeded account with the demo's public password, done by the server so the browser never holds the password.
import { z } from 'zod'
import { PROFILE_TITLE_MAX } from '../avatar'
import { UserId, Uuid7 } from '../ids'
import { Locale } from './common'
import { endpoint } from './endpoint'
import { Username } from './auth'
import { TeamSettings } from './entities'
import { CompanyProfileInput } from './onboarding'

/** The three people a viewer can be. Their labels are app strings (web i18n `demo.persona.*`). */
export const DemoPersonaKey = z.enum(['newHire', 'lead', 'ceo'])
export type DemoPersonaKey = z.infer<typeof DemoPersonaKey>

/**
 * A recorded real answer (`scripts/demo/company/record.ts`): one prompt of one demo person, run once by the real AI on a
 * development server, written down from the engine's own transcript: the answer's text and every tool call with its
 * input, in order, with the time since the start. In demo mode the same prompt from the same person replays it
 * (server/src/demo/replay.ts): the text again, and every team tool call made again through the turn's own tools with
 * the person's permissions, so the files and artifacts it shows are made by the product, now.
 */
export const DemoRecordingEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), t: z.number().int().min(0), text: z.string().max(40_000) }).strict(),
  z.object({ type: z.literal('tool'), t: z.number().int().min(0), name: z.string().min(1).max(200), input: z.unknown(), ok: z.boolean(),
    /** what the tool answered in the recorded run (only replayed for the engine's own tools, never for team tools) */
    output: z.string().max(4000).optional(), ms: z.number().int().min(0).optional() }).strict(),
])
export type DemoRecordingEvent = z.infer<typeof DemoRecordingEvent>
export const DemoRecording = z.object({
  v: z.literal(1),
  /** the demo person's account (replays only for them) and their id when it was recorded (paths in users/<id>/) */
  username: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  prompt: z.string().min(1).max(2000),
  /** showcase: suggested on Home, replayed with its pace; history: seeded as a past chat, replayed at once */
  kind: z.enum(['showcase', 'history']),
  /** history: how many days ago the seeded chat says it was */
  daysAgo: z.number().int().min(0).max(60).optional(),
  recordedAt: z.string(),
  engine: z.string().max(40),
  model: z.string().max(100).nullable(),
  events: z.array(DemoRecordingEvent).min(1).max(400),
}).strict()
export type DemoRecording = z.infer<typeof DemoRecording>

/** A suggestion chip of the free-roam demo's bar: what it says, and the prompt a tap sends. */
export const DemoSuggestion = z.object({ label: z.string().min(1).max(60), prompt: z.string().min(1).max(500) }).strict()
export type DemoSuggestion = z.infer<typeof DemoSuggestion>

/** The demo file (MYCEL_DEMO). Written by scripts/demo/company/start.ts from the demo content (company.json); its texts
 * are the content's data in the company's own language, like the sample files. */
export const DemoFile = z.object({
  company: z.string().min(1).max(80),
  /** the seeded accounts' public demo password (scripts/demo/seed.ts DEMO_PASSWORD) */
  password: z.string().min(8).max(200),
  /** the question to ask as each person ("같은 질문, 사람마다 다른 답") */
  sameQuestion: z.string().min(1).max(200).optional(),
  /** a folder of recorded real answers (DemoRecording JSON files) the demo replays */
  replays: z.string().min(1).max(1000).optional(),
  /** the demo's fake services (server/src/demo/fakes/): Gmail, Google Drive and Higgsfield answered on this server from
   * fake data, and every other call to the outside refused. `content`: a folder with gmail.json, drive.json and
   * higgsfield/ pictures; left out, built-in fictional data */
  fakes: z.object({ content: z.string().min(1).max(1000).optional() }).strict().optional(),
  /** free-roam demo: its bar's suggestion chips ("Try anything"), in the demo's language (the content's
   * freeRoam.suggestions; the web reads them from GET /api/demo) */
  freeRoam: z.object({ suggestions: z.array(DemoSuggestion).max(4) }).strict().optional(),
  /** the snapshot builder only (scripts/demo/free-roam/build-snapshot.ts): the /api/demo/builder/* routes answer, for
   * the owner. Never in a snapshot's demo file. */
  builder: z.boolean().optional(),
  personas: z.array(z.object({
    key: DemoPersonaKey,
    username: z.string().min(1).max(64),
    /** one line at the top of Home: "오늘 트리나 마케팅팀에 입사한 한지우예요" */
    intro: z.string().min(1).max(200),
    /** suggested first questions (a tap sends one) */
    questions: z.array(z.string().min(1).max(200)).max(6),
  }).strict()).min(1).max(3)
    .refine((ps) => new Set(ps.map((p) => p.key)).size === ps.length, 'each persona key once'),
  /**
   * The kind of demo (docs/decisions/20261119-demo-free-roam-a.md). Absent or "scripted": the demo company of
   * `bun run demo:company` (persona switcher, replays). "freeRoam": one visitor's own instance behind demo-gate, with
   * the real AI until the demo limit: exactly one persona (the gate signs the visitor in as it), and the server accepts
   * it only with engine.authMode "managed", a loopback listener, no relay and a loopback model upstream
   * (server/src/app-config.ts readDemoFile). Everything a visitor must not reach is refused (server/src/demo/guard.ts).
   */
  kind: z.enum(['scripted', 'freeRoam']).optional(),
  /** freeRoam: the demo limit in weighted tokens (uncached input + cache writes + output + 0.1 x cache reads), for the
   * whole instance; default DEMO_LIMIT_DEFAULT */
  limitTokens: z.number().int().min(1_000).max(50_000_000).optional(),
  /** freeRoam: where "Start free" goes at the limit (https only) */
  signupUrl: z.string().max(500).regex(/^https:\/\/[^\s]+$/, 'an https:// address').optional(),
  /** freeRoam: the largest file one upload may hold (bytes; default DEMO_UPLOAD_FILE_MAX) */
  uploadFileMax: z.number().int().min(1).max(50 * 1024 * 1024).optional(),
  /** freeRoam: all uploads of the instance together (bytes; default DEMO_UPLOAD_TOTAL_MAX) */
  uploadTotalMax: z.number().int().min(1).max(1024 * 1024 * 1024).optional(),
  /** freeRoam, written by demo-gate into each instance's own copy (never in a snapshot): the SHA-256 (hex) of a random
   * key only the gate holds. POST /api/demo/persona needs that key in DEMO_GATE_KEY_HEADER, so code running on one
   * instance cannot sign in to another instance's port; a free-roam demo without a hash signs nobody in. Only the hash is
   * here: this file gives no way in. */
  gateKeySha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict()
  .refine((d) => d.kind === 'freeRoam' || (d.limitTokens === undefined && d.signupUrl === undefined && d.uploadFileMax === undefined && d.uploadTotalMax === undefined && d.gateKeySha256 === undefined), 'limitTokens, signupUrl, the upload limits and gateKeySha256 are for kind "freeRoam" only')
  .refine((d) => d.kind !== 'freeRoam' || d.personas.length === 1, 'a freeRoam demo has exactly one persona')
export type DemoFile = z.infer<typeof DemoFile>

/** the header demo-gate signs a visitor in with (DemoFile.gateKeySha256; demo-gate/src/public.ts names it too: no shared
 * imports there) */
export const DEMO_GATE_KEY_HEADER = 'x-mycel-demo-gate'

/** freeRoam's demo limit when the demo file names none (weighted tokens, see DemoFile.limitTokens) */
export const DEMO_LIMIT_DEFAULT = 300_000
/**
 * freeRoam: what one question to the AI costs in the demo limit on average (weighted tokens), so the screen can say
 * "about N questions" and never "tokens". The demo limit counts cache reads and cache writes at 0.1
 * (DEMO_CACHE_READ_WEIGHT, DEMO_CACHE_WRITE_WEIGHT): a copy's first question writes the system prompt and the tools to
 * the cache (about 90k true tokens on demo.trina.app, 11-20), and that cold start is not the visitor's question. In
 * those weights a typical question is about 20k-25k, the first one about the same, a banner edit about two; 35k keeps
 * DEMO_LIMIT_DEFAULT reading as "about 8" from the start (floor(300k / 35k)) and the first question leaves "about 7".
 * demo-gate's landing says "about 8" in its own words (demo-gate/src/pages.ts, no shared imports there): change both
 * together. docs/decisions/20261121-demo-meter-cache-writes.md
 */
export const DEMO_QUESTION_TOKENS = 35_000
/** freeRoam: the weight of a cache read in the demo limit */
export const DEMO_CACHE_READ_WEIGHT = 0.1
/** freeRoam: the weight of a cache write in the demo limit (the visitor's meter only; demo-gate's daily cap counts it
 * fully) */
export const DEMO_CACHE_WRITE_WEIGHT = 0.1
/** freeRoam: one upload's largest file, and all uploads of an instance together */
export const DEMO_UPLOAD_FILE_MAX = 10 * 1024 * 1024
export const DEMO_UPLOAD_TOTAL_MAX = 100 * 1024 * 1024
/** freeRoam: `params.reason` of a send refused at the demo limit (code budget_exceeded, with params used and cap) */
export const DEMO_LIMIT_REASON = 'demo_limit'
/** freeRoam: `params.reason` of an answer demo-gate stopped (its daily cap or its pause; code budget_exceeded) */
export const DEMO_REST_REASON = 'demo_rest'
/** freeRoam: `params.reason` of any other answer that failed (the words are always "The demo is busy, try again in a bit.") */
export const DEMO_BUSY_REASON = 'demo_busy'

/**
 * The demo content's company.json (scripts/demo/company/README.md, read by scripts/demo/company/content.ts): a fictional
 * company the demo scripts seed and run. Only the scripts read it; the server reads the demo file made from it.
 */
export const DEMO_CONTENT_FORMAT = 1
const ContentName = z.string().min(1).max(80)
const ContentSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and "-"')
const ContentPath = z.string().min(1).max(512)
  .refine((p) => !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '.' || s === ''), 'a team path like shared/a.md')
const ContentAccess = z.enum(['read', 'write'])
const ContentProfileTitle = z.string().trim().min(1).max(PROFILE_TITLE_MAX)
const ContentEmail = z.string().email().max(200)
const ContentRule = z.union([
  z.object({ group: ContentName, access: ContentAccess }).strict(),
  z.object({ user: Username, access: ContentAccess }).strict(),
  z.object({ everyone: z.literal(true), access: ContentAccess }).strict(),
])

// ---- the end of a story as data (free-roam demo; scripts/demo/company/README.md "The state a story ends in") ----
/** at most 60 days back */
const MinutesAgo = z.number().int().min(0).max(60 * 24 * 60)
const ContentProjectName = z.string().trim().min(1).max(100)
export const DemoContentProject = z.object({
  name: ContentProjectName,
  instructions: z.string().max(5000).default(''),
  /** who makes it: a person of the team or the owner (default: the owner) */
  by: Username.optional(),
  /** who is in it (they write in its folder) */
  members: z.array(z.union([z.object({ group: ContentName }).strict(), z.object({ user: Username }).strict()])).min(1).max(20),
  /** its channel: a private channel of `rooms` (kind "group" with a name; `rooms[].slug`), linked by its maker (a team
   * room or a DM never links: rooms/project-link.ts) */
  channel: ContentSlug.optional(),
}).strict()
export type DemoContentProject = z.infer<typeof DemoContentProject>
/** One past message. In `text`, `{project:<name>}` becomes a link to that project, `{file:<team path>}` the file's
 * address and `@<a person's name>` a mention of them. */
export const DemoContentRoomMessage = z.object({
  from: Username,
  text: z.string().max(4000).default(''),
  minutesAgo: MinutesAgo,
  /** team files sent with it (copied into the room as the sender's upload) */
  files: z.array(ContentPath).max(10).default([]),
  reactions: z.array(z.object({ from: Username, emoji: z.string().min(1).max(16) }).strict()).max(20).default([]),
  /** this message is the last answer of that seeded chat (`chats[].slug`), sent with "Send to room" by its person;
   * `text` is the note before it */
  shareChat: ContentSlug.optional(),
  /** the new hire (the demo person) has not read it when the visitor arrives: only at the end of a room's timeline */
  unread: z.literal(true).optional(),
  /** replies in its thread, oldest first, each after it; `unread` as above, only at the end of the thread */
  thread: z.array(z.object({
    from: Username,
    text: z.string().min(1).max(4000),
    minutesAgo: MinutesAgo,
    reactions: z.array(z.object({ from: Username, emoji: z.string().min(1).max(16) }).strict()).max(20).default([]),
    unread: z.literal(true).optional(),
  }).strict()).max(30).optional(),
}).strict()
export type DemoContentRoomMessage = z.infer<typeof DemoContentRoomMessage>
export const DemoContentRoom = z.object({
  /** how chats and checks name it */
  slug: ContentSlug,
  /** all: the everyone room; team: a group's room (`group`); dm: two `people`; group: a group chat people[0] makes */
  kind: z.enum(['all', 'team', 'dm', 'group']),
  group: ContentName.optional(),
  people: z.array(Username).min(2).max(20).optional(),
  /** a group chat's name (it is a private channel then) */
  name: z.string().min(1).max(80).optional(),
  messages: z.array(DemoContentRoomMessage).max(200).default([]),
}).strict()
export type DemoContentRoom = z.infer<typeof DemoContentRoom>
export const DemoContentChat = z.object({
  slug: ContentSlug,
  username: Username,
  /** a chat in this project (shared with its members unless `private`) */
  project: ContentProjectName.optional(),
  /** the side chat (✦) of this room (`rooms[].slug`) */
  sideRoom: ContentSlug.optional(),
  private: z.boolean().optional(),
  title: z.string().min(1).max(200),
  /** oldest first; an answer shows a team picture with `![label]({file:<team path>})` */
  turns: z.array(z.object({ ask: z.string().min(1).max(4000), answer: z.string().min(1).max(20_000), minutesAgo: MinutesAgo }).strict()).min(1).max(20),
  /** replies in the thread under the last answer (a shared chat: a project's), oldest first; `@<a person's name>`
   * mentions them. The answer's asker and anyone mentioned get the reply's notice (Activity) */
  thread: z.array(z.object({ from: Username, text: z.string().min(1).max(2000), minutesAgo: MinutesAgo }).strict()).max(20).optional(),
}).strict()
export type DemoContentChat = z.infer<typeof DemoContentChat>
const DemoAccount = z.object({ name: z.string().min(1).max(80), email: z.string().email().max(200) }).strict()
/** gmail and google-drive: a person's own (`username`); higgsfield: the team's (made by the owner). The builder makes up
 * the secrets; `account` is what the connection shows (a reserved `.example` address). */
export const DemoContentConnection = z.object({
  service: z.enum(['gmail', 'google-drive', 'higgsfield']),
  username: Username.optional(),
  account: DemoAccount,
}).strict()
export type DemoContentConnection = z.infer<typeof DemoContentConnection>

export const DemoContentCompany = z.object({
  format: z.literal(DEMO_CONTENT_FORMAT),
  /** short name: the relay address (<id>.localhost) and the default data folder (~/.<id>demo) */
  id: ContentSlug,
  teamName: ContentName,
  /** the team's and the people's language (the app's screens; the content's own words are in it too) */
  locale: Locale,
  /** the team's owner: an account of its own, never a demo person; its password is random (<data>/owner-password) */
  owner: z.object({ username: Username, name: ContentName,
    /** a group the owner is in too (a CEO who owns the team and is in #Marketing); none by default */
    group: ContentName.nullable().optional(),
    /** the job title on their profile, and their e-mail (a reserved `.example` address), each set by them */
    title: ContentProfileTitle.optional(), email: ContentEmail.optional() }).strict(),
  /** everyone else, all members: a demo may be open to the network with a public password, so nobody else is an owner
   * or an admin */
  people: z.array(z.object({
    username: Username,
    name: ContentName,
    /** the one group they are in, or null */
    group: ContentName.nullable(),
    /** who they are in the story ("CEO", "Marketing lead"), for people reading the file; shown nowhere */
    note: z.string().max(200).optional(),
    /** the job title on their profile (people lists, mentions), set by them */
    title: ContentProfileTitle.optional(),
    /** their e-mail (Settings › Profile; a reserved `.example` address), set by them */
    email: ContentEmail.optional(),
  }).strict()).min(3).max(60),
  groups: z.array(z.object({ name: ContentName, description: z.string().max(200) }).strict()).max(20),
  /** folder rules beyond the group folders (each group gets groups/<name>/, written by its members) */
  // access adds up from the folders above; `limited` cuts what comes from above (docs/DECISIONS.md "Folder access adds
  // up like Google Drive (P2)")
  rules: z.array(z.object({ path: ContentPath, rules: z.array(ContentRule).max(20), limited: z.boolean().optional(), why: z.string().max(200).optional() }).strict()
    .refine((r) => r.rules.length > 0 || r.limited === true, 'a rule or limited: true')).max(60),
  /** who uploads a sample file: the first entry whose path is the file or a folder above it, else defaultUploader */
  uploaders: z.array(z.object({ path: ContentPath, username: Username }).strict()).max(100).default([]),
  /** default: the owner */
  defaultUploader: Username.optional(),
  /** skills of the product's own skill packs (resources/skill-packs/<pack>/<locale>/<skill>/SKILL.md), uploaded where
   * the pack installs them: skills/<pack>/<skill>/SKILL.md */
  packSkills: z.array(z.object({ pack: ContentSlug, locale: Locale, skills: z.array(ContentSlug).min(1).max(20) }).strict()).max(5).default([]),
  /** team settings the owner sets; recordings need aiSubagents false (a run with a sub-agent is not recorded) */
  settings: TeamSettings.pick({ aiSubagents: true, timeZone: true }).partial().strict().optional(),
  /** what a person's AI remembers about them, saved as that person */
  memories: z.array(z.object({ username: Username, text: z.string().min(1).max(2000),
    /** when it was saved in the story (default: when the seed ran) */
    minutesAgo: MinutesAgo.optional() }).strict()).max(20).default([]),
  /** the company profile (회사 소개), saved by the owner */
  profile: CompanyProfileInput.optional(),
  /** demo mode: the people a viewer can be and the question to ask as each */
  demo: z.object({
    sameQuestion: z.string().min(1).max(200).optional(),
    personas: z.array(z.object({
      key: DemoPersonaKey,
      username: Username,
      /** one line at the top of Home, in the content's language */
      intro: z.string().min(1).max(200),
      /** suggested first questions; the person's recorded showcase prompts come after them */
      questions: z.array(z.string().min(1).max(200)).max(6),
    }).strict()).min(1).max(3),
  }).strict(),
  /** prompts each demo person ran once with the real AI (scripts/demo/company/record.ts): showcase (suggested on Home,
   * replayed at a natural pace) or history (seeded as a past chat, daysAgo days ago) */
  scenarios: z.array(z.object({
    slug: ContentSlug,
    username: Username,
    kind: z.enum(['showcase', 'history']),
    prompt: z.string().min(1).max(2000),
    daysAgo: z.number().int().min(0).max(60).optional(),
  }).strict()).max(40).default([]),
  /** what the content promises, checked on a seeded app (tests/unit/demo-company-seed.test.ts): files a person opens
   * and does not open, and, when given, exactly which team skills they see */
  checks: z.array(z.object({
    username: Username,
    opens: z.array(ContentPath).default([]),
    closed: z.array(ContentPath).default([]),
    skills: z.array(z.string().min(1)).optional(),
  }).strict()).default([]),
  // ---- the state a story ends in (free-roam demo; scripts/demo/company/story-state.ts seeds it). All optional ----
  /** team projects, each a folder projects/<name> made by `by` (default: the owner) and seen by its members */
  projects: z.array(DemoContentProject).max(10).default([]),
  /** rooms with their past messages, oldest first */
  rooms: z.array(DemoContentRoom).max(30).default([]),
  /** past AI chats, seeded as plain messages (no AI runs) */
  chats: z.array(DemoContentChat).max(40).default([]),
  /** connected services with made-up secrets (the free-roam demo's fakes answer them) */
  connections: z.array(DemoContentConnection).max(20).default([]),
  /** who invited a person (their welcome card on Home: "Sara invited you") */
  welcome: z.array(z.object({ username: Username, inviter: Username,
    /** they asked the AI what they can do here (the card's row is done) */
    asked: z.boolean().optional() }).strict()).max(60).default([]),
  /** when the files were last changed in the story (a file, or a folder for all under it: the first entry that
   * matches); a file none matches keeps the time it was seeded */
  fileTimes: z.array(z.object({ path: ContentPath, minutesAgo: MinutesAgo }).strict()).max(200).optional(),
  /** files and folders whose seeding stays out of Files › Recent (the team skills, the company profile) */
  recentHidden: z.array(ContentPath).max(50).optional(),
  /** the free-roam demo's bar: two to four suggestion chips */
  freeRoam: z.object({ suggestions: z.array(DemoSuggestion).min(1).max(4),
    /** where "Start free" goes at the demo limit (https) */
    signupUrl: z.string().max(500).regex(/^https:\/\/[^\s]+$/, 'an https:// address').optional() }).strict().optional(),
}).strict()
export type DemoContentCompany = z.infer<typeof DemoContentCompany>

export const DemoPersona = z.object({
  key: DemoPersonaKey,
  /** the account's name, null while the account does not exist (not seeded yet) */
  name: z.string().nullable(),
  /** the person's first group ("마케팅팀"), null for none */
  team: z.string().nullable(),
  intro: z.string(),
  questions: z.array(z.string()),
})
export type DemoPersona = z.infer<typeof DemoPersona>

export const DemoInfo = z.object({
  company: z.string(),
  sameQuestion: z.string().nullable(),
  /** which demo person the caller is signed in as (null: signed out, or another account) */
  current: DemoPersonaKey.nullable(),
  /** the server listens beyond this machine (not only 127.0.0.1): anyone on a network the machine is on can use it */
  network: z.boolean(),
  personas: z.array(DemoPersona),
  /** the demo file's kind (DemoFile.kind; absent = scripted, as from a server before free roam) */
  kind: z.enum(['scripted', 'freeRoam']).optional(),
  /** freeRoam only: weighted tokens used so far on this instance, and the demo limit */
  used: z.number().nonnegative().optional(),
  cap: z.number().int().positive().optional(),
  /** the team default language (team settings' defaultLocale): what a free-roam instance's sign-in page is in and offers
   * next to English, since demo-gate denies GET /api/setup (QA TC-6790). Absent from a server before it. */
  locale: Locale.optional(),
  /** freeRoam only: where "Start free" goes (null: none set) */
  signupUrl: z.string().nullable().optional(),
  /** free-roam demo: its bar's suggestion chips, in the demo's language (DemoFile.freeRoam); absent elsewhere */
  freeRoam: z.object({ suggestions: z.array(DemoSuggestion) }).optional(),
  /** true while the demo file turns the snapshot builder on (DemoFile.builder); absent otherwise. demo-gate refuses an
   * instance that says it (demo-gate/src/pool.ts checkFenced) */
  builder: z.literal(true).optional(),
})
export type DemoInfo = z.infer<typeof DemoInfo>

export const DemoSwitchBody = z.object({ key: DemoPersonaKey }).strict()

// ---- the snapshot builder's routes (server/src/routes/demo-builder.ts): the owner only, and only while the demo file says
// `builder: true` (404 otherwise, like a route that is not there). What the public API cannot do: times in the past,
// who invited a person, connection rows with made-up secrets, the finished turns of a seeded chat ----
const BuilderAt = z.string().datetime()
export const DemoBuilderRoomTimesBody = z.object({
  roomId: Uuid7,
  times: z.array(z.object({ messageId: Uuid7, at: BuilderAt }).strict()).max(500),
  /** delete the room's "joined the team" lines (the seed's first sign-ins wrote them today) */
  dropJoinLines: z.boolean().optional(),
}).strict()
export const DemoBuilderWelcomeBody = z.object({ userId: UserId, inviterId: UserId }).strict()
export const DemoBuilderConnectionBody = z.object({
  service: DemoContentConnection.shape.service,
  /** a person's own (gmail, google-drive); none: the team's (higgsfield) */
  userId: UserId.optional(),
  account: DemoAccount,
}).strict()
export const DemoBuilderChatTurnsBody = z.object({
  chatId: Uuid7,
  /** oldest first: each a question of the chat's person and its finished answer */
  turns: z.array(z.object({ ask: z.string().min(1).max(4000), answer: z.string().min(1).max(20_000), at: BuilderAt }).strict()).min(1).max(20),
}).strict()
export const DemoBuilderChatTurns = z.object({ turns: z.array(z.object({ askId: Uuid7, answerId: Uuid7 })) })
export type DemoBuilderChatTurns = z.infer<typeof DemoBuilderChatTurns>
/** replies in a seeded chat's thread: when each was sent (the notices they made follow the thread's latest one) */
export const DemoBuilderThreadTimesBody = z.object({
  chatId: Uuid7,
  times: z.array(z.object({ replyId: Uuid7, at: BuilderAt }).strict()).min(1).max(50),
}).strict()
/** team files: when each one was last changed (its time on disk, and its place in Files › Recent), and the paths (a
 * file or a folder with all under it) whose seeded changes stay out of Files › Recent */
export const DemoBuilderFileTimesBody = z.object({
  times: z.array(z.object({ path: z.string().min(1).max(512), at: BuilderAt }).strict()).max(500),
  hideFromRecent: z.array(z.string().min(1).max(512)).max(50).default([]),
  /** a person's saved memories (Settings › Memory): when each was saved; `text` picks one, none: all of theirs */
  memories: z.array(z.object({ userId: UserId, text: z.string().min(1).max(2000).optional(), at: BuilderAt }).strict()).max(60).default([]),
}).strict()

const DEMO_BUILDER = {
  demoBuilderRoomTimes: endpoint({
    method: 'POST', path: '/api/demo/builder/room-times', auth: 'owner', owner: 'A', body: DemoBuilderRoomTimesBody, response: z.object({ updated: z.number().int(), dropped: z.number().int() }),
    summary: 'Demo snapshot builder only (a demo file with builder: true; 404 otherwise): when messages of a room were sent (its activity, the notices they made and its threads\' follows follow them), and drop its "joined the team" lines.',
  }),
  demoBuilderWelcome: endpoint({
    method: 'POST', path: '/api/demo/builder/welcome', auth: 'owner', owner: 'A', body: DemoBuilderWelcomeBody, response: z.object({ ok: z.literal(true) }),
    summary: 'Demo snapshot builder only: who invited a person, as their welcome card on Home says it.',
  }),
  demoBuilderConnection: endpoint({
    method: 'POST', path: '/api/demo/builder/connections', auth: 'owner', owner: 'A', status: 201, body: DemoBuilderConnectionBody, response: z.object({ id: z.string() }),
    summary: 'Demo snapshot builder only: a person\'s connected Gmail or Google Drive, or the team\'s Higgsfield, with a made-up secret (the demo\'s fakes answer it; no sign-in, nothing goes anywhere).',
  }),
  demoBuilderChatTurns: endpoint({
    method: 'POST', path: '/api/demo/builder/chat-turns', auth: 'owner', owner: 'A', body: DemoBuilderChatTurnsBody, response: DemoBuilderChatTurns,
    summary: 'Demo snapshot builder only: past questions and finished answers of a chat, as plain messages at the times given (no AI runs).',
  }),
  demoBuilderThreadTimes: endpoint({
    method: 'POST', path: '/api/demo/builder/thread-times', auth: 'owner', owner: 'A', body: DemoBuilderThreadTimesBody, response: z.object({ updated: z.number().int() }),
    summary: 'Demo snapshot builder only: when the replies in a seeded chat\'s thread were sent; the thread notices they made carry the latest time.',
  }),
  demoBuilderFileTimes: endpoint({
    method: 'POST', path: '/api/demo/builder/file-times', auth: 'owner', owner: 'A', body: DemoBuilderFileTimesBody, response: z.object({ updated: z.number().int(), hidden: z.number().int() }),
    summary: 'Demo snapshot builder only: when team files were last changed (on disk and in Files › Recent, oldest first; their folders follow the newest inside), which seeded changes stay out of Recent, and when people\'s memories were saved.',
  }),
} as const

export const DEMO = {
  demoInfo: endpoint({
    method: 'GET', path: '/api/demo', auth: 'public', owner: 'A', response: DemoInfo,
    summary: 'Demo mode only (MYCEL_DEMO on a development server; 404 otherwise): the fictional company, its demo people and which one the caller is; in a free-roam demo also the weighted tokens used, the demo limit and the sign-up address.',
  }),
  demoSwitch: endpoint({
    method: 'POST', path: '/api/demo/persona', auth: 'public', owner: 'A', body: DemoSwitchBody, response: z.object({ ok: z.literal(true) }),
    summary: 'Demo mode only: sign in as one of the demo people (the seeded account\'s password check, session and audit row of a sign-in, with the public demo password; never the owner); the previous session ends. A free-roam demo has one person, the only one this signs in.',
  }),
  ...DEMO_BUILDER,
} as const
