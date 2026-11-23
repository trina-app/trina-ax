// The instance sandbox a Linux host's pool.command must have (demo-gate/linux, README "Each instance in its own bwrap").
// install.sh keeps an existing gate.json, so a new gate with an older command would run without these parts and look
// healthy: it migrates the command with this file and refuses to go on when the result is still not right.
export const LINUX_BUN = '/opt/trina-demo/bin/bun'
export const LINUX_TDSCOPE = '/opt/trina-demo/bin/tdscope'
const BWRAP = '/usr/bin/bwrap'

/** what is missing from the command; [] = it has the whole sandbox */
export function linuxCommandProblems(c: readonly string[]): string[] {
  const p: string[] = []
  const bw = c.indexOf(BWRAP), end = bw < 0 ? -1 : c.indexOf('--', bw + 1), bun = c.indexOf(LINUX_BUN)
  if (bw < 0 || end < 0) return [`no ${BWRAP} ... -- in pool.command`]
  const flags = c.slice(bw + 1, end)
  for (const f of ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts']) if (!flags.includes(f)) p.push(`no ${f}`)
  const h = flags.indexOf('--hostname')
  if (h < 0 || flags[h + 1] !== 'demo') p.push('no --hostname demo')
  if (flags.includes('--new-session')) p.push('--new-session (the gate needs the process group)')
  if (bun < end) p.push(`no ${LINUX_BUN} after the bwrap options`)
  else if (c[bun - 1] !== LINUX_TDSCOPE) p.push(`${LINUX_TDSCOPE} is not directly before ${LINUX_BUN}`)
  return p
}

/** the command with --unshare-uts --hostname demo and tdscope added where they are missing; anything else stays */
export function migrateLinuxCommand(command: readonly string[]): string[] {
  const c = [...command]
  const bw = c.indexOf(BWRAP), end = bw < 0 ? -1 : c.indexOf('--', bw + 1)
  if (end < 0) return c
  const flags = c.slice(bw + 1, end), add: string[] = []
  if (!flags.includes('--unshare-uts')) add.push('--unshare-uts')
  if (!flags.includes('--hostname')) add.push('--hostname', 'demo')
  if (add.length) { const ipc = c.indexOf('--unshare-ipc', bw); c.splice(ipc >= 0 && ipc < end ? ipc + 1 : bw + 1, 0, ...add) }
  const bun = c.indexOf(LINUX_BUN)
  if (bun > 0 && c[bun - 1] !== LINUX_TDSCOPE && !c.includes(LINUX_TDSCOPE)) c.splice(bun, 0, LINUX_TDSCOPE)
  return c
}
