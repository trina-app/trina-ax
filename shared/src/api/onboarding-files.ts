// 팀 파일 in the welcome steps (docs/DECISIONS.md "W6 — Onboarding v6: 팀 파일 recommendations"): the owner picks a
// folder, the page lists its documents without reading them (web/src/lib/teamFiles.ts), the AI picks from the names,
// paths inside the folder, types, sizes and dates only, the person confirms one checked list, and only then do the
// files go up, as a folder upload run of the file screen tagged with the step. Route module:
// server/src/routes/onboarding-files.ts. No file content ever reaches these endpoints.
import { z } from 'zod'
import { RelPath } from './common'
import { endpoint } from './endpoint'

/** The words a pick carries (the list shows them in the team's language): 양식 · 회사 소개 · 보고서 · 회의록 · 브랜드 자료 ·
 * 규정·정책 · 교육 자료 · 제안서. */
export const TEAM_FILE_REASONS = ['form', 'intro', 'report', 'minutes', 'brand', 'policy', 'training', 'proposal'] as const
export const TeamFileReason = z.enum(TEAM_FILE_REASONS)
export type TeamFileReason = z.infer<typeof TeamFileReason>

/** The step's limits (FLOW v6 §3.2). The walk and the cut are the page's; the server checks what reaches it. */
export const TEAM_FILES_LIMITS = {
  /** the walk stops at this many documents (the types considered) … */
  walkDocs: 5000,
  /** … or at this many entries walked (a home folder, Downloads) … */
  walkFiles: 50_000,
  /** … or this many folders down from the picked one … */
  depth: 6,
  /** … or after this long */
  walkMs: 15_000,
  /** a bigger file is not offered here (the file screen takes it): the step seeds working documents */
  fileBytes: 50 * 1024 * 1024,
  /** at most this many entries go to the AI */
  toAi: 500,
  /** the AI's top picks come ticked, at most this many */
  prechecked: 20,
  /** at most this many ticked files per upload */
  perUpload: 100,
  /** the page waits this long for the AI, and the server stops the turn then */
  rankMs: 30_000,
  /** a name and a path as they go to the AI, at most */
  nameChars: 200,
  pathChars: 400,
} as const

/** One file as the AI sees it: never its content. `id` is the page's key for it (short, opaque); `path` is the folder
 * inside the picked one ("영업/양식", "" at the top), `type` the extension, `modified` the file's date (YYYY-MM-DD). */
export const RankFileEntry = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/),
  name: z.string().min(1).max(TEAM_FILES_LIMITS.nameChars),
  path: z.string().max(TEAM_FILES_LIMITS.pathChars),
  type: z.string().max(16),
  size: z.number().int().nonnegative(),
  modified: z.string().max(40),
}).strict()
export type RankFileEntry = z.infer<typeof RankFileEntry>

export const RankTeamFiles = z.object({ entries: z.array(RankFileEntry).min(1).max(TEAM_FILES_LIMITS.toAi) }).strict()
export type RankTeamFiles = z.infer<typeof RankTeamFiles>

/** `ai`: done (the picks, best first; may be empty) · none (no AI answers the caller, or their budget is used up) ·
 * failed (the turn could not start, or its answer did not read) · timeout (no answer within rankMs; the turn was
 * stopped). Only `done` carries picks. */
export const RankedTeamFiles = z.object({
  ai: z.enum(['done', 'none', 'failed', 'timeout']),
  picks: z.array(z.object({ id: z.string(), reason: TeamFileReason })).max(TEAM_FILES_LIMITS.toAi),
})
export type RankedTeamFiles = z.infer<typeof RankedTeamFiles>

/** A file of the step's upload run landed (`path`: where it is now, in the team folder). */
export const TeamFilesLanded = z.object({ path: RelPath }).strict()
export type TeamFilesLanded = z.infer<typeof TeamFilesLanded>
/** `recorded`: 팀 파일 was recorded done now (false: done before, no welcome row, or not a team file the caller can
 * read). */
export const TeamFilesLandedResult = z.object({ recorded: z.boolean() })
export type TeamFilesLandedResult = z.infer<typeof TeamFilesLandedResult>

export const ONBOARDING_FILES = {
  rankTeamFiles: endpoint({ method: 'POST', path: '/api/onboarding/files/rank', auth: 'admin', owner: 'B', body: RankTeamFiles, response: RankedTeamFiles,
    summary: 'The AI\'s picks among files of a folder the caller picked (owners and admins): names, paths inside the folder, types, sizes and dates only, never content. A turn of the caller with no tool at all; answers within 30 s (timeout otherwise), its chat deleted after.' }),
  teamFilesLanded: endpoint({ method: 'POST', path: '/api/onboarding/files/landed', auth: 'admin', owner: 'B', body: TeamFilesLanded, response: TeamFilesLandedResult,
    summary: 'A file of the welcome step\'s upload run landed (owners and admins): records the team files step done in the welcome steps, once, when the file is in a group folder the caller can read.' }),
} as const
