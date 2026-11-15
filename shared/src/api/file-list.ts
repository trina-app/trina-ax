// The file list (docs/DECISIONS.md "File list"; server/src/file-list/): every night the team's AI reads new and
// changed team files and the server keeps one English line per file, saying what it really is. The AI's file tools
// show the lines, for the person asking, as a `_FILES.md` in each access folder (not a file on disk). It is always on
// (docs/DECISIONS.md "File list: always on"); admins see a short status and start a run now (Admin › Team settings). Owner: C (server/src/routes/file-list.ts).
import { z } from 'zod'
import { endpoint } from './endpoint'
import { IsoTime } from './common'

/** The name of every list. The AI's tools show it in a folder; nothing of that name is written to disk. */
export const FILE_LIST_NAME = '_FILES.md'
/** Whether a file name is the list's, the way the server compares names for clashes (NFKC, any letter case). */
export const isFileListName = (name: string): boolean => name.normalize('NFKC').toLowerCase().normalize('NFKC') === '_files.md'

/** Why no run can start now:
 * - forced_off: the server's host turned it off (server.json)
 * - no_ai: no AI the team can use for it: no team AI account (Admin › AI accounts; a person's own account is never
 *   used), or no engine on the server
 * - no_cheap_model: the team's AI has no small model to read with (a gateway without a haiku model, a Codex catalog
 *   without a mini or nano model), so nothing is read rather than spend a big model's limit
 * - limited: the AI's usage or rate limit, or the team's block budget, stopped the last run; it goes on at the next
 * - failed: the last run did not finish (the AI gave no answer or could not be used); the next run tries again */
export const FileListProblem = z.enum(['forced_off', 'no_ai', 'no_cheap_model', 'limited', 'failed'])
export type FileListProblem = z.infer<typeof FileListProblem>

/** Why the last run ended: done (nothing left), window (the night's window ended), limit (usage or rate limit), off
 * (a run of an older build that was switched off, or the host turned it off meanwhile), stopped (the server stopped), failed (the AI could not be used) */
export const FileListStop = z.enum(['done', 'window', 'limit', 'off', 'stopped', 'failed'])
export type FileListStop = z.infer<typeof FileListStop>

export const FileListRun = z.object({
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
  /** nightly: the night's run; now: an admin's Run now */
  trigger: z.enum(['nightly', 'now']),
  /** files the AI read in this run */
  read: z.number().int().nonnegative(),
  stoppedBy: FileListStop.nullable(),
})
export type FileListRun = z.infer<typeof FileListRun>

/** Whose AI sign-in the runs use (Admin › Team settings › File list): every night's run spends a little of its limit.
 * - team: a team AI account (Admin › AI accounts), its name and who signed it in (with a shared subscription usually
 *   an admin's own Claude account)
 * - server: the AI's sign-in on the server's own computer (a development or office server) */
export const FileListSignIn = z.object({
  engine: z.enum(['claude-code', 'codex']),
  /** the model the reader asks for (Claude Code's "haiku", or a Codex model), when known */
  model: z.string().nullable(),
  kind: z.enum(['team', 'server']),
  /** the AI account's name in Admin › AI accounts */
  label: z.string().nullable(),
  /** the person who signed it in, when known */
  by: z.string().nullable(),
})
export type FileListSignIn = z.infer<typeof FileListSignIn>

/** Admin › Team settings › File list. Counts and times only: never a path (personal folders are counted too). */
export const FileListStatus = z.object({
  /** it runs: always, unless the host turned it off in server.json (the team has no switch since "File list: always
   * on"; kept for older clients, it is the opposite of forcedOff) */
  enabled: z.boolean(),
  /** the host turned it off in server.json: the switch cannot turn it on */
  forcedOff: z.boolean(),
  /** a run is going now */
  running: z.boolean(),
  /** files with a line in a list */
  listed: z.number().int().nonnegative(),
  /** files found and not read yet (a first run on a big team goes on night after night) */
  waiting: z.number().int().nonnegative(),
  lastRun: FileListRun.nullable(),
  /** when the next nightly run may start (team time zone), null while off */
  nextRunAt: IsoTime.nullable(),
  problem: FileListProblem.nullable(),
  /** whose AI sign-in the next run would use; null when none can be used (see problem) */
  signIn: FileListSignIn.nullable(),
})
export type FileListStatus = z.infer<typeof FileListStatus>

export const FILE_LIST = {
  fileListStatus: endpoint({ method: 'GET', path: '/api/admin/file-list', auth: 'admin', owner: 'C', response: FileListStatus, summary: 'The file list: files listed and waiting, the last and next run, why it cannot run, and whose AI sign-in the runs use.' }),
  runFileList: endpoint({ method: 'POST', path: '/api/admin/file-list/run', auth: 'admin', owner: 'C', status: 202, response: FileListStatus, summary: 'Start a file list run now, in the background (new and changed files only, within the per-run cap); audited.' }),
} as const
