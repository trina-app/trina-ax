// The AI scenario catalog's shape (tests/ai-scenarios/cases.yaml) and what one run of a case records.
import { z } from 'zod'

export const Context = z.enum(['personal', 'project', 'room-side', 'guest'])
/** the tool set of an install, as a local server can give it (README "Install types"):
 *  linux-devenv: Linux self-install with the dev environment (srt) on, the AI may run commands (box_shell);
 *  linux-nodevenv: the same server with the dev environment off;
 *  office-mac: Office Mac (docs/OFFICE.md): no dev environment, the Mac's own Claude sign-in. On a local server this is
 *  the same tool set as linux-nodevenv; they differ in guests' AI and team connections, which a local server lacks.
 *  managed: an install whose AI runs on team connections (hosting, Linux, Docker): the only kind where a guest can have
 *  AI. A local dev server runs on this machine's own sign-in, so these cases are blocked there. */
export const Install = z.enum(['linux-devenv', 'linux-nodevenv', 'office-mac', 'managed'])
/** what a good answer does: do the task / refuse it (permission, policy) / explain plainly that it cannot be done here
 * and offer what can / ask one needed question */
export const Outcome = z.enum(['do', 'refuse', 'explain', 'ask'])

/** automatic checks; `file` is a glob over the team paths created or changed during the case (or, with `path`, one
 * team path read as it is after the case) */
export const Check = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file_created'), file: z.string() }),
  z.object({ type: z.literal('no_file_created'), file: z.string().default('**') }),
  z.object({ type: z.literal('pdf_image_on_page'), file: z.string(), page: z.number().int().positive() }),
  z.object({ type: z.literal('pdf_pages'), file: z.string(), min: z.number().int().positive().optional(), max: z.number().int().positive().optional() }),
  /** the text of a page (or of every page) has `text`: page numbers, a watermark, an added line (pdftotext) */
  z.object({ type: z.literal('pdf_text'), file: z.string(), text: z.string(), page: z.number().int().positive().optional() }),
  /** page N is shown turned by `deg` (0 = upright): the page's own rotation, or a page laid out the other way round */
  z.object({ type: z.literal('pdf_upright'), file: z.string(), page: z.number().int().positive() }),
  z.object({ type: z.literal('xlsx'), file: z.string(), header: z.string().optional(), formula: z.boolean().optional(), chart: z.boolean().optional(), cell: z.object({ ref: z.string(), equals: z.union([z.string(), z.number()]) }).optional() }),
  // photos: every changed file that matches `file` is read; `count` of them at least; JPEG, no wider than `maxWidth`, with or without a GPS location
  z.object({ type: z.literal('image'), file: z.string(), count: z.number().int().positive().default(1), format: z.enum(['jpeg', 'png', 'webp']).optional(), maxWidth: z.number().int().positive().optional(), gps: z.enum(['kept', 'removed']).optional(), details: z.enum(['kept', 'removed']).optional() }),
  z.object({ type: z.literal('docx_contains'), file: z.string(), text: z.string() }),
  /** a Word file or deck holds a native chart with its data workbook (word|ppt/charts/chartN.xml and embeddings/*.xlsx), not only a picture */
  z.object({ type: z.literal('office_chart'), file: z.string() }),
  z.object({ type: z.literal('pptx_slides'), file: z.string(), min: z.number().int().positive() }),
  z.object({ type: z.literal('file_contains'), path: z.string(), text: z.string() }),
  z.object({ type: z.literal('file_not_contains'), path: z.string(), text: z.string() }),
  z.object({ type: z.literal('path_exists'), path: z.string() }),
  z.object({ type: z.literal('path_missing'), path: z.string() }),
  z.object({ type: z.literal('answer_matches'), pattern: z.string() }),
  z.object({ type: z.literal('answer_not_matches'), pattern: z.string() }),
  z.object({ type: z.literal('tool_used'), any: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('tool_not_used'), tools: z.array(z.string()).min(1) }),
  /** a working page: an artifact, or an .html file saved where `file` says (the file viewer runs it the same way, in the
   * sandbox frame: web FileBody.tsx); a project chat saves its work in the project folder (CHT-05.project) */
  z.object({ type: z.literal('page_made'), file: z.string().default('**/*.html') }),
  /** in each turn that used one of `tools`, the server showed a card (the person said yes to it): content or a change
   * that reaches people who could not see it never happens on the AI's word alone */
  z.object({ type: z.literal('card_or_not_used'), tools: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('room_message'), pattern: z.string() }),
  z.object({ type: z.literal('no_room_message'), pattern: z.string() }),
  /** added to every case by the runner: each turn ended and said something (a refusal check never passes on silence) */
  z.object({ type: z.literal('answered') }),
])
export type Check = z.infer<typeof Check>

export const Kind = z.enum(['happy', 'context', 'install', 'refuse', 'flow'])
export type Kind = z.infer<typeof Kind>
const Expect = z.object({
  outcome: Outcome,
  /** for the judge: what a good answer does, in one or two sentences */
  good: z.string(),
  checks: z.array(Check).default([]),
})
const CaseFields = {
  title: z.string(),
  /** feature ids of docs/features.ts this case covers (the first is its main feature) */
  features: z.array(z.string()).min(1),
  /** happy path / another place (context) / another install / a refusal / a cross-feature office flow */
  kind: Kind.default('happy'),
  lang: z.enum(['ko', 'en', 'ja']),
  context: Context,
  /** who asks (a fixture username) */
  as: z.string(),
  install: Install.default('office-mac'),
  prompt: z.string().min(1),
  /** said next in the same chat, after each answer */
  followUps: z.array(z.string()).default([]),
  /** what to say when the AI asks a question with free text (default: a plain go-ahead in the case's language) */
  reply: z.string().optional(),
  expect: Expect,
  /** the fix that is being built for this (PR or branch): a failure is expected on today's dev */
  fixInProgress: z.string().optional(),
  /** team paths this case may change: put back from the fixture after it */
  restores: z.array(z.string()).default([]),
  /** it may change who can open what (access, people, skill places, "Always allow"): it runs alone, after the others
   * (cases of the features in STATE_FEATURES do so anyway) */
  changesState: z.boolean().default(false),
  /** the asker's device time zone, sent with each turn as the web app does (IANA, e.g. Asia/Jakarta; QA TC-4549):
   * the AI gives its times in it. Without it the team's zone is sent (lib/run-case.ts). */
  timeZone: z.string().optional(),
  /** in the first, representative pass (`run --first-pass`) */
  pass1: z.boolean().default(false),
  /** why this case exists (the incident, the decision) */
  why: z.string().optional(),
}
export const Case = z.object({ id: z.string().regex(/^[A-Z]+-\d{2,3}(\.[a-z0-9-]+)?$/), ...CaseFields })
export type Case = z.infer<typeof Case>
/** the same request in another place, install or by another person: a case of its own, `<id>.<key>`; fields given
 * here replace the base case's (kind defaults to refuse for a refusal, install when the install differs, else context) */
export const Variant = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  // without the base fields' defaults: a field the variant leaves out comes from the base case, not from the default
  ...Object.fromEntries(Object.entries(CaseFields).map(([k, v]) => [k, (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : (v as z.ZodType)).optional()])) as { [K in keyof typeof CaseFields]: z.ZodOptional<z.ZodType<z.output<(typeof CaseFields)[K]>>> },
}).strict()
// strict: a field this runner does not know (a newer cases.yaml read by an older runner) stops the run instead of being
// dropped. TC-4549: an older runner dropped `timeZone`, ran the Jakarta cases with no zone and reported Seoul times.
export const CaseInput = z.object({ id: z.string().regex(/^[A-Z]+-\d{2,3}$/), ...CaseFields, variants: z.array(Variant).default([]) }).strict()
export const Catalog = z.object({ version: z.number().int().positive(), cases: z.array(CaseInput) })

export interface ToolCall { name: string; input: unknown; ok: boolean; result?: string }
export interface CardSeen {
  kind: string
  origin: 'server' | 'ai' | 'n/a'
  question: string
  answer: string | null
  /** the choices the card offered (labels), and whether one of them was "always allow" for this kind of action */
  options?: string[]
  hasAlways?: boolean
}
export interface TurnRecord {
  prompt: string
  /** when the message was sent (ISO): the AI's "now" for this turn; missing in results from before 2026-11-18 */
  sentAt?: string
  status: string
  error: string | null
  answer: string
  tools: ToolCall[]
  cards: CardSeen[]
  saved: string[]
  ms: number
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; apiCalls: number }
  model: string | null
}
export interface CheckResult { check: Check; ok: boolean; detail: string }
export interface CaseResult {
  id: string
  runId: string
  commit: string
  startedAt: string
  chatId: string | null
  /** the chat is shared with other people (a team project's members): what the server says, not what the case meant */
  chatShared?: boolean
  turns: TurnRecord[]
  /** team paths created or changed during the case */
  changed: string[]
  checks: CheckResult[]
  /** words a non-developer should never read, found in the answers */
  jargon: string[]
  error: string | null
  /** who-can-open-what that changed during the case (lib/state-guard.ts), put back after it; `driftLeft`: what could
   * not be put back */
  drift?: string[]
  driftLeft?: string[]
  judge?: Verdict
}
export const Verdict = z.object({
  pass: z.boolean(),
  did_task: z.enum(['yes', 'partly', 'no', 'n/a']),
  refusal: z.enum(['none', 'correct', 'wrong', 'missing']),
  jargon: z.boolean(),
  false_claim: z.boolean(),
  unneeded_question: z.boolean(),
  tone_ok: z.boolean(),
  root_cause: z.enum(['none', 'missing tool', 'prompt over-refusal', 'permission bug', 'jargon', 'wrong claim', 'tool failure', 'wrong result', 'other']),
  why: z.string(),
})
export type Verdict = z.infer<typeof Verdict>
