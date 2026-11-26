// Windows Authenticode signing with SSL.com eSigner (docs/RELEASE-CI.md 11장 "윈도우 코드 서명").
//
// electron-builder signs the app's .exe files, the uninstaller and the NSIS installer through `win.signtoolOptions.sign`
// before it writes latest.yml, so the sha512 there is the signed file's. This hook runs SSL.com's CodeSignTool
// (`java -jar code_sign_tool-<v>.jar sign … -override`, the release job installs a pinned, sha256-checked copy) for
// each file, then checks the signature it made with Get-AuthenticodeSignature: CodeSignTool can print an error and still
// exit 0, so its exit code alone proves nothing.
//
// Off unless MYCEL_WIN_SIGN_PROVIDER is `sslcom` (the release job sets it from the repository variable
// WINDOWS_SIGNING_PROVIDER): local builds, dev builds and a repository without a certificate build the unsigned
// installer exactly as before. Switched on with a credential missing, or an unknown provider, fails the build instead of
// shipping an unsigned installer by accident.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface WinSignSettings {
  provider: 'sslcom'
  /** the SSL.com account's username and password (eSigner signs as this account) */
  username: string
  password: string
  /** the eSigner signing credential (a UUID: CodeSignTool get_credential_ids) */
  credentialId: string
  /** the eSigner TOTP secret, so CodeSignTool makes the one-time code itself */
  totpSecret: string
  /** the CodeSignTool folder (conf/, jar/) the release job unpacked */
  toolDir: string
}

const SECRETS = {
  username: 'MYCEL_SSLCOM_USERNAME',
  password: 'MYCEL_SSLCOM_PASSWORD',
  credentialId: 'MYCEL_SSLCOM_CREDENTIAL_ID',
  totpSecret: 'MYCEL_SSLCOM_TOTP_SECRET',
} as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** the signing settings from the environment; null = build unsigned (MYCEL_WIN_SIGN_PROVIDER empty) */
export function winSignSettings(env: Record<string, string | undefined> = process.env): WinSignSettings | null {
  const provider = env.MYCEL_WIN_SIGN_PROVIDER?.trim().toLowerCase() ?? ''
  if (!provider) return null
  if (provider !== 'sslcom') throw new Error(`MYCEL_WIN_SIGN_PROVIDER is not a known signing provider: ${provider} (only sslcom)`)
  const v = Object.fromEntries(Object.entries(SECRETS).map(([k, name]) => [k, env[name]?.trim() ?? ''])) as Record<keyof typeof SECRETS, string>
  const toolDir = env.MYCEL_WIN_SIGN_TOOL?.trim() ?? ''
  const missing = [...Object.entries(SECRETS).filter(([k]) => !v[k as keyof typeof SECRETS]).map(([, name]) => name),
    ...(toolDir ? [] : ['MYCEL_WIN_SIGN_TOOL'])]
  if (missing.length) throw new Error(`Windows signing is switched on but half set up: ${missing.join(', ')} missing`)
  if (!UUID.test(v.credentialId)) throw new Error('MYCEL_SSLCOM_CREDENTIAL_ID is not an eSigner credential id (a UUID)')
  if (/\s/.test(v.totpSecret)) throw new Error('MYCEL_SSLCOM_TOTP_SECRET has white space in it')
  return { provider, ...v, toolDir }
}

/** the CodeSignTool jar in the unpacked folder (exactly one jar/code_sign_tool-*.jar) */
export function toolJar(toolDir: string): string {
  const dir = path.join(toolDir, 'jar')
  const jars = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^code_sign_tool-[\d.]+\.jar$/.test(f)) : []
  if (jars.length !== 1) throw new Error(`Windows signing: expected one code_sign_tool-*.jar in ${dir}, found ${jars.length}`)
  return path.join(dir, jars[0]!)
}

/** java from JAVA_HOME (actions/setup-java sets it), else the one on PATH */
export function javaBin(env: Record<string, string | undefined> = process.env): string {
  const home = env.JAVA_HOME?.trim()
  return home ? path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
}

/** CodeSignTool's arguments that sign one file in place (exported for the unit test). Passed as an argument list,
 * never through a shell or a .bat, so a password with special characters reaches Java unchanged. */
export function signArgs(file: string, s: WinSignSettings, jar: string): string[] {
  return ['-jar', jar, 'sign', `-username=${s.username}`, `-password=${s.password}`, `-credential_id=${s.credentialId}`,
    `-totp_secret=${s.totpSecret}`, `-input_file_path=${file}`, '-override']
}

/** the check after each signature: Valid, with a timestamp (it stays valid after the certificate expires) */
export const CHECK_PS = [
  '$ErrorActionPreference = "Stop"',
  '$s = Get-AuthenticodeSignature -LiteralPath $env:MYCEL_SIGNED_FILE',
  '@{ status = "$($s.Status)"; message = "$($s.StatusMessage)"; subject = "$($s.SignerCertificate.Subject)"; timestamped = ($null -ne $s.TimeStamperCertificate) } | ConvertTo-Json -Compress',
].join('; ')

export interface SignatureState { status: string; message: string; subject: string; timestamped: boolean }

/** the environment of the signature check: the build's, without the SSL.com credentials (it needs none) */
export function checkEnv(file: string, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env, MYCEL_SIGNED_FILE: file }
  for (const name of Object.values(SECRETS)) delete out[name]
  return out
}

function checkSignature(file: string): SignatureState {
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', CHECK_PS], {
    env: checkEnv(file), encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`Get-AuthenticodeSignature failed for ${file}: ${r.stderr || r.error}`)
  return JSON.parse(r.stdout.trim()) as SignatureState
}

/** a CodeSignTool output that reports a failure (it may still exit 0) */
export function toolFailed(out: string): boolean {
  return /\berror\b|exception/i.test(out)
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** signs one file and checks it; three tries (15 s, 30 s apart) so a passing hiccup of eSigner, the timestamp server or
 * the network does not fail the release */
export function signFile(file: string, s: WinSignSettings, deps = { run: spawnSync, check: checkSignature, pause }): void {
  const jar = toolJar(s.toolDir)
  for (let attempt = 1; ; attempt++) {
    let problem: string
    const r = deps.run(javaBin(), signArgs(file, s, jar), {
      cwd: s.toolDir, env: { ...process.env, CODE_SIGN_TOOL_PATH: s.toolDir }, encoding: 'utf8', timeout: 5 * 60_000,
    })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    if (out) console.log(out)
    if (r.status !== 0 || r.error) problem = `CodeSignTool exited ${r.status ?? r.error}`
    else if (toolFailed(out)) problem = 'CodeSignTool reported an error'
    else {
      const sig = deps.check(file)
      if (sig.status === 'Valid' && sig.timestamped) {
        console.log(`signed: ${file} (${sig.subject})`)
        return
      }
      problem = sig.status === 'Valid' ? 'the signature has no timestamp' : `the signature is ${sig.status}: ${sig.message}`
    }
    if (attempt >= 3) throw new Error(`Windows signing failed for ${file}: ${problem}`)
    console.warn(`signing ${file} failed (try ${attempt} of 3): ${problem}`)
    deps.pause(15_000 * attempt)
  }
}

/** what electron-builder's `win` gets: nothing (unsigned) or the signing hook, one SHA-256 signature per file */
export function winSignOptions(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const s = winSignSettings(env)
  if (!s) return {}
  toolJar(s.toolDir) // fail at config time, not after the app is packed
  return {
    signtoolOptions: {
      // one signature per file: eSigner signs with SHA-256 (no SHA-1 dual signature)
      signingHashAlgorithms: ['sha256'],
      sign: (task: { path: string }) => signFile(task.path, s),
    },
  }
}
