// The one instance command a Linux host may run (demo-gate/linux, README "Each instance in its own bwrap"). install.sh
// keeps an existing gate.json, so a new gate with an older or edited command would run without parts of the sandbox and
// look healthy. The check is therefore exact: the argv must equal this template, whose only variables are {dir} and
// {config}. A flag inside another option's value, a wider bind or a missing mount cannot pass.
export const LINUX_BUN = '/opt/trina-demo/bin/bun'
export const LINUX_TDSCOPE = '/opt/trina-demo/bin/tdscope'
export const LINUX_INSTANCES_DIR = '/srv/tdg/i'

const HEAD = ['/usr/bin/choom', '-n', '800', '--', '/usr/bin/bwrap', '--die-with-parent', '--unshare-pid', '--unshare-ipc'] as const
const MOUNTS = ['--ro-bind', '/', '/', '--tmpfs', '/srv/tdg', '--bind', '{dir}', '{dir}', '--tmpfs', '/run', '--tmpfs', '/tmp', '--tmpfs', '/dev/shm', '--dev', '/dev', '--proc', '/proc', '--'] as const
const SERVER = [LINUX_BUN, '/opt/trina-demo/app/server/src/main.ts', '--config', '{config}'] as const

/** the instance command */
export const LINUX_COMMAND: readonly string[] = [...HEAD, '--unshare-uts', '--hostname', 'demo', ...MOUNTS, LINUX_TDSCOPE, ...SERVER]
/** the one older command migrated to it: what the first Linux hosts' gate.json holds (no UTS namespace, no tdscope) */
export const LINUX_COMMAND_V1: readonly string[] = [...HEAD, ...MOUNTS, ...SERVER]

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** why this is not the instance command; [] = it is, exactly */
export function linuxCommandProblems(c: readonly string[]): string[] {
  if (same(c, LINUX_COMMAND)) return []
  const at = LINUX_COMMAND.findIndex((x, i) => c[i] !== x)
  if (at < 0) return [`${c.length - LINUX_COMMAND.length} argument(s) after the expected command`]
  return [`argument ${at} is ${JSON.stringify(c[at] ?? null)}, expected ${JSON.stringify(LINUX_COMMAND[at])}`]
}

/** the older command becomes the current one; any other command stays as it is (and linuxCommandProblems refuses it) */
export function migrateLinuxCommand(command: readonly string[]): string[] {
  return same(command, LINUX_COMMAND_V1) ? [...LINUX_COMMAND] : [...command]
}
