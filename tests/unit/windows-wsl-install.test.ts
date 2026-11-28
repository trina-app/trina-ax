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
        // (or inside Initialize-DataDir, which starts with its own Test-Change)
        const fnAt = lines.slice(0, i + 1).map((l) => /^function /.test(l)).lastIndexOf(true)
        const inDataDir = fnAt >= 0 && lines[fnAt]!.startsWith('function Initialize-DataDir') && !lines.slice(fnAt, i).some((l) => l === '}')
        expect(`${c} (line ${i + 1}): ${inDataDir || /Test-Change|Read-YesNo -Question 'WSL must restart/.test(before)}`).toBe(`${c} (line ${i + 1}): true`)
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
  test('the helper\'s bash is valid; wsl.conf: systemd on, interop and drive mounts off, root, nothing else lost', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-helper-'))
    const helper = path.join(d, 'wsl-setup.sh')
    fs.writeFileSync(helper, between(PS1, "$HelperScript = @'\n", "\n'@") + '\n')
    expect(bash(`bash -n '${helper}'`).code).toBe(0)
    const conf = path.join(d, 'wsl.conf')
    const sd = (text: string | null) => {
      if (text === null) fs.rmSync(conf, { force: true }); else fs.writeFileSync(conf, text)
      const r = bash(`bash '${helper}' wslconf`, { TRINA_WSL_CONF: conf })
      return { out: r.out.trim(), conf: fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : null }
    }
    const ours = '[boot]\nsystemd=true\n\n[interop]\nappendWindowsPath=false\nenabled=false\n\n[automount]\nmountFsTab=false\nenabled=false\n\n[user]\ndefault=root\n'
    expect(sd(null)).toEqual({ out: 'set', conf: ours })
    // the image's own file (Debian: [boot] systemd=true) and a person's lines stay; the keys we set win
    expect(sd('[boot]\nsystemd=false\ncommand=echo hi\n[automount]\nenabled = true\nroot=/mnt/\n[network]\nhostname=office\n')).toEqual({ out: 'set', conf:
      '[boot]\nsystemd=true\ncommand=echo hi\n[automount]\nmountFsTab=false\nenabled=false\nroot=/mnt/\n[network]\nhostname=office\n\n[interop]\nappendWindowsPath=false\nenabled=false\n\n[user]\ndefault=root\n' })
    // the earlier file is kept beside it
    expect(fs.readFileSync(`${conf}.trina-backup`, 'utf8')).toBe('[boot]\nsystemd=false\ncommand=echo hi\n[automount]\nenabled = true\nroot=/mnt/\n[network]\nhostname=office\n')
    // already as wanted: unchanged, no new copy; "set" here only because this machine's PID 1 is not systemd
    const now = fs.readFileSync(conf, 'utf8')
    expect(sd(now)).toEqual({ out: 'set', conf: now })
    expect(fs.readFileSync(`${conf}.trina-backup`, 'utf8')).toContain('systemd=false')
    // "on" needs all of it in effect: systemd as PID 1, no WSLInterop binfmt entry, no /mnt/<drive> mount
    const helperText = fs.readFileSync(helper, 'utf8')
    for (const s of ['/proc/1/comm', '/proc/mounts', '[ -z "${WSL_INTEROP:-}" ]']) expect(helperText).toContain(s)
    // WSL 3.0.5 keeps the WSLInterop binfmt entry with interop off (Windows QA 2026-11-28): it is not the sign
    expect(helperText).not.toContain('binfmt_misc')
    const mounts = path.join(d, 'mounts')
    const live = (env: Record<string, string>, m: string) => {
      fs.writeFileSync(mounts, m)
      return bash(`bash '${helper}' wslconf`, { TRINA_WSL_CONF: conf, TRINA_MOUNTS: mounts, ...env }).out.trim()
    }
    const plain = 'none / ext4 rw 0 0\nsysfs /sys sysfs rw 0 0\n'
    expect(live({ TRINA_PID1: 'systemd' }, plain)).toBe('on')
    expect(live({ TRINA_PID1: 'systemd', WSL_INTEROP: '/run/WSL/1_interop' }, plain)).toBe('set')
    expect(live({ TRINA_PID1: 'systemd' }, plain + 'C:\\134 /mnt/c 9p rw 0 0\n')).toBe('set')
    expect(live({ TRINA_PID1: 'init' }, plain)).toBe('set')
    expect(bash(`bash '${helper}' nonsense`).code).toBe(2)
    fs.rmSync(d, { recursive: true, force: true })
  })
  test('nothing the setup or the keep-alive needs reads the C: drive or runs Windows programs from Linux', () => {
    const helper = between(PS1, "$HelperScript = @'\n", "\n'@")
    expect(PS1).not.toContain('wslpath')
    expect(helper).not.toMatch(/\/mnt\/[a-z]\/|\.exe\b/)
    // the helper and a kit from this PC go in through wsl.exe's standard input
    expect(PS1).toContain("$HelperLinux = '/root/.trina-wsl-setup.sh'")
    expect(PS1).toMatch(/function Copy-ToDistro[\s\S]*RedirectStandardInput = \$true/)
    for (const f of ['docs/INSTALL-WINDOWS.md', 'docs/INSTALL-WINDOWS.ko.md']) expect(`${f}: ${/\bcp\b[^\n]*\/mnt\//.test(read(f))}`).toBe(`${f}: false`)
  })
  test('every wsl.exe call into the distro starts in / (no C: drive to translate the Windows folder to); values are stdout only', () => {
    // review of #716: with the drive mounts off, wsl.exe -d <distro> without --cd printed "Failed to translate ..." and
    // that line, merged into the output, broke every value the script read
    const calls = [...PS1.matchAll(/(?:'-d', \$Distro|-d \$Distro|-d '@DISTRO@'|-d TrinaAX)[^\n]*/g)].map((m) => m[0])
    expect(calls.length).toBeGreaterThanOrEqual(5)
    for (const c of calls) expect(`${c}: ${/^(?:'-d', \$Distro, '--cd', '\/'|-d \$Distro --cd \/ |-d '@DISTRO@' --cd \/ |-d TrinaAX --cd \/ )/.test(c)}`).toBe(`${c}: true`)
    for (const f of ['docs/INSTALL-WINDOWS.md', 'docs/INSTALL-WINDOWS.ko.md'])
      for (const m of read(f).matchAll(/wsl -d TrinaAX[^\n`]*/g)) expect(`${f}: ${m[0]}: ${m[0].startsWith('wsl -d TrinaAX --cd ')}`).toBe(`${f}: ${m[0]}: true`)
    const inv = between(PS1, 'function Invoke-Wsl([string[]]$A) {', '\n}\n')
    expect(inv).toContain('if ($line -is [System.Management.Automation.ErrorRecord]) { $se += "$line" } else { $so += "$line" }')
    expect(inv).toContain('Out = (& $clean $so); Err = (& $clean $se)')
    // Copy-ToDistro: a write that fails ends in the normal STOP message (an exit code and the reason), never a throw
    const cp = between(PS1, 'function Copy-ToDistro(', '\n}\n')
    expect(cp).toMatch(/\} catch \{\n\s+# the distro side ended early[^\n]*\n\s+\$failed = \$_\.Exception\.Message/)
    expect(cp).toContain('if ($failed -and $code -eq 0) { $code = 1 }')
    expect(cp).toContain('ReadToEndAsync()')
    // a new -KitPath kit goes into an emptied folder
    expect(PS1.indexOf('$cu = Invoke-Helper clearupload')).toBeLessThan(PS1.indexOf('$c = Copy-ToDistro -LinuxPath $pair[1] -From $pair[0]'))
    expect(between(PS1, "$HelperScript = @'\n", "\n'@")).toContain('  clearupload)\n    # an earlier -KitPath copy that stopped half-way: an empty folder for the next one\n    rm -rf -- "$UPLOAD"\n')
  })
  test('Windows QA 2026-11-28: wsl.exe writes its own lines to the console, -WhatIf loads modules quietly, sleep is put back as it was', () => {
    const live = between(PS1, 'function Invoke-WslLive([string[]]$A) {', '\n}\n')
    // no pipe through PowerShell and no WSL_UTF8: the Korean progress lines came out with every letter twice
    expect(live).not.toContain('Out-Host')
    expect(live).toContain("$psi.EnvironmentVariables.Remove('WSL_UTF8')")
    expect(live).not.toMatch(/Redirect/)
    // the modules load before anything with WhatIf off
    expect(PS1.indexOf("Import-Module $m -Global -ErrorAction SilentlyContinue -WhatIf:$false")).toBeLessThan(PS1.indexOf('# ---- 1. this PC ----'))
    for (const m of ['CimCmdlets', 'Dism', 'ScheduledTasks']) expect(PS1).toContain(`'${m}'`)
    // the AC sleep values before the first change are kept (never overwritten) and the uninstall puts them back
    expect(PS1).toMatch(/if \(\(Initialize-DataDir\) -and -not \(Test-Path -LiteralPath \$before\)\) \{[\s\S]*?standbyAcSeconds = \$standby; hibernateAcSeconds = \$hibernate[\s\S]*?& powercfg\.exe \/change standby-timeout-ac 0/)
    expect(PS1).toContain("if (($standby -eq 0) -and ($hibernate -eq 0)) {")
    for (const f of ['docs/INSTALL-WINDOWS.md', 'docs/INSTALL-WINDOWS.ko.md']) {
      const g = read(f)
      expect(`${f}: ${g.includes('standby-timeout-ac 30')}`).toBe(`${f}: false`)
      for (const s of ['power-before.json', 'powercfg /setacvalueindex $p.scheme SUB_SLEEP STANDBYIDLE $p.standbyAcSeconds', 'mycel-ctl update --check']) expect(`${f}: ${s}: ${g.includes(s)}`).toBe(`${f}: ${s}: ${s !== 'mycel-ctl update --check'}`)
    }
  })
  test('a re-run after a half install repairs (installed = the server answers); the kit stays once the installer ran', () => {
    const helper = between(PS1, "$HelperScript = @'\n", "\n'@")
    expect(helper).toContain('if healthy; then echo "ok $v"; else echo "broken $v"; fi')
    expect(helper).toContain('./install-linux.sh repair --from .')
    expect(helper.indexOf('RAN=1')).toBeLessThan(helper.indexOf('./install-linux.sh install --from .'))
    expect(helper.indexOf('RAN=1')).toBeGreaterThan(helper.indexOf('./install-linux.sh check --from .'))
    expect(helper).toContain('if [ "$OK" = 1 ] || [ "$RAN" = 1 ]; then ln -sfn')
    expect(PS1).toContain("$repair = ($state -match '^broken ') -and ((Invoke-Helper haskit).Out -eq 'yes')")
  })
  test('-KitPath: the same checks as a download, no unsigned kits; the setup code never on a command line', () => {
    const helper = between(PS1, "$HelperScript = @'\n", "\n'@")
    // only the download is skipped: the checksum, verify-bundle and the installer's check run for both
    const local = helper.indexOf('if [ "$SRC" = local ]; then'), check = helper.indexOf("python3 - \"$KIT\" <<'CHECK'")
    expect(local).toBeGreaterThan(0)
    expect(helper.indexOf('if [ "$SRC" != local ]; then\n      curl -fLO')).toBeLessThan(check)
    expect(helper.slice(local, check)).not.toMatch(/exit 0|verify-bundle|install-linux/)
    expect(PS1).toContain('-not ($KitPath -and $SumsPath)')
    expect(PS1).not.toContain('setup?token')
    expect(PS1).toContain('Set-Clipboard -Value $code')
    // a question that stops other distros answers No when no one can be asked; the restart window waits
    expect(PS1).toContain("-Answer 'Ask' -Default $true -Unattended $false) {\n            $null = Invoke-Wsl @('--shutdown')")
    expect(PS1).toMatch(/function Exit-Setup[\s\S]*?Wait-Resumed\n {4}exit \$Code/)
    expect(PS1.trimEnd().endsWith('Wait-Resumed')).toBe(true)
  })
  test('ProgramData\\TrinaAX: a folder someone else made is moved aside; owner Administrators; links removed, files reset', () => {
    const fn = between(PS1, 'function Initialize-DataDir {', '\n}\n')
    for (const s of ['GetOwner(', '-ne $SidAdmins', '-ne $SidSystem', 'Rename-Item', '$acl.SetOwner($SidAdmins)', 'SetAccessRuleProtection($true, $false)', 'Test-ReparsePoint $e', '[IO.File]::Delete', '$fa.SetOwner($SidAdmins)']) expect(`${s}: ${fn.includes(s)}`).toBe(`${s}: true`)
    expect(fn).not.toMatch(/Remove-Item[^\n]*-Recurse/)
  })
  test('keep-alive: a sign-in task of this user, never stopped by a time limit, that attaches again after WSL stops', () => {
    expect(PS1).toContain('New-ScheduledTaskTrigger -AtLogOn -User $userName')
    expect(PS1).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)')
    expect(PS1).toMatch(/while \(\$true\) \{\n {4}& wsl\.exe -d '@DISTRO@' --cd \/ -u root --exec \/usr\/bin\/sleep infinity\n {4}Start-Sleep -Seconds 10\n\}/)
    // sleep is changed only after a yes (or -KeepAwake Yes)
    expect(PS1).toMatch(/if \(Read-YesNo -Question 'Stop this PC from going to sleep[^\n]*-Answer \$KeepAwake[^\n]*\{\n[\s\S]{0,300}?\} elseif \(Test-Change 'Power options'/)
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
