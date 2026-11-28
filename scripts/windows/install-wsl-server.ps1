#Requires -Version 5.1
<#
.SYNOPSIS
Installs a Trina AX team server on this Windows PC, inside WSL2 (a small Debian Linux that Windows runs).

.DESCRIPTION
Run it in PowerShell as administrator, signed in to Windows with the account that will keep the server running:

  powershell -ExecutionPolicy Bypass -File .\install-wsl-server.ps1

What it does, in order (docs/INSTALL-WINDOWS.md explains each step):
  1. Checks this PC: Windows 11 or Windows 10 22H2, 64-bit, at least 8 GB of memory (16 GB recommended),
     virtualization turned on, 20 GB of free disk.
  2. Turns on the two Windows features WSL needs (Virtual Machine Platform, Windows Subsystem for Linux). The first
     time this needs one restart; the setup goes on by itself after you sign in again.
  3. Installs or updates WSL, and sets how much memory Linux may use (.wslconfig; an existing file is kept and only
     gets a memory line when it has none, after a backup copy).
  4. Installs a Debian distro named TrinaAX (or -Distro) with systemd on, and curl and Python 3 for the download.
  5. Downloads the latest signed server kit and checks it exactly as docs/INSTALL-LINUX.en.md does (checksum, the
     kit's signature, the installer's check). It never skips a check and never uses --allow-unsigned.
  6. Installs the server with the normal Linux installer (install-linux.sh), unless it is installed already.
  7. Adds a task that keeps the server running while you are signed in, and asks before it stops this PC from
     sleeping on power.
  8. Prints the address (http://127.0.0.1:47820) and opens the setup page.

Run it again at any time: steps that are done are skipped. -WhatIf shows what it would change and changes nothing.

.PARAMETER Distro
Name of the WSL distro for the server. Default: TrinaAX. Your other WSL distros are not touched.

.PARAMETER Version
Release to install, for example 0.21.0. Default: the latest release.

.PARAMETER Engine
AI engines to install: claude, codex or claude,codex. Default: both, as in the Linux guide.

.PARAMETER MemoryGB
Memory limit for WSL in GB when .wslconfig has none. Default (0): chosen from this PC's memory.

.PARAMETER KeepAwake
Ask (default), Yes or No: whether this PC should stop sleeping while it is plugged in.

.PARAMETER OpenSetup
Ask (default), Yes or No: whether to open the setup page in the browser at the end.

.PARAMETER KitPath
A server kit file on this PC (TrinaAX-server-<version>-linux-<arch>.tar.gz) to install instead of downloading one,
for example a signed pre-release for testing. Needs -SumsPath. It is checked exactly like a download: the checksum
from SHA256SUMS, the kit's release signature (verify-bundle) and the installer's check. An unsigned kit is refused.

.PARAMETER SumsPath
The SHA256SUMS file of the release that -KitPath comes from.

.PARAMETER Resume
Used by the task that continues the setup after the restart. You do not need it.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\install-wsl-server.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\install-wsl-server.ps1 -WhatIf

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\install-wsl-server.ps1 -KeepAwake Yes -OpenSetup No
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'An installer a person watches: plain coloured lines on the console.')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidatePattern('^[A-Za-z][A-Za-z0-9._-]{0,63}$')]
    [string]$Distro = 'TrinaAX',
    [ValidatePattern('^(latest|[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$')]
    [string]$Version = 'latest',
    [ValidatePattern('^(claude|codex)(,(claude|codex))?$')]
    [string]$Engine = 'claude,codex',
    [ValidateRange(0, 512)]
    [int]$MemoryGB = 0,
    [ValidateSet('Ask', 'Yes', 'No')]
    [string]$KeepAwake = 'Ask',
    [ValidateSet('Ask', 'Yes', 'No')]
    [string]$OpenSetup = 'Ask',
    [string]$KitPath = '',
    [string]$SumsPath = '',
    [switch]$Resume
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:Cmd = $PSCmdlet
$script:DryRun = [bool]$WhatIfPreference
# the modules this script uses, loaded now with WhatIf off: loaded on first use under -WhatIf, Windows PowerShell 5.1
# printed some 30 "What if: ..." lines of their own setup (Windows QA 2026-11-28). Loading changes nothing.
& {
    $WhatIfPreference = $false
    foreach ($m in @('CimCmdlets', 'Dism', 'ScheduledTasks', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility')) {
        Import-Module $m -Global -ErrorAction SilentlyContinue
    }
}

# ---- fixed names (docs/INSTALL-WINDOWS.md names them too) ----
$ProductName = 'Trina AX'
$DataDir = Join-Path $env:ProgramData 'TrinaAX'
$TaskPath = '\TrinaAX\'
$KeepAliveTask = 'Keep the Trina AX server running'
$ResumeTask = 'Continue the Trina AX setup after the restart'
$MinWslVersion = [version]'2.4.4'   # wsl --install --name (the distro's own name), the tar-based Debian with systemd
$LinuxBase = '/var/lib/mycel'        # install-linux.sh's default --id mycel

# ---- output: short plain lines ----
function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "   OK  $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "       $Text" }
function Write-Note([string]$Text) { Write-Host "   !   $Text" -ForegroundColor Yellow }
# the window the restart task opened closes when the script ends: keep it until the person has read it
function Wait-Resumed {
    if ($Resume -and [Environment]::UserInteractive) { $null = Read-Host '       Press Enter to close this window' }
}
function Exit-Setup([string]$Text, [int]$Code = 1) {
    Write-Host ''
    Write-Host "   STOP  $Text" -ForegroundColor Red
    Write-Host '         Nothing else was changed. Fix this, then run the same command again.' -ForegroundColor Red
    Wait-Resumed
    exit $Code
}
# -Unattended: the answer when no one can be asked (a dry run, no console); for a question that stops other programs it
# is No
function Read-YesNo([string]$Question, [string]$Answer, [bool]$Default = $true, [bool]$Unattended = $Default) {
    if ($Answer -eq 'Yes') { return $true }
    if ($Answer -eq 'No') { return $false }
    if ($script:DryRun -or -not [Environment]::UserInteractive) { return $Unattended }
    $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
    while ($true) {
        $r = (Read-Host "   ?   $Question $hint").Trim().ToLowerInvariant()
        if ($r -eq '') { return $Default }
        if ($r -in @('y', 'yes')) { return $true }
        if ($r -in @('n', 'no')) { return $false }
    }
}
# every change asks the script's own ShouldProcess: -WhatIf (and -Confirm) of the command line cover all of them
function Test-Change {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSShouldProcess', '', Justification = 'Forwards to the script''s ShouldProcess, which -WhatIf sets.')]
    param([string]$Target, [string]$Action)
    return $script:Cmd.ShouldProcess($Target, $Action)
}

# ---- wsl.exe: UTF-8 output (it prints UTF-16 otherwise), exit code returned. Out is standard output only, the value
# the script reads; Err is what wsl.exe and the command said on standard error (a warning there must never become
# part of a value: "Failed to translate ..." once broke every answer, review of #716) ----
# (arguments as one array: a function's own parameter binding would take "-d" for -Debug)
function Invoke-Wsl([string[]]$A) {
    $env:WSL_UTF8 = '1'
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $so = @(); $se = @()
    try {
        foreach ($line in @(& wsl.exe @A 2>&1)) {
            if ($line -is [System.Management.Automation.ErrorRecord]) { $se += "$line" } else { $so += "$line" }
        }
        $code = $LASTEXITCODE
    } catch {
        $se = @("$_"); $code = 1
    } finally { $ErrorActionPreference = $old }
    $clean = { param($l) (($l | ForEach-Object { $_ -replace "`0", '' }) -join "`n").Trim() }
    return [pscustomobject]@{ Code = $code; Out = (& $clean $so); Err = (& $clean $se) }
}
# a long step inside the distro: its output goes straight to this window
function Invoke-WslLive([string[]]$A) {
    # wsl.exe writes straight to this console, nothing in between: piped through PowerShell with WSL_UTF8, its Korean
    # progress lines came out with every letter twice (Windows QA 2026-11-28). Without WSL_UTF8 here: the console
    # shows wsl.exe's own text as Windows writes it; Linux output is UTF-8 (the console's code page is UTF-8, above).
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'wsl.exe'
    $psi.Arguments = (@($A | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
    $psi.UseShellExecute = $false
    if ($psi.EnvironmentVariables.ContainsKey('WSL_UTF8')) { $psi.EnvironmentVariables.Remove('WSL_UTF8') }
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        $p.WaitForExit()
        return $p.ExitCode
    } catch {
        Write-Note "wsl.exe did not start: $($_.Exception.Message)"
        return 1
    }
}
function Get-WslVersion {
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { return $null }
    $r = Invoke-Wsl @('--version')
    if ($r.Code -ne 0) { return $null }
    # the first line, in the language of Windows ("WSL version: 2.6.1.0" in English): the first number in it
    $m = [regex]::Match(($r.Out -split "`n")[0], '(\d+)\.(\d+)\.(\d+)')
    if (-not $m.Success) { return $null }
    return [version]('{0}.{1}.{2}' -f $m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value)
}
# installed (or running) distros by name; a message such as "no installed distributions" is not a name of them
function Get-DistroName([switch]$Running) {
    $a = if ($Running) { @('--list', '--running', '--quiet') } else { @('--list', '--quiet') }
    $r = Invoke-Wsl $a
    if ($r.Code -ne 0) { return @() }
    $names = @($r.Out -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Za-z0-9._-]+$' })
    if (-not $Running) { return $names }
    $all = Get-DistroName
    return @($names | Where-Object { $all -contains $_ })
}
# the distro's WSL version (1 or 2) from "wsl -l -v": "* TrinaAX   Running   2"
function Get-DistroWslVersion([string]$Name) {
    $r = Invoke-Wsl @('--list', '--verbose')
    foreach ($line in ($r.Out -split "`n")) {
        $f = @(($line -replace '^\s*\*?\s*', '') -split '\s+' | Where-Object { $_ })
        if ($f.Count -ge 3 -and $f[0] -eq $Name) { return [int]$f[-1] }
    }
    return 0
}
# a file into the distro through wsl.exe's standard input (the distro has no C: drive: /etc/wsl.conf turns the drive
# mounts and Windows interop off). $From: a file on this PC, or $Text (written with LF line ends, no BOM).
function Copy-ToDistro([string]$LinuxPath, [string]$From = '', [string]$Text = $null) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'wsl.exe'
    $psi.Arguments = "-d $Distro --cd / -u root --exec /bin/sh -c `"umask 077 && mkdir -p -- `$(dirname -- `$1) && cat > `$1`" sh $LinuxPath"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['WSL_UTF8'] = '1'
    $failed = ''
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    } catch { return [pscustomobject]@{ Code = 1; Out = "wsl.exe did not start: $($_.Exception.Message)" } }
    # (stderr read while stdin is written: a full stderr pipe must not stall the copy)
    $errTask = $p.StandardError.ReadToEndAsync()
    try {
        if ($From) { $in = [IO.File]::OpenRead($From); try { $in.CopyTo($p.StandardInput.BaseStream) } finally { $in.Dispose() } }
        else { $b = (New-Object System.Text.UTF8Encoding($false)).GetBytes(($Text -replace "`r`n", "`n")); $p.StandardInput.BaseStream.Write($b, 0, $b.Length) }
    } catch {
        # the distro side ended early (it did not start, the disk is full): the copy stopped
        $failed = $_.Exception.Message
    } finally {
        try { $p.StandardInput.Close() } catch { if (-not $failed) { $failed = $_.Exception.Message } }
    }
    $p.WaitForExit()
    $err = ($errTask.Result -replace "`0", '').Trim()
    $code = $p.ExitCode
    if ($failed -and $code -eq 0) { $code = 1 }
    return [pscustomobject]@{ Code = $code; Out = (@($err, $failed) | Where-Object { $_ }) -join ' ' }
}
# run a command of the setup helper (below) in the distro as root
$HelperLinux = '/root/.trina-wsl-setup.sh'
function Invoke-Helper([string]$Step, [string[]]$More = @(), [switch]$Live) {
    $a = @('-d', $Distro, '--cd', '/', '-u', 'root', '--exec', '/bin/bash', $HelperLinux, $Step) + @($More | Where-Object { $_ })
    if ($Live) { return Invoke-WslLive $a }
    return Invoke-Wsl $a
}

# ---- the steps run inside Debian, as root. Copied into the distro (/root/.trina-wsl-setup.sh, through wsl.exe's
# standard input) and run with bash. "install" is the Linux guide's "Download, verify, check" and "Install" blocks
# (docs/INSTALL-LINUX.en.md), unchanged: a new, empty folder, the checksum from SHA256SUMS, verify-bundle,
# install-linux.sh check, then install. A kit from this PC (-KitPath) skips only the download. ----
$HelperScript = @'
#!/bin/bash
# Trina AX on Windows: the steps scripts/windows/install-wsl-server.ps1 runs inside the WSL distro, as root.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BASE=/var/lib/mycel
UPLOAD=/root/.trina-upload
cmd=${1:-}
[ $# -eq 0 ] || shift
port() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["port"])' "$BASE/root/install.json" 2>/dev/null || echo 47820; }
healthy() { local p i; p=$(port); for i in 1 2 3 4 5 6 7 8 9 10 11 12; do curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$p/api/health" && return 0; sleep 5; done; return 1; }
# set_key SECTION KEY VALUE: KEY=VALUE in [SECTION] of $f (the key's other lines in that section go; the rest stays)
set_key() {
  awk -v s="$1" -v k="$2" -v v="$3" '
    /^[[:space:]]*\[/ { h = $0; gsub(/[[:space:]]/, "", h); ins = (tolower(h) == "[" s "]"); print; if (ins) { print k "=" v; seen = 1 }; next }
    ins { t = $0; sub(/^[[:space:]]*/, "", t); if (index(t, k) == 1 && substr(t, length(k) + 1) ~ /^[[:space:]]*=/) next }
    { print }
    END { if (!seen) { if (NR) print ""; print "[" s "]"; print k "=" v } }' "$f" > "$f.new"
  mv "$f.new" "$f"
}
case "$cmd" in
  os)
    . /etc/os-release
    echo "${ID:-unknown} ${VERSION_ID:-unknown}"
    ;;
  wslconf)
    # systemd on; Windows interop off (a Linux program, the AI's sandbox included, cannot start Windows programs) and
    # no C: drive in Linux (it cannot read or change the PC's files); root as the default user.
    # "on": all of it is in effect. "set": /etc/wsl.conf says so and the distro must start again (wsl --terminate).
    f=${TRINA_WSL_CONF:-/etc/wsl.conf}  # (the tests point it elsewhere)
    want='boot systemd true
interop enabled false
interop appendWindowsPath false
automount enabled false
automount mountFsTab false
user default root'
    [ -f "$f" ] || : > "$f"
    before=$(cat "$f")
    while read -r sec key val; do set_key "$sec" "$key" "$val"; done <<< "$want"
    if [ "$before" != "$(cat "$f")" ]; then printf '%s\n' "$before" > "$f.trina-backup"; echo set; exit 0; fi
    live=1
    # (the tests set TRINA_PID1 and TRINA_MOUNTS)
    [ "${TRINA_PID1:-$(cat /proc/1/comm 2>/dev/null)}" = systemd ] || live=0
    # interop is off when WSL gives this session no interop socket (WSL 3.0.5 keeps its binfmt entry even then:
    # Windows QA 2026-11-28; a Windows program then fails to start)
    [ -z "${WSL_INTEROP:-}" ] || live=0
    ! grep -qE '^[^ ]+ /mnt/[a-z] ' "${TRINA_MOUNTS:-/proc/mounts}" 2>/dev/null || live=0
    if [ "$live" = 1 ]; then echo on; else echo set; fi
    ;;
  bootstrap)
    # only what downloading and checking the kit needs (INSTALL-LINUX "Requirements": curl and Python 3); the
    # installer then installs everything else from the kit's own list (scripts/system/packages.json)
    need=()
    for p in ca-certificates curl python3; do
      dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || need+=("$p")
    done
    if [ ${#need[@]} -eq 0 ]; then echo "curl and Python 3 are installed"; exit 0; fi
    echo "installing ${need[*]} (for the download and its check)"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends "${need[@]}"
    ;;
  state)
    # none: not installed. ok <version>: installed and the server answers. broken <version>: installed, no answer
    # (an install that stopped half-way, or a server that does not start)
    if [ ! -f "$BASE/root/install.json" ] || [ ! -L "$BASE/app/current" ]; then echo none; exit 0; fi
    v=$(basename "$(readlink -f "$BASE/app/current")")
    if healthy; then echo "ok $v"; else echo "broken $v"; fi
    ;;
  clearupload)
    # an earlier -KitPath copy that stopped half-way: an empty folder for the next one
    rm -rf -- "$UPLOAD"
    ;;
  haskit)
    if [ -x /root/trina-ax-kit/install-linux.sh ]; then echo yes; else echo no; fi
    ;;
  port)
    port
    ;;
  install)
    SRC=${1:?source}
    ARCH=${2:?arch}
    shift 2
    ENGINES=()
    for e in "$@"; do ENGINES+=(--engine "$e"); done
    # a new, empty download folder (the guide's first line)
    W=$(mktemp -d /root/trina-ax-kit.XXXXXX)
    # a run that stops before the installer leaves nothing behind; once the installer ran, the unpacked kit stays
    # for repairs (its install-linux.sh: /root/trina-ax-kit, docs/INSTALL-WINDOWS.md)
    OK=0 RAN=0 V=''
    trap 'if [ "$OK" = 1 ] || [ "$RAN" = 1 ]; then ln -sfn "$W/TrinaAX-server-$V-linux-$ARCH" /root/trina-ax-kit; else cd / && rm -rf -- "$W"; fi' EXIT
    cd "$W"
    if [ "$SRC" = local ]; then
      # a kit and its SHA256SUMS from this PC (-KitPath, -SumsPath): only the download differs
      KIT=$(cd "$UPLOAD" && ls -- TrinaAX-server-*-linux-"$ARCH".tar.gz 2>/dev/null | head -n 1)
      [ -n "$KIT" ] && [ -f "$UPLOAD/SHA256SUMS" ] || { echo "no kit for $ARCH or no SHA256SUMS was copied" >&2; exit 1; }
      V=${KIT#TrinaAX-server-}
      V=${V%-linux-$ARCH.tar.gz}
      mv -- "$UPLOAD/$KIT" "$UPLOAD/SHA256SUMS" .
      rm -rf -- "$UPLOAD"
    else
      V=$SRC
      if [ "$V" = latest ]; then
        V=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/trina-app/trina-ax/releases/latest)
        V=${V##*/v}
      fi
    fi
    [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "not a release version: $V" >&2; exit 1; }
    echo "release $V ($ARCH)"
    BASE_URL="https://github.com/trina-app/trina-ax/releases/download/v$V"
    KIT="TrinaAX-server-$V-linux-$ARCH.tar.gz"
    if [ "$SRC" != local ]; then
      curl -fLO "$BASE_URL/$KIT"
      curl -fLO "$BASE_URL/SHA256SUMS"
    fi
    python3 - "$KIT" <<'CHECK'
import hashlib, pathlib, sys
name = sys.argv[1]
entries = {parts[1].lstrip('*'): parts[0] for line in pathlib.Path('SHA256SUMS').read_text().splitlines() if len(parts := line.split()) == 2}
assert name in entries, 'Artifact missing from SHA256SUMS'
assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == entries[name], 'Checksum mismatch'
print('Checksum OK')
CHECK
    tar xzf "$KIT"
    cd "TrinaAX-server-$V-linux-$ARCH"
    ./app/$V/root/mycel-ctl verify-bundle "./app/$V"
    ./install-linux.sh check --from .
    RAN=1
    ./install-linux.sh install --from . "${ENGINES[@]}"
    OK=1
    rm -f -- "$W/$KIT"
    mycel-ctl status || true
    ;;
  repair)
    # an install that stopped half-way: the installer again, with the arguments it recorded (root/install.json)
    cd /root/trina-ax-kit
    ./install-linux.sh repair --from .
    mycel-ctl status || true
    ;;
  status)
    mycel-ctl status
    ;;
  setupcode)
    # the one-time setup code while the team has no owner yet (nothing once it is spent)
    if [ -f "$BASE/setup/code" ] && [ -e "$BASE/data/setup-token" ]; then tr -d '[:space:]' < "$BASE/setup/code"; fi
    ;;
  *)
    echo "unknown step: $cmd" >&2
    exit 2
    ;;
esac
'@

# ---- the keep-alive: while this Windows user is signed in, one wsl.exe stays attached to the distro. WSL stops a
# distro about 15 s after its last wsl.exe ends, and systemd's services do not count. If WSL is stopped or updated,
# the loop attaches again after 10 s. ----
$KeepAliveScript = @'
# Trina AX: keeps the WSL distro "@DISTRO@" (the team server) running while this Windows user is signed in.
# Written by install-wsl-server.ps1; the task "Keep the Trina AX server running" (Task Scheduler, folder TrinaAX)
# starts it at sign-in. To stop the server for a while: disable that task, then run  wsl --terminate @DISTRO@
$env:WSL_UTF8 = '1'
while ($true) {
    & wsl.exe -d '@DISTRO@' --cd / -u root --exec /usr/bin/sleep infinity
    Start-Sleep -Seconds 10
}
'@

function Write-LfFile([string]$Path, [string]$Text) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), $utf8)
}
$SidSystem = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$SidAdmins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$SidUsers = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')
function Test-ReparsePoint($Item) { return [bool]($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) }
# %ProgramData%\TrinaAX holds the scripts the elevated restart task and the keep-alive task run. Any user may make a
# folder in ProgramData, so one that someone else made first is moved aside, never used. Ours is owned by
# Administrators, administrators and SYSTEM may change it, everyone else only reads; every entry in it gets that
# (a link in it is removed, not followed) before this script writes there.
function Initialize-DataDir {
    if (-not (Test-Change $DataDir 'create or take over the folder for the setup files (owner Administrators; administrators may change it, others only read)')) { return $false }
    if (Test-Path -LiteralPath $DataDir) {
        $item = Get-Item -LiteralPath $DataDir -Force
        $owner = (Get-Acl -LiteralPath $DataDir).GetOwner([System.Security.Principal.SecurityIdentifier])
        if ((Test-ReparsePoint $item) -or -not $item.PSIsContainer -or (($owner -ne $SidAdmins) -and ($owner -ne $SidSystem))) {
            $aside = "$DataDir.untrusted-$(Get-Date -Format yyyyMMdd-HHmmss)"
            Rename-Item -LiteralPath $DataDir -NewName (Split-Path -Leaf $aside)
            Write-Note "$DataDir was not made by an administrator: moved to $aside (not used). Delete it once you have looked at it."
        }
    }
    if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $none = [System.Security.AccessControl.PropagationFlags]::None
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner($SidAdmins)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($SidSystem, $SidAdmins)) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $none, 'Allow')))
    }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($SidUsers, 'ReadAndExecute', $inherit, $none, 'Allow')))
    Set-Acl -LiteralPath $DataDir -AclObject $acl
    foreach ($e in @(Get-ChildItem -LiteralPath $DataDir -Force)) {
        if (Test-ReparsePoint $e) {
            if ($e.PSIsContainer) { [IO.Directory]::Delete($e.FullName, $false) } else { [IO.File]::Delete($e.FullName) }
            continue
        }
        if ($e.PSIsContainer) { Exit-Setup "$($e.FullName) is a folder this setup did not make. Move it out of $DataDir, then run this again." }
        $fa = New-Object System.Security.AccessControl.FileSecurity
        $fa.SetOwner($SidAdmins)
        $fa.SetAccessRuleProtection($false, $false)
        Set-Acl -LiteralPath $e.FullName -AclObject $fa
    }
    return $true
}

# ---- .wslconfig: a memory limit only when it has none; an existing file is copied first and otherwise kept ----
# the current plan's AC value of a sleep setting (STANDBYIDLE, HIBERNATEIDLE) in seconds, or -1 when it cannot be read.
# powercfg prints in the language of Windows; the "AC" line with a hex number is the same in each ("Current AC Power
# Setting Index: 0x00000708", Korean too).
function Get-AcSleepSetting([string]$Setting) {
    $text = & powercfg.exe /query SCHEME_CURRENT SUB_SLEEP $Setting 2>$null | Out-String
    $m = [regex]::Match($text, 'AC[^\r\n:]*:\s*0x([0-9a-fA-F]+)')
    if (-not $m.Success) { return -1 }
    return [Convert]::ToInt32($m.Groups[1].Value, 16)
}
function Get-MemoryCapGB([double]$TotalGB, [int]$Wanted) {
    if ($Wanted -gt 0) { return $Wanted }
    if ($TotalGB -lt 12) { return 5 }    # 8 GB PC: Windows keeps about 3 GB
    if ($TotalGB -lt 16) { return 6 }
    if ($TotalGB -lt 24) { return 8 }
    if ($TotalGB -lt 32) { return 12 }
    return 16
}
# returns the new text, or $null when the file already has a memory line in [wsl2]
function Get-MergedWslConfig([string]$Text, [int]$CapGB) {
    $nl = if ($Text -match "`r`n") { "`r`n" } else { "`n" }
    $lines = [Collections.Generic.List[string]]::new()
    if ($Text) { foreach ($l in ($Text -split "`r?`n")) { $lines.Add($l) } }
    $section = ''; $wsl2At = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $t = $lines[$i].Trim()
        if ($t -match '^\[(.+)\]$') { $section = $Matches[1].Trim().ToLowerInvariant(); if ($section -eq 'wsl2' -and $wsl2At -lt 0) { $wsl2At = $i }; continue }
        if ($section -eq 'wsl2' -and $t -match '^memory\s*=') { return $null }
    }
    $add = @("# Trina AX server: memory Linux may use (install-wsl-server.ps1). Applies after: wsl --shutdown", "memory=${CapGB}GB")
    if ($wsl2At -ge 0) { $lines.InsertRange($wsl2At + 1, [string[]]$add) }
    else {
        while ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim() -eq '') { $lines.RemoveAt($lines.Count - 1) }
        if ($lines.Count -gt 0) { $lines.Add('') }
        $lines.Add('[wsl2]'); $lines.AddRange([string[]]$add)
    }
    return (($lines -join $nl).TrimEnd() + $nl)
}

# ============================================================================================================
Write-Host ''
Write-Host "$ProductName server on Windows (WSL2) - setup" -ForegroundColor White
if ($script:DryRun) { Write-Note 'Dry run (-WhatIf): this shows what would change and changes nothing.' }
if ($Resume) { Write-Note 'Windows restarted: the setup goes on where it stopped.' }
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { Write-Verbose 'console encoding unchanged' }

# ---- 1. this PC ----
Write-Step '1/8  Checking this PC'
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Exit-Setup 'Run PowerShell as administrator: right-click Windows PowerShell, then "Run as administrator", and start this again.'
}
# WSL, the distro, the task and .wslconfig belong to one Windows user: the one signed in at this screen
$consoleUser = $null
try { $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName } catch { Write-Verbose 'no console user' }
if ($consoleUser -and ($consoleUser -ne $me.Name)) {
    Exit-Setup "This window runs as $($me.Name), but $consoleUser is signed in to Windows. The server lives in one Windows account: sign in to Windows with an administrator account that will keep the server, and run this from there (not with another account's password)."
}
$userName = $me.Name
Write-Ok "Windows account: $userName (the server runs while this account is signed in)"

$os = Get-CimInstance Win32_OperatingSystem
$build = [int]$os.BuildNumber
if ($build -ge 22000) { Write-Ok "$($os.Caption) (build $build)" }
elseif ($build -ge 19045) { Write-Note "$($os.Caption) (build $build): works, but Windows 10 gets no more regular updates. Windows 11 is recommended." }
else { Exit-Setup "$($os.Caption) (build $build) is too old for WSL2 with systemd. You need Windows 11, or Windows 10 version 22H2 (build 19045) with its updates." }

$cpuArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($cpuArch) {
    'AMD64' { $Arch = 'amd64' }
    'ARM64' { $Arch = 'arm64' }
    default { Exit-Setup "This PC's processor ($cpuArch) is not supported: a 64-bit PC (x64 or ARM64) is needed." }
}
Write-Ok "Processor: $cpuArch"

$ramBytes = 0
try { $ramBytes = (Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum } catch { Write-Verbose 'no memory modules listed' }
if (-not $ramBytes) { $ramBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory }
$ramGB = [math]::Round($ramBytes / 1GB, 1)
if ($ramGB -lt 7.5) { Exit-Setup "This PC has $ramGB GB of memory. The server needs at least 8 GB (16 GB recommended)." }
elseif ($ramGB -lt 15) { Write-Note "Memory: $ramGB GB. Enough for a small team; 16 GB is recommended (an AI turn with documents took about 2.4 GB in Linux)." }
else { Write-Ok "Memory: $ramGB GB" }

$cs = Get-CimInstance Win32_ComputerSystem
$virtOk = [bool]$cs.HypervisorPresent
if (-not $virtOk) { $virtOk = [bool](@(Get-CimInstance Win32_Processor | Where-Object { $_.VirtualizationFirmwareEnabled }).Count) }
if (-not $virtOk) {
    Exit-Setup 'Virtualization is off in this PC''s firmware (BIOS/UEFI). Restart into the BIOS/UEFI settings and turn on "Intel Virtualization Technology (VT-x)" or "AMD-V / SVM Mode", then run this again.'
}
Write-Ok 'Virtualization is on'

$sysDrive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
$freeGB = [math]::Round($sysDrive.FreeSpace / 1GB, 0)
if ($freeGB -lt 20) { Exit-Setup "Drive $($env:SystemDrive) has $freeGB GB free. The server needs at least 20 GB, plus room for the team's files and backups." }
elseif ($freeGB -lt 40) { Write-Note "Drive $($env:SystemDrive): $freeGB GB free. Enough to start; the team's files and backups need more over time." }
else { Write-Ok "Drive $($env:SystemDrive): $freeGB GB free" }

# a kit from this PC (-KitPath): its file name says the version and the processor; SHA256SUMS comes with it
if ($KitPath -or $SumsPath) {
    if (-not ($KitPath -and $SumsPath)) { Exit-Setup '-KitPath and -SumsPath go together: the kit file and the SHA256SUMS file of its release.' }
    foreach ($f in @($KitPath, $SumsPath)) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Exit-Setup "$f is not a file." } }
    $KitPath = (Resolve-Path -LiteralPath $KitPath).Path
    $SumsPath = (Resolve-Path -LiteralPath $SumsPath).Path
    $kitName = Split-Path -Leaf $KitPath
    if ($kitName -notmatch "^TrinaAX-server-[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?-linux-$Arch\.tar\.gz$") {
        Exit-Setup "$kitName is not a server kit for this PC (TrinaAX-server-<version>-linux-$Arch.tar.gz)."
    }
    Write-Ok "Kit from this PC: $kitName (checked like a download: checksum, signature, the installer's check)"
}

$onBattery = $false
try { $onBattery = [bool](Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue) } catch { Write-Verbose 'no battery' }

# the restart task of an earlier run has done its work once this runs
if (Get-ScheduledTask -TaskPath $TaskPath -TaskName $ResumeTask -ErrorAction SilentlyContinue) {
    if (Test-Change $ResumeTask 'remove the one-time task that continued the setup after the restart') {
        Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $ResumeTask -Confirm:$false
    }
}

# continue after a restart: a one-time task at this user's next sign-in starts this script again (elevated, in a window)
function Register-ResumeTask {
    if (-not (Initialize-DataDir)) { return }
    $copy = Join-Path $DataDir 'install-wsl-server.ps1'
    if ($PSCommandPath -and ($PSCommandPath -ne $copy)) { Copy-Item -LiteralPath $PSCommandPath -Destination $copy -Force }
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$copy`"", '-Resume', '-Distro', $Distro, '-Version', $Version,
        '-KeepAwake', $KeepAwake, '-OpenSetup', $OpenSetup, '-Engine', $Engine)
    if ($MemoryGB -gt 0) { $a += @('-MemoryGB', "$MemoryGB") }
    if ($KitPath) { $a += @('-KitPath', "`"$KitPath`"", '-SumsPath', "`"$SumsPath`"") }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($a -join ' ')
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
    $principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3)
    if (Test-Change $ResumeTask 'add a one-time task that continues this setup when you sign in after the restart') {
        Register-ScheduledTask -TaskPath $TaskPath -TaskName $ResumeTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    }
}
function Request-Restart([string]$Why) {
    Register-ResumeTask
    Write-Host ''
    Write-Note "$Why Windows must restart once."
    Write-Info 'After you sign in again with this account, the setup goes on by itself in a new window.'
    Write-Info 'If no window opens, run the same command again.'
    if ($script:DryRun) { Write-Info 'Dry run: the steps after the restart show when you run -WhatIf again after it.'; exit 0 }
    if ((Read-YesNo -Question 'Restart Windows now? Save your work in other programs first.' -Answer 'Ask' -Default $true)) {
        if (Test-Change $env:COMPUTERNAME 'restart Windows') { Restart-Computer -Force }
    } else {
        Write-Info 'Restart Windows yourself when you are ready.'
    }
    exit 0
}

# ---- 2. Windows features ----
Write-Step '2/8  Windows features for WSL'
$restart = $false
foreach ($f in @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux')) {
    $state = (Get-WindowsOptionalFeature -Online -FeatureName $f).State
    if ("$state" -eq 'Enabled') { Write-Ok "$f is on"; continue }
    if ("$state" -eq 'EnablePending') { Write-Note "$f is turned on and waits for a restart"; $restart = $true; continue }
    if (Test-Change $f 'turn on the Windows feature') {
        $r = Enable-WindowsOptionalFeature -Online -FeatureName $f -All -NoRestart -WarningAction SilentlyContinue
        Write-Ok "$f turned on"
        if ($r.RestartNeeded) { $restart = $true }
    } else { $restart = $true }
}
if ($restart) { Request-Restart 'The WSL features are turned on.' }

# ---- 3. WSL itself, and its memory limit ----
Write-Step '3/8  WSL'
$wslV = Get-WslVersion
if ((-not $wslV) -or ($wslV -lt $MinWslVersion)) {
    # no WSL, the old one built into Windows (no "wsl --version", no systemd) or an older one: the current WSL
    $what = if ($wslV) { "update WSL $wslV to the current version (wsl --update)" } else { 'install the current WSL (wsl --update, else wsl --install --no-distribution)' }
    if (Test-Change 'WSL' $what) {
        $code = 1
        if (Get-Command wsl.exe -ErrorAction SilentlyContinue) { $code = Invoke-WslLive @('--update', '--web-download') }
        $wslV = Get-WslVersion
        if (-not $wslV) {
            $code = Invoke-WslLive @('--install', '--no-distribution', '--web-download')
            $wslV = Get-WslVersion
        }
        if (-not $wslV) {
            if ($code -eq 0) { Request-Restart 'WSL is installed.' }
            Exit-Setup "Installing WSL failed (wsl.exe exit code $code). Check that this PC can reach the internet (github.com and the Microsoft download servers)."
        }
        if ($wslV -lt $MinWslVersion) { Exit-Setup "WSL is still $wslV after the update; $MinWslVersion or newer is needed. Run  wsl --update  yourself, then this again." }
    }
}
if ($wslV) { Write-Ok "WSL $wslV" }

$cfgPath = Join-Path $env:USERPROFILE '.wslconfig'
$cap = Get-MemoryCapGB -TotalGB $ramGB -Wanted $MemoryGB
# (the server offers video renders from 3.5 GB of Linux memory and keeps 25% of it for printing and converters)
if ($cap -lt 4) { Write-Note "$cap GB is little for the server: answers with documents may fail, and below 4 GB it makes no videos." }
$oldCfg = if (Test-Path -LiteralPath $cfgPath) { [IO.File]::ReadAllText($cfgPath) } else { '' }
$merged = Get-MergedWslConfig $oldCfg $cap
if ($null -eq $merged) {
    Write-Ok "$cfgPath already sets a memory limit: kept as it is"
} elseif (Test-Change $cfgPath "set the memory Linux may use to $cap GB") {
    if ($oldCfg) {
        $backup = "$cfgPath.trina-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item -LiteralPath $cfgPath -Destination $backup
        Write-Info "Your .wslconfig was copied to $backup first."
    }
    Write-LfFile $cfgPath ($merged -replace "`n", "`r`n")
    Write-Ok "Linux may use up to $cap GB of memory ($cfgPath)"
    # WSL reads the file when it starts: restart it if it runs (other distros stop for a moment)
    $running = @(Get-DistroName -Running)
    if ($running.Count -gt 0) {
        if (Read-YesNo -Question "WSL must restart to use the new memory limit. This stops the running Linux distros ($($running -join ', ')) for a moment. Restart WSL now?" -Answer 'Ask' -Default $true -Unattended $false) {
            $null = Invoke-Wsl @('--shutdown')
        } else { Write-Info 'The memory limit applies after the next  wsl --shutdown  or restart of Windows.' }
    }
}

# ---- 4. the Debian distro ----
Write-Step "4/8  Debian for the server (WSL distro `"$Distro`")"
$haveDistro = (Get-DistroName) -contains $Distro
if (-not $haveDistro) {
    if (Test-Change $Distro 'install Debian as a new WSL distro (wsl --install --distribution Debian --name ... --no-launch --web-download)') {
        # --no-launch: no first-start prompt for a Linux user name (everything here runs as root)
        $code = Invoke-WslLive @('--install', '--distribution', 'Debian', '--name', $Distro, '--no-launch', '--web-download')
        $haveDistro = (Get-DistroName) -contains $Distro
        if (-not $haveDistro) { Exit-Setup "Installing Debian failed (wsl.exe exit code $code). Check the internet connection and run this again." }
        Write-Ok "Debian installed as `"$Distro`""
    }
} else { Write-Ok "`"$Distro`" is installed" }

if ($haveDistro) {
    if ((Get-DistroWslVersion $Distro) -eq 1) {
        if (Test-Change $Distro 'convert the distro to WSL 2 (wsl --set-version ... 2)') {
            if ((Invoke-WslLive @('--set-version', $Distro, '2')) -ne 0) { Exit-Setup "Converting `"$Distro`" to WSL 2 failed." }
        }
    }
    # the helper, into the distro through wsl.exe's standard input (no file on this PC, nothing read from C:)
    if (Test-Change $Distro "copy the setup steps into the distro ($HelperLinux)") {
        $c = Copy-ToDistro -LinuxPath $HelperLinux -Text $HelperScript
        if ($c.Code -ne 0) { Exit-Setup "The distro `"$Distro`" does not start, or the setup steps could not be copied into it ($($c.Out))." }
        $script:HelperReady = $true
    }
}
$ready = $haveDistro -and (Test-Path variable:script:HelperReady)
if ($ready) {
    $osr = (Invoke-Helper os).Out
    if ($osr -notmatch '^debian (12|13)$') {
        Exit-Setup "The WSL distro `"$Distro`" is $osr, not Debian 12 or 13. Choose another name for the server: add  -Distro TrinaAXServer  to the command."
    }
    Write-Ok "Debian $($osr -replace '^debian ', '')"
    # /etc/wsl.conf: systemd on, Windows interop off, no C: drive inside Linux, root as the default user
    $sd = Invoke-Helper wslconf
    if ($sd.Code -ne 0) { Exit-Setup "Could not read or change /etc/wsl.conf: $($sd.Err) $($sd.Out)" }
    if ($sd.Out -match 'set$') {
        if (Test-Change $Distro 'start the distro again with its new /etc/wsl.conf (wsl --terminate)') {
            $null = Invoke-Wsl @('--terminate', $Distro)
            $c = Copy-ToDistro -LinuxPath $HelperLinux -Text $HelperScript
            if ($c.Code -ne 0) { Exit-Setup "The distro `"$Distro`" does not start again ($($c.Out))." }
            if ((Invoke-Helper wslconf).Out -notmatch 'on$') { Exit-Setup "The settings in /etc/wsl.conf of `"$Distro`" do not take effect (systemd, interop off, no drive mounts). Run  wsl --shutdown , then this again. If it still fails, WSL may be too old: run  wsl --update ." }
        }
    }
    Write-Ok 'systemd runs; Linux cannot start Windows programs or see drive C:'
}

# ---- 5. curl and Python 3 (the download and its check need them; a new Debian has neither) ----
Write-Step '5/8  Tools for the download'
if ($ready -and (Test-Change $Distro 'install curl, ca-certificates and python3 if missing (apt-get)')) {
    if ((Invoke-Helper bootstrap -Live) -ne 0) { Exit-Setup 'Installing curl and Python 3 failed (see above). Check the internet connection.' }
    Write-Ok 'curl and Python 3'
}

# ---- 6. the Trina AX server: the Linux kit, checked as in docs/INSTALL-LINUX.en.md, then install-linux.sh ----
Write-Step "6/8  $ProductName server"
# none: install. ok: installed and answering, nothing to do. broken: installed but not answering (an install that
# stopped half-way): the installer's repair from the kept kit, or a new install when there is no kit
$state = if ($ready) { (Invoke-Helper state).Out } else { '' }
$installed = ''
if ($state -match '^ok (.+)$') {
    $installed = $Matches[1]
    Write-Ok "$ProductName $installed is installed and answers. It updates itself; nothing to do here."
} elseif ($ready) {
    $repair = ($state -match '^broken ') -and ((Invoke-Helper haskit).Out -eq 'yes')
    $source = if ($KitPath) { "the kit $KitPath" } else { "the $Version server kit" }
    $what = if ($repair) { 'repair the installed server that does not answer (install-linux.sh repair)' } else { "get $source, check its checksum and signature, and install it (install-linux.sh install)" }
    if ($state -match '^broken (.+)$') { Write-Note "$ProductName $($Matches[1]) is installed but does not answer: the setup tries again." }
    if (Test-Change $Distro $what) {
        Write-Info 'This takes 10 to 30 minutes on a new PC. Lines keep coming while it works; leave the window open.'
        if ($repair) { $code = Invoke-Helper 'repair' -Live }
        else {
            $src = $Version
            if ($KitPath) {
                # a kit from this PC: copied into an empty folder, then checked exactly like a download
                $cu = Invoke-Helper clearupload
                if ($cu.Code -ne 0) { Exit-Setup "Could not empty /root/.trina-upload in the distro ($($cu.Err))." }
                foreach ($pair in @(@($KitPath, "/root/.trina-upload/$(Split-Path -Leaf $KitPath)"), @($SumsPath, '/root/.trina-upload/SHA256SUMS'))) {
                    $c = Copy-ToDistro -LinuxPath $pair[1] -From $pair[0]
                    if ($c.Code -ne 0) { Exit-Setup "Copying $($pair[0]) into the distro failed ($($c.Out))." }
                }
                $src = 'local'
            }
            $code = Invoke-Helper 'install' (@($src, $Arch) + ($Engine -split ',')) -Live
        }
        if ($code -ne 0) { Exit-Setup "The server install stopped (exit code $code; the reason is above). Run this again after fixing it: finished steps are skipped." }
        $state = (Invoke-Helper state).Out
        if ($state -notmatch '^ok (.+)$') { Exit-Setup "The server is installed but does not answer ($state). See  wsl -d $Distro --cd / -u root -- mycel-ctl status , then run this again." }
        $installed = $Matches[1]
        Write-Ok "$ProductName $installed installed"
    }
}

# ---- 7. keep it running: the sign-in task, and no sleep on power ----
Write-Step '7/8  Keeping the server running'
if (Initialize-DataDir) {
    $kaPath = Join-Path $DataDir 'keep-alive.ps1'
    Write-LfFile $kaPath (($KeepAliveScript -replace '@DISTRO@', $Distro) -replace "`n", "`r`n")
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$kaPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
    $principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    if (Test-Change $KeepAliveTask 'add or update the task that keeps the server running while you are signed in, and start it') {
        Register-ScheduledTask -TaskPath $TaskPath -TaskName $KeepAliveTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
            -Description "Keeps the WSL distro $Distro (the $ProductName team server) running while $userName is signed in. Added by install-wsl-server.ps1." -Force | Out-Null
        $t = Get-ScheduledTask -TaskPath $TaskPath -TaskName $KeepAliveTask
        if ("$($t.State)" -ne 'Running') { Start-ScheduledTask -TaskPath $TaskPath -TaskName $KeepAliveTask }
        Write-Ok "Task `"$KeepAliveTask`" (Task Scheduler, folder TrinaAX): the server runs while $userName is signed in"
        Write-Info 'Locking the screen is fine. Signing out, or a restart without signing in again, stops the server.'
    }
}
if (Read-YesNo -Question 'Stop this PC from going to sleep while it is plugged in? The server cannot answer while the PC sleeps.' -Answer $KeepAwake -Default $true) {
    $standby = Get-AcSleepSetting 'STANDBYIDLE'
    $hibernate = Get-AcSleepSetting 'HIBERNATEIDLE'
    if (($standby -eq 0) -and ($hibernate -eq 0)) {
        Write-Ok 'This PC already never sleeps while it is plugged in'
    } elseif (Test-Change 'Power options' 'never sleep or hibernate on AC power (powercfg /change standby-timeout-ac 0, hibernate-timeout-ac 0), after noting the values it has now') {
        # what it was, for the uninstall (docs/INSTALL-WINDOWS.md): kept from the first change, never overwritten
        $before = Join-Path $DataDir 'power-before.json'
        if ((Initialize-DataDir) -and -not (Test-Path -LiteralPath $before)) {
            $scheme = ([regex]::Match((& powercfg.exe /getactivescheme | Out-String), '[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}')).Value
            Write-LfFile $before ((@{ scheme = $scheme; standbyAcSeconds = $standby; hibernateAcSeconds = $hibernate } | ConvertTo-Json) + "`n")
        }
        & powercfg.exe /change standby-timeout-ac 0
        & powercfg.exe /change hibernate-timeout-ac 0
        Write-Ok "This PC no longer sleeps while it is plugged in (the screen still turns off). Before: $before"
    }
} else {
    Write-Note 'Sleep settings unchanged: while this PC sleeps, the team cannot reach the server.'
}
if ($onBattery) { Write-Note 'This PC has a battery: keep it plugged in. On battery it may still sleep, and closing the lid may put it to sleep.' }

# ---- 8. check and open ----
Write-Step '8/8  Checking the server'
if ($ready -and $installed) {
    $port = (Invoke-Helper port).Out
    if ($port -notmatch '^\d+$') { $port = '47820' }
    $url = "http://127.0.0.1:$port"
    $ok = $false
    for ($i = 0; $i -lt 24 -and -not $ok; $i++) {
        try {
            $r = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 5
            $ok = ($r.StatusCode -eq 200)
        } catch { Start-Sleep -Seconds 5 }
    }
    if ($ok) { Write-Ok "The server answers at $url" }
    else { Write-Note "The server does not answer at $url yet. Check it with:  wsl -d $Distro --cd / -u root -- mycel-ctl status" }

    $code = (Invoke-Helper setupcode).Out
    Write-Host ''
    if ($code) {
        Write-Host "   Next: open $url/setup on this PC and create the owner account and the team." -ForegroundColor White
        Write-Info "The setup page asks for the one-time setup code. To see it:  wsl -d $Distro --cd / -u root -- cat $LinuxBase/setup/code"
        if ($ok -and (Read-YesNo -Question 'Open the setup page in the browser now? The setup code goes to the clipboard: paste it there.' -Answer $OpenSetup -Default $true)) {
            # (on the clipboard, not in the address: an address is on the browser's command line, which other
            # programs on this PC can read)
            Set-Clipboard -Value $code
            Start-Process "$url/setup"
        }
    } else {
        Write-Host "   $ProductName runs at $url on this PC." -ForegroundColor White
        if ($ok -and (Read-YesNo -Question 'Open it in the browser now?' -Answer $OpenSetup -Default $true)) { Start-Process $url }
    }
    Write-Info "The Trina AX desktop app on this PC: paste $url as the team address on its first screen."
    Write-Info 'Other computers and phones reach it once you give it an https address: see "Reach it from other computers" in docs/INSTALL-WINDOWS.md.'
    Write-Info "Status:  wsl -d $Distro --cd / -u root -- mycel-ctl status"
} elseif ($script:DryRun) {
    Write-Info 'Dry run: nothing was changed. Run it without -WhatIf to install.'
}
Write-Host ''
Wait-Resumed
