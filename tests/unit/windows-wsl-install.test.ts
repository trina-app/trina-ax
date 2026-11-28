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

describe('install-linux.sh: the closing hint on a WSL server (Windows QA 2026-11-28)', () => {
  const part = between(INSTALLER, '# BEGIN wsl check\n', '# END wsl check') + '\n' + 'done_ok() {\n' + between(INSTALLER, '\ndone_ok() {\n', '\n}\n') + '\n}\n'
  const run = (release: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-done-'))
    fs.mkdirSync(path.join(d, 'setup')); fs.mkdirSync(path.join(d, 'data'))
    fs.writeFileSync(path.join(d, 'setup', 'code'), 'ABCD\n'); fs.writeFileSync(path.join(d, 'data', 'setup-token'), 'x')
    fs.writeFileSync(path.join(d, 'osrelease'), release)
    const r = bash(`WARNINGS=()\nsay() { echo "$*"; }\ndev_env_step() { :; }\nBASE='${d}' PORT=47820 ID=mycel RUNNING=1.0.0 DEPLOYMENT=x SRV_USER=s AGT_USER=a CTL_LINK=c\n${part}\ndone_ok`, { MYCEL_OSRELEASE: path.join(d, 'osrelease'), WSL_DISTRO_NAME: 'TrinaAX' })
    fs.rmSync(d, { recursive: true, force: true })
    return { ...r, out: r.out.replaceAll(d, '<base>') }
  }
  test('WSL: open 127.0.0.1 on this PC, the code on the clipboard or through wsl.exe; no ssh -L, no sudo cat', () => {
    expect(part).toContain('on_wsl')
    const r = run('6.6.87.2-microsoft-standard-WSL2\n')
    expect(r.code).toBe(0)
    expect(r.out).toContain('open http://127.0.0.1:47820/setup on this PC')
    expect(r.out).toContain('The setup code is on the clipboard')
    expect(r.out).toContain('wsl -d TrinaAX --cd / -u root -- cat <base>/setup/code')
    expect(r.out).not.toContain('ssh -L')
    expect(r.out).not.toContain('sudo cat')
  })
  test('a Linux server elsewhere: the ssh tunnel and sudo cat as before', () => {
    const r = run('6.12.48+deb13-amd64\n')
    expect(r.code).toBe(0)
    expect(r.out).toContain('ssh -L 47820:127.0.0.1:47820 <this server>')
    expect(r.out).toContain('sudo cat <base>/setup/code')
    expect(r.out).not.toContain('wsl -d')
  })
})

describe('install-wsl-server.ps1', () => {
  test('Windows PowerShell 5.1 reads it as written: ASCII only, -WhatIf through ShouldProcess, every change behind it', () => {
    // (5.1 reads a file without a BOM in the PC's code page: one non-ASCII character can break the script on a Korean PC)
    expect([...PS1].every((c) => c.charCodeAt(0) < 128)).toBe(true)
    expect(PS1).toContain('#Requires -Version 5.1')
    expect(PS1).toContain('[CmdletBinding(SupportsShouldProcess = $true)]')
    // the commands that change this PC all sit under a Test-Change (ShouldProcess) in the same block
    const changes = ['Enable-WindowsOptionalFeature', 'Register-ScheduledTask', 'Unregister-ScheduledTask', 'Restart-Computer', 'powercfg.exe /change', 'Set-Acl', "'--install'", "'--update'", "'--shutdown'", "'--terminate'", "'--set-version'", "'--unregister'"]
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
    expect(installs).toEqual(['    { apt-get update -qq && apt-get install -y -qq --no-install-recommends "${need[@]}"; } >> "$PK_APT_LOG" 2>&1 \\'])
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
      const r = bash(`bash '${helper}' wslconf`, { TRINA_WSL_CONF: conf, TRINA_PID1: 'init' })
      return { out: r.out.trim(), conf: fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : null }
    }
    const ours = '[boot]\nsystemd=true\n\n[interop]\nappendWindowsPath=false\nenabled=false\n\n[automount]\nmountFsTab=false\nenabled=false\n\n[user]\ndefault=root\n'
    expect(sd(null)).toEqual({ out: 'set', conf: ours })
    // the image's own file (Debian: [boot] systemd=true) and a person's lines stay; the keys we set win
    expect(sd('[boot]\nsystemd=false\ncommand=echo hi\n[automount]\nenabled = true\nroot=/mnt/\n[network]\nhostname=office\n')).toEqual({ out: 'set', conf:
      '[boot]\nsystemd=true\ncommand=echo hi\n[automount]\nmountFsTab=false\nenabled=false\nroot=/mnt/\n[network]\nhostname=office\n\n[interop]\nappendWindowsPath=false\nenabled=false\n\n[user]\ndefault=root\n' })
    // the earlier file is kept beside it
    expect(fs.readFileSync(`${conf}.trina-backup`, 'utf8')).toBe('[boot]\nsystemd=false\ncommand=echo hi\n[automount]\nenabled = true\nroot=/mnt/\n[network]\nhostname=office\n')
    // already as wanted: unchanged, no new copy; "set" here only because PID 1 is not systemd (TRINA_PID1=init above: a CI runner's PID 1 is systemd)
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
  test('step 4: a failed Debian install is tried once more; a leftover distro is removed only on a positive "empty" (fail-closed)', () => {
    // Windows QA 2026-11-28: wsl --install ... --web-download stopped once with exit code -1 after 22 s on a clean PC
    const step = between(PS1, 'Write-Step "4/8', '} else { Write-Ok "`"$Distro`" is installed" }')
    expect(step).not.toBe('')
    expect(step).toContain('for ($try = 1; $try -le 2; $try++) {')
    expect(step.match(/'--install', '--distribution', 'Debian'/g)?.length).toBe(1)
    // "none before" needs a list that answered (asked twice); a failed list is unknown
    expect(step).toContain("$absentBefore = (-not $haveDistro) -and (((Invoke-Wsl @('--list', '--quiet')).Code -eq 0) -or ((Invoke-Wsl @('--list', '--quiet')).Code -eq 0))")
    // success only with exit code 0 and the distro listed; otherwise the STOP message that says to run it again
    expect(step).toContain("if ($code -eq 0 -and ((Get-DistroName) -contains $Distro)) { $installed = $true; break }")
    expect(step).toContain('if (-not $installed) { Exit-Setup "Installing Debian failed (wsl.exe exit code $code). This happens now and then on a new PC: run this script again (finished steps are skipped).')
    // the one --unregister sits right after the one check that needs 'remove'; every other answer leaves the loop
    const lines = step.split('\n')
    const un = lines.map((l, i) => (l.includes("'--unregister'") ? i : -1)).filter((i) => i >= 0)
    expect(un.length).toBe(1)
    expect(lines[un[0]! - 1]!.trim()).toBe("if ((Get-LeftoverAction -AbsentBefore $absentBefore -Probe $probe) -ne 'remove') { break }")
    expect(lines[un[0]! - 2]!).toContain("$probe = Invoke-Wsl @('-d', $Distro, '--cd', '/', '-u', 'root', '--exec', '/bin/sh', '-c',")
    // Get-LeftoverAction: one 'remove', behind AbsentBefore, a probe that ran (code 0) and said exactly "empty"
    const f = between(PS1, 'function Get-LeftoverAction([bool]$AbsentBefore, $Probe) {', '\n}\n')
    expect(f.trim().split('\n').map((l) => l.trim())).toEqual([
      "if (-not $AbsentBefore -or $null -eq $Probe) { return 'keep' }",
      `if ($Probe.Code -eq 0 -and "$($Probe.Out)".Trim() -eq 'empty') { return 'remove' }`,
      "return 'keep'",
    ])
  })
  test('step 4: the leftover probe says "empty" only for a bare distro; the server folder, an upload or a home folder: "keep"', () => {
    const m = PS1.match(/'-c', "(if \[ -e \$LinuxBase \][^"]*)"\)/)
    expect(m).not.toBeNull()
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-probe-'))
    const probe = (prep: (root: string) => void) => {
      const root = fs.mkdtempSync(path.join(d, 'r-'))
      fs.mkdirSync(path.join(root, 'home')); fs.mkdirSync(path.join(root, 'root'))
      prep(root)
      const script = m![1]!.replace('$LinuxBase', `${root}/var/lib/mycel`).replace('/root/.trina-upload', `${root}/root/.trina-upload`).replace('/home', `${root}/home`)
      return bash(script).out.trim()
    }
    expect(probe(() => {})).toBe('empty')
    expect(probe((r) => fs.mkdirSync(path.join(r, 'var/lib/mycel'), { recursive: true }))).toBe('keep')
    expect(probe((r) => fs.mkdirSync(path.join(r, 'root/.trina-upload')))).toBe('keep')
    expect(probe((r) => fs.mkdirSync(path.join(r, 'home/alice')))).toBe('keep')
    fs.rmSync(d, { recursive: true, force: true })
  })
  test('-WhatIf / -Confirm only on cmdlets that take them (Windows PowerShell 5.1 stops on any other: QA 2026-11-28)', () => {
    // the cmdlets of this script and its guides that support ShouldProcess; Import-Module, Get-*, Write-*, Read-Host,
    // Invoke-WebRequest and the rest do not, and a -WhatIf:$false on Import-Module stopped the script before step 1
    const SHOULD_PROCESS = new Set(['Unregister-ScheduledTask', 'Register-ScheduledTask', 'Remove-Item', 'Rename-Item', 'Copy-Item', 'New-Item', 'Set-Acl', 'Set-Clipboard', 'Start-Process', 'Restart-Computer', 'Enable-WindowsOptionalFeature', 'Start-ScheduledTask', 'Stop-ScheduledTask', 'Disable-ScheduledTask', 'Enable-ScheduledTask'])
    const sources = { 'scripts/windows/install-wsl-server.ps1': PS1, 'docs/INSTALL-WINDOWS.md': read('docs/INSTALL-WINDOWS.md'), 'docs/INSTALL-WINDOWS.ko.md': read('docs/INSTALL-WINDOWS.ko.md') }
    let seen = 0
    for (const [f, text] of Object.entries(sources)) {
      for (const line of text.split('\n')) {
        if (line.trimStart().startsWith('#')) continue
        // (text in quotes is a message, not a parameter)
        for (const m of line.replace(/'[^']*'|"[^"]*"/g, "''").matchAll(/([A-Z][a-z]+-[A-Za-z]+)\b[^|;{}()]*?\s-(?:WhatIf|Confirm)\b/g)) {
          seen++
          expect(`${f}: ${m[1]} (${line.trim()}): ${SHOULD_PROCESS.has(m[1]!)}`).toBe(`${f}: ${m[1]} (${line.trim()}): true`)
        }
      }
    }
    expect(seen).toBeGreaterThan(0)
    // the regex sees it: the line QA hit would fail here
    expect([...'        Import-Module $m -Global -ErrorAction SilentlyContinue -WhatIf:$false'.matchAll(/([A-Z][a-z]+-[A-Za-z]+)\b[^|;{}()]*?\s-(?:WhatIf|Confirm)\b/g)].map((m) => m[1])).toEqual(['Import-Module'])
  })
  test('Windows QA 2026-11-28: wsl.exe writes its own lines to the console, -WhatIf loads modules quietly, sleep is put back as it was', () => {
    const live = between(PS1, 'function Invoke-WslLive([string[]]$A) {', '\n}\n')
    // no pipe through PowerShell and no WSL_UTF8: the Korean progress lines came out with every letter twice
    expect(live).not.toContain('Out-Host')
    expect(live).toContain("$psi.EnvironmentVariables.Remove('WSL_UTF8')")
    expect(live).not.toMatch(/Redirect/)
    // the modules load before anything with WhatIf off
    // (WhatIf off by the preference in a child scope: Import-Module has no -WhatIf on Windows PowerShell 5.1)
    // and the global one while they load (a module's own Set-Alias reads it), put back after
    expect(PS1).toMatch(/& \{\n {4}\$WhatIfPreference = \$false\n {4}\$globalWhatIf = \$global:WhatIfPreference\n {4}\$global:WhatIfPreference = \$false\n {4}try \{\n[^\n]*\n {12}Import-Module \$m -Global -ErrorAction SilentlyContinue\n {8}\}\n {4}\} finally \{ \$global:WhatIfPreference = \$globalWhatIf \}\n/)
    expect(PS1.indexOf("Import-Module $m -Global -ErrorAction SilentlyContinue")).toBeLessThan(PS1.indexOf("# ---- 1. this PC ----"))
    for (const m of ['CimCmdlets', 'Dism', 'ScheduledTasks']) expect(PS1).toContain(`'${m}'`)
    // the AC sleep values before the first change are kept (never overwritten) and the uninstall puts them back
    expect(PS1).toMatch(/if \(\(Initialize-DataDir\) -and -not \(Test-Path -LiteralPath \$before\)\) \{[\s\S]*?standbyAcSeconds = \$standbyKept; hibernateAcSeconds = \$hibernateKept[\s\S]*?& powercfg\.exe \/change standby-timeout-ac 0/)
    expect(PS1).toContain("if (($standby -eq 0) -and ($hibernate -eq 0)) {")
    // a value powercfg did not show is kept as "unknown", never -1, and the uninstall skips it
    expect(PS1).toContain("$standbyKept = if ($standby -ge 0) { $standby } else { 'unknown' }")
    expect(PS1).toContain("$hibernateKept = if ($hibernate -ge 0) { $hibernate } else { 'unknown' }")
    for (const f of ['docs/INSTALL-WINDOWS.md', 'docs/INSTALL-WINDOWS.ko.md']) {
      const g = read(f)
      expect(`${f}: ${g.includes('standby-timeout-ac 30')}`).toBe(`${f}: false`)
      expect(g).toContain(`if ("$($p.standbyAcSeconds)" -match '^\\d+$') { powercfg /setacvalueindex`)
      expect(g).toContain(`if ("$($p.hibernateAcSeconds)" -match '^\\d+$') { powercfg /setacvalueindex`)
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
  test('Get-LeftoverAction is fail-closed: only a list that answered and a probe that said "empty" remove', () => {
    const cases = [
      ['$true', "[pscustomobject]@{ Code = 0; Out = 'empty'; Err = '' }", 'remove'],
      ['$false', "[pscustomobject]@{ Code = 0; Out = 'empty'; Err = '' }", 'keep'],
      ['$true', "[pscustomobject]@{ Code = 0; Out = 'keep'; Err = '' }", 'keep'],
      ['$true', "[pscustomobject]@{ Code = 1; Out = 'empty'; Err = '' }", 'keep'],
      ['$true', "[pscustomobject]@{ Code = -1; Out = ''; Err = 'failed' }", 'keep'],
      ['$true', "[pscustomobject]@{ Code = 0; Out = 'Failed to translate x' + [char]10 + 'empty'; Err = '' }", 'keep'],
      ['$true', '$null', 'keep'],
    ]
    for (const [before, probe, want] of cases)
      expect(`${before} ${probe}: ${fn('Get-LeftoverAction', `Get-LeftoverAction -AbsentBefore ${before} -Probe (${probe})`).trim()}`).toBe(`${before} ${probe}: ${want}`)
  }, 60_000)
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
  }, 60_000)
  test('the memory limit by the PC\'s memory, and -MemoryGB first', () => {
    expect(fn('Get-MemoryCapGB', '@(7.8, 8, 12, 16, 24, 32, 64) | ForEach-Object { Get-MemoryCapGB -TotalGB $_ -Wanted 0 }; Get-MemoryCapGB -TotalGB 8 -Wanted 3').trim().split(/\s+/)).toEqual(['5', '5', '6', '8', '12', '16', '16', '3'])
  }, 60_000)
  test('PSScriptAnalyzer, where it is installed, finds nothing', () => {
    const out = fn('Write-Ok', `if (Get-Module -ListAvailable PSScriptAnalyzer) { Invoke-ScriptAnalyzer -Path '${path.join(REPO, 'scripts/windows/install-wsl-server.ps1')}' -Severity Warning,Error | ForEach-Object { "$($_.RuleName):$($_.Line)" } } else { 'none' }`)
    expect(['', 'none']).toContain(out.trim())
  }, 60_000)
})
