// Windows code signing with Microsoft Artifact Signing (desktop/scripts/win-sign.ts, the release job build-windows;
// docs/RELEASE-CI.md 11장): off without settings, a loud failure when half set up, one SHA-256 signature per file
// through the pinned PowerShell module, and an OIDC sign-in with no stored Azure secret.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { signArgs, signScript, winSignOptions, winSignSettings } from '../../desktop/scripts/win-sign'

const ROOT = path.resolve(import.meta.dir, '../..')
const OK = {
  MYCEL_WIN_SIGN_ENDPOINT: 'https://krc.codesigning.azure.net',
  MYCEL_WIN_SIGN_ACCOUNT: 'acme-signing',
  MYCEL_WIN_SIGN_PROFILE: 'acme-public',
}

describe('the signing settings', () => {
  test('nothing set: unsigned, exactly as before (no signtoolOptions at all)', () => {
    expect(winSignSettings({})).toBeNull()
    expect(winSignSettings({ MYCEL_WIN_SIGN_ENDPOINT: ' ', MYCEL_WIN_SIGN_ACCOUNT: '', MYCEL_WIN_SIGN_PROFILE: '' })).toBeNull()
    expect(winSignOptions({})).toEqual({})
  })
  test('all three set: the settings, trimmed', () => {
    expect(winSignSettings({ ...OK, MYCEL_WIN_SIGN_PROFILE: ' acme-public ' })).toEqual({ endpoint: OK.MYCEL_WIN_SIGN_ENDPOINT, account: 'acme-signing', profile: 'acme-public' })
  })
  test('half set up fails the build and names what is missing', () => {
    expect(() => winSignSettings({ MYCEL_WIN_SIGN_PROFILE: 'acme-public' })).toThrow(/MYCEL_WIN_SIGN_ENDPOINT, MYCEL_WIN_SIGN_ACCOUNT missing/)
    expect(() => winSignSettings({ ...OK, MYCEL_WIN_SIGN_ACCOUNT: '' })).toThrow(/MYCEL_WIN_SIGN_ACCOUNT missing/)
  })
  test('values that cannot be an Artifact Signing endpoint, account or profile are refused', () => {
    for (const endpoint of ['http://krc.codesigning.azure.net', 'https://krc.codesigning.azure.net.evil.example', 'https://evil.example/', "https://krc.codesigning.azure.net'; x"]) {
      expect(() => winSignSettings({ ...OK, MYCEL_WIN_SIGN_ENDPOINT: endpoint }), endpoint).toThrow(/not an Artifact Signing endpoint/)
    }
    for (const account of ['ab', '1acme', 'acme--sign', 'acme-', "acme'x", 'a'.repeat(25)]) {
      expect(() => winSignSettings({ ...OK, MYCEL_WIN_SIGN_ACCOUNT: account }), account).toThrow(/account name/)
    }
    for (const profile of ['abcd', 'acme public', 'acme--public', '-acme']) {
      expect(() => winSignSettings({ ...OK, MYCEL_WIN_SIGN_PROFILE: profile }), profile).toThrow(/certificate profile name/)
    }
  })
})

describe('the electron-builder hook', () => {
  test('one SHA-256 signature per file, through pwsh and win-sign.ps1 with the settings as separate arguments', () => {
    const s = winSignSettings(OK)!
    expect(signArgs('C:\\b\\App Setup.exe', s, 'C:\\d\\scripts\\win-sign.ps1')).toEqual([
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\d\\scripts\\win-sign.ps1',
      '-Path', 'C:\\b\\App Setup.exe', '-Endpoint', OK.MYCEL_WIN_SIGN_ENDPOINT, '-Account', 'acme-signing', '-CertificateProfile', 'acme-public',
    ])
    const prev = process.cwd()
    process.chdir(path.join(ROOT, 'desktop'))
    try {
      const opts = winSignOptions(OK) as { signtoolOptions: { signingHashAlgorithms: string[]; sign: unknown } }
      expect(opts.signtoolOptions.signingHashAlgorithms).toEqual(['sha256'])
      expect(typeof opts.signtoolOptions.sign).toBe('function')
    } finally { process.chdir(prev) }
  })
  test('the script is found from desktop/, and a build from elsewhere fails instead of skipping the signature', () => {
    expect(signScript(path.join(ROOT, 'desktop'))).toBe(path.join(ROOT, 'desktop/scripts/win-sign.ps1'))
    expect(() => signScript(ROOT)).toThrow(/not found/)
  })
  test('win-sign.ps1 tries only the Azure CLI sign-in, timestamps, and checks the signature it made', () => {
    const ps = fs.readFileSync(path.join(ROOT, 'desktop/scripts/win-sign.ps1'), 'utf8')
    expect(ps).toContain('Invoke-ArtifactSigning @params')
    expect(ps).toMatch(/ExcludeAzureCliCredential\s+= \$false/)
    for (const c of ['Environment', 'WorkloadIdentity', 'ManagedIdentity', 'SharedTokenCache', 'VisualStudio', 'VisualStudioCode', 'AzurePowerShell', 'AzureDeveloperCli', 'InteractiveBrowser']) {
      expect(ps, c).toMatch(new RegExp(`Exclude${c}Credential\\s+= \\$true`))
    }
    expect(ps).toContain("TimestampRfc3161                    = 'http://timestamp.acs.microsoft.com'")
    expect(ps).toContain("if ($sig.Status -ne 'Valid')")
    expect(ps).toContain('TimeStamperCertificate')
    expect(ps).toContain('if ($try -ge 3) { throw }')
  })
})

describe('the release job', () => {
  type Step = { name?: string; if?: string; uses?: string; run?: string; with?: Record<string, string> }
  const wf = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')) as {
    permissions: Record<string, string>
    jobs: Record<string, { environment?: string; permissions?: Record<string, string>; env?: Record<string, string>; steps?: Step[] }>
  }
  const job = wf.jobs['build-windows']!
  const steps = job.steps!
  const at = (n: string) => steps.findIndex((s) => s.name === n)

  test('only build-windows may ask for an OIDC token, in the release environment the Azure credential trusts', () => {
    expect(wf.permissions).toEqual({ contents: 'read' })
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    expect(job.environment).toBe('release')
  })
  test('the settings are repository variables; the Azure sign-in is OIDC with ids only, no client secret', () => {
    expect(job.env).toMatchObject({
      MYCEL_WIN_SIGN_ENDPOINT: '${{ vars.WINDOWS_SIGNING_ENDPOINT }}',
      MYCEL_WIN_SIGN_ACCOUNT: '${{ vars.WINDOWS_SIGNING_ACCOUNT }}',
      MYCEL_WIN_SIGN_PROFILE: '${{ vars.WINDOWS_SIGNING_PROFILE }}',
    })
    const login = steps.find((s) => s.uses?.startsWith('azure/login@'))!
    expect(login.uses).toMatch(/^azure\/login@[0-9a-f]{40}$/) // pinned to a commit, like every action here
    expect(login.with).toEqual({
      'client-id': '${{ secrets.AZURE_CLIENT_ID }}',
      'tenant-id': '${{ secrets.AZURE_TENANT_ID }}',
      'allow-no-subscriptions': true,
    })
    expect(JSON.stringify(job)).not.toMatch(/CLIENT_SECRET|RELEASE_SIGNING_KEY|CLOUDFLARE_API_TOKEN/)
  })
  test('module, sign-in and the signature check run only when signing is set up; the build runs either way', () => {
    for (const n of ['Artifact Signing PowerShell module (pinned)', 'Azure sign-in for code signing (OIDC)', 'The installer and the app carry a valid signature']) {
      expect(steps[at(n)]?.if, n).toBe("env.MYCEL_WIN_SIGN_PROFILE != ''")
    }
    const build = 'NSIS installer and latest.yml (signed when the WINDOWS_SIGNING_* variables are set, else unsigned)'
    expect(steps[at(build)]!.if).toBeUndefined()
    expect(steps[at('Artifact Signing PowerShell module (pinned)')]!.run).toContain('-RequiredVersion 0.1.8')
    expect(at('Azure sign-in for code signing (OIDC)')).toBeLessThan(at(build))
    expect(at(build)).toBeLessThan(at('The installer and the app carry a valid signature'))
    expect(steps[at('The installer and the app carry a valid signature')]!.run).toContain('verify /pa /tw')
  })
})
