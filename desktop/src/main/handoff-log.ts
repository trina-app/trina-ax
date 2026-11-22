// The sign-in hand-off's log (open-url, a second start, the team matched, each claim try), in a file a person can
// find and send: <user data>/logs/handoff.log (macOS: ~/Library/Application Support/Team AX/logs/handoff.log). Also
// on stdout (`--enable-logging`). Addresses, kinds and answers only, never a link's code. Kept small: at 256 KB the
// file moves to handoff.log.1 (the one before is dropped).
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

let file: string | null = null
const MAX_BYTES = 256 * 1024

/** Where the log goes: set once the user data folder is known (main.ts). */
export function setHandoffLogDir(userData: string) {
  file = join(userData, 'logs', 'handoff.log')
  try { mkdirSync(join(userData, 'logs'), { recursive: true, mode: 0o700 }) } catch { file = null }
}

export function handoffLog(line: string) {
  console.info('[desktop]', line)
  if (!file) return
  try {
    try { if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1') } catch { /* no file yet */ }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  } catch { /* a full disk or a read-only folder: stdout still has it */ }
}
