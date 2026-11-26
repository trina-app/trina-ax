// Problem reports (docs/decisions/20261126-problem-reports.md). Owner: G (server/src/system/problem-reports.ts,
// registered by server/src/routes/problem-reports.ts). "문제 신고" in Settings › About and 👎 under an AI answer open the
// same sheet; this server keeps the report in an outbox and sends it, signed, to the hosting service
// (shared/src/cloud-protocol/problem-report.ts), which posts it into the operators' own room.
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { PROBLEM_REPORT_CLIENTS, PROBLEM_REPORT_OS, PROBLEM_REPORT_SCREENS, PROBLEM_REPORT_TEXT_MAX } from '../cloud-protocol/problem-report'
import { endpoint } from './endpoint'

export const PROBLEM_REPORT_SCREEN_KINDS = PROBLEM_REPORT_SCREENS
export const ProblemReportBody = z.strictObject({
  /** the person's words: 1-4000 characters, not only white space */
  text: z.string().max(PROBLEM_REPORT_TEXT_MAX * 2).refine((s) => s.trim().length > 0 && [...s.trim()].length <= PROBLEM_REPORT_TEXT_MAX, { message: 'required' }),
  /** the kind of screen the person was on (a fixed word, never an id) */
  screen: z.enum(PROBLEM_REPORT_SCREENS),
  client: z.strictObject({
    kind: z.enum(PROBLEM_REPORT_CLIENTS),
    version: z.string().max(40).nullable(),
    os: z.enum(PROBLEM_REPORT_OS),
  }),
  /** from 👎: the answer; withConversation = the tick "이 답변과 질문 함께 보내기" (only the person's own chat of one
   * person: 403 conversation_not_allowed otherwise) */
  answer: z.strictObject({ messageId: Uuid7, withConversation: z.boolean() }).optional(),
})
export type ProblemReportBody = z.infer<typeof ProblemReportBody>
export const ProblemReportAccepted = z.object({ id: Uuid7 })

export const PROBLEM_REPORTS = {
  sendProblemReport: endpoint({ method: 'POST', path: '/api/problem-reports', auth: 'user', owner: 'G', status: 202, body: ProblemReportBody, response: ProblemReportAccepted,
    summary: 'Send a problem report to the Trina AX team: kept in an outbox and sent in the background, signed with this server\'s relay team key. Only the words, versions, platform, screen kind and, from 👎, the turn id, failure code and tool ids; the question and answer only with withConversation. 404 while the feature or the team switch is off; 429 problem_reports_limit past 5 a person or 30 a team a day; a guest: 403.' }),
} as const
