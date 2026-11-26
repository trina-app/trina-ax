// Windows code signing with SSL.com eSigner (desktop/scripts/win-sign.ts, the release job build-windows;
// docs/RELEASE-CI.md 11장): off without the switch, a loud failure when half set up, CodeSignTool called with an
// argument list (no shell), every signature checked because CodeSignTool may exit 0 on an error, and the credentials
// only as environment secrets.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkEnv, javaBin, signArgs, signFile, toolFailed, toolJar, winSignOptions, winSignSettings, type SignatureState } from '../../desktop/scripts/win-sign'

const ROOT = path.resolve(import.meta.dir, '../..')
const CRED = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e'

function fakeTool(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-sign-'))
  fs.mkdirSync(path.join(dir, 'jar'))
  fs.writeFileSync(path.join(dir, 'jar', 'code_sign_tool-1.3.2.jar'), '')
  return dir
}
const TOOL = fakeTool()
const OK = {
  MYCEL_WIN_SIGN_PROVIDER: 'sslcom',
  MYCEL_SSLCOM_USERNAME: 'acme-user',
  MYCEL_SSLCOM_PASSWORD: 'p"a ss&|^%!=',
  MYCEL_SSLCOM_CREDENTIAL_ID: CRED,
  MYCEL_SSLCOM_TOTP_SECRET: 'QUJDREVGR0g+/=',
  MYCEL_WIN_SIGN_TOOL: TOOL,
}

describe('the signing settings', () => {
  test('switch empty: unsigned, exactly as before (no signtoolOptions at all), even with credentials around', () => {
    expect(winSignSettings({})).toBeNull()
    expect(winSignSettings({ ...OK, MYCEL_WIN_SIGN_PROVIDER: ' ' })).toBeNull()
    expect(winSignOptions({})).toEqual({})
  })
  test('switched on with everything: the settings, trimmed', () => {
    expect(winSignSettings({ ...OK, MYCEL_WIN_SIGN_PROVIDER: ' SSLcom ', MYCEL_SSLCOM_USERNAME: ' acme-user ' })).toEqual({
      provider: 'sslcom', username: 'acme-user', password: OK.MYCEL_SSLCOM_PASSWORD, credentialId: CRED,
      totpSecret: OK.MYCEL_SSLCOM_TOTP_SECRET, toolDir: TOOL,
    })
  })
  test('an unknown provider (Azure was cancelled) fails the build', () => {
    expect(() => winSignSettings({ ...OK, MYCEL_WIN_SIGN_PROVIDER: 'azure' })).toThrow(/not a known signing provider/)
  })
  test('switched on but half set up fails the build and names what is missing, never the values', () => {
    expect(() => winSignSettings({ MYCEL_WIN_SIGN_PROVIDER: 'sslcom' })).toThrow(
      /MYCEL_SSLCOM_USERNAME, MYCEL_SSLCOM_PASSWORD, MYCEL_SSLCOM_CREDENTIAL_ID, MYCEL_SSLCOM_TOTP_SECRET, MYCEL_WIN_SIGN_TOOL missing/)
    let msg = ''
    try { winSignSettings({ ...OK, MYCEL_SSLCOM_TOTP_SECRET: '' }) } catch (e) { msg = String(e) }
    expect(msg).toMatch(/MYCEL_SSLCOM_TOTP_SECRET missing/)
    expect(msg).not.toContain(OK.MYCEL_SSLCOM_PASSWORD)
  })
  test('a credential id that is not a UUID, or a TOTP secret with white space, is refused', () => {
    expect(() => winSignSettings({ ...OK, MYCEL_SSLCOM_CREDENTIAL_ID: 'abc' })).toThrow(/not an eSigner credential id/)
    expect(() => winSignSettings({ ...OK, MYCEL_SSLCOM_TOTP_SECRET: 'AB CD' })).toThrow(/white space/)
  })
})

describe('the electron-builder hook', () => {
  const s = winSignSettings(OK)!
  test('CodeSignTool sign in place, the values as single arguments (no shell, so special characters survive)', () => {
    expect(signArgs('C:\\b\\App Setup.exe', s, 'C:\\t\\jar\\code_sign_tool-1.3.2.jar')).toEqual([
      '-jar', 'C:\\t\\jar\\code_sign_tool-1.3.2.jar', 'sign', '-username=acme-user', `-password=${OK.MYCEL_SSLCOM_PASSWORD}`,
      `-credential_id=${CRED}`, `-totp_secret=${OK.MYCEL_SSLCOM_TOTP_SECRET}`, '-input_file_path=C:\\b\\App Setup.exe', '-override',
    ])
    const opts = winSignOptions(OK) as { signtoolOptions: { signingHashAlgorithms: string[]; sign: unknown } }
    expect(opts.signtoolOptions.signingHashAlgorithms).toEqual(['sha256'])
    expect(typeof opts.signtoolOptions.sign).toBe('function')
  })
  test('the jar is found in the unpacked tool, and a missing one fails at config time', () => {
    expect(toolJar(TOOL)).toBe(path.join(TOOL, 'jar', 'code_sign_tool-1.3.2.jar'))
    expect(() => winSignOptions({ ...OK, MYCEL_WIN_SIGN_TOOL: path.join(TOOL, 'nope') })).toThrow(/expected one code_sign_tool/)
  })
  test('the signature check (pwsh) gets the file but none of the SSL.com credentials', () => {
    const env = checkEnv('C:\\b\\x.exe', { ...OK, PATH: '/bin' })
    expect(env.MYCEL_SIGNED_FILE).toBe('C:\\b\\x.exe')
    expect(env.PATH).toBe('/bin')
    for (const k of Object.keys(env)) expect(k.startsWith('MYCEL_SSLCOM_'), k).toBe(false)
  })
  test('java from JAVA_HOME (setup-java), else PATH', () => {
    expect(javaBin({ JAVA_HOME: '/j' })).toBe(path.join('/j', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))
    expect(javaBin({})).toBe('java')
  })

  type Run = { status: number | null; stdout: string; stderr: string; error?: Error }
  function harness(runs: Run[], sigs: SignatureState[]) {
    const calls: { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> }[] = []
    const pauses: number[] = []
    const deps = {
      run: ((cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string> }) => {
        calls.push({ cmd, args, cwd: o.cwd, env: o.env })
        return runs.shift() ?? { status: 0, stdout: '', stderr: '' }
      }) as never,
      check: () => sigs.shift() ?? { status: 'NotSigned', message: '', subject: '', timestamped: false },
      pause: (ms: number) => { pauses.push(ms); return 'ok' as const },
    }
    return { calls, pauses, deps }
  }
  const good: SignatureState = { status: 'Valid', message: '', subject: 'CN=Acme Inc., O=Acme Inc., C=KR', timestamped: true }

  test('a valid, timestamped signature on the first try: one CodeSignTool run from the tool folder', () => {
    const h = harness([{ status: 0, stdout: 'Code signed successfully: x.exe', stderr: '' }], [good])
    signFile('x.exe', s, h.deps)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.cwd).toBe(TOOL)
    expect(h.calls[0]!.env!.CODE_SIGN_TOOL_PATH).toBe(TOOL)
    expect(h.pauses).toEqual([])
  })
  test('an error printed with exit 0, then a signature without a timestamp, then success: three tries, 15 s and 30 s apart', () => {
    const h = harness([
      { status: 0, stdout: 'Error: invalid otp', stderr: '' },
      { status: 0, stdout: 'Code signed successfully', stderr: '' },
      { status: 0, stdout: 'Code signed successfully', stderr: '' },
    ], [{ ...good, timestamped: false }, good])
    signFile('x.exe', s, h.deps)
    expect(h.calls).toHaveLength(3)
    expect(h.pauses).toEqual([15_000, 30_000])
  })
  test('three failures fail the build (never an unsigned file in the release)', () => {
    const h = harness([{ status: 1, stdout: '', stderr: 'boom' }, { status: 0, stdout: 'Exception in thread', stderr: '' }, { status: 0, stdout: '', stderr: '' }],
      [{ status: 'NotSigned', message: 'no signature', subject: '', timestamped: false }])
    expect(() => signFile('x.exe', s, h.deps)).toThrow(/Windows signing failed for x\.exe: the signature is NotSigned/)
  })
  test('CodeSignTool output that means failure', () => {
    for (const t of ['Error: invalid otp', 'java.lang.NullPointerException', 'ERROR something']) expect(toolFailed(t), t).toBe(true)
    expect(toolFailed('Code signed successfully: C:\\b\\Trina.exe')).toBe(false)
  })
})

describe('the release job', () => {
  type Step = { name?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string | boolean> }
  const wf = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')) as {
    permissions: Record<string, string>
    jobs: Record<string, { environment?: string; permissions?: Record<string, string>; env?: Record<string, string>; steps?: Step[] }>
  }
  const job = wf.jobs['build-windows']!
  const steps = job.steps!
  const at = (n: string) => steps.findIndex((s) => s.name === n)
  const build = 'NSIS installer and latest.yml (signed when WINDOWS_SIGNING_PROVIDER is set, else unsigned)'

  test('read-only, in the release environment that holds the credentials, no OIDC token any more', () => {
    expect(wf.permissions).toEqual({ contents: 'read' })
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(job.environment).toBe('release')
  })
  test('the switch is a repository variable; the credentials are secrets, given only to the build step and only when switched on', () => {
    expect(job.env).toMatchObject({ MYCEL_WIN_SIGN_PROVIDER: '${{ vars.WINDOWS_SIGNING_PROVIDER }}' })
    expect(JSON.stringify(job.env)).not.toContain('secrets.')
    expect(steps[at(build)]!.env).toEqual({
      MYCEL_SSLCOM_USERNAME: "${{ vars.WINDOWS_SIGNING_PROVIDER != '' && secrets.SSLCOM_USERNAME || '' }}",
      MYCEL_SSLCOM_PASSWORD: "${{ vars.WINDOWS_SIGNING_PROVIDER != '' && secrets.SSLCOM_PASSWORD || '' }}",
      MYCEL_SSLCOM_CREDENTIAL_ID: "${{ vars.WINDOWS_SIGNING_PROVIDER != '' && secrets.SSLCOM_CREDENTIAL_ID || '' }}",
      MYCEL_SSLCOM_TOTP_SECRET: "${{ vars.WINDOWS_SIGNING_PROVIDER != '' && secrets.SSLCOM_TOTP_SECRET || '' }}",
    })
    const others = steps.filter((st) => st.name !== build)
    expect(JSON.stringify(others)).not.toContain('secrets.')
    expect(JSON.stringify(job)).not.toMatch(/AZURE_|azure\/login|RELEASE_SIGNING_KEY|CLOUDFLARE_API_TOKEN/)
  })
  test('Java and CodeSignTool are pinned and run only when signing is switched on; the build runs either way', () => {
    const java = steps[at('Java for CodeSignTool (pinned)')]!
    expect(java.uses).toMatch(/^actions\/setup-java@[0-9a-f]{40}$/)
    const tool = steps[at('SSL.com CodeSignTool (pinned, sha256 checked)')]!
    expect(job.env!.CODESIGNTOOL_VERSION).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(job.env!.CODESIGNTOOL_SHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(tool.run).toContain('Get-FileHash -Algorithm SHA256')
    expect(tool.run).toContain('$env:CODESIGNTOOL_SHA256')
    expect(tool.run).toContain('MYCEL_WIN_SIGN_TOOL=')
    for (const n of ['Java for CodeSignTool (pinned)', 'SSL.com CodeSignTool (pinned, sha256 checked)', 'The installer and the app carry a valid signature']) {
      expect(steps[at(n)]?.if, n).toBe("env.MYCEL_WIN_SIGN_PROVIDER != ''")
    }
    expect(steps[at(build)]!.if).toBeUndefined()
    expect(at('SSL.com CodeSignTool (pinned, sha256 checked)')).toBeLessThan(at(build))
    expect(at(build)).toBeLessThan(at('The installer and the app carry a valid signature'))
    expect(steps[at('The installer and the app carry a valid signature')]!.run).toContain('verify /pa /tw')
  })
})
