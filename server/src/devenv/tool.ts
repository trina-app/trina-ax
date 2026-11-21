// The box_shell tool of the dev environment (docs/DECISIONS.md "Dev environment on srt, behind a flag" and "Dev
// environment: box runner removed, srt only"). The name stays box_shell: steps and transcripts name it. Offered to a
// turn when the team's dev environment is in force and the person is in scope (setting.ts mayUseDevEnv); checked again
// on every call. The engine keeps its lockdown (no Bash, --restricted): the command goes engine -> our MCP tool ->
// server -> srt on the team server (srt/runner.ts). The AI engine and the model token never enter the run.
//
// Per call in a project chat: the command runs inside a change window (track.ts: who changed what, versions, conflict
// copies), and the audit line is written (dev_env.command). On the first call of a turn the AI also gets what other
// people changed in the project folder since this person's last command, and the other people's jobs and dev servers
// there. Before a command that would use a person's credentials (git push, npm publish, ssh ...) the PERSON confirms on
// a server card that names those changes (hole 2): a run holds no credentials today, so such a command fails anyway;
// the gate is where a per-command credential helper plugs in.
//
// Before each command the rule of the AI's writes applies (assertStorageRoomForAI). A long command runs as a job: it
// has an exit status and a log, the person gets a notice when it ends, and each later call gives the AI the results it
// did not get yet. The AI does not go on by itself when a job ends.
import { updateWaitingFor } from '../system/update-wait'
import { z } from 'zod'
import type { AppContext } from '../context'
import type { McpContent } from '../turns'
import { audit } from '../admin/audit'
import { ToolError } from '../policy/errors'
import { authorize } from '../policy/authorize'
import { assertStorageRoomForAI } from '../system/storage'
import { newJobName, pendingShared, pollSrt, runResultsForAI } from './jobs'
import { mayUseDevEnv, teamSetting, type ProjectRef } from './setting'
import { networkNow, noteSharedReads, othersInProject, personNetNow, reachSupported, reachTargets, runCommand, runNameInUse, sharedLockedTops, sharedLogKey, sharedVisible, spaceOf, startServer, submitJob, teamHosts, type SharedRun, type Space } from './srt/runner'
import { grantUserSite, siteAllowed } from './sites'
import { DEV_ENV_MAX_USER_SITES, siteFromInput, userSiteProblem } from '@mycel/shared'
import { FILE_VIEW_PATH } from '@mycel/shared/api'
import path from 'node:path'
import { changesByOthers, markSeen, withChangeWindow, type ForeignChange } from './track'
import type { Change } from './snapshot'
import type { Step } from '@mycel/shared/api'
import type { RunExit } from './srt/types'
import { BOX_NODE_LIB_NAMES, BOX_PYTHON_LIBS, type DevPlatform } from './srt/config'
import { placeInLine, projectBusy, waitProjectFree, previewPortProblem, previewSupported, runPlatform, runProblem, startWaiting } from './srt/runner'
import { previewBase } from './preview'
import { addTicket, armTicket, commandWaitFor, FULL_MESSAGE, releaseCommand, waitTicket } from './srt/queue'
import { newId } from '../db'
import { inOthersSkills } from '../skills/script-copies'
import { hideProxyLogin } from './srt/proxy-login'
import { auditBulk, BULK_FILES, bulkFolders, mb, moveToScratch, newBulkState, overBulk, type BulkAsk, type BulkState } from './bulk'

export const BOX_SHELL_TOOL = 'box_shell'

const OUT_SHOWN = 32 << 10

export const BoxShellInput = z.object({
  command: z.string().min(1).max(64 * 1024).describe('the shell command (bash -lc), for example "npm install" or "git status"'),
  cwd: z.string().max(1024).optional().describe('folder relative to the project folder (default: the project folder)'),
  timeout_sec: z.number().int().min(1).max(1800).optional().describe('time limit in seconds (default 120, at most 1800)'),
  background: z.boolean().optional().describe('start a long-running process (a dev server, a watcher) and return at once; its output goes to the log <log_name>.log (the tool text says where)'),
  job: z.boolean().optional().describe('run a long command (a render, a large build) in the background as a job: it returns at once, it has an exit status and a log, and the person gets a notice when it ends'),
  log_name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional().describe('name of the log file for a background command or a job'),
  port: z.number().int().min(1).max(65535).optional().describe('with background=true: the port the dev server listens on (for example 3000 or 5173); the person gets a Preview button for it'),
  request_sites: z.array(z.string().min(1).max(300)).max(5).optional().describe('host names this command needs that are not allowed yet (for example ["api.example.com"]): the person is asked to allow each one before the command runs. Use it only after a command failed because a site was blocked'),
})
export type BoxShellInput = z.infer<typeof BoxShellInput>

/** How the AI starts and tests a dev server (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md). macOS (a Mac
 * team server): one localhost for the whole Mac; a run listens only on its own port, $PORT, and a later command of the
 * same chat reaches the ports of the chat's own running jobs and dev servers, nothing else (srt-mac.mjs); the Preview
 * button is Linux only. Linux: each run has its own localhost; with preview the person opens it from the step, and with
 * the sandbox helper a later command reaches it at the port the AI named (mycel-sandbox port-bridge). */
const MAC_DEV_SERVER_TEXT = 'For a dev server use background=true and make it listen on port $PORT (each command has its own; no other localhost port can listen), for example: npm run dev -- --port $PORT (Next.js reads PORT itself). The answer names that port: later box_shell commands in this chat reach the dev server at localhost:<that port> (for example curl -s localhost:<port>), and no other localhost port. There is no preview link yet. '
const reachText = 'Later box_shell commands in this chat reach it at localhost:<port> (for example curl -s localhost:3000), as long as it runs; no other localhost port of the server. '
const devServerText = (preview: boolean, reach: boolean = reachSupported()) => runPlatform() === 'darwin' ? MAC_DEV_SERVER_TEXT : preview
  ? 'For a dev server use background=true and set port to the port it listens on: the person gets a Preview button on this step and opens the app in their browser. Do not open the app yourself. '
    + (reach ? reachText : 'A later command cannot reach the dev server: to test it yourself, start a second copy, call it and stop it in one command, for example: npm run dev -- --port 3001 & sleep 5; curl -s localhost:3001; kill %1. ')
  : reach ? 'For a dev server use background=true and set port to the port it listens on. There is no preview link on this server. ' + reachText
  : 'For a dev server use background=true. There is no preview link on this server, and a later command cannot reach the dev server: to test it, start it, call it and stop it in one command, for example: npm run dev & sleep 5; curl -s localhost:3000; kill %1. '

/** What a command has without installing (docs/decisions/20261121-box-python-libs.md), in one line: Linux has the
 * Python libraries of the list (apt and the python-pptx venv); a Mac team server has Trina's bare Python 3 so far. */
export const boxLibsText = (platform: DevPlatform = runPlatform()) => (platform === 'darwin'
  ? `Already installed: node with ${BOX_NODE_LIB_NAMES.join(' and ')} (require them); python3 has no extra libraries yet. `
  : `Already installed: python3 with ${BOX_PYTHON_LIBS.join(', ')}; node with ${BOX_NODE_LIB_NAMES.join(' and ')} (require them). `)
  + 'For anything else use the folder: npm install, or a venv (python3 -m venv .venv && .venv/bin/pip install <package>); a plain pip install has nowhere to write. '
/** The tool text (docs/research/srt-dev-env.md section 7). The dev environment is not locked to a project: the command
 * gets the folder access of the person of this chat. */
export const srtShellDescription = (preview: boolean) => 'Run a shell command in the dev environment (bash, git, node, npm, python3, pip, ffmpeg, chromium) on the team server. '
  + boxLibsText()
  + 'The command can read the team folders that the person of this chat may open; other folders are not there. '
  + 'It can write only the folder it starts in and the person\'s own folder users/<id>: every other team folder is read-only in a command, also where the person may write. To put a file in another team folder, use copy_files (for a file in $TRINA_WORK its path is chat:work/<path>). '
  + 'A folder in users/<id> that the person shares with other people is read-only in a command too: write the file somewhere else, then move it in with move_files, which asks the person first. '
  + 'Team folders are under $TRINA_TEAM, with the same paths as in the file tools. '
  + 'In a project chat the command starts in the project folder, and changes there are shared with the team and recorded with your name. '
  + 'It also has this chat\'s own work folder $TRINA_WORK, which only this chat uses and which is not a team folder (chat:work/ in the file tools). '
  + PROJECT_SCRATCH_TEXT
  + 'In a chat with no project it starts in the chat\'s own work folder ($TRINA_WORK), which only this chat uses: in the file tools it is chat:work/ (chat:work/out/frame.png is $TRINA_WORK/out/frame.png in a command). Bring a team file or folder in with copy_files (to_folder "chat:work/in/"); open a picture, a video, a PDF or any file made there with read (chat:work/out/frame.png, or the absolute path a command prints) to see it yourself; list, glob and grep take chat:work/ too; hand a finished file over with copy_files (paths ["chat:work/out/promo.mp4"], to_folder a team folder, the person\'s own folder users/<id>/ by default), then link it. write and edit do not change the work folder: make a text file there with a command (cat > report.txt <<\'EOF\' … EOF). Do not start a dev server to show a finished file: Preview is for a web app. '
  + 'node_modules, .venv and build output are in that folder and use team disk. '
  + 'The network reaches only allowed sites (npm, PyPI, GitHub, the team\'s sites and the sites this person allowed), or nothing (the team setting No network). '
  + 'A blocked site answers HTTP 403 (curl: "CONNECT tunnel failed, response 403"). If the command needs that site, call box_shell again with the same command and request_sites set to its host name: the person is asked to allow it, and the command runs when they do. Never ask for an IP address, localhost or the team server; those stay blocked. '
  + 'There are NO credentials: git push, npm publish and other commands that need a login do not work; tell the person to do them on their own computer. '
  + 'You cannot change .git/config or .git/hooks, and git runs no repository hooks here. For chromium use --headless --no-sandbox --disable-dev-shm-usage. '
  + devServerText(preview)
  + 'For a long command (a render, a large build) use job=true: the call returns at once; if other jobs of the team run, it waits in a queue. '
  + 'Read its log with tail -n 20 $TRINA_LOGS/<log_name>.log and do not wait for it in a loop. When a job ends the person gets a notice, and your next box_shell call in this chat gives you its exit code and the end of its log. '
  + '/tmp and $TMPDIR can be the command\'s own and gone when it ends, and read cannot open them: make a result in $TRINA_WORK. '
  + 'One command at a time per folder; default time limit 120 s; a long stdout or stderr comes back as its first and its last 16 KiB (the middle is left out, and the result says so): to search all of a long output, send it to a file (cmd > $TRINA_LOGS/out.log 2>&1) and grep or tail that. '
  + 'When the dev environment of the team is full, a command waits for a free slot (at most 5 minutes) and then runs; the person sees its place in line.'
/** The tool text in a shared chat (docs/decisions/20261118-devenv-shared-chats.md): everyone in the chat sees the
 * command and its output, so it sees only what all of them may open; no login. Jobs and dev servers too, with the same
 * folders (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md). */
export const sharedShellDescription = (project: boolean) => 'Run a shell command in the dev environment (bash, git, node, npm, python3, pip, ffmpeg, chromium) on the team server. '
  + boxLibsText()
  + 'This is a shared chat: everyone in it sees the command and its output, so the command sees only the team folders that EVERYONE in this chat may open. No personal folder (users/...) is there, not even the person\'s own, and no other chat\'s files. '
  + (project
    ? 'It starts in the project folder and sees only the parts of it that everyone here may open (a folder some of them cannot open is not there); it can write only in the project folder, where the person may write, and in this chat\'s own work folder $TRINA_WORK (chat:work/ in the file tools; not a team folder, and everyone in this chat sees what is there). Changes in the project folder are shared with the team and recorded with your name. To use a file from somewhere else, the person must copy it into the project folder first. '
      + PROJECT_SCRATCH_TEXT
    : 'It starts in the chat\'s own work folder ($TRINA_WORK), which it can write: in the file tools it is chat:work/ (chat:work/out/frame.png is $TRINA_WORK/out/frame.png in a command). A file from a place not everyone here may open (the person\'s own folder) comes in only with copy_files (to_folder "chat:work/in/"; a whole folder too, an HTML file with its images folder): the person is asked first. Open a picture, a video, a PDF or any file made there with read (chat:work/out/frame.png) to see it yourself; list, glob and grep take chat:work/ too; hand a finished file over with copy_files to "chat:files/": it is attached to your answer for everyone here. write and edit do not change the work folder: make a text file there with a command (cat > report.txt <<\'EOF\' … EOF), then copy_files it to "chat:files/"; never save it in someone\'s own folder first. It can read the team folders that everyone in this chat may open, under $TRINA_TEAM with the same paths as in the file tools, and write none of them. Do not start a dev server to show a finished file: Preview is for a web app. ')
  + 'The network reaches only allowed sites (npm, PyPI, GitHub, the team\'s sites and the sites this person allowed), or nothing (the team setting No network). '
  + 'A blocked site answers HTTP 403 (curl: "CONNECT tunnel failed, response 403"). If the command needs that site, call box_shell again with the same command and request_sites set to its host name: the person is asked to allow it, and the command runs when they do. Never ask for an IP address, localhost or the team server; those stay blocked. '
  + 'There are NO credentials, and commands that need a login (git push, npm publish, ssh ...) are refused here: tell the person to do them on their own computer. '
  + 'Jobs and dev servers run here too, with the same folders: everyone in this chat sees their results, and they stop when the people of this chat or what they may open change. '
  + 'You cannot change .git/config or .git/hooks, and git runs no repository hooks here. For chromium use --headless --no-sandbox --disable-dev-shm-usage. '
  + devServerText(previewReady())
  + 'For a long command (a render, a large build) use job=true: the call returns at once; if other jobs of the team run, it waits in a queue. '
  + 'Read its log with tail -n 20 $TRINA_LOGS/<log_name>.log and do not wait for it in a loop. When a job ends, the next box_shell call in this chat gives you its exit code and the end of its log. '
  + '/tmp and $TMPDIR can be the command\'s own and gone when it ends, and read cannot open them: make a result in $TRINA_WORK. '
  + 'One command at a time per folder; default time limit 120 s; a long stdout or stderr comes back as its first and its last 16 KiB (the middle is left out, and the result says so): to search all of a long output, send it to a file (cmd > $TRINA_LOGS/out.log 2>&1) and grep or tail that. '
  + 'When the dev environment of the team is full, a command waits for a free slot (at most 5 minutes) and then runs; the person sees its place in line.'

/** Where a project chat's scratch goes (docs/decisions/20261121-ai-scratch-files.md): a project chat's commands have
 * $TRINA_WORK next to the project folder; only finished files go into the team's folder. */
export const PROJECT_SCRATCH_TEXT = 'Put downloads, git clones, tools and their installs (a venv, node_modules), previews and every other scratch file in $TRINA_WORK, and run downloaded code from there. '
  + 'Put only the finished files the person asked for (the deck, the PDF) in the project folder, for example cp $TRINA_WORK/out/deck.pptx ./; never a downloaded repository or tool, and nothing into the team\'s skills or another team folder, unless the person asks for exactly that. Say where third-party code came from and its licence. '
  + 'A download or clone as a job (job=true) goes in $TRINA_WORK too: cd $TRINA_WORK first. When one answer adds many new files to the project folder, the person is asked whether to keep them there or move them to $TRINA_WORK. '

/** this server shows previews: a preview origin is set and the runner can forward a port (systemd scopes) */
export const previewReady = () => !!previewBase() && previewSupported()

/** commands that would use a person's login (hole 2: the person confirms after seeing who changed what) */
export const CREDENTIAL_COMMAND = /(^|[\s;&|(])(git\s+(push|fetch|pull|clone|submodule|ls-remote)|npm\s+(publish|login|adduser|token)|yarn\s+(publish|npm\s+publish)|pnpm\s+publish|gh\s|ssh\s|scp\s|rsync\s.*:|docker\s+(login|push)|twine\s+upload|cargo\s+publish|aws\s|gcloud\s|az\s)/
export const usesCredentials = (cmd: string) => CREDENTIAL_COMMAND.test(cmd)

/** a cwd inside the project folder (no "..", no absolute path) */
export function boxCwd(cwd: string | undefined): string | null {
  const c = (cwd ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')
  if (c === '' || c === '.') return ''
  if (c.startsWith('/') || c.split('/').some((s) => s === '..' || s === '')) return null
  return c
}

/** a team file's link in the app (chat/prompt.ts SOURCE_LINK_RULE's form): the AI links what a command made, and the API
 * engine's link guard (engine/api-links.ts) lets a link through only when a tool result holds it */
const fileLink = (p: string) => `[${p.split('/').pop()}](${FILE_VIEW_PATH}?path=${encodeURIComponent(p)})`

/** `links`: a link for each new or changed file, or only for those this predicate takes (the ones the person can open) */
export function changeLines(changes: Change[], max = 30, links: boolean | ((rel: string) => boolean) = false): string {
  const verb = { create: 'created', update: 'changed', delete: 'deleted' } as const
  const linked = (c: Change) => c.action !== 'delete' && (typeof links === 'function' ? links(c.path) : links)
  const lines = changes.slice(0, max).map((c) => `  ${verb[c.action]} ${c.path}${linked(c) ? ` (link: ${fileLink(c.path)})` : ''}`)
  if (changes.length > max) lines.push(`  ... and ${changes.length - max} more`)
  return lines.join('\n')
}

export function foreignLines(f: { items: ForeignChange[]; total: number }): string {
  const lines = f.items.map((c) => `  ${c.by.name}${c.background ? ' (a background process)' : ''}: ${c.action} ${c.path} (${c.at})`)
  if (f.total > f.items.length) lines.push(`  ... and ${f.total - f.items.length} more`)
  return lines.join('\n')
}

/** what the AI gets of a stdout or stderr: its first and last half of OUT_SHOWN, never only the start (limits audit 1 #21:
 * the error at the end of a long build was lost). The runner already cut a long output this way with its own line
 * (srt/runner.ts readEnds, the same size): that one is kept, never cut again. Cuts go to a line break when one is near,
 * so a value on one line is never split (the redaction after this matches whole values). */
export const clip = (s: string) => {
  if (s.length <= OUT_SHOWN || RUNNER_CUT.test(s) && s.length <= OUT_SHOWN + 200) return s
  let head = s.slice(0, OUT_SHOWN / 2), tail = s.slice(-OUT_SHOWN / 2)
  const nl = head.lastIndexOf('\n')
  if (nl >= 0 && head.length - nl <= 4096) head = head.slice(0, nl + 1)
  const tn = tail.indexOf('\n')
  if (tn >= 0 && tn < 4096) tail = tail.slice(tn + 1)
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1)
  return `${head}\n… (${s.length - head.length - tail.length} characters in the middle left out; the end follows) …\n${tail}`
}
const RUNNER_CUT = /\n… \(about \d+ bytes in the middle of this output were left out; the end follows\) …\n/

export interface BoxShellHost {
  ctx: AppContext
  /** the project of the chat; null: a chat with no project */
  project: (ProjectRef & { name: string }) | null
  userId: string
  turnId: string
  /** the chat of the turn: the link in a job's notice */
  chatId?: string
  /** the waiting state of this call's command or job on its step (Step.devEnvRun) */
  queueStep?(run: NonNullable<Step['devEnvRun']>): void
  signal: AbortSignal
  /** a server card the person answers (chat/tools.ts turnPerson): the value of the chosen option, or null */
  confirm(question: string, options: { label: string; value: string }[], details: string[]): Promise<string | null>
  /** the site card (dev_env_site): may the AI reach this host? null: no answer (a scheduled run, timeout, turn ended) */
  askSite?(host: string, command: string): Promise<'once' | 'always' | 'deny' | null>
  /** nobody can answer a card in this turn (a scheduled run): no site card is raised */
  unattended?: boolean
  /** a shared chat (srt/runner.ts SharedRun): each run sees only what everyone who sees the chat may read; foreground
   * commands only, no command that needs a login, no results of the person's jobs */
  shared?: SharedRun
  /** who made a call (its turn file state, chat/tools.ts): a sub-agent ("helper", QA TC-4911) or the main AI. `key`:
   * one per agent, so each agent's first call gets the notes of a first call */
  caller?(files: unknown): { helper: boolean; key: string }
  /** this call is a sub-agent's (set per call from `caller`): it runs commands with the same folders and fence, but
   * raises no card (it cannot ask the person), starts no job or dev server (their notice, Preview button and results
   * are the main AI's) and takes no job results */
  helper?: boolean
  /** the sub-agent's key (its Agent call id, '?' when not known) on a helper's call: in the audit line */
  agent?: string
  /** the bulk card (devenv/bulk.ts): keep this command's many new files in the project folder? true: keep (also the
   * person's "Always allow", kind bulk_files); false or null: move them to the chat's scratch folder */
  keepBulk?(ask: BulkAsk): Promise<boolean | null>
  /** what this answer's commands added to project folders so far (boxShellTool keeps one per turn) */
  bulk?: BulkState
  redact(s: string): string
}

/** What a shared chat's command cannot do in a folder given entry by entry (srt/mounts.ts). Names only folders everyone
 * in the chat may open, and never what is hidden or why. */
export const lockedTopsNote = (folders: readonly string[]) => `Note: in this shared chat a command cannot add, rename or delete anything directly in ${folders.slice(0, 5).map((f) => `$TRINA_TEAM/${f}`).join(', ')}${folders.length > 5 ? ` and ${folders.length - 5} more` : ''} (a new file or folder there fails with "Permission denied"), and the files there are read-only; folders whose names start with a dot and skill folders there are read-only too, and a .git folder there is not available (git does not work at that level). Write in one of its other sub-folders or in $TMPDIR, and save a result with the file tools (write, edit, copy_files).`

type Window = { changes: Change[]; background: Change[]; conflicts: string[] }

/** May the person of this call open the team file `rel` now (their own read access; false when it cannot be told)? */
function personCanOpen(h: Pick<BoxShellHost, 'ctx' | 'userId'>, rel: string): boolean {
  try {
    const f = h.ctx.files
    authorize(f.fx, f.rules(), f.principal(h.userId), rel, 'read')
    return true
  } catch { return false }
}

/** The answer to the AI after a command ran. */
function answer(h: BoxShellHost, o: { notes: string[]; head: string; started: number; exit: RunExit; w: Window; background: boolean; what: string }) {
  const { notes, head, started, exit: e, w, background, what } = o
  const parts = [...notes, `${head} (${((Date.now() - started) / 1000).toFixed(1)} s)`]
  // srt's proxy login (srt/proxy-login.ts: per run, useless outside it) never reaches the AI, so never a chat; secrets are
  // hidden before any cut (a value split at a cut would not match), and the whole answer again below
  parts.push(e.stdout ? `--- stdout ---
${clip(h.redact(hideProxyLogin(e.stdout)))}` : '--- stdout: empty ---')
  if (e.stderr) parts.push(`--- stderr ---
${clip(h.redact(hideProxyLogin(e.stderr)))}`)
  if (e.truncated) parts.push('(output cut)')
  // a link only for a file the person can open now: the project folder's changes may include a file a teammate's run
  // saved in a sub-folder this person cannot open (a dead link in the answer otherwise)
  if (w.changes.length) parts.push(`Files changed by this command (${w.changes.length}):\n${changeLines(w.changes, 30, (rel) => personCanOpen(h, rel))}`)
  if (w.background.length) parts.push(`Files changed in the background since the last command (${w.background.length}):\n${changeLines(w.background)}`)
  if (w.conflicts.length) parts.push(`Someone saved some of these files while the command ran; their version is kept as: ${w.conflicts.join(', ')}`)
  const failed = e.code !== 0 || (e.signal !== '' && !background)
  return { ...text(h.redact(parts.join('\n')), failed), summary: `${what} -> ${e.signal || 'exit ' + e.code} ${e.ms} ms, ${w.changes.length} files` }
}

type SrtNotes = () => Promise<string[]>
const NO_WINDOW: Window = { changes: [], background: [], conflicts: [] }

/** A command waits for its end; a job starts or waits in the queue; a dev server starts or is refused. In the project
 * folder of a project chat they run in a change window. Elsewhere (the chat's work folder) nothing is recorded: that folder is not a team folder. */
async function srtShell(h: BoxShellHost, input: BoxShellInput, o: { space: Space; tracked: ProjectRef | null; cwd: string; what: string; jobName: string | null; notes: string[]; jobNotes: SrtNotes; once: Set<string> }) {
  const { ctx } = h
  const { space, cwd, what, jobName, notes } = o
  const background = !!input.background && !jobName
  const timeoutMs = (input.timeout_sec ?? 120) * 1000
  const started = Date.now()
  const shown = h.redact(input.command)
  // a command waits for a slot of the team's queue (srt/queue.ts) before its change window opens: what other people
  // change while it waits is not the command's
  let slot: { release(): void } | null = null
  if (!jobName && !background) {
    const got = await waitForSlot(h, { space, cwd, shown, timeoutMs })
    if (!got.ok) return { ...text(h.redact([...notes, ...await o.jobNotes(), got.message].join('\n')), true), summary: `${o.what} -> ${got.summary}` }
    slot = got
  }
  const run = async (): Promise<Out> => { try { return await go() } finally { slot?.release() } }
  type Out = { kind: 'exit'; r: Awaited<ReturnType<typeof runCommand>> } | { kind: 'job'; r: Awaited<ReturnType<typeof submitJob>> } | { kind: 'server'; r: Awaited<ReturnType<typeof startServer>> }
  const go = async (): Promise<Out> => {
    const base = { space, turnId: h.turnId, command: input.command, shown, cwd, once: [...o.once] }
    if (jobName) return { kind: 'job', r: await submitJob(ctx, { ...base, name: jobName }) }
    if (background) return { kind: 'server', r: await startServer(ctx, { ...base, name: input.log_name ?? 'background', ...(input.port ? { port: input.port } : {}) }) }
    return { kind: 'exit', r: await runCommand(ctx, { space, cwd, command: input.command, shown, timeoutMs, signal: h.signal, once: [...o.once], redact: h.redact }) }
  }
  let w: Window & { value: Out }
  if (o.tracked) {
    const tracked = o.tracked
    w = await withChangeWindow(ctx, tracked, { userId: h.userId, turnId: h.turnId }, { command: input.command.slice(0, 500) }, run, {
      bulk: (changes, startedMs, present) => bulkGuard(h, { space, project: tracked, changes, startedMs, present, notes }),
    }).finally(() => slot?.release())
    // a sub-agent's command does not use up the main AI's "changed by other people" note or the login card's check
    // (both are the main AI's; the helper never sees the card)
    if (!h.helper) markSeen(ctx, o.tracked.id, h.userId)
  } else w = { ...NO_WINDOW, value: await run() }
  notes.push(...await o.jobNotes())
  // a job or dev server that added many files to the project folder since the last command (not guarded: moving a
  // running job's files would break it): the AI is told where such output belongs
  const bgNew = o.tracked ? w.background.filter((c) => c.action === 'create').length : 0
  if (bgNew > BULK_FILES) notes.push(`A job or dev server of this project added ${bgNew} new files to the project folder since the last command. Downloads, clones and other scratch belong in $TRINA_WORK: tell the person, and use $TRINA_WORK for such jobs from now on.`)
  const out = w.value
  const result = !out.r.ok ? { error: out.r.message.slice(0, 300) }
    : out.kind === 'exit' && out.r.ok ? { code: out.r.value.code, signal: out.r.value.signal, ms: out.r.value.ms }
    : out.kind === 'job' && out.r.ok ? { state: out.r.state, position: out.r.position }
    : { state: 'running' }
  audit(ctx.db, { actor: h.userId, action: 'dev_env.command', target: space.projectId, detail: {
    turnId: h.turnId, chatId: space.chatId, command: h.redact(input.command.slice(0, 2000)), cwd, folder: o.tracked ? 'project' : 'work', background: background || !!jobName, ...(jobName ? { job: jobName } : {}), runner: 'srt',
    result, changed: w.changes.length, background_changes: w.background.length, conflicts: w.conflicts,
    ...(h.helper ? { by: 'sub-agent', agent: h.agent ?? '?' } : {}),
  } })
  // a shared chat: the answer names only paths the run could see (a save by someone else in a folder some people here
  // cannot open lands in the same window); the audit line above keeps them all
  if (h.shared) {
    const see = sharedVisible(ctx, space)
    w = { ...w, changes: w.changes.filter((c) => see(c.path)), background: w.background.filter((c) => see(c.path)), conflicts: w.conflicts.filter(see) }
    // a writable folder that holds a folder some of them cannot open is given entry by entry (srt/mounts.ts): its top
    // cannot change in a command, which the AI must know (else it would try to make files there, which fails)
    const locked = sharedLockedTops(ctx, space)
    if (locked.length) notes.push(lockedTopsNote(locked))
  }
  if (!out.r.ok) return { ...text(h.redact([...notes, `Error: the command could not run (${out.r.message.slice(0, 300)}).`].join('\n')), true), summary: `${what} -> ${out.r.message.slice(0, 200)}` }
  const empty = { ev: 'exit' as const, code: 0, signal: '', stdout: '', stderr: '', truncated: false, ms: Date.now() - started }
  if (out.kind === 'job' && out.r.ok) {
    // the chat shows the job's place in line until it starts (the app reads the live place)
    if (out.r.state === 'waiting') h.queueStep?.({ id: out.r.rowId, kind: 'job', state: 'waiting', position: out.r.position })
    const head = out.r.state === 'running'
      ? `Started as job ${jobName} (log: $TRINA_LOGS/${jobName}.log). Do not wait for it: when it ends the person gets a notice, and your next box_shell call in this chat gives you the result.`
      : `Queued as job ${jobName}: other jobs of the team run now, so it waits (position ${out.r.position}) and starts by itself. Do not wait for it: when it ends the person gets a notice, and your next box_shell call in this chat gives you the result.`
    return answer(h, { notes, head, started, exit: empty, w, background: true, what })
  }
  if (out.kind === 'server' && out.r.ok) {
    const log = `$TRINA_LOGS/${input.log_name ?? 'background'}.log`
    const preview = previewReady()
    // the step shows the Preview button for the port the AI named (Step.devEnvRun kind server)
    if (preview && input.port) h.queueStep?.({ id: out.r.rowId, kind: 'server', state: 'started', position: null, port: input.port })
    // where later commands of this chat reach it (srt/runner.ts reachTargets): macOS its own $PORT, Linux the port named
    const at = out.r.port
    const later = at ? `Later box_shell commands in this chat reach it at localhost:${at} while it runs (for example curl -s localhost:${at}).` : 'A later command cannot reach it; test it in one command with curl.'
    const head = runPlatform() === 'darwin' ? `Started in the background (log: ${log}), listening on $PORT, which is ${at ?? 'its own port'}. ${later}`
      : !preview ? `Started in the background (log: ${log}). ${later}`
      : input.port ? `Started in the background (log: ${log}). The person now has a Preview button for port ${input.port} on this step: tell them to press it${h.shared ? ' (everyone in this chat can open it)' : ''}. If the page does not open, read the log. ${later}`
      : `Started in the background (log: ${log}), with no port: the person has no Preview button. Stop it and start it again with port set to the port the dev server listens on.`
    return answer(h, { notes, head, started, exit: empty, w, background: true, what })
  }
  if (out.kind !== 'exit' || !out.r.ok) throw new Error('unreachable')
  const e = out.r.value
  const head = e.signal === 'timeout' ? `Stopped: the time limit (${timeoutMs / 1000} s) was reached.`
    : e.signal === 'oom' ? 'Stopped: the command ran out of memory (the team limit).'
    : e.signal === 'stopped' ? 'Stopped.'
    : e.signal === 'setting' ? 'Stopped: the dev environment setting or your access to this folder changed. Check the access, then try again.'
    : `Exit code ${e.code}.`
  if (e.code !== 0 && networkNow(ctx) === 'open' && (BLOCKED_SITE.test(e.stderr) || BLOCKED_SITE.test(e.stdout))) notes.push(blockedHint({ full: personNetNow(ctx, h.userId).full }))
  return answer(h, { notes, head, started, exit: e, w, background: false, what })
}

/**
 * The bulk guard after a command in a project folder (devenv/bulk.ts): this answer's new files there over the line ask
 * the person whether to keep them; no answer or "move" moves the command's new files to the chat's scratch folder.
 * Returns the team paths that went (the window does not record them). The AI gets a note either way.
 */
async function bulkGuard(h: BoxShellHost, o: { space: Space; project: ProjectRef; changes: Change[]; startedMs: number; present: readonly string[]; notes: string[] }): Promise<Set<string>> {
  const st = h.bulk ?? newBulkState()
  const created = o.changes.filter((c) => c.action === 'create')
  const bytes = created.reduce((n, c) => n + (c.size ?? 0), 0)
  const none = new Set<string>()
  if (!overBulk(st, created.length, bytes)) { st.files += created.length; st.bytes += bytes; return none }
  const base = { userId: h.userId, turnId: h.turnId, chatId: h.chatId ?? null, projectId: o.project.id, files: created.length, bytes }
  // a sub-agent and a run nobody watches cannot ask: the files move (keeping them needs the person's yes or their
  // "Always allow", which keepBulk answers without a card)
  const ask: BulkAsk = { files: created.length, bytes, folders: bulkFolders(o.project.folderPath, created), project: o.project.folderPath }
  const keep = !h.helper && h.keepBulk ? await h.keepBulk(ask).catch(() => null) : null
  if (keep === true) {
    st.kept = true; st.files += created.length; st.bytes += bytes
    auditBulk(h.ctx, { ...base, decision: 'keep', asked: true })
    o.notes.push(`The person chose to keep the ${created.length} new files (${mb(bytes)} MB) of this command in the project folder.`)
    return none
  }
  const r = await moveToScratch(h.ctx, { space: o.space, project: o.project.folderPath, created, startedMs: o.startedMs, present: o.present, signal: h.signal })
  const left = created.filter((c) => !r.moved.has(c.path))
  st.files += left.length; st.bytes += left.reduce((n, c) => n + (c.size ?? 0), 0)
  if ('error' in r) {
    auditBulk(h.ctx, { ...base, decision: 'move_failed', asked: !h.helper && !!h.keepBulk })
    o.notes.push(`This command added ${created.length} new files (${mb(bytes)} MB) to the project folder, more than one answer may add without the person's yes, and they could not be moved to $TRINA_WORK (${r.error}). They stay in the project folder: tell the person, and put scratch files in $TRINA_WORK from now on.`)
    return r.moved
  }
  auditBulk(h.ctx, { ...base, decision: 'move', asked: !h.helper && !!h.keepBulk, moved: r.moved.size, dest: r.dest })
  const why = h.helper ? 'a sub-agent cannot ask the person to keep them' : keep === false ? 'the person chose to move them' : 'the person did not say to keep them'
  o.notes.push(`This command added ${created.length} new files (${mb(bytes)} MB) to the project folder. That is more than one answer may add there without the person's yes, and ${why}, so ${r.moved.size} of them were moved out of the project folder to $TRINA_WORK/${r.dest}/ (chat:work/${r.dest}/ in the file tools), with their folders. Use them from there, keep downloads, tools and previews in $TRINA_WORK, and copy only finished files into the project folder.`)
  return r.moved
}

/** A foreground command takes a slot of the team's queue (srt/queue.ts): at once when one is free and nobody is ahead,
 * else it waits as a ticket, at most 5 minutes; the chat shows the place in line and a Cancel button (Step.devEnvRun).
 * The slot is free again with release(). */
async function waitForSlot(h: BoxShellHost, o: { space: Space; cwd: string; shown: string; timeoutMs: number }): Promise<{ ok: true; release(): void } | { ok: false; message: string; summary: string }> {
  const { ctx } = h
  const problem = runProblem(ctx)
  if (problem) return { ok: false, message: `Error: the command could not run (${problem.slice(0, 300)}).`, summary: problem.slice(0, 200) }
  // commands of one project run one at a time: wait for the other command first, with a plain line and no slot held
  const rowId = newId()
  let waitedProject = false
  if (projectBusy(o.space.root)) {
    waitedProject = true
    h.queueStep?.({ id: rowId, kind: 'command', state: 'waiting', position: null, why: 'project' })
    if (!await waitProjectFree(o.space.root, h.signal)) {
      h.queueStep?.({ id: rowId, kind: 'command', state: 'cancelled', position: null })
      return { ok: false, message: 'Stopped. The command did not run.', summary: 'aborted' }
    }
  }
  addTicket(ctx.db, { id: rowId, space: o.space, turnId: h.turnId, shown: o.shown, cwd: o.cwd })
  const limitMs = commandWaitFor(o.timeoutMs)
  const ended = waitTicket(ctx.db, rowId, h.userId, { signal: h.signal })
  await startWaiting(ctx)
  // granted in that start round: no waiting state at all
  let end = await Promise.race([ended, Promise.resolve(null)])
  const waited = end === null
  if (waited) {
    armTicket(rowId, limitMs)
    h.queueStep?.({ id: rowId, kind: 'command', state: 'waiting', position: placeInLine(ctx, rowId) })
    end = await ended
  }
  if (end === 'granted') {
    if (waited || waitedProject) h.queueStep?.({ id: rowId, kind: 'command', state: 'started', position: null })
    let done = false
    return { ok: true, release: () => { if (done) return; done = true; releaseCommand(rowId); void startWaiting(ctx).catch(() => {}) } }
  }
  const state = end === 'expired' ? 'expired' as const : 'cancelled' as const
  h.queueStep?.({ id: rowId, kind: 'command', state, position: null })
  audit(ctx.db, { actor: h.userId, action: 'dev_env.command', target: o.space.projectId, detail: { turnId: h.turnId, chatId: o.space.chatId, command: o.shown.slice(0, 2000), cwd: o.cwd, runner: 'srt', result: { error: end === 'expired' ? 'full' : end ?? 'stopped', waitedMs: limitMs } } })
  const waitedFor = limitMs >= 60_000 ? `it waited ${Math.round(limitMs / 60_000)} minutes for a free slot` : 'no slot was free, and its time limit leaves no time to wait'
  const message = end === 'expired' ? `Error: ${FULL_MESSAGE} The command did not run: ${waitedFor}. Tell the person. Do not try again in a loop.`
    : end === 'cancelled' ? 'The person cancelled this command before it started. It did not run. Do not run it again unless the person asks.'
    : end === 'aborted' ? 'Stopped. The command did not run.'
    : 'The command did not run: the dev environment stopped (the setting changed, or the server disk is nearly full). Do not try again now.'
  return { ok: false, message, summary: end === 'expired' ? 'full' : end ?? 'stopped' }
}

/** One box_shell call. */
async function srtCall(h: BoxShellHost, data: BoxShellInput, what: string, firstCall: boolean, once: Set<string>, denied: Set<string>) {
  const { ctx, project } = h
  // never trust the start of the turn alone: the admin may have turned it off, the person may be out of scope now
  if (!mayUseDevEnv(ctx.db, ctx.files, h.userId)) return { ...text('The dev environment is off for you now. Do not try again.', true), summary: `${what} -> off` }
  // a shared chat: no command that would use a login (no card: a run holds no credentials anyway), checked before
  // anything else runs. Jobs and dev servers run there with the chat's view (srt/runner.ts sharedRowStart)
  // a sub-agent (QA TC-4911): foreground commands only; the main AI starts jobs and dev servers
  if (h.helper && (data.job || data.background)) return { ...text(HELPER_NO_JOB, true), summary: `${what} -> refused (job of a sub-agent)` }
  // a group's or project's skills folder is not in any run (srt/access.ts RunWrites.othersSkills); a command that names
  // one gets the reason before anything runs (QA TC-4932)
  if (namesOthersSkills(data.command) || (data.cwd && namesOthersSkills(data.cwd))) return { ...text(OTHERS_SKILLS_REFUSAL, true), summary: `${what} -> refused (a group or project skills folder)` }
  if (h.shared && usesCredentials(data.command)) return { ...text('Not run: commands that need a login (git push, npm publish, ssh ...) do not run in a shared chat. Tell the person to do it on their own computer.', true), summary: `${what} -> refused (login in a shared chat)` }
  const space = spaceOf(ctx, { userId: h.userId, chatId: h.chatId ?? null, project: project ? { id: project.id, folderPath: project.folderPath } : null, ...(h.shared ? { shared: h.shared } : {}) })
  if (!space) return { ...text('Error: this chat has no folder for commands. Do not try again.', true), summary: `${what} -> no folder` }
  const tracked = project && space.projectId === project.id && space.root === path.join(ctx.files.fx.root, project.folderPath) ? { id: project.id, folderPath: project.folderPath } : null
  const cwd = boxCwd(data.cwd)
  if (cwd === null) return { ...text('Invalid input: cwd must be a folder inside the folder of this chat (the project folder, or the work folder).', true), summary: `${what} -> bad cwd` }
  // the project's own skills folder as cwd: not in the run either (QA TC-4932)
  if (tracked && cwd && inOthersSkills(`${tracked.folderPath}/${cwd}`)) return { ...text(OTHERS_SKILLS_REFUSAL, true), summary: `${what} -> refused (a project skills folder)` }
  const background = !!data.background || !!data.job
  /** the jobs of this chat that ended and the AI does not know of yet, in every answer that goes back to it */
  const jobNotes = async () => {
    // a sub-agent: none (the main AI gets them on its next call: a result given to a helper would never reach it)
    if (h.helper) return []
    if (h.shared) {
      // a shared chat: the chat's jobs of the same people and view only (a person's own jobs never: their log is the
      // person's), and only once what a run here may read joined this answer's record (as for a command)
      await pollSrt(ctx, { chatId: h.chatId ?? '' }).catch(() => {})
      const key = sharedLogKey(ctx, space)
      if (!key || !pendingShared(ctx, h.chatId ?? null, key) || !noteSharedReads(ctx, space)) return []
      return runResultsForAI(ctx, h.userId, h.chatId ?? null, key).map((n) => h.redact(n))
    }
    await pollSrt(ctx, { userId: h.userId }).catch(() => {})
    return runResultsForAI(ctx, h.userId, h.chatId ?? null).map((n) => h.redact(n))
  }
  try { assertStorageRoomForAI(0) } catch (e) {
    if (!(e instanceof ToolError)) throw e
    audit(ctx.db, { actor: h.userId, action: 'dev_env.command', target: space.projectId, detail: { turnId: h.turnId, chatId: space.chatId, command: h.redact(data.command.slice(0, 2000)), cwd, background, runner: 'srt', result: { error: 'storage_full' } } })
    return { ...text([...await jobNotes(), `Error: ${e.message}. No command runs until then. Delete files with the file tools, or ask the person to do it. Do not try again before that.`].join('\n'), true), summary: `${what} -> storage full` }
  }
  if (data.port !== undefined) {
    if (!data.background || data.job) return { ...text('Invalid input: port goes only with background=true (a dev server).', true), summary: `${what} -> bad port` }
    const why = previewPortProblem(data.port)
    if (why) return { ...text(`Invalid input: port ${data.port}: ${why}. Use the port of the dev server (for example 3000 or 5173).`, true), summary: `${what} -> bad port` }
  }
  // an update waits for running work before the server restarts (system/update-wait.ts): a long foreground command
  // started now could be cut off at the end of that wait, and a job keeps running through the restart
  // (a command that can end before the wait does is fine: the update waits for it)
  const upd = background ? null : updateWaitingFor(ctx.config)
  const leftSec = upd ? Math.floor((Date.parse(upd.until) - Date.now()) / 1000) - 30 : 0
  if (upd && (data.timeout_sec ?? 120) > leftSec) {
    const fits = leftSec >= 10 ? ` or keep timeout_sec at ${leftSec} or less` : ''
    return { ...text(`Not started: a Trina update is waiting for running tasks to finish and restarts the server soon, which would stop this command. Run it with job=true (a job keeps running through the update, and the person gets a notice when it ends)${fits}, or tell the person to try again after the update.`, true), summary: `${what} -> update waiting` }
  }
  const jobName = data.job ? (data.log_name ?? newJobName()) : null
  // the log is per person: a job or dev server with the same name would write over it
  const logInUse = background ? (jobName ?? data.log_name ?? 'background') : null
  if (logInUse) {
    await pollSrt(ctx, { userId: h.userId }).catch(() => {})
    if (runNameInUse(ctx, space, logInUse)) return { ...text(`Error: a job or dev server named ${logInUse} still runs ${h.shared ? 'in this chat' : 'for this person'}. Use another log_name, or wait for it to end.`, true), summary: `${what} -> job name in use` }
  }
  const notes: string[] = []
  if (tracked) {
    let foreign = changesByOthers(ctx, tracked, h.userId)
    // a shared chat: only changes in folders this run may see, and no count of the others (sharedVisible)
    if (h.shared) { const see = sharedVisible(ctx, space); const items = foreign.items.filter((c) => see(c.path)); foreign = { ...foreign, items, total: items.length } }
    if (usesCredentials(data.command) && foreign.total > 0) {
      if (h.helper) return { ...text(HELPER_NO_CARD, true), summary: `${what} -> refused (login command of a sub-agent after changes by others)` }
      const ok = await h.confirm(
        `This command can use a login: ${data.command.slice(0, 200)}\nOther people changed files in the project since your last command. Check the changes before you run it.`,
        [{ label: 'Run it', value: 'run' }, { label: 'Do not run', value: 'no' }],
        foreign.items.slice(0, 20).map((c) => `${c.by.name}${c.background ? ' (background process)' : ''}: ${c.action} ${c.path}`),
      )
      if (ok !== 'run') return { ...text('The person did not allow this command after seeing the changes by other people. Do not run it again in this answer.', true), summary: `${what} -> not allowed (changes by others)` }
      markSeen(ctx, tracked.id, h.userId, foreign.lastId)
    } else if (firstCall && foreign.total > 0) {
      notes.push(`Changed by other people since this person's last command:\n${foreignLines(foreign)}`)
    }
    // other people's jobs and dev servers (their names): never in a shared chat
    if (firstCall && !h.shared) {
      const others = othersInProject(ctx, tracked.id, h.userId)
      if (others.length) notes.push('Other people\'s jobs and dev servers in this project (they keep running):\n' + others.slice(0, 20).map((r) => `  ${r.kind} ${r.name}${r.position ? ` (waiting, position ${r.position})` : ''}, by ${r.by}`).join('\n'))
    }
  }
  // the chat's own jobs and dev servers this command reaches on localhost (srt/runner.ts reachTargets)
  const reach = reachTargets(ctx, space)
  if (reach.length) notes.push(`This command can reach the running ${reach.length === 1 ? 'dev server' : 'dev servers'} of this chat: ${reach.map((t) => `${t.name} (${t.kind === 'job' ? 'a job' : 'a dev server'}) at localhost:${t.port}`).join(', ')}.`)
  if (data.request_sites?.length) {
    const asked = await askSites(h, data, once, denied)
    if (asked.refusal) return { ...text(h.redact([...notes, ...asked.notes, asked.refusal].join('\n')), true), summary: `${what} -> ${asked.summary}` }
    notes.push(...asked.notes)
  }
  return srtShell(h, data, { space, tracked, cwd, what, jobName, notes, jobNotes, once })
}

/** The sites the AI asked for (request_sites): each host is checked; one that is allowed already needs no card; for the
 * others the person who owns the turn answers a server card. A refusal stops the command. Nothing is asked when the
 * team (or the plan) set No network. */
async function askSites(h: BoxShellHost, data: BoxShellInput, once: Set<string>, denied: Set<string>): Promise<{ notes: string[]; refusal?: string; summary?: string }> {
  const { ctx } = h
  if (networkNow(ctx) === 'offline') return { notes: [], refusal: 'The team set the dev environment to No network: no site can be allowed, and commands have no network. Do not ask for sites again; tell the person that the command needs the network.', summary: 'sites refused (No network)' }
  const hosts = teamHosts(ctx)
  const notes: string[] = []
  for (const raw of data.request_sites ?? []) {
    const host = siteFromInput(raw)
    // the AI asks for one exact host name: a "*." pattern from a card would cover every name under a domain (every
    // bucket of a storage service, for example) with one click. A person cannot allow a pattern; an admin can.
    const why = !host ? 'not a host name' : host.includes('*') ? 'ask for one exact host name, not a pattern with "*"' : userSiteProblem(host, hosts)
    if (!host || why) {
      audit(ctx.db, { actor: h.userId, action: 'dev_env.site_refused', target: null, detail: { host: (host ?? raw).slice(0, 253), why, turnId: h.turnId, chatId: h.chatId ?? null } })
      return { notes, refusal: `${(host ?? raw).slice(0, 253)} cannot be allowed: ${why}. The command did not run. Do not ask for it again.`, summary: `site ${(host ?? raw).slice(0, 100)} refused (${why})` }
    }
    const person = personNetNow(ctx, h.userId)
    if (siteAllowed(host, { teamSites: teamSetting(ctx.db).extraDomains, person, once })) { notes.push(`${host} is allowed already.`); continue }
    // a host that the person did not allow in this turn is not asked again: no second card (the AI may try again
    // because a web page or a file tells it to; the person said no once)
    if (denied.has(host)) return { notes, refusal: `The person did not allow ${host} in this answer, so the command did not run. Do not ask for it again; tell the person what does not work without it.`, summary: `site ${host} not allowed (asked again)` }
    // a sub-agent cannot ask the person: the main AI asks for the site (no card, nothing recorded as denied)
    if (h.helper) return { notes, refusal: `${host} is not on the allowed list, and a sub-agent cannot ask the person to allow it, so the command did not run. Say in your report that the command needs ${host}: the main assistant can ask for it.`, summary: `site ${host} not asked (sub-agent)` }
    if (h.unattended) {
      audit(ctx.db, { actor: h.userId, action: 'dev_env.site_denied', target: null, detail: { host, answer: 'none', turnId: h.turnId, chatId: h.chatId ?? null } })
      denied.add(host)
      return { notes, refusal: `Nobody can answer a site card in this run (a scheduled task, for example): ${host} is not on the allowed list, so the command did not run. Sites that the person allowed with "Always allow" work here; tell the person to allow ${host} in a chat first.`, summary: `site ${host} not allowed (no person to ask)` }
    }
    const decision = h.askSite ? await h.askSite(host, h.redact(data.command.slice(0, 300))) : null
    if (decision === 'always') {
      if (grantUserSite(ctx.db, h.userId, host) === 'full') {
        once.add(host)
        notes.push(`The person allowed ${host}, for this chat only: their list of allowed sites is full (${DEV_ENV_MAX_USER_SITES}).`)
      } else notes.push(`The person allowed ${host} (always).`)
      audit(ctx.db, { actor: h.userId, action: 'dev_env.site_allowed', target: null, detail: { host, scope: 'always', turnId: h.turnId, chatId: h.chatId ?? null } })
    } else if (decision === 'once') {
      once.add(host)
      notes.push(`The person allowed ${host} for this answer.`)
      audit(ctx.db, { actor: h.userId, action: 'dev_env.site_allowed', target: null, detail: { host, scope: 'once', turnId: h.turnId, chatId: h.chatId ?? null } })
    } else {
      audit(ctx.db, { actor: h.userId, action: 'dev_env.site_denied', target: null, detail: { host, answer: decision === null ? 'none' : 'deny', turnId: h.turnId, chatId: h.chatId ?? null } })
      denied.add(host)
      return { notes, refusal: `The person did not allow ${host}, so the command did not run. Do not ask for ${host} again in this answer; tell the person what does not work without it.`, summary: `site ${host} not allowed` }
    }
  }
  return { notes }
}

/** srt's proxy refused a connection (HTTP 403 "blocked-by-allowlist"; curl prints "CONNECT tunnel failed, response 403") */
export const BLOCKED_SITE = /blocked-by-allowlist|Connection blocked by network allowlist|CONNECT tunnel failed, response 403|tunneling socket could not be established, statusCode=403|ProxyError\('Unable to connect to proxy', OSError\('Tunnel connection failed: 403/i
export const blockedHint = (o: { full: boolean }) => o.full
  ? 'A connection was blocked. With Full internet only the team server, IP addresses, local names and private addresses are blocked, and the person cannot allow them.'
  : 'A connection was blocked: the site is not on the allowed list. If the command needs it, call box_shell again with the same command and request_sites set to the host name (not an IP address): the person is asked to allow it.'

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }] as McpContent[], ...(isError ? { isError: true } : {}) })

/** a path of a group's or project's skills folder under $TRINA_TEAM in a command ($TRINA_TEAM/groups/<folder>/skills,
 * $TRINA_TEAM/projects/<name>/skills, any letter case; a folder name may hold spaces). A hint for a clear refusal only,
 * so a relative path or a look-alike elsewhere is not refused by its text: the run itself never has these folders
 * (srt/access.ts RunWrites.othersSkills), however the command names them */
const OTHERS_SKILLS_PATH = /\$\{?TRINA_TEAM\}?\/+(?:\.\/+)*(?:groups|projects)\/+[^/\n'"`]+?\/+skills(?=$|[\/\s'"`;|&)<>*?])/i
export const namesOthersSkills = (s: string) => OTHERS_SKILLS_PATH.test(s.normalize('NFC'))
export const OTHERS_SKILLS_REFUSAL = 'Not run: this command names a group\'s or project\'s skills folder. Those folders are not in the dev environment: other members wrote what is there, and their scripts never run or get copied (they would run with this user\'s access). Follow the skill\'s other steps, and tell the user that a skill manager can make it a team skill if they need its script.'

/** a sub-agent's job or dev server (QA TC-4911) */
export const HELPER_NO_JOB = 'Not started: a sub-agent runs commands that finish within their time limit (at most 1800 s); jobs and dev servers are started by the main assistant. Run it without job and background, or say in your report that it needs a job or a dev server.'
/** a sub-agent's command that would need the person's yes on a card */
export const HELPER_NO_CARD = 'Not run: this command can use a login and other people changed files in the project, so the person must check the changes on a card first, and a sub-agent cannot ask them. Say in your report that the command still needs to run: the main assistant can run it.'

/** Who made a box_shell call, from the turn file state it came with (files/service.ts forCall): the turn's own state
 * is the main AI; anything else is a helper, also a call whose agent is not known (a fresh view with agent null), which
 * fails closed to the helper's rules. `key`: one per agent ('?' for an unknown one). */
export function callerOf(files: unknown, main: unknown): { helper: boolean; key: string } {
  if (!files || files === main) return { helper: false, key: '' }
  const agent = (files as { agent?: unknown }).agent
  return { helper: true, key: typeof agent === 'string' && agent ? agent : '?' }
}

export function boxShellTool(h: BoxShellHost) {
  /** the agents (main AI '', each sub-agent its own key) whose first call came already */
  const called = new Set<string>()
  /** the sites the person allowed once in this turn (foreground commands; a job or dev server keeps its own copy) */
  const once = new Set<string>()
  /** the sites the person did not allow in this turn (or nobody could answer): no second card for them */
  const denied = new Set<string>()
  /** what this answer's commands added to project folders (devenv/bulk.ts), shared by the main AI and its sub-agents */
  const bulk = h.bulk ?? newBulkState()
  return {
    name: BOX_SHELL_TOOL,
    description: h.shared ? sharedShellDescription(h.shared.within !== null) : srtShellDescription(previewReady()),
    inputSchema: (() => { const j = z.toJSONSchema(BoxShellInput, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j })(),
    async call(args: unknown, files?: unknown): Promise<{ content: McpContent[]; isError?: boolean; summary?: string }> {
      const a = BoxShellInput.safeParse(args)
      if (!a.success) return { ...text('Invalid input: ' + a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), true), summary: 'box_shell -> invalid input' }
      const who = h.caller?.(files) ?? { helper: false, key: '' }
      const what = h.redact(`box_shell ${a.data.command.slice(0, 200)}`)
      const first = !called.has(who.key)
      called.add(who.key)
      // a sub-agent's call: no step patch (patchToolStep's FIFO is the main AI's; chat/subagents.ts PARENT_ONLY_TOOLS)
      const host: BoxShellHost = who.helper ? { ...h, bulk, helper: true, agent: who.key, queueStep: undefined } : { ...h, bulk }
      return srtCall(host, a.data, what + (who.helper ? ' (sub-agent)' : ''), first, once, denied)
    },
  }
}
