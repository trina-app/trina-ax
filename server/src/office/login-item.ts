// How an office Mac names the background job, and whether the owner switched it off (QA TC-3451,
// docs/decisions/20261116-office-login-item-name.md).
//
// macOS 13+ lists every LaunchAgent under System Settings > General > Login Items & Extensions > "Allow in the
// Background" and shows a "Background Items Added" notice for it. For a plist in ~/Library/LaunchAgents the name is
// the organization of the program's signing certificate, or the program's file name when it has none (Apple:
// "Updating helper executables from earlier versions of macOS"). The agents ran app/bin/bun, signed by Bun's
// developer, so the Mac showed that person's name. They now run <home>/bin/<product name>: a few lines of shell that
// start app/bin/bun with the same arguments. It has no signature, so the Mac shows its file name: the product name.
// It lives outside app/ so a plist that names it keeps working when an update or a rollback swaps app/.
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'

/** the file the agents run: <home>/bin/<product name> */
export const agentProgram = (home: string, name: string = PRODUCT.displayName) => path.join(path.resolve(home), 'bin', name)

/** exec, so launchd's process is bun itself (same pid, signals, output and exit code as before) */
export const AGENT_PROGRAM_TEXT = '#!/bin/sh\n# Starts the team server\'s runtime (app/bin/bun). This file\'s name is what macOS shows under Login Items.\nexec "$(dirname "$0")/../app/bin/bun" "$@"\n'

/** a product name that is one plain file name (it becomes one; never a path) */
const fileNameOk = (name: string) => /^[^/\0]{1,100}$/.test(name) && !name.startsWith('.') && name.trim() === name

/** Write <home>/bin/<product name> when this installation has app/bin/bun; returns its path, or null (a checkout
 * without the bundle: the agent then runs bun itself, as before). */
export function ensureAgentProgram(home: string, name: string = PRODUCT.displayName): string | null {
  if (!fileNameOk(name) || !fs.existsSync(path.join(path.resolve(home), 'app', 'bin', 'bun'))) return null
  const file = agentProgram(home, name)
  // the name is cosmetic: when the file cannot be written (something else is at <home>/bin), the agents run bun itself
  try {
    let have = ''
    try { have = fs.readFileSync(file, 'utf8') } catch {}
    if (have !== AGENT_PROGRAM_TEXT) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, AGENT_PROGRAM_TEXT, { mode: 0o755 })
      fs.renameSync(tmp, file)
    }
    fs.chmodSync(file, 0o755)
    return file
  } catch { return null }
}

/** What a plist's ProgramArguments start with: the file above when it is there, else app/bin/bun. */
export function agentCommand(home: string, name: string = PRODUCT.displayName): string {
  const file = agentProgram(home, name)
  try { if (fileNameOk(name) && fs.statSync(file).isFile()) return file } catch {}
  return path.join(path.resolve(home), 'app', 'bin', 'bun')
}

export type LoginItemState = 'on' | 'off' | 'unknown'

type Run = (cmd: string[]) => { code: number | null; out: string }
const osascript: Run = (cmd) => {
  const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'ignore', timeout: 3000 })
  return { code: p.exitCode, out: p.stdout.toString() }
}

/** Is the background item of this plist switched off in System Settings? Asks macOS as this user
 * (SMAppService.statusForLegacyPlist: 1 = enabled, 2 = needs the user's approval, i.e. switched off). Anything else
 * (no such plist, no answer, not a Mac, macOS 12) is 'unknown': the caller then claims nothing. */
export function loginItemState(plistFile: string, run: Run = osascript, platform: string = process.platform): LoginItemState {
  if (platform !== 'darwin') return 'unknown'
  const js = 'function run(argv) { ObjC.import("ServiceManagement"); return String($.SMAppService.statusForLegacyURL($.NSURL.fileURLWithPath(argv[0]))) }'
  try {
    const r = run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', js, plistFile])
    if (r.code !== 0) return 'unknown'
    const v = r.out.trim()
    return v === '1' ? 'on' : v === '2' ? 'off' : 'unknown'
  } catch { return 'unknown' }
}

/** What `teamax` says when the owner switched the job off (plain words; Korean, then English like the lines around it).
 * An installation whose plist still runs bun itself shows under bun's name or its signer's, hence the hint. */
export function loginItemOffText(what: 'server' | 'updates', teamax: string, name: string = PRODUCT.displayName): string {
  const ko = what === 'server'
    ? `이 맥의 설정에서 ${name} 항목이 꺼져 있어서 팀 서버가 시작되지 않아요.`
    : `이 맥의 설정에서 ${name} 항목이 꺼져 있어서 자동 업데이트가 멈췄어요.`
  const en = what === 'server'
    ? `${name} is switched off in this Mac's settings, so the team server does not start.`
    : `${name} is switched off in this Mac's settings, so automatic updates are stopped.`
  return [
    `  ${ko}`,
    `  켜는 방법: 시스템 설정 > 일반 > 로그인 항목 및 확장 프로그램 > "백그라운드에서 허용"에서 ${name} 항목을 모두 켠 다음 (예전 설치에서는 "Jarred Sumner" 또는 bun 으로 보여요): ${teamax} start`,
    `  ${en}`,
    `  To turn it on: System Settings > General > Login Items & Extensions > "Allow in the Background", switch on every ${name} entry (an older installation shows it as "Jarred Sumner" or bun), then run: ${teamax} start`,
  ].join('\n')
}
