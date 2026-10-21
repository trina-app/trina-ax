// Security regression, round 4 (office-lan 2): the office CA's DNS name constraint carried the Mac's bare Bonjour
// name next to <host>.local. An RFC 5280 dNSName constraint permits every name below it, so for a Mac named like a
// real top-level domain (dental, clinic, dentist, office) a leaked tls/ca.key could sign certificates for every
// public site under that TLD, and every desk that trusts the CA would accept them. tls.ts promises it could not
// impersonate "a bank, any public site".
//
// Port of scratchpad repro-ca-bare-host-constraint.sh: make the CA as office mode does for a Mac called "dental",
// sign leaf certificates with its key, and check them with /usr/bin/openssl verify (which enforces name
// constraints). A CA made by an older version (bare name in its constraint) is made again.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ensureOfficeTls, tlsPaths } from '../../server/src/office/tls'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'security', 'r4-office-ca-tld')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const NET: [string, string][] = [['192.168.77.0', '255.255.255.0']]
const openssl = (args: string[], cwd = BASE) => Bun.spawnSync(['/usr/bin/openssl', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })

/** sign a leaf for `name` with the CA in `dir` and verify it against that CA; true = accepted */
function accepted(dir: string, name: string): boolean {
  const p = tlsPaths(dir)
  const d = fs.mkdtempSync(path.join(BASE, 'leaf-'))
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'k'], d)
  openssl(['req', '-new', '-key', 'k', '-subj', `/CN=${name}`, '-out', 'csr'], d)
  fs.writeFileSync(path.join(d, 'ext'), `basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${name}\n`)
  const s = openssl(['x509', '-req', '-in', 'csr', '-CA', p.caCrt, '-CAkey', p.caKey, '-CAcreateserial', '-CAserial', 'srl', '-days', '30', '-extfile', 'ext', '-out', 'crt'], d)
  expect(s.exitCode, s.stderr.toString()).toBe(0)
  const v = openssl(['verify', '-CAfile', p.caCrt, path.join(d, 'crt')])
  return v.exitCode === 0 && v.stdout.toString().includes(': OK')
}

const PUBLIC = ['www.smile.dental', 'login.bank.dental', 'www.x.dental', 'dental']

describe('the office CA never vouches for names under a TLD that happens to be the Mac\'s name', () => {
  test('a new CA for a Mac called "dental": only dental.local', () => {
    const dir = path.join(BASE, 'new')
    const t = ensureOfficeTls(dir, { host: 'dental', addrs: ['192.168.77.10'], subnets: NET })
    expect(t.constraints.dns).toEqual(['dental.local'])
    expect(t.names.dns).toEqual(['dental.local'])
    for (const n of PUBLIC) expect(accepted(dir, n), n).toBe(false)
    expect(accepted(dir, 'www.example.com')).toBe(false) // control: always refused
    expect(accepted(dir, 'dental.local')).toBe(true) // the Mac's own name still works
  })

  test('a CA made by an older version (bare name in the constraint) is made again on the next start', () => {
    const dir = path.join(BASE, 'old')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // what caConstraintsFor used to write: DNS:<host>.local and DNS:<host>
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key'], dir)
    const nc = 'nameConstraints=critical,permitted;DNS:dental.local,permitted;DNS:dental,permitted;IP:192.168.77.0/255.255.255.0'
    const r = openssl(['req', '-new', '-x509', '-sha256', '-key', 'ca.key', '-days', '3650', '-subj', '/O=Team AX/CN=old office CA',
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', nc, '-out', 'ca.crt'], dir)
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    fs.chmodSync(path.join(dir, 'ca.key'), 0o600)
    fs.writeFileSync(path.join(dir, 'ca.json'), JSON.stringify({ format: 1, constraints: { dns: ['dental.local', 'dental'], v4: NET, v6: [] } }))
    expect(accepted(dir, 'www.smile.dental')).toBe(true) // the hole the old CA had

    const t = ensureOfficeTls(dir, { host: 'dental', addrs: ['192.168.77.10'], subnets: NET })
    expect(t.caMade).toBe(true)
    expect(t.reason).toMatch(/new office CA/)
    expect(t.constraints.dns).toEqual(['dental.local'])
    for (const n of PUBLIC) expect(accepted(dir, n), n).toBe(false)
    expect(accepted(dir, 'dental.local')).toBe(true)
    // kept, not served: the old CA stays beside it with its date
    expect(fs.readdirSync(dir).some((f) => f.startsWith('ca.crt.old-'))).toBe(true)
    // and it is not made again on the following start
    expect(ensureOfficeTls(dir, { host: 'dental', addrs: ['192.168.77.10'], subnets: NET }).caMade).toBe(false)
  })

  test('with TEAMAX_CA_CONSTRAINTS=0 the owner chose no constraints: an existing CA is kept as it is', () => {
    const dir = path.join(BASE, 'none')
    const a = ensureOfficeTls(dir, { host: 'dental', addrs: ['192.168.77.10'], subnets: NET, constraints: false })
    const b = ensureOfficeTls(dir, { host: 'dental', addrs: ['192.168.77.10'], subnets: NET, constraints: false })
    expect(b.caMade).toBe(false)
    expect(b.ca.fingerprint256).toBe(a.ca.fingerprint256)
  })
})
