// The run_code tool of a turn (docs/DECISIONS.md "Code sandbox", D1). Offered only when the team's code sandbox names
// the person and the launcher can run code (admin/code-sandbox.ts); the turn's LaunchRequest then carries codeSandbox,
// and each call asks the launcher to run the program for this turn (launcher op "code"). The server checks the scope
// again on every call: an admin who turns it off stops the next call, not only the next turn.
import { z } from 'zod'
import { codeSandboxFor } from '../admin/code-sandbox'
import { launcherCode } from '../native'
import type { McpContent } from '../turns'
import type { TurnFiles } from '../files/service'

export const RUN_CODE_TOOL = 'run_code'

export const RunCodeInput = z.object({
  lang: z.enum(['bash', 'python']).describe('bash (a bash script) or python (Python 3)'),
  code: z.string().min(1).max(256 * 1024).describe('the whole program'),
  timeout_sec: z.number().int().min(1).max(600).optional().describe('time limit in seconds (default 60, at most 600)'),
})

/** what the AI is told (tool description); runtimes = the launcher's list of programs found in /usr/bin */
export function runCodeDescription(runtimes?: Record<string, boolean>): string {
  const have = Object.entries(runtimes ?? {}).filter(([, v]) => v).map(([k]) => k)
  return 'Run a bash script or a Python 3 program in a separate sandbox for this chat. The sandbox has NO network (no internet, no package downloads) '
    + 'and no team folders: only its working folder /work (kept for this chat between runs) and /tmp (empty each run). '
    + 'To use a team file, read it with the file tools and put its text into the program or write it into /work first; '
    + 'to keep a result, print it and save it with the file tools (write, make_file). '
    + `Programs available: ${have.length ? have.join(', ') : 'bash, python3'} (the server's own; you cannot install more). `
    + 'Each run has a time limit (default 60 s), a memory and process limit, and only the first 64 KiB of stdout and of stderr come back.'
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }] as McpContent[], ...(isError ? { isError: true } : {}) })

/** the result text the AI gets */
export function codeResultText(e: { code: number; signal: string; stdout: string; stderr: string; truncated: boolean; ms: number }): string {
  const head = e.signal === 'timeout' ? 'Stopped: the time limit was reached.'
    : e.signal === 'oom' ? 'Stopped: the program used more memory than the limit.'
    : e.signal === 'disk_limit' ? 'Stopped: the chat folder passed its disk limit. The answer ends here and the work folder is emptied.'
    : e.signal === 'stopped' ? 'Stopped.'
    : `Exit code ${e.code}.`
  const parts = [`${head} (${(e.ms / 1000).toFixed(1)} s)`]
  parts.push(e.stdout ? `--- stdout ---\n${e.stdout}` : '--- stdout: empty ---')
  if (e.stderr) parts.push(`--- stderr ---\n${e.stderr}`)
  if (e.truncated) parts.push('(output cut: only the first 64 KiB of stdout and of stderr are kept)')
  return parts.join('\n')
}

export interface RunCodeHost {
  db: Parameters<typeof codeSandboxFor>[0]['db']
  turnId: string
  userId: string
  signal: AbortSignal
  /** the launcher socket of the turn's core */
  sock: () => Promise<string | null>
}

export function runCodeTool(h: RunCodeHost, runtimes?: Record<string, boolean>) {
  return {
    name: RUN_CODE_TOOL,
    description: runCodeDescription(runtimes),
    inputSchema: (() => { const j = z.toJSONSchema(RunCodeInput, { target: 'draft-7' }) as Record<string, unknown>; delete j.$schema; return j })(),
    async call(args: unknown, _files: TurnFiles): Promise<{ content: McpContent[]; isError?: boolean; summary?: string }> {
      const a = RunCodeInput.safeParse(args)
      if (!a.success) return { ...text('Invalid input: ' + a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), true), summary: 'run_code -> invalid input' }
      const what = `run_code ${a.data.lang} (${Buffer.byteLength(a.data.code)} bytes)`
      // never trust the start of the turn alone: the admin may have turned it off since
      if (!codeSandboxFor({ db: h.db }, h.userId)) return { ...text('The code sandbox is off for this person now. Do not try again.', true), summary: `${what} -> off` }
      const sock = await h.sock().catch(() => null)
      if (!sock) return { ...text('Error: the code sandbox cannot be reached.', true), summary: `${what} -> no launcher` }
      const r = await launcherCode(sock, { turnId: h.turnId, lang: a.data.lang, code: a.data.code, timeoutMs: (a.data.timeout_sec ?? 60) * 1000 }, h.signal)
      if (!r.ok) {
        const busy = r.message.startsWith('code_busy')
        return { ...text(busy ? 'Error: another program of this answer is still running. Run one program at a time.' : `Error: the program could not run (${r.message.slice(0, 300)}).`, true), summary: `${what} -> ${r.message.slice(0, 200)}` }
      }
      const e = r.exit
      const failed = e.code !== 0 || e.signal !== ''
      return { ...text(codeResultText(e), failed), summary: `${what} -> ${e.signal || 'exit ' + e.code} ${e.ms} ms` }
    },
  }
}
