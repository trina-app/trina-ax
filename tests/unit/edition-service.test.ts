// shared/src/service-hosts.ts and scripts/edition-service.ts: an edition's hosted service addresses.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { editionService, parseEditionService } from '../../scripts/edition-service'
import { isServiceHost, SERVICE_HOSTS } from '../../shared/src/service-hosts'

const ROOT = path.resolve(import.meta.dir, '../..')
const source = fs.readFileSync(path.join(ROOT, 'shared/src/service-hosts.ts'), 'utf8')
const trina = { teamDomain: 'trina.app', officialRelayUrl: 'wss://relay.trina.app/connect', accountHost: 'account.trina.app', statusHost: 'status.trina.app' }

describe('edition service hosts', () => {
  test('the official relay is under the team domain, and isServiceHost knows both', () => {
    expect(isServiceHost(new URL(SERVICE_HOSTS.officialRelayUrl.replace('wss:', 'https:')).hostname)).toBe(true)
    expect(isServiceHost(`acme.${SERVICE_HOSTS.teamDomain}`)).toBe(true)
    expect(isServiceHost(`evil${SERVICE_HOSTS.teamDomain}`)).toBe(false)
    expect(isServiceHost('relay.example.com')).toBe(false)
  })
  test('writes exactly the four fields', () => {
    const out = editionService(source, trina)
    expect(out).toContain("teamDomain: 'trina.app',")
    expect(out).toContain("officialRelayUrl: 'wss://relay.trina.app/connect',")
    expect(out).toContain("accountHost: 'account.trina.app',")
    expect(out).toContain("statusHost: 'status.trina.app',")
    expect(out.replace(/'[^'\n]*'/g, "''")).toBe(source.replace(/'[^'\n]*'/g, "''"))
    expect(editionService(out, trina)).toBe(out)
  })
  test('refuses unknown keys, bad hosts and a relay outside the team domain', () => {
    expect(() => parseEditionService({ ...trina, extra: 'x' })).toThrow()
    expect(() => parseEditionService({ ...trina, teamDomain: "trina.app'; process.exit()" })).toThrow()
    expect(() => parseEditionService({ ...trina, accountHost: 'https://account.trina.app' })).toThrow()
    expect(() => parseEditionService({ ...trina, officialRelayUrl: 'ws://relay.trina.app/connect' })).toThrow()
    expect(() => parseEditionService({ ...trina, officialRelayUrl: 'wss://relay.other.app/connect' })).toThrow()
  })
})
