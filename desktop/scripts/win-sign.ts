// Windows Authenticode signing with Microsoft Artifact Signing (docs/RELEASE-CI.md 11장 "윈도우 코드 서명").
//
// electron-builder signs the app's .exe files, the uninstaller and the NSIS installer through `win.signtoolOptions.sign`
// before it writes latest.yml, so the sha512 there is the signed file's. This hook runs ./win-sign.ps1, which calls
// Invoke-ArtifactSigning (the ArtifactSigning PowerShell module the release job installs at a pinned version). It signs
// in with the Azure CLI session that azure/login (OIDC) left on the runner: no Azure secret is stored anywhere.
//
// Off unless all three MYCEL_WIN_SIGN_* variables are set (the release job sets them from repository variables): local
// builds, dev builds and a repository without a signing account build the unsigned installer exactly as before. Half
// of them set is a mistake and fails the build instead of shipping an unsigned installer by accident.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface WinSignSettings {
  /** the account's region endpoint, e.g. https://krc.codesigning.azure.net */
  endpoint: string
  /** the Artifact Signing account name */
  account: string
  /** the certificate profile name (Public Trust) */
  profile: string
}

const ENDPOINT = /^https:\/\/[a-z0-9]{2,8}\.codesigning\.azure\.net\/?$/
// Azure's naming rules for accounts (3-24) and certificate profiles (5-100): letters, digits and single hyphens,
// starting with a letter, ending with a letter or digit
const ACCOUNT = /^[A-Za-z](?!.*--)[A-Za-z0-9-]{1,22}[A-Za-z0-9]$/
const PROFILE = /^[A-Za-z](?!.*--)[A-Za-z0-9-]{3,98}[A-Za-z0-9]$/

/** the signing settings from the environment; null = build unsigned (no MYCEL_WIN_SIGN_* variable set) */
export function winSignSettings(env: Record<string, string | undefined> = process.env): WinSignSettings | null {
  const endpoint = env.MYCEL_WIN_SIGN_ENDPOINT?.trim() ?? ''
  const account = env.MYCEL_WIN_SIGN_ACCOUNT?.trim() ?? ''
  const profile = env.MYCEL_WIN_SIGN_PROFILE?.trim() ?? ''
  if (!endpoint && !account && !profile) return null
  const missing = Object.entries({ MYCEL_WIN_SIGN_ENDPOINT: endpoint, MYCEL_WIN_SIGN_ACCOUNT: account, MYCEL_WIN_SIGN_PROFILE: profile })
    .filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) throw new Error(`Windows signing is half set up: ${missing.join(', ')} missing`)
  if (!ENDPOINT.test(endpoint)) throw new Error(`MYCEL_WIN_SIGN_ENDPOINT is not an Artifact Signing endpoint: ${endpoint}`)
  if (!ACCOUNT.test(account)) throw new Error(`MYCEL_WIN_SIGN_ACCOUNT is not an Artifact Signing account name: ${account}`)
  if (!PROFILE.test(profile)) throw new Error(`MYCEL_WIN_SIGN_PROFILE is not a certificate profile name: ${profile}`)
  return { endpoint, account, profile }
}

/** ./win-sign.ps1, found from the build's working directory (desktop/: `bun run --cwd desktop dist:win`). Not
 * __dirname: electron-builder loads the config through its own loader (config-file-ts compiled it into a cache folder
 * up to 26.0; jiti since 26.x), so the build folder is the sure way to find the script. */
export function signScript(cwd = process.cwd()): string {
  const script = path.join(cwd, 'scripts', 'win-sign.ps1')
  if (!fs.existsSync(script)) throw new Error(`Windows signing: ${script} not found (build from desktop/)`)
  return script
}

/** the PowerShell arguments that sign one file (exported for the unit test) */
export function signArgs(file: string, s: WinSignSettings, script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Path', file, '-Endpoint', s.endpoint, '-Account', s.account, '-CertificateProfile', s.profile]
}

/** what electron-builder's `win` gets: nothing (unsigned) or the signing hook, one SHA-256 signature per file */
export function winSignOptions(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const s = winSignSettings(env)
  if (!s) return {}
  const script = signScript()
  return {
    signtoolOptions: {
      // one signature per file: Artifact Signing signs with SHA-256 only (no SHA-1 dual signature)
      signingHashAlgorithms: ['sha256'],
      sign: (task: { path: string }) => {
        execFileSync('pwsh', signArgs(task.path, s, script), { stdio: 'inherit' })
      },
    },
  }
}
