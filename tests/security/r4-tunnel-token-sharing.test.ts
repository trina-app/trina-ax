// Security regression, round 4 (tunnel 4): public-address.ts gave a second name the connector token of an existing
// tunnel, and removing the name never revoked it. `set <clinic2> --tunnel <clinic1's tunnel>` (or a clinic2 CNAME that
// already pointed at it) was accepted without a word and wrote clinic1's token (same tunnel id and secret) as
// clinic2's token file, which OFFICE.md says to hand to clinic2's Mac. Cloudflare spreads every name of a tunnel over
// all its connectors, so each clinic's visitors (session cookies, sign-in bodies) could reach the other's Mac.
// `remove <clinic2>` then dropped only the ingress rule: the token on clinic2's Mac kept connecting.
//
// Port of scratchpad tunnel/repro/set-shares-connector-token.sh against an in-memory Cloudflare API whose tokens are
// derived from the tunnel's secret (tests/security/lib/fake-cloudflare.ts).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { main, removeAddress, rotateAddress, setAddress } from '../../scripts/office/public-address'
import { WORK } from '../lib/env'
import { cred, fakeCloudflare, tokenConnects, writes } from './lib/fake-cloudflare'

const W = path.join(WORK, 'security', 'r4-tunnel-token-sharing')
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })
const ONE = 'clinic1.clinic-test.example', TWO = 'clinic2.clinic-test.example'
const T1 = path.join(W, 'T1'), T2 = path.join(W, 'T2')

describe('one tunnel token is never handed out for a second name by accident, and a removed name\'s token dies', () => {
  test('set <second name> --tunnel <first name\'s tunnel> is refused, nothing changed', async () => {
    const f = fakeCloudflare()
    const a = await setAddress(f.api, cred, { host: ONE, port: 52030, tokenOut: T1 })
    const n = writes(f).length
    await expect(setAddress(f.api, cred, { host: TWO, port: 52031, tunnel: a.tunnelName, tokenOut: T2 })).rejects.toThrow(/already serves clinic1\.clinic-test\.example; its connector token is the same/)
    expect(writes(f).length).toBe(n)
    expect(fs.existsSync(T2)).toBe(false) // was: a copy of clinic1's token
    // a CNAME for the second name that already points at the first name's tunnel: refused the same way
    f.dns.push({ id: 'r-two', type: 'CNAME', name: TWO, content: `${a.tunnelId}.cfargotunnel.com`, proxied: true })
    await expect(setAddress(f.api, cred, { host: TWO, port: 52031, tokenOut: T2 })).rejects.toThrow(/already serves clinic1/)
    expect(fs.existsSync(T2)).toBe(false)
    // an empty --tunnel is the default name (a tunnel of its own), not a way past the check
    const c = await setAddress(f.api, cred, { host: TWO, port: 52031, tunnel: '', tokenOut: T2 }).catch((e) => e)
    expect(String(c)).toMatch(/already serves clinic1/) // the CNAME still points at clinic1's tunnel
  })

  test('set again on a tunnel that already has connectors says whose token it is', async () => {
    const f = fakeCloudflare()
    await setAddress(f.api, cred, { host: ONE, tokenOut: T1 })
    f.tunnels[0]!.connections = 4
    const r = await setAddress(f.api, cred, { host: ONE, tokenOut: T1 })
    expect(r.connectors).toBe(4)
    expect(r.sharedWith).toEqual([])
  })

  test('with --share-tunnel the token is shared on purpose; removing a name rotates the secret so its token stops connecting', async () => {
    const f = fakeCloudflare()
    const a = await setAddress(f.api, cred, { host: ONE, port: 52030, tokenOut: T1 })
    const b = await setAddress(f.api, cred, { host: TWO, port: 52031, tunnel: a.tunnelName, shareTunnel: true, tokenOut: T2 })
    expect(b.sharedWith).toEqual([ONE])
    const old = fs.readFileSync(T2, 'utf8')
    expect(old).toBe(fs.readFileSync(T1, 'utf8')) // the same secret: why it is refused without the flag
    const NEW1 = path.join(W, 'T1-new')
    const r = await removeAddress(f.api, cred, { host: TWO, tokenOut: T2, newTokenOut: NEW1 })
    expect(tokenConnects(f, old)).toBe(false) // was true: clinic2's Mac kept connecting to clinic1's tunnel
    expect(f.calls).toContain(`DELETE /accounts/acc1/cfd_tunnel/${a.tunnelId}/connections`)
    expect(r.rotated).toEqual({ tunnelName: a.tunnelName, names: [ONE], tokenFile: NEW1 })
    expect(tokenConnects(f, fs.readFileSync(NEW1, 'utf8'))).toBe(true) // the remaining name's Mac gets this one
    expect(fs.statSync(NEW1).mode & 0o777).toBe(0o600)
    // --keep-tunnel on the last name rotates too (the kept tunnel must not take the old token)
    const before = fs.readFileSync(NEW1, 'utf8')
    await removeAddress(f.api, cred, { host: ONE, tokenOut: path.join(W, 'none'), keepTunnel: true })
    expect(tokenConnects(f, before)).toBe(false)
    expect(f.tunnels[0]!.deleted_at).toBeNull()
  })

  test('rotate <name>: a new secret for the name\'s tunnel, the new token written, every old copy dead', async () => {
    const f = fakeCloudflare()
    await setAddress(f.api, cred, { host: ONE, tokenOut: T1 })
    const old = fs.readFileSync(T1, 'utf8')
    const NEW = path.join(W, 'rotated')
    const r = await rotateAddress(f.api, cred, { host: ONE, tokenOut: NEW })
    expect(r.rotated.names).toEqual([ONE])
    expect(tokenConnects(f, old)).toBe(false)
    expect(tokenConnects(f, fs.readFileSync(NEW, 'utf8'))).toBe(true)
    // on the command line: the token is never printed
    const out: string[] = []
    const log = console.log
    console.log = (...x: unknown[]) => { out.push(x.join(' ')) }
    try { expect(await main(['rotate', ONE, '--cert', certFile(), '--token-out', NEW], () => f.api)).toBe(0) } finally { console.log = log }
    expect(out.join('\n')).not.toContain(fs.readFileSync(NEW, 'utf8'))
    expect(out.join('\n')).toContain(`teamax public-address set ${ONE}`)
  })
})

function certFile(): string {
  const f = path.join(W, 'cert.pem')
  const block = Buffer.from(JSON.stringify({ zoneID: 'z1', accountID: 'acc1', apiToken: 'A'.repeat(40) })).toString('base64')
  fs.writeFileSync(f, `-----BEGIN ARGO TUNNEL TOKEN-----\n${block}\n-----END ARGO TUNNEL TOKEN-----\n`, { mode: 0o600 })
  return f
}
