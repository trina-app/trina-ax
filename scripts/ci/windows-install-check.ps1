# The Windows installer as a person and the updater use it (docs/RELEASE-CI.md "데스크톱 검사"), on a GitHub windows
# runner, never on a real PC. Two unsigned NSIS installers of the same app, built by the desktop workflow with versions
# -OldVersion and -NewVersion:
#
#   pwsh scripts/ci/windows-install-check.ps1 -Old <Setup-old.exe> -New <Setup-new.exe> -OldVersion 0.5.8-ci.1 `
#     -NewVersion 0.5.8-ci.2 -Product "Trina AX" -Scheme trina-ax -LogDir <folder>
#
#   1. nothing of the app is installed (a fresh runner profile)
#   2. silent install (/S): the uninstall entry (version, quiet uninstall), the app files, the Start menu and desktop
#      shortcuts; both exes' signature status is reported (NotSigned on a pull request, Valid in a signed release;
#      a broken signature fails)
#   3. the app starts with a throw-away data folder (MYCEL_DESKTOP_USER_DATA), keeps running, writes its data and the
#      <Scheme>:// link handler that points at the installed exe; then it is stopped
#   4. install over it the way the updater does (electron-updater NsisUpdater: --updated /S --force-run): one uninstall
#      entry with the new version, the new exe, the link handler kept (installer.nsh skips an update), the app started
#      again by --force-run
#   5. silent uninstall (the entry's QuietUninstallString): entry, files, shortcuts and the link handler are gone; the
#      data folder stays (deleteAppDataOnUninstall: false)
#
# Every step is logged to -LogDir (the workflow uploads it). Only processes started from the install folder are
# stopped. Exits non-zero on the first failed check.
param(
  [Parameter(Mandatory)] [string] $Old,
  [Parameter(Mandatory)] [string] $New,
  [Parameter(Mandatory)] [string] $OldVersion,
  [Parameter(Mandatory)] [string] $NewVersion,
  [Parameter(Mandatory)] [string] $Product,
  [Parameter(Mandatory)] [string] $Scheme,
  [Parameter(Mandatory)] [string] $LogDir
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Start-Transcript -Path (Join-Path $LogDir 'install-check.log') | Out-Null
$summary = [System.Collections.Generic.List[string]]::new()
$started = Get-Date

function Ok([string] $what) { Write-Host "ok   $what"; $summary.Add("ok   $what") }
function Fail([string] $what) {
  Write-Host "FAIL $what"; $summary.Add("FAIL $what")
  Write-Summary
  throw "check failed: $what"
}
function Check([bool] $cond, [string] $what) { if ($cond) { Ok $what } else { Fail $what } }
function Write-Summary {
  if ($env:GITHUB_STEP_SUMMARY) {
    $secs = [int]((Get-Date) - $started).TotalSeconds
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "## Windows install / update check ($secs s)`n`n``````"
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $summary
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value '```'
  }
}
function Wait-Until([scriptblock] $cond, [int] $seconds, [string] $what) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  Write-Host "(waited $seconds s for: $what)"
  return $false
}

$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
# electron-builder's entry: DisplayName "<productName> <version>" under a GUID made from the appId
function Get-Entries {
  @(Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName -like "$Product *" -or $_.DisplayName -eq $Product })
}
$linkKey = "HKCU:\Software\Classes\$Scheme\shell\open\command"
function Get-Link { (Get-ItemProperty -Path $linkKey -ErrorAction SilentlyContinue).'(default)' }
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "$Product.lnk"
$startLnk = Join-Path ([Environment]::GetFolderPath('Programs')) "$Product.lnk"

function Get-AppProcs([string] $dir) {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) })
}
function Stop-App([string] $dir) {
  foreach ($p in Get-AppProcs $dir) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { } }
  Check (Wait-Until { (Get-AppProcs $dir).Count -eq 0 } 30 'the app to stop') 'the app stopped'
}
function Signature([string] $file) {
  $s = Get-AuthenticodeSignature -LiteralPath $file
  $who = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { 'no signer' }
  # NotSigned: a pull request's build (no secrets); Valid: a signed release. Anything else (HashMismatch, NotTrusted …)
  # means a signature that is there but broken.
  Check ($s.Status -in 'NotSigned', 'Valid') "signature of $(Split-Path -Leaf $file): $($s.Status) ($who)"
}
function Run-Installer([string] $exe, [string[]] $argv) {
  Write-Host "> $(Split-Path -Leaf $exe) $($argv -join ' ')"
  $p = Start-Process -FilePath $exe -ArgumentList $argv -PassThru -Wait
  Check ($p.ExitCode -eq 0) "$(Split-Path -Leaf $exe) $($argv -join ' ') exited $($p.ExitCode)"
}

$data = Join-Path $env:RUNNER_TEMP "desktop-data-$PID"
New-Item -ItemType Directory -Force -Path $data | Out-Null
$env:MYCEL_DESKTOP_USER_DATA = $data

# 1. a fresh profile
Check ((Get-Entries).Count -eq 0) 'no uninstall entry before the install'
Check (-not (Test-Path $desktopLnk) -and -not (Test-Path $startLnk)) 'no shortcuts before the install'
Check (-not (Get-Link)) "no ${Scheme}:// handler before the install"
Signature $Old
Signature $New

# 2. silent install
Run-Installer $Old @('/S')
Check (Wait-Until { (Get-Entries).Count -eq 1 } 60 'the uninstall entry') 'one uninstall entry after the install'
$entry = (Get-Entries)[0]
$entry | Format-List | Out-String | Write-Host
Check ($entry.DisplayVersion -eq $OldVersion) "entry version $($entry.DisplayVersion) (expected $OldVersion)"
Check ([bool] $entry.QuietUninstallString) "quiet uninstall: $($entry.QuietUninstallString)"
$dir = $entry.InstallLocation
if (-not $dir) { $dir = Split-Path -Parent (($entry.UninstallString -split '"')[1]) }
$exe = Join-Path $dir "$Product.exe"
Check (Test-Path $exe) "the app at $exe"
Check (Test-Path (Join-Path $dir 'resources\app.asar')) 'resources\app.asar'
Check (Test-Path (Join-Path $dir "Uninstall $Product.exe")) "Uninstall $Product.exe"
Check (Test-Path $startLnk) "Start menu shortcut $startLnk"
Check (Test-Path $desktopLnk) "desktop shortcut $desktopLnk"
Signature $exe
$oldFileVersion = (Get-Item $exe).VersionInfo.ProductVersion
Ok "exe product version $oldFileVersion"
Get-ChildItem $dir | Out-String | Write-Host

# 3. it starts (a window, no team), keeps running, writes its data and the link handler
$app = Start-Process -FilePath $exe -PassThru
Check (Wait-Until { (Get-ChildItem $data -Force -ErrorAction SilentlyContinue).Count -gt 0 } 60 'the app to write its data folder') "the app writes its data folder ($data)"
Check (Wait-Until { (Get-Link) -like "*$exe*" } 30 'the link handler') "${Scheme}:// handler: $(Get-Link)"
Start-Sleep -Seconds 5
Check (-not $app.HasExited) "the app is still running after start (pid $($app.Id))"
Stop-App $dir

# 4. install over it like the updater
Run-Installer $New @('--updated', '/S', '--force-run')
Check (Wait-Until { $e = Get-Entries; $e.Count -eq 1 -and $e[0].DisplayVersion -eq $NewVersion } 120 'the new version in the entry') "one uninstall entry, version $NewVersion"
Check (Test-Path $exe) 'the app is still at the same place'
$newFileVersion = (Get-Item $exe).VersionInfo.ProductVersion
Check ($newFileVersion -ne $oldFileVersion) "exe product version $oldFileVersion -> $newFileVersion"
Check ((Get-Link) -like "*$exe*") "${Scheme}:// handler kept over the update"
Check (Wait-Until { (Get-AppProcs $dir).Count -gt 0 } 60 'the app started by --force-run') 'the app runs again after the update (--force-run)'
Start-Sleep -Seconds 5
Check ((Get-AppProcs $dir).Count -gt 0) 'the updated app is still running'
Stop-App $dir

# 5. silent uninstall
$quiet = (Get-Entries)[0].QuietUninstallString
Write-Host "> $quiet"
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $quiet -PassThru -Wait
Check ($p.ExitCode -eq 0) "uninstall exited $($p.ExitCode)"
# the uninstaller copies itself to %TEMP% and runs from there: wait for its result, not its first process
Check (Wait-Until { (Get-Entries).Count -eq 0 } 120 'the entry to go') 'no uninstall entry after the uninstall'
Check (Wait-Until { -not (Test-Path $exe) } 60 'the app files to go') 'the app files are gone'
Check (-not (Test-Path $startLnk) -and -not (Test-Path $desktopLnk)) 'the shortcuts are gone'
Check (-not (Get-Link)) "the ${Scheme}:// handler is gone"
Check (Test-Path $data) 'the data folder stays (deleteAppDataOnUninstall: false)'
if (Test-Path $dir) { Get-ChildItem $dir -Recurse -Force | Out-String | Write-Host }

Copy-Item -Recurse -Force $data (Join-Path $LogDir 'app-data') -ErrorAction SilentlyContinue
Write-Summary
Write-Host "every install check passed in $([int]((Get-Date) - $started).TotalSeconds) s"
Stop-Transcript | Out-Null
