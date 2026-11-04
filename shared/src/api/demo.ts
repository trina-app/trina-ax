// Demo mode (docs/DECISIONS.md "Demo company: a new hire at 트리나"): a development server started by `bun run demo:trina`
// with MYCEL_DEMO=<demo file>. Only then do these endpoints exist (404 otherwise), and the server refuses to start with
// the flag in production, on the hosted service or in office mode (server/src/app-config.ts). The product itself has
// no "sign in as someone else" (docs/WORKPLAN.md A): switching to another demo person is a normal sign-in of that
// seeded account with the demo's public password, done by the server so the browser never holds the password.
import { z } from 'zod'
import { endpoint } from './endpoint'

/** The three people a viewer can be. Their labels are app strings (web i18n `demo.persona.*`). */
export const DemoPersonaKey = z.enum(['newHire', 'lead', 'ceo'])
export type DemoPersonaKey = z.infer<typeof DemoPersonaKey>

/** The demo file (MYCEL_DEMO). Written by scripts/demo/trina/start.ts from the seeded company; its texts are the
 * scenario's data in the company's own language, like the sample files. */
export const DemoFile = z.object({
  company: z.string().min(1).max(80),
  /** the seeded accounts' public demo password (scripts/demo/seed.ts DEMO_PASSWORD) */
  password: z.string().min(8).max(200),
  /** the question to ask as each person ("같은 질문, 사람마다 다른 답") */
  sameQuestion: z.string().min(1).max(200).optional(),
  personas: z.array(z.object({
    key: DemoPersonaKey,
    username: z.string().min(1).max(64),
    /** one line at the top of Home: "오늘 트리나 마케팅팀에 입사한 한지우예요" */
    intro: z.string().min(1).max(200),
    /** suggested first questions (a tap sends one) */
    questions: z.array(z.string().min(1).max(200)).max(4),
  }).strict()).min(1).max(3)
    .refine((ps) => new Set(ps.map((p) => p.key)).size === ps.length, 'each persona key once'),
}).strict()
export type DemoFile = z.infer<typeof DemoFile>

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
    summary: 'Demo mode only: sign in as one of the demo people (a normal sign-in of that seeded account with the public demo password, rate-limited and audited like any sign-in); the previous session ends.',
  }),
} as const
