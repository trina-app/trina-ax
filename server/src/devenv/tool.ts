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
import { usesCredentials } from '@mycel/shared'
import type { AppContext } from '../context'
import type { McpContent } from '../turns'
import { audit } from '../admin/audit'
import { ToolError } from '../policy/errors'
import { assertStorageRoomForAI } from '../system/storage'
import { boxd } from './boxd'
import { jobResultsForAI, jobRuns, newJobName, pollJobs, startJob } from './jobs'
import { devEnvSetting, mayUseBox, type ProjectRef } from './setting'
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
  background: z.boolean().optional().describe('start a long-running process (a dev server, a watcher) and return at once; its output goes to /cache/logs/<log_name>.log in the box'),
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

/** commands that would use a person's login (hole 2: the person confirms after seeing who changed what); the PC runner uses the same list */
export { CREDENTIAL_COMMAND, usesCredentials } from '@mycel/shared'

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
  project: ProjectRef & { name: string }
  userId: string
  turnId: string
  /** the chat of the turn: the link in a job's notice */
  chatId?: string
  signal: AbortSignal
  /** a server card the person answers (chat/tools.ts turnPerson): the value of the chosen option, or null */
  confirm(question: string, options: { label: string; value: string }[], details: string[]): Promise<string | null>
  redact(s: string): string
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }] as McpContent[], ...(isError ? { isError: true } : {}) })

export function boxShellTool(h: BoxShellHost) {
  let firstCall = true
  return {
    name: BOX_SHELL_TOOL,
    description: BOX_SHELL_DESCRIPTION,
    inputSchema: (() => { const j = z.toJSONSchema(BoxShellInput, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j })(),
    async call(args: unknown): Promise<{ content: McpContent[]; isError?: boolean; summary?: string }> {
      const a = BoxShellInput.safeParse(args)
      if (!a.success) return { ...text('Invalid input: ' + a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), true), summary: 'box_shell -> invalid input' }
      const { ctx, project } = h
      const what = h.redact(`box_shell ${a.data.command.slice(0, 200)}`)
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
      const parts = [...notes, `${head} (${((Date.now() - started) / 1000).toFixed(1)} s)`]
      parts.push(e.stdout ? `--- stdout ---\n${clip(e.stdout)}` : '--- stdout: empty ---')
      if (e.stderr) parts.push(`--- stderr ---\n${clip(e.stderr)}`)
      if (e.truncated) parts.push('(output cut)')
      if (w.changes.length) parts.push(`Files changed by this command (${w.changes.length}):\n${changeLines(w.changes)}`)
      if (w.background.length) parts.push(`Files changed in the background since the last command (${w.background.length}):\n${changeLines(w.background)}`)
      if (w.conflicts.length) parts.push(`Someone saved some of these files while the command ran; their version is kept as: ${w.conflicts.join(', ')}`)
      const failed = e.code !== 0 || (e.signal !== '' && !background)
      return { ...text(h.redact(parts.join('\n')), failed), summary: `${what} -> ${e.signal || 'exit ' + e.code} ${e.ms} ms, ${w.changes.length} files` }
    },
  }
}
