// Input schemas of the PC runner tools (docs/DECISIONS.md "PC runner"). The shapes follow the file tools of
// shared/src/tools.ts, so the AI uses them the same way; the paths are relative to the project's workspace folder on the
// person's computer. Owner: E (desktop).
//
//   server (B):  expose PC_TOOLS[name].description + pcToolJsonSchema(name) to the engine, forward the call unchanged
//                as pc.call { tool, args }.
//   desktop (E): parsePcToolInput(tool, args) before anything runs.
import { z } from 'zod'
import { PcToolName } from './api/pc'

const workPath = z.string().min(1).max(4096).describe('Path relative to the workspace folder, e.g. "src/app.ts". No absolute paths, no "..".')

export const PC_SHELL_TIMEOUT_DEFAULT_SEC = 120
export const PC_SHELL_TIMEOUT_MAX_SEC = 1800
/** Each of stdout and stderr: what the AI gets of a command. */
export const PC_OUTPUT_LIMIT = 32 << 10
/** What the AI gets of a file or a search at once. */
export const PC_TEXT_LIMIT = 256 << 10
/** What one call can carry to the computer: it travels in one WebSocket frame, and a socket with more than 4 MiB unsent is
 * closed as too slow (WS_MAX_BUFFERED_BYTES). */
export const PC_WRITE_LIMIT = 2 << 20

export const PcReadInput = z.strictObject({
  file_path: workPath,
  offset: z.number().int().min(1).optional().describe('1-based line to start from'),
  limit: z.number().int().min(1).max(20000).optional().describe('Number of lines (default 2000)'),
})
export const PcWriteInput = z.strictObject({ file_path: workPath, content: z.string().max(PC_WRITE_LIMIT) })
export const PcEditInput = z.strictObject({
  file_path: workPath,
  old_string: z.string().min(1).max(PC_WRITE_LIMIT),
  new_string: z.string().max(PC_WRITE_LIMIT),
  replace_all: z.boolean().optional(),
})
export const PcSearchInput = z.strictObject({
  pattern: z.string().min(1).max(10000).optional().describe('Extended regular expression to find in file contents. Without it, the files whose names match glob are listed.'),
  glob: z.string().min(1).max(1000).optional().describe('Only files whose name matches, e.g. "*.ts"'),
  path: workPath.optional().describe('File or folder to search (default: the whole workspace)'),
  '-i': z.boolean().optional().describe('Case-insensitive'),
  head_limit: z.number().int().min(1).max(5000).optional().describe('Max output lines (default 200)'),
}).refine((v) => v.pattern !== undefined || v.glob !== undefined, { message: 'give pattern or glob' })
export const PcShellInput = z.strictObject({
  command: z.string().min(1).max(64 * 1024).describe('The shell command (bash), for example "npm test" or "git status"'),
  cwd: z.string().max(1024).optional().describe('Folder relative to the workspace folder (default: the workspace folder)'),
  timeout_sec: z.number().int().min(1).max(PC_SHELL_TIMEOUT_MAX_SEC).optional().describe(`Time limit in seconds (default ${PC_SHELL_TIMEOUT_DEFAULT_SEC}, at most ${PC_SHELL_TIMEOUT_MAX_SEC})`),
  background: z.boolean().optional().describe('Start a long-running process (a dev server, a watcher) and return at once. It ends when the app closes; its output goes to $HOME/logs/<log_name>.log'),
  log_name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional().describe('Name of the log file of a background command'),
  preview_port: z.number().int().min(1024).max(65535).optional().describe('The port a background dev server listens on: the person gets a button that opens it in their own browser'),
  secret_files: z.boolean().optional().describe('The command needs the secret files of the workspace (.env, key files). The person is asked every time, and what the command prints reaches the server.'),
})
export type PcReadInput = z.infer<typeof PcReadInput>
export type PcWriteInput = z.infer<typeof PcWriteInput>
export type PcEditInput = z.infer<typeof PcEditInput>
export type PcSearchInput = z.infer<typeof PcSearchInput>
export type PcShellInput = z.infer<typeof PcShellInput>

export const PC_TOOLS = {
  pc_read: { input: PcReadInput, description: 'Read a text file of the workspace on the person\'s computer. Returns numbered lines (cat -n style); use offset and limit for long files.' },
  pc_write: { input: PcWriteInput, description: 'Create a text file in the workspace on the person\'s computer, or overwrite one. Folders are created as needed. Not for anything under .git.' },
  pc_edit: { input: PcEditInput, description: 'Replace an exact string in a text file of the workspace on the person\'s computer. old_string must be unique unless replace_all is true. Read the file first.' },
  pc_search: { input: PcSearchInput, description: 'Search the workspace on the person\'s computer: pattern finds text in files (file:line:text), glob alone lists files by name. Skips .git, node_modules, build output and secret files.' },
  pc_shell: {
    input: PcShellInput,
    description: 'Run a shell command in the workspace on the person\'s computer (bash; git, node, npm and whatever else the person has installed). '
      + 'The person sees and approves it in the desktop app. A command reaches only the workspace folder: no other folder of the computer, no secret files of the workspace (.env, key files) unless secret_files is true. '
      + 'A command that uses a login (git push, git pull, git clone, npm publish, ssh, gh ...) or changes git settings (git init, git config, git remote) is asked for every time and gets the person\'s login for that one command. It must be alone in the call, with cwd for its folder and no option that names a program or settings: "git push origin main", not "cd x && git push". '
      + 'For a dev server use background=true with preview_port. It stops when the app closes. '
      + `Default time limit ${PC_SHELL_TIMEOUT_DEFAULT_SEC} s; only the first ${PC_OUTPUT_LIMIT >> 10} KiB of stdout and of stderr come back. Commands cannot ask for input.`,
  },
} as const

export type PcToolInput = {
  pc_read: PcReadInput
  pc_write: PcWriteInput
  pc_edit: PcEditInput
  pc_search: PcSearchInput
  pc_shell: PcShellInput
}
export type ParsedPcCall = { [T in PcToolName]: { tool: T; input: PcToolInput[T] } }[PcToolName]
export const PC_TOOL_NAMES: readonly PcToolName[] = PcToolName.options

/** Errors are short English sentences for the model (it reads them and retries). */
export function parsePcToolInput(tool: string, args: unknown): { ok: true; call: ParsedPcCall } | { ok: false; error: string } {
  const name = PcToolName.safeParse(tool)
  if (!name.success) return { ok: false, error: `Unknown PC tool "${tool}".` }
  const r = PC_TOOLS[name.data].input.safeParse(args ?? {})
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.length ? i.path.join('.') : 'input'}: ${i.message}`)
    return { ok: false, error: `Invalid input for ${name.data}: ${issues.join('; ')}` }
  }
  return { ok: true, call: { tool: name.data, input: r.data } as ParsedPcCall }
}

/** JSON Schema of a tool's input, for the engine's tool list (MCP inputSchema). */
export function pcToolJsonSchema(tool: PcToolName): Record<string, unknown> {
  const s = z.toJSONSchema(PC_TOOLS[tool].input, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
  delete s.$schema
  return s
}

/** Commands that would use a person's login: the person is asked before each one (dev environment hole 2, PC runner). */
export const CREDENTIAL_COMMAND = /(^|[\s;&|(])(git\s+(push|fetch|pull|clone|submodule|ls-remote)|npm\s+(publish|login|adduser|token)|yarn\s+(publish|npm\s+publish)|pnpm\s+publish|gh\s|ssh\s|scp\s|rsync\s.*:|docker\s+(login|push)|twine\s+upload|cargo\s+publish|aws\s|gcloud\s|az\s)/
export const usesCredentials = (cmd: string) => CREDENTIAL_COMMAND.test(cmd)

/** Commands that change what git runs by itself. The jail closes .git/config and .git/hooks to a plain command, so these
 * go the way of a login command: the person is asked each time. */
export const GIT_CONTROL_COMMAND = /(^|[\s;&|(])git\s+(init|config|remote|branch\s+(-u|--set-upstream))/
export const changesGitControl = (cmd: string) => GIT_CONTROL_COMMAND.test(cmd)

/** Shell that runs a second thing in one line. */
const COMPOUND = /[;&|\n`<>]|\$\(/

/** Arguments that make a login command run a program or read settings named on the line: `ssh -o ProxyCommand=./x`, `git
 * clone -c core.sshCommand=./x`, `git submodule foreach ./x`, `scp -S ./x`, `rsync -e ./x`. Not a complete list, and it
 * cannot be one: the person reading the card is the gate. It keeps the plain forms from looking like a push. */
const NAMES_A_PROGRAM = /(^|\s)(-[oFSec]|--config|--template|--exec|--upload-pack|--receive-pack|--rsh|--script-shell|--userconfig|foreach)(\s|=|$)|(^|\s)-[oFSe]\S/

/**
 * The commands of the login grant on the PC: such a command ALONE, at the start of the line. The lists above answer "could
 * this use a login", which is right for a warning and wrong for a grant: `python3 evil.py git push` matches them, and so
 * does `./evil.sh && git push`. A command that is anything more gets no login, and the jail closes what it reaches for.
 */
export function loginCommand(cmd: string): boolean {
  const c = cmd.trim()
  if (COMPOUND.test(c) || NAMES_A_PROGRAM.test(c)) return false
  return CREDENTIAL_COMMAND.exec(c)?.index === 0 || GIT_CONTROL_COMMAND.exec(c)?.index === 0
}

/** Names of secret files, as regular expression source that both JavaScript and the macOS sandbox read. */
export const SECRET_NAME_SOURCE = String.raw`\.env(\.[^/]*)?|\.netrc|\.pypirc|\.git-credentials|credentials\.json|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.[^/]*)?`
/** Not secrets: the templates of .env that projects keep in git, and what package managers install (cacert.pem, the
 * test keys of a package). */
export const NOT_SECRET_SOURCE = String.raw`\.env\.(example|sample|template|dist)$|(node_modules|site-packages|\.venv|venv|vendor)/`

// ignoring case, like the sandbox's regular expressions: .ENV is .env on a Mac's disk
const SECRET_NAME = new RegExp(`^(.*/)?(${SECRET_NAME_SOURCE})$`, 'i')
const NOT_SECRET = new RegExp(`^(.*/)?(${NOT_SECRET_SOURCE})`, 'i')
/** A secret file, by its path relative to the workspace: what it holds must not reach the server unasked. */
export const isSecretPath = (rel: string) => SECRET_NAME.test(rel) && !NOT_SECRET.test(rel)
