// Windows PC as a team server (WSL2), QA on a Windows 11 PC on 2026-11-27 (docs/INSTALL-WINDOWS.md):
// - install-linux.sh decides its Landlock warning from mycel-sandbox probe, not /sys/kernel/security/lsm (WSL2 does
//   not mount securityfs; Landlock ABI 7 worked and the old check warned that every turn would be refused)
// - scripts/windows/install-wsl-server.ps1: the rules it keeps (the Linux guide's download and checks unchanged, never
//   --allow-unsigned, -WhatIf, only the bootstrap packages, a file Windows PowerShell 5.1 reads), and the bash steps it
//   runs inside Debian. Its .wslconfig merge runs in pwsh where pwsh is installed (TRINA_PWSH or pwsh on PATH).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '../..')
const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8')
const INSTALLER = read('scripts/install-linux.sh')
const PS1 = read('scripts/windows/install-wsl-server.ps1')
const bash = (script: string, env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(['/bin/bash', '-c', script], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...env }, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const between = (s: string, a: string, b: string) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); return i >= 0 && j > i ? s.slice(i + a.length, j) : '' }

describe('install-linux.sh: Landlock from the sandbox helper\'s probe', () => {
  const part = between(INSTALLER, '# BEGIN landlock check\n', '# END landlock check')
  const run = (probe: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'landlock-'))
    const helper = path.join(d, 'mycel-sandbox')
    fs.writeFileSync(helper, `#!/bin/sh\n[ "$1" = probe ] || exit 9\n${probe}\n`, { mode: 0o755 })
    const r = bash(`WARNINGS=()\nwarn() { WARNINGS+=("$*"); echo "warning: $*" >&2; }\n${part}\nlandlock_check '${helper}'\necho "n=\${#WARNINGS[@]}"`)
    fs.rmSync(d, { recursive: true, force: true })
    return r
  }
  test('the check is the probe\'s landlockAbi, not the LSM list', () => {
    expect(part).not.toBe('')
    expect(INSTALLER).not.toContain('/sys/kernel/security/lsm 2>')
    expect(INSTALLER).not.toMatch(/grep -qw landlock/)
    expect(INSTALLER).toContain('if [ "$HOSTED" = 0 ]; then landlock_check "$BASE/root/mycel-sandbox"; fi')
    // after the root programs are in place (step 7), before the units (step 13)
    expect(INSTALLER.indexOf('landlock_check "$BASE/root/mycel-sandbox"')).toBeGreaterThan(INSTALLER.indexOf('for f in mycel-ctl mycel-bootstrap mycel-launcher mycel-sandbox'))
  })
  test('ABI 1 or more (WSL2: 7, with no securityfs): no warning', () => {
    for (const abi of [1, 6, 7]) {
      const r = run(`echo '{"kernel":"6.6.87.2-microsoft-standard-WSL2","landlockAbi":${abi},"seccomp":true}'`)
      expect(`${abi}: ${r.out.trim()} ${r.err}`).toBe(`${abi}: n=0 `)
    }
  })
  test('ABI 0, a probe that fails or prints something else: the warning, with what the probe said', () => {
    for (const [probe, abi] of [[`echo '{"landlockAbi":0,"seccomp":true}'`, '0'], ['exit 1', '0'], ['echo nonsense', '0']] as const) {
      const r = run(probe)
      expect(r.out.trim()).toBe('n=1')
      expect(r.err).toContain(`this kernel offers no Landlock (mycel-sandbox probe: landlockAbi ${abi})`)
    }
  })
})

describe('install-wsl-server.ps1', () => {
  test('Windows PowerShell 5.1 reads it as written: ASCII only, -WhatIf through ShouldProcess, every change behind it', () => {
    // (5.1 reads a file without a BOM in the PC's code page: one non-ASCII character can break the script on a Korean PC)
    expect([...PS1].every((c) => c.charCodeAt(0) < 128)).toBe(true)
    expect(PS1).toContain('#Requires -Version 5.1')
    expect(PS1).toContain('[CmdletBinding(SupportsShouldProcess = $true)]')
    // the commands that change this PC all sit under a Test-Change (ShouldProcess) in the same block
    const changes = ['Enable-WindowsOptionalFeature', 'Register-ScheduledTask', 'Unregister-ScheduledTask', 'Restart-Computer', 'powercfg.exe /change', 'Set-Acl', "'--install'", "'--update'", "'--shutdown'", "'--terminate'", "'--set-version'"]
    const lines = PS1.split('\n')
    for (const c of changes) {
      const at = lines.map((l, i) => (l.includes(c) ? i : -1)).filter((i) => i >= 0 && !lines[i]!.trimStart().startsWith('#'))
      expect(`${c}: ${at.length > 0}`).toBe(`${c}: true`)
      for (const i of at) {
        const before = lines.slice(Math.max(0, i - 12), i + 1).join('\n')
        expect(`${c} (line ${i + 1}): ${/Test-Change|function Initialize-DataDir|Read-YesNo -Question 'WSL must restart/.test(before)}`).toBe(`${c} (line ${i + 1}): true`)
      }
    }
  })
  test('the kit is downloaded and checked exactly as docs/INSTALL-LINUX.en.md says, and never unsigned', () => {
    const helper = between(PS1, "$HelperScript = @'\n", "\n'@")
    expect(helper).not.toBe('')
    expect(helper).not.toContain('allow-unsigned')
    expect(helper).not.toMatch(/--skip-verify|--insecure|curl [^\n]*-k\b/)
    const guide = read('docs/INSTALL-LINUX.en.md')
    const check = (s: string) => between(s, "python3 - \"$KIT\" <<'CHECK'\n", '\nCHECK')
    expect(check(helper)).not.toBe('')
    expect(check(helper)).toBe(check(guide))
    // the same steps in the same order: download, checksum, unpack, the kit's signature, the installer's check, install
    const steps = ['curl -fLO "$BASE_URL/$KIT"', 'curl -fLO "$BASE_URL/SHA256SUMS"', "python3 - \"$KIT\" <<'CHECK'", 'tar xzf "$KIT"', './app/$V/root/mycel-ctl verify-bundle "./app/$V"', './install-linux.sh check --from .', './install-linux.sh install --from . "${ENGINES[@]}"']
    let last = -1
    for (const s of steps) {
      const i = helper.indexOf(s)
      expect(`${s}: ${i > last}`).toBe(`${s}: true`)
      last = i
    }
    for (const s of ['curl -fLO "$BASE/$KIT"', 'curl -fLO "$BASE/SHA256SUMS"', 'tar xzf "$KIT"', './app/$V/root/mycel-ctl verify-bundle "./app/$V"', 'sudo ./install-linux.sh check --from .']) expect(guide).toContain(s)
    // set -e: a failed check stops before the install
    expect(helper).toContain('set -euo pipefail')
    // a new, empty download folder
    expect(helper).toContain('W=$(mktemp -d /root/trina-ax-kit.XXXXXX)')
  })
  test('it installs only what the download needs; the rest comes from the kit\'s list (scripts/system/packages.json)', () => {
    const helper = between(PS1, "$HelperScript = @'\n", "\n'@")
    const installs = helper.split('\n').filter((l) => /apt-get install/.test(l))
    expect(installs).toEqual(['    apt-get install -y -qq --no-install-recommends "${need[@]}"'])
    expect(helper).toContain('for p in ca-certificates curl python3; do')
    const list = JSON.parse(read('scripts/system/packages.json')) as { groups: Record<string, { packages?: Record<string, unknown> }> }
    for (const p of ['ca-certificates', 'curl', 'python3']) expect(Object.values(list.groups).some((g) => p in (g.packages ?? {}))).toBe(true)
  })
  test('the helper\'s bash is valid, and turns systemd on in wsl.conf without losing what is there', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-helper-'))
    const helper = path.join(d, 'wsl-setup.sh')
    fs.writeFileSync(helper, between(PS1, "$HelperScript = @'\n", "\n'@") + '\n')
    expect(bash(`bash -n '${helper}'`).code).toBe(0)
    const conf = path.join(d, 'wsl.conf')
    const sd = (text: string | null) => {
      if (text === null) fs.rmSync(conf, { force: true }); else fs.writeFileSync(conf, text)
      const r = bash(`bash '${helper}' systemd`, { TRINA_WSL_CONF: conf })
      return { out: r.out.trim(), conf: fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : null }
    }
    // (this machine's PID 1 is not systemd, so the helper writes the file each time)
    expect(sd(null)).toEqual({ out: 'set', conf: '[boot]\nsystemd=true\n' })
    expect(sd('[automount]\nenabled=true\n')).toEqual({ out: 'set', conf: '[automount]\nenabled=true\n\n[boot]\nsystemd=true\n' })
    expect(sd('[boot]\nsystemd=false\ncommand=echo hi\n[user]\ndefault=me\n')).toEqual({ out: 'set', conf: '[boot]\nsystemd=true\ncommand=echo hi\n[user]\ndefault=me\n' })
    // the earlier file is kept beside it
    expect(fs.readFileSync(`${conf}.trina-backup`, 'utf8')).toBe('[boot]\nsystemd=false\ncommand=echo hi\n[user]\ndefault=me\n')
    // already on: unchanged, no new copy (the distro only has to start again)
    expect(sd('[boot]\nsystemd=true\n')).toEqual({ out: 'set', conf: '[boot]\nsystemd=true\n' })
    expect(fs.readFileSync(`${conf}.trina-backup`, 'utf8')).toContain('systemd=false')
    expect(bash(`bash '${helper}' nonsense`).code).toBe(2)
    fs.rmSync(d, { recursive: true, force: true })
  })
  test('keep-alive: a sign-in task of this user, never stopped by a time limit, that attaches again after WSL stops', () => {
    expect(PS1).toContain('New-ScheduledTaskTrigger -AtLogOn -User $userName')
    expect(PS1).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)')
    expect(PS1).toMatch(/while \(\$true\) \{\n {4}& wsl\.exe -d '@DISTRO@' -u root --exec \/usr\/bin\/sleep infinity\n {4}Start-Sleep -Seconds 10\n\}/)
    // sleep is changed only after a yes (or -KeepAwake Yes)
    expect(PS1).toMatch(/if \(Read-YesNo -Question 'Stop this PC from going to sleep[^\n]*-Answer \$KeepAwake[^\n]*\{\n\s+if \(Test-Change 'Power options'/)
  })
  test('the guides name the script\'s task, folder and distro', () => {
    for (const f of ['docs/INSTALL-WINDOWS.md', 'docs/INSTALL-WINDOWS.ko.md']) {
      const g = read(f)
      for (const s of ['install-wsl-server.ps1', 'Keep the Trina AX server running', 'TrinaAX', 'wsl --unregister', '.wslconfig']) expect(`${f}: ${s}: ${g.includes(s)}`).toBe(`${f}: ${s}: true`)
    }
    expect(PS1).toContain("$KeepAliveTask = 'Keep the Trina AX server running'")
    expect(PS1).toContain("[string]$Distro = 'TrinaAX'")
  })
})

const PWSH = process.env.TRINA_PWSH || Bun.which('pwsh')
describe.skipIf(!PWSH)('install-wsl-server.ps1 in pwsh', () => {
  const fn = (name: string, call: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1-'))
    const f = path.join(d, 't.ps1')
    fs.writeFileSync(f, `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${path.join(REPO, 'scripts/windows/install-wsl-server.ps1')}', [ref]$null, [ref]$null)
$def = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq '${name}' }, $true) | Select-Object -First 1
. ([scriptblock]::Create($def.Extent.Text))
${call}
`)
    const p = Bun.spawnSync([PWSH!, '-NoProfile', '-NonInteractive', '-File', f], { stdout: 'pipe', stderr: 'pipe' })
    fs.rmSync(d, { recursive: true, force: true })
    expect(p.stderr.toString()).toBe('')
    return p.stdout.toString()
  }
  const merge = (text: string, cap = 5) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wslconfig-')), 'in')
    fs.writeFileSync(f, text)
    const out = JSON.parse(fn('Get-MergedWslConfig', `$r = Get-MergedWslConfig ([IO.File]::ReadAllText('${f}')) ${cap}; ConvertTo-Json -InputObject $r`)) as string | null
    fs.rmSync(path.dirname(f), { recursive: true, force: true })
    return out
  }
  test('.wslconfig: none, one without [wsl2], one with [wsl2] and no memory, one that sets memory (kept)', () => {
    expect(merge('')).toBe('[wsl2]\n# Trina AX server: memory Linux may use (install-wsl-server.ps1). Applies after: wsl --shutdown\nmemory=5GB\n')
    expect(merge('[general]\ninstanceIdleTimeout=30000\n\n')).toBe('[general]\ninstanceIdleTimeout=30000\n\n[wsl2]\n# Trina AX server: memory Linux may use (install-wsl-server.ps1). Applies after: wsl --shutdown\nmemory=5GB\n')
    expect(merge('[wsl2]\r\nprocessors=4\r\n[experimental]\r\nautoMemoryReclaim=gradual\r\n', 8)).toBe('[wsl2]\r\n# Trina AX server: memory Linux may use (install-wsl-server.ps1). Applies after: wsl --shutdown\r\nmemory=8GB\r\nprocessors=4\r\n[experimental]\r\nautoMemoryReclaim=gradual\r\n')
    expect(merge('[WSL2]\nmemory = 12GB\n')).toBeNull()
    // a memory line of another section is not the VM's
    expect(merge('[other]\nmemory=1GB\n')).toContain('[wsl2]\n# Trina AX')
  })
  test('the memory limit by the PC\'s memory, and -MemoryGB first', () => {
    expect(fn('Get-MemoryCapGB', '@(7.8, 8, 12, 16, 24, 32, 64) | ForEach-Object { Get-MemoryCapGB -TotalGB $_ -Wanted 0 }; Get-MemoryCapGB -TotalGB 8 -Wanted 3').trim().split(/\s+/)).toEqual(['5', '5', '6', '8', '12', '16', '16', '3'])
  })
  test('PSScriptAnalyzer, where it is installed, finds nothing', () => {
    const out = fn('Write-Ok', `if (Get-Module -ListAvailable PSScriptAnalyzer) { Invoke-ScriptAnalyzer -Path '${path.join(REPO, 'scripts/windows/install-wsl-server.ps1')}' -Severity Warning,Error | ForEach-Object { "$($_.RuleName):$($_.Line)" } } else { 'none' }`)
    expect(['', 'none']).toContain(out.trim())
  })
})
