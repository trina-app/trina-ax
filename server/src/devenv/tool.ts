// The box_shell tool (dev environment EXPERIMENT, docs/DECISIONS.md "Dev environment (experiment)"). Offered to a
// turn of a project chat when the project's dev environment is in force and the person may use the box
// (setting.ts mayUseBox); checked again on every call. The engine keeps its lockdown (no Bash, --restricted): the
// command goes engine -> our MCP tool -> server -> mycel-boxd -> the project box. The AI engine and the model token
// never enter the box (P0 spike section 5.3).
//
// Per call: ensure the box runs (boxd), run the command inside a change window (track.ts: who changed what, versions,
// conflict copies), write the audit line (dev_env.command). On the first call of a turn the AI also gets what other
// people changed in the folder since this person's last command, and the processes still running in the box (a dev
// server that someone else's turn left). Before a command that would use a person's credentials (git push, npm
// publish, ssh ...) the PERSON confirms on a server card that names those changes (hole 2): the box holds no
// credentials today, so such a command fails anyway; the gate is where a per-command credential helper plugs in.
//
// Before each command the rule of the AI's writes applies (assertStorageRoomForAI). A long command runs as a job
// (jobs.ts): it has an exit status and a log, the person gets a notice when it ends, and each later call gives the AI the
// results it did not get yet. The AI does not go on by itself when a job ends.
import { z } from 'zod'
import type { AppContext } from '../context'
import type { McpContent } from '../turns'
import { audit } from '../admin/audit'
import { ToolError } from '../policy/errors'
import { assertStorageRoomForAI } from '../system/storage'
import { boxd } from './boxd'
import { jobResultsForAI, jobRuns, newJobName, pollJobs, startJob } from './jobs'
import { devEnvRunner, devEnvSetting, mayUseBox, mayUseDevEnv, type ProjectRef } from './setting'
import { commandSlotFree, othersInProject, runCommand, runNameInUse, spaceOf, startServer, submitJob, type Space } from './srt/runner'
import { pollSrt, runResultsForAI } from './jobs'
import path from 'node:path'
import { changesByOthers, markSeen, withChangeWindow, type ForeignChange } from './track'
import type { Change } from './snapshot'

export const BOX_SHELL_TOOL = 'box_shell'

/** last destination line already in the audit, per box (destinations are audited once per command, hole 7) */
const netSeen = new Map<string, string>()
/** the destinations (address:port) of connections after `seen`, at most 50, and the new last line */
export function newDestinations(lines: string[], seen: string | undefined): { dest: string[]; last: string | undefined } {
  const i = seen ? lines.lastIndexOf(seen) : -1
  const fresh = lines.slice(i + 1)
  const dest = [...new Set(fresh.map((l) => l.split(' ').slice(1).join(' ')))].slice(0, 50)
  return { dest, last: lines.length ? lines[lines.length - 1] : seen }
}
const OUT_SHOWN = 32 << 10

export const BoxShellInput = z.object({
  command: z.string().min(1).max(64 * 1024).describe('the shell command (bash -lc), for example "npm install" or "git status"'),
  cwd: z.string().max(1024).optional().describe('folder relative to the project folder (default: the project folder)'),
  timeout_sec: z.number().int().min(1).max(1800).optional().describe('time limit in seconds (default 120, at most 1800)'),
  background: z.boolean().optional().describe('start a long-running process (a dev server, a watcher) and return at once; its output goes to the log <log_name>.log (the tool text says where)'),
  job: z.boolean().optional().describe('run a long command (a render, a large build) in the background as a job: it returns at once, it has an exit status and a log, and the person gets a notice when it ends'),
  log_name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional().describe('name of the log file for a background command or a job'),
})
export type BoxShellInput = z.infer<typeof BoxShellInput>

export const BOX_SHELL_DESCRIPTION = 'Run a shell command in the dev environment of this project (a Linux box: bash, git, node, npm, python3, pip). '
  + 'The project folder is /work in the box and is the same folder as in the file tools; changes are shared with the team and recorded with your name. '
  + 'node_modules, .venv and caches are kept in the box, not in the folder. The box has internet access without private addresses, or no network at all (the project setting). '
  + 'It has NO credentials: git push, npm publish and other commands that need a login do not work; tell the person to do them on their own computer. '
  + 'For a dev server use background=true and bind it to 127.0.0.1 or 0.0.0.0; the person opens it with the Preview button of the project. '
  + 'For a long command (a render, a large build, anything that can take more than a few minutes) use job=true: the call returns at once and the chat does not wait. '
  + 'To see progress, read the end of its log with another command: tail -n 20 /cache/logs/<log_name>.log. Do not wait for a job in a loop. '
  + 'When a job ends the person gets a notice, and your next box_shell call in this project gives you its exit code and the end of its log; you do not go on by yourself when it ends. '
  + 'The disk size of the box limits only node_modules, .venv and caches. Files in /work are on the server disk: a command there has no size limit of its own, and the box stops when the server disk is nearly full. '
  + 'One command at a time per project; default time limit 120 s; only the first 32 KiB of stdout and of stderr come back.'

/** The tool text with the srt runner (docs/research/srt-dev-env.md section 7). The runner is not locked to a project:
 * the command gets the folder access of the person of this chat. */
export const SRT_SHELL_DESCRIPTION = 'Run a shell command in the dev environment (bash, git, node, npm, python3, pip, ffmpeg, chromium) on the team server. '
  + 'The command can read the team folders that the person of this chat may open; other folders are not there. '
  + 'It can write only the folder it starts in and the person\'s own folder users/<id>: every other team folder is read-only in a command, also where the person may write. To save a file in another team folder, use the file tools. '
  + 'Team folders are under $TRINA_TEAM, with the same paths as in the file tools. '
  + 'In a project chat the command starts in the project folder, and changes there are shared with the team and recorded with your name. '
  + 'In a chat with no project it starts in the chat\'s own work folder ($TRINA_WORK), which only this chat uses and which the file tools do not show: copy a result the person needs into their own folder users/<id>, or into another team folder they can write with the file tools. '
  + 'node_modules, .venv and build output are in that folder and use team disk. '
  + 'The network reaches only allowed sites (npm, PyPI, GitHub and the sites an admin added), or nothing (the team setting). '
  + 'There are NO credentials: git push, npm publish and other commands that need a login do not work; tell the person to do them on their own computer. '
  + 'You cannot change .git/config or .git/hooks. For chromium use --headless --no-sandbox --disable-dev-shm-usage. '
  + 'For a dev server use background=true. There is no preview link yet, and a later command cannot reach the dev server: to test it, start it, call it and stop it in one command, for example: npm run dev & sleep 5; curl -s localhost:3000; kill %1. '
  + 'For a long command (a render, a large build) use job=true: the call returns at once; if other jobs of the team run, it waits in a queue. '
  + 'Read its log with tail -n 20 $TRINA_LOGS/<log_name>.log and do not wait for it in a loop. When a job ends the person gets a notice, and your next box_shell call in this chat gives you its exit code and the end of its log. '
  + 'One command at a time per folder; default time limit 120 s; only the first 32 KiB of stdout and of stderr come back.'

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

export function changeLines(changes: Change[], max = 30): string {
  const verb = { create: 'created', update: 'changed', delete: 'deleted' } as const
  const lines = changes.slice(0, max).map((c) => `  ${verb[c.action]} ${c.path}`)
  if (changes.length > max) lines.push(`  ... and ${changes.length - max} more`)
  return lines.join('\n')
}

export function foreignLines(f: { items: ForeignChange[]; total: number }): string {
  const lines = f.items.map((c) => `  ${c.by.name}${c.background ? ' (a process in the box)' : ''}: ${c.action} ${c.path} (${c.at})`)
  if (f.total > f.items.length) lines.push(`  ... and ${f.total - f.items.length} more`)
  return lines.join('\n')
}

const clip = (s: string) => (s.length > OUT_SHOWN ? s.slice(0, OUT_SHOWN) + '\n(cut)' : s)

export interface BoxShellHost {
  ctx: AppContext
  /** the project of the chat; null: a chat with no project (srt runner only) */
  project: (ProjectRef & { name: string }) | null
  userId: string
  turnId: string
  /** the chat of the turn: the link in a job's notice */
  chatId?: string
  signal: AbortSignal
  /** a server card the person answers (chat/tools.ts turnPerson): the value of the chosen option, or null */
  confirm(question: string, options: { label: string; value: string }[], details: string[]): Promise<string | null>
  redact(s: string): string
}

type Window = { changes: Change[]; background: Change[]; conflicts: string[] }

/** The answer to the AI after a command ran (both runners). */
function answer(h: BoxShellHost, o: { notes: string[]; head: string; started: number; exit: import('@mycel/shared').BoxdExit; w: Window; background: boolean; what: string }) {
  const { notes, head, started, exit: e, w, background, what } = o
  const parts = [...notes, `${head} (${((Date.now() - started) / 1000).toFixed(1)} s)`]
  parts.push(e.stdout ? `--- stdout ---\n${clip(e.stdout)}` : '--- stdout: empty ---')
  if (e.stderr) parts.push(`--- stderr ---\n${clip(e.stderr)}`)
  if (e.truncated) parts.push('(output cut)')
  if (w.changes.length) parts.push(`Files changed by this command (${w.changes.length}):\n${changeLines(w.changes)}`)
  if (w.background.length) parts.push(`Files changed in the background since the last command (${w.background.length}):\n${changeLines(w.background)}`)
  if (w.conflicts.length) parts.push(`Someone saved some of these files while the command ran; their version is kept as: ${w.conflicts.join(', ')}`)
  const failed = e.code !== 0 || (e.signal !== '' && !background)
  return { ...text(h.redact(parts.join('\n')), failed), summary: `${what} -> ${e.signal || 'exit ' + e.code} ${e.ms} ms, ${w.changes.length} files` }
}

type SrtNotes = () => Promise<string[]>
const NO_WINDOW: Window = { changes: [], background: [], conflicts: [] }

/** The srt runner (MYCEL_DEV_ENV_RUNNER=srt): a command waits for its end; a job starts or waits in the queue; a dev
 * server starts or is refused. In the project folder of a project chat they run in a change window, as with the box.
 * Elsewhere (the chat's work folder) nothing is recorded: that folder is not a team folder. */
async function srtShell(h: BoxShellHost, input: BoxShellInput, o: { space: Space; tracked: ProjectRef | null; cwd: string; what: string; jobName: string | null; notes: string[]; jobNotes: SrtNotes }) {
  const { ctx } = h
  const { space, cwd, what, jobName, notes } = o
  const background = !!input.background && !jobName
  const timeoutMs = (input.timeout_sec ?? 120) * 1000
  const started = Date.now()
  const shown = h.redact(input.command)
  if (!jobName && !background) {
    const slot = commandSlotFree(ctx)
    if (!slot.ok) return { ...text(h.redact([...notes, ...await o.jobNotes(), `Error: the command could not run (${slot.message}).`].join('\n')), true), summary: `${o.what} -> busy` }
  }
  type Out = { kind: 'exit'; r: Awaited<ReturnType<typeof runCommand>> } | { kind: 'job'; r: Awaited<ReturnType<typeof submitJob>> } | { kind: 'server'; r: Awaited<ReturnType<typeof startServer>> }
  const go = async (): Promise<Out> => {
    const base = { space, turnId: h.turnId, command: input.command, shown, cwd }
    if (jobName) return { kind: 'job', r: await submitJob(ctx, { ...base, name: jobName }) }
    if (background) return { kind: 'server', r: await startServer(ctx, { ...base, name: input.log_name ?? 'background' }) }
    return { kind: 'exit', r: await runCommand(ctx, { space, cwd, command: input.command, shown, timeoutMs, signal: h.signal }) }
  }
  let w: Window & { value: Out }
  if (o.tracked) {
    w = await withChangeWindow(ctx, o.tracked, { userId: h.userId, turnId: h.turnId }, { command: input.command.slice(0, 500) }, go)
    markSeen(ctx, o.tracked.id, h.userId)
  } else w = { ...NO_WINDOW, value: await go() }
  notes.push(...await o.jobNotes())
  const out = w.value
  const result = !out.r.ok ? { error: out.r.message.slice(0, 300) }
    : out.kind === 'exit' && out.r.ok ? { code: out.r.value.code, signal: out.r.value.signal, ms: out.r.value.ms }
    : out.kind === 'job' && out.r.ok ? { state: out.r.state, position: out.r.position }
    : { state: 'running' }
  audit(ctx.db, { actor: h.userId, action: 'dev_env.command', target: space.projectId, detail: {
    turnId: h.turnId, chatId: space.chatId, command: h.redact(input.command.slice(0, 2000)), cwd, folder: o.tracked ? 'project' : 'work', background: background || !!jobName, ...(jobName ? { job: jobName } : {}), runner: 'srt',
    result, changed: w.changes.length, background_changes: w.background.length, conflicts: w.conflicts,
  } })
  if (!out.r.ok) return { ...text(h.redact([...notes, `Error: the command could not run (${out.r.message.slice(0, 300)}).`].join('\n')), true), summary: `${what} -> ${out.r.message.slice(0, 200)}` }
  const empty = { ev: 'exit' as const, code: 0, signal: '', stdout: '', stderr: '', truncated: false, ms: Date.now() - started }
  if (out.kind === 'job' && out.r.ok) {
    const head = out.r.state === 'running'
      ? `Started as job ${jobName} (log: $TRINA_LOGS/${jobName}.log). Do not wait for it: when it ends the person gets a notice, and your next box_shell call in this chat gives you the result.`
      : `Queued as job ${jobName}: other jobs of the team run now, so it waits (position ${out.r.position}) and starts by itself. Do not wait for it: when it ends the person gets a notice, and your next box_shell call in this chat gives you the result.`
    return answer(h, { notes, head, started, exit: empty, w, background: true, what })
  }
  if (out.kind === 'server') return answer(h, { notes, head: `Started in the background (log: $TRINA_LOGS/${input.log_name ?? 'background'}.log). A later command cannot reach it; test it in one command with curl.`, started, exit: empty, w, background: true, what })
  if (out.kind !== 'exit' || !out.r.ok) throw new Error('unreachable')
  const e = out.r.value
  const head = e.signal === 'timeout' ? `Stopped: the time limit (${timeoutMs / 1000} s) was reached.`
    : e.signal === 'oom' ? 'Stopped: the command ran out of memory (the team limit).'
    : e.signal === 'stopped' ? 'Stopped.'
    : `Exit code ${e.code}.`
  return answer(h, { notes, head, started, exit: e, w, background: false, what })
}

/** One box_shell call on the srt runner. */
async function srtCall(h: BoxShellHost, data: BoxShellInput, what: string, firstCall: boolean) {
  const { ctx, project } = h
  // never trust the start of the turn alone: the admin may have turned it off, the person may be out of scope now
  if (!mayUseDevEnv(ctx.db, ctx.files, h.userId)) return { ...text('The dev environment is off for you now. Do not try again.', true), summary: `${what} -> off` }
  const space = spaceOf(ctx, { userId: h.userId, chatId: h.chatId ?? null, project: project ? { id: project.id, folderPath: project.folderPath } : null })
  if (!space) return { ...text('Error: this chat has no folder for commands. Do not try again.', true), summary: `${what} -> no folder` }
  const tracked = project && space.projectId === project.id && space.root === path.join(ctx.files.fx.root, project.folderPath) ? { id: project.id, folderPath: project.folderPath } : null
  const cwd = boxCwd(data.cwd)
  if (cwd === null) return { ...text('Invalid input: cwd must be a folder inside the folder of this chat (the project folder, or the work folder).', true), summary: `${what} -> bad cwd` }
  const background = !!data.background || !!data.job
  /** the jobs of this chat that ended and the AI does not know of yet, in every answer that goes back to it */
  const jobNotes = async () => {
    await pollSrt(ctx, { userId: h.userId }).catch(() => {})
    return runResultsForAI(ctx, h.userId, h.chatId ?? null).map((n) => h.redact(n))
  }
  try { assertStorageRoomForAI(0) } catch (e) {
    if (!(e instanceof ToolError)) throw e
    audit(ctx.db, { actor: h.userId, action: 'dev_env.command', target: space.projectId, detail: { turnId: h.turnId, chatId: space.chatId, command: h.redact(data.command.slice(0, 2000)), cwd, background, runner: 'srt', result: { error: 'storage_full' } } })
    return { ...text([...await jobNotes(), `Error: ${e.message}. No command runs until then. Delete files with the file tools, or ask the person to do it. Do not try again before that.`].join('\n'), true), summary: `${what} -> storage full` }
  }
  const jobName = data.job ? (data.log_name ?? newJobName()) : null
  // the log is per person: a job or dev server with the same name would write over it
  const logInUse = background ? (jobName ?? data.log_name ?? 'background') : null
  if (logInUse) {
    await pollSrt(ctx, { userId: h.userId }).catch(() => {})
    if (runNameInUse(ctx.db, h.userId, logInUse)) return { ...text(`Error: a job or dev server named ${logInUse} still runs for this person. Use another log_name, or wait for it to end.`, true), summary: `${what} -> job name in use` }
  }
  const notes: string[] = []
  if (tracked) {
    const foreign = changesByOthers(ctx, tracked, h.userId)
    if (usesCredentials(data.command) && foreign.total > 0) {
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
    if (firstCall) {
      const others = othersInProject(ctx, tracked.id, h.userId)
      if (others.length) notes.push('Other people\'s jobs and dev servers in this project (they keep running):\n' + others.slice(0, 20).map((r) => `  ${r.kind} ${r.name}${r.position ? ` (waiting, position ${r.position})` : ''}, by ${r.by}`).join('\n'))
    }
  }
  return srtShell(h, data, { space, tracked, cwd, what, jobName, notes, jobNotes })
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }] as McpContent[], ...(isError ? { isError: true } : {}) })

export function boxShellTool(h: BoxShellHost) {
  let firstCall = true
  return {
    name: BOX_SHELL_TOOL,
    description: devEnvRunner() === 'srt' ? SRT_SHELL_DESCRIPTION : BOX_SHELL_DESCRIPTION,
    inputSchema: (() => { const j = z.toJSONSchema(BoxShellInput, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j })(),
    async call(args: unknown): Promise<{ content: McpContent[]; isError?: boolean; summary?: string }> {
      const a = BoxShellInput.safeParse(args)
      if (!a.success) return { ...text('Invalid input: ' + a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), true), summary: 'box_shell -> invalid input' }
      const what = h.redact(`box_shell ${a.data.command.slice(0, 200)}`)
      if (devEnvRunner() === 'srt') { const first = firstCall; firstCall = false; return srtCall(h, a.data, what, first) }
      const { ctx } = h
      const project = h.project
      // the box runner is offered in project chats only (chat/turn.ts)
      if (!project) return { ...text('The dev environment is off for this chat. Do not try again.', true), summary: `${what} -> off` }
      // never trust the start of the turn alone: the admin may have turned it off, the folder rules may have changed
      if (!mayUseBox(ctx.db, ctx.files, project, h.userId)) return { ...text('The dev environment is off for this project or for you now. Do not try again.', true), summary: `${what} -> off` }
      // a turn that began before the project got its folder, or a project turned on before turn-on gave it one
      if (project.folderPath === '') return { ...text('Error: this project has no folder of its own, so it has no box. An admin must open Dev environment on the project page and save it (this creates the folder), then start a new message. Do not try again.', true), summary: `${what} -> no project folder` }
      const cwd = boxCwd(a.data.cwd)
      if (cwd === null) return { ...text('Invalid input: cwd must be a folder inside the project folder.', true), summary: `${what} -> bad cwd` }
      const client = boxd()
      if (!client) return { ...text('Error: the dev environment helper is not set up on this server.', true), summary: `${what} -> no boxd` }
      const background = !!a.data.background || !!a.data.job
      /** the jobs that ended and the AI does not know of yet, in every answer that goes back to it */
      const jobNotes = async () => {
        await pollJobs(ctx, project.id).catch(() => {})
        return jobResultsForAI(ctx, project.id).map((n) => h.redact(n))
      }
      // the rule of the AI's writes: a command can write as much as it likes, so no size can be asked for first
      try { assertStorageRoomForAI(0) } catch (e) {
        if (!(e instanceof ToolError)) throw e
        audit(ctx.db, { actor: h.userId, action: 'dev_env.command', target: project.id, detail: { turnId: h.turnId, command: h.redact(a.data.command.slice(0, 2000)), cwd, background, result: { error: 'storage_full' } } })
        return { ...text([...await jobNotes(), `Error: ${e.message}. No box command runs until then. Delete files with the file tools, or ask the person to do it. Do not try again before that.`].join('\n'), true), summary: `${what} -> storage full` }
      }
      const jobName = a.data.job ? (a.data.log_name ?? newJobName()) : null
      // a background command writes over the script and the log of a job with its name, so this holds for both
      const logInUse = background ? (jobName ?? a.data.log_name ?? 'background') : null
      if (logInUse) {
        await pollJobs(ctx, project.id).catch(() => {})
        if (jobRuns(ctx.db, project.id, logInUse)) return { ...text(`Error: a job named ${logInUse} still runs in this box. Use another log_name, or wait for it to end.`, true), summary: `${what} -> job name in use` }
      }

      const notes: string[] = []
      const foreign = changesByOthers(ctx, project, h.userId)
      if (usesCredentials(a.data.command) && foreign.total > 0) {
        const answer = await h.confirm(
          `This command can use a login: ${a.data.command.slice(0, 200)}\nOther people changed files in the project since your last command. Check the changes before you run it.`,
          [{ label: 'Run it', value: 'run' }, { label: 'Do not run', value: 'no' }],
          foreign.items.slice(0, 20).map((c) => `${c.by.name}${c.background ? ' (box process)' : ''}: ${c.action} ${c.path}`),
        )
        if (answer !== 'run') return { ...text('The person did not allow this command after seeing the changes by other people. Do not run it again in this answer.', true), summary: `${what} -> not allowed (changes by others)` }
        markSeen(ctx, project.id, h.userId, foreign.lastId)
      } else if (firstCall && foreign.total > 0) {
        notes.push(`Changed by other people since this person's last command:\n${foreignLines(foreign)}`)
      }

      const s = devEnvSetting(ctx.db, project.id)
      const denyAddrs = (process.env.MYCEL_DEV_ENV_DENY_ADDRS ?? '').split(',').map((x) => x.trim()).filter(Boolean)
      const up = await client.ensure({ box: project.id, folder: project.folderPath, network: s.network, limits: s.limits, denyAddrs })
      if (!up.ok) return { ...text([...await jobNotes(), `Error: the box could not start (${up.message.slice(0, 300)}).`].join('\n'), true), summary: `${what} -> box start failed: ${up.message.slice(0, 200)}` }
      if (firstCall) {
        const ps = await client.ps(project.id)
        if (ps.ok && ps.value.processes.length) notes.push('Processes still running in the box (earlier commands, maybe by other people):\n' + ps.value.processes.slice(0, 20).map((p) => `  pid ${p.pid}, ${p.seconds} s: ${p.command.slice(0, 160)}`).join('\n'))
      }
      firstCall = false

      const timeoutMs = (a.data.timeout_sec ?? 120) * 1000
      const started = Date.now()
      const logName = jobName ?? a.data.log_name
      const execReq = { box: project.id, cwd, command: a.data.command, timeoutMs, background, ...(jobName ? { job: true } : {}), actor: h.userId, ...(logName ? { logName } : {}) }
      const w = await withChangeWindow(ctx, project, { userId: h.userId, turnId: h.turnId }, { command: a.data.command.slice(0, 500) }, async () => {
        let r = await client.exec(execReq, h.signal)
        // the box stopped since ensure (an earlier command ended its main process, the idle stop): the command did
        // not run, so start the box again and run it once more
        if (!r.ok && r.message.startsWith('box_stopped')) {
          const again = await client.ensure({ box: project.id, folder: project.folderPath, network: s.network, limits: s.limits, denyAddrs })
          if (again.ok) {
            notes.push(`The box had stopped and started again, so processes that ran in it ended (${r.message.slice('box_stopped: '.length, 200)}).`)
            r = await client.exec(execReq, h.signal)
          }
        }
        return r
      })
      markSeen(ctx, project.id, h.userId)
      const r = w.value
      if (jobName && r.ok && r.value.job) startJob(ctx, { projectId: project.id, name: jobName, userId: h.userId, chatId: h.chatId, turnId: h.turnId, command: h.redact(a.data.command) })
      notes.push(...await jobNotes())
      let destinations: string[] = []
      if (s.network === 'open' && client.netlog) {
        const n = await client.netlog(project.id).catch(() => null)
        if (n?.ok) { const d = newDestinations(n.value.lines, netSeen.get(project.id)); destinations = d.dest; if (d.last) netSeen.set(project.id, d.last) }
      }
      audit(ctx.db, { actor: h.userId, action: 'dev_env.command', target: project.id, detail: {
        turnId: h.turnId, command: h.redact(a.data.command.slice(0, 2000)), cwd, background, ...(jobName ? { job: jobName } : {}),
        result: r.ok ? { code: r.value.code, signal: r.value.signal, ms: r.value.ms } : { error: r.message.slice(0, 300) },
        changed: w.changes.length, background_changes: w.background.length, conflicts: w.conflicts, destinations,
      } })
      if (!r.ok) return { ...text(h.redact([...notes, `Error: the command could not run (${r.message.slice(0, 300)}).`].join('\n')), true), summary: `${what} -> ${r.message.slice(0, 200)}` }
      const e = r.value
      const head = e.signal === 'timeout' ? `Stopped: the time limit (${timeoutMs / 1000} s) was reached.`
        : e.signal === 'oom' ? 'Stopped: the box ran out of memory.'
        : e.signal === 'stopped' ? 'Stopped.'
        : e.signal === 'box_stopped' ? `Stopped: ${e.reason ?? 'the box stopped'}.`
        : background && e.code !== 0 ? `The command did not start (exit code ${e.code}).`
        : jobName && e.job ? `Started as job ${jobName} (log: /cache/logs/${jobName}.log). Do not wait for it: when it ends the person gets a notice, and your next box_shell call in this project gives you the result.`
        : jobName ? `Started in the background (log: /cache/logs/${jobName}.log), but this server does not track jobs: there is no notice and no exit code. Read the log for progress.`
        : background ? `Started in the background (log: /cache/logs/${a.data.log_name ?? 'background'}.log).`
        : `Exit code ${e.code}.`
      return answer(h, { notes, head, started, exit: e, w, background, what })
    },
  }
}
