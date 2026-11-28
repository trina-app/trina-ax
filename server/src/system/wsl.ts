// Whether this Linux server runs inside WSL on a Windows PC (scripts/windows/install-wsl-server.ps1,
// docs/INSTALL-WINDOWS.md). There the office network cannot reach the server (WSL's default NAT): only the PC itself
// (127.0.0.1) and the https address (the relay or a tunnel) do, so advice that says "the office network" is wrong
// there (WSL QA 2026-11-28). The kernel says so in its release string ("…-microsoft-standard-WSL2"), also for a
// systemd service that has no WSL_* variables.
import fs from 'node:fs'

let cached: boolean | null = null
let forTests: boolean | null = null

/** true inside WSL (Linux only; read once). */
export function runsOnWsl(platform: NodeJS.Platform = process.platform): boolean {
  if (forTests !== null) return forTests
  if (platform !== 'linux') return false
  if (cached === null) {
    let release = ''
    try { release = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8') } catch { /* not readable: not WSL as far as we know */ }
    cached = /microsoft|wsl/i.test(release)
  }
  return cached
}

/** Tests: pretend to run inside WSL or not (null: read the kernel again). */
export function setWslForTests(v: boolean | null): void { forTests = v; cached = null }
