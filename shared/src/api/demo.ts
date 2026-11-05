// Demo mode (docs/DECISIONS.md "Demo company: a new hire at 트리나"): a development server started by `bun run demo:company`
// with MYCEL_DEMO=<demo file>. Only then do these endpoints exist (404 otherwise), and the server refuses to start with
// the flag in production, on the hosted service or in office mode (server/src/app-config.ts). The product itself has
// no "sign in as someone else" (docs/WORKPLAN.md A): switching to another demo person is a normal sign-in of that
// seeded account with the demo's public password, done by the server so the browser never holds the password.
import { z } from 'zod'
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
  personas: z.array(z.object({
    key: DemoPersonaKey,
    username: z.string().min(1).max(64),
    /** one line at the top of Home: "오늘 트리나 마케팅팀에 입사한 한지우예요" */
    intro: z.string().min(1).max(200),
    /** suggested first questions (a tap sends one) */
    questions: z.array(z.string().min(1).max(200)).max(6),
  }).strict()).min(1).max(3)
    .refine((ps) => new Set(ps.map((p) => p.key)).size === ps.length, 'each persona key once'),
}).strict()
export type DemoFile = z.infer<typeof DemoFile>

/**
 * The demo content's company.json (scripts/demo/company/README.md, read by scripts/demo/company/content.ts): a fictional
 * company the demo scripts seed and run. Only the scripts read it; the server reads the demo file made from it.
 */
export const DEMO_CONTENT_FORMAT = 1
const ContentName = z.string().min(1).max(80)
const ContentSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and "-"')
const ContentPath = z.string().min(1).max(512)
  .refine((p) => !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '.' || s === ''), 'a team path like shared/a.md')
const ContentAccess = z.enum(['none', 'read', 'write'])
const ContentRule = z.union([
  z.object({ group: ContentName, access: ContentAccess }).strict(),
  z.object({ user: Username, access: ContentAccess }).strict(),
  z.object({ everyone: z.literal(true), access: ContentAccess }).strict(),
])
export const DemoContentCompany = z.object({
  format: z.literal(DEMO_CONTENT_FORMAT),
  /** short name: the relay address (<id>.localhost) and the default data folder (~/.<id>demo) */
  id: ContentSlug,
  teamName: ContentName,
  /** the team's and the people's language (the app's screens; the content's own words are in it too) */
  locale: Locale,
  /** the team's owner: an account of its own, never a demo person; its password is random (<data>/owner-password) */
  owner: z.object({ username: Username, name: ContentName }).strict(),
  /** everyone else, all members: a demo may be open to the network with a public password, so nobody else is an owner
   * or an admin */
  people: z.array(z.object({
    username: Username,
    name: ContentName,
    /** the one group they are in, or null */
    group: ContentName.nullable(),
    /** who they are in the story ("CEO", "Marketing lead"), for people reading the file; shown nowhere */
    note: z.string().max(200).optional(),
  }).strict()).min(3).max(60),
  groups: z.array(z.object({ name: ContentName, description: z.string().max(200) }).strict()).max(20),
  /** folder rules beyond the group folders (each group gets groups/<name>/, written by its members) */
  rules: z.array(z.object({ path: ContentPath, rules: z.array(ContentRule).min(1).max(20), why: z.string().max(200).optional() }).strict()).max(60),
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
  memories: z.array(z.object({ username: Username, text: z.string().min(1).max(2000) }).strict()).max(20).default([]),
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
})
export type DemoInfo = z.infer<typeof DemoInfo>

export const DemoSwitchBody = z.object({ key: DemoPersonaKey }).strict()

export const DEMO = {
  demoInfo: endpoint({
    method: 'GET', path: '/api/demo', auth: 'public', owner: 'A', response: DemoInfo,
    summary: 'Demo mode only (MYCEL_DEMO on a development server; 404 otherwise): the fictional company, its demo people and which one the caller is.',
  }),
  demoSwitch: endpoint({
    method: 'POST', path: '/api/demo/persona', auth: 'public', owner: 'A', body: DemoSwitchBody, response: z.object({ ok: z.literal(true) }),
    summary: 'Demo mode only: sign in as one of the demo people (the seeded account\'s password check, session and audit row of a sign-in, with the public demo password; never the owner); the previous session ends.',
  }),
} as const
