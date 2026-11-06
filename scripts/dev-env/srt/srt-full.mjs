// Full internet for one run of the dev environment (docs/DECISIONS.md "Dev environment: sites a person allows").
// install-srt.sh puts this file next to srt's cli.js as full.mjs, owned by root. It runs srt's own CLI, but gives
// SandboxManager an ask callback for the hosts that are on no list. srt calls the callback only when strictAllowlist is
// false (the runner writes false only for a person who turned Full internet on), and only after its deny list (the
// team server, metadata names). With strictAllowlist true this file acts as cli.js.
//
// The callback allows a public host NAME only. srt's resolved-address guard then refuses a name that resolves to a loopback,
// link-local, metadata, private (deniedResolvedAddresses) or own address. The guard does not judge an IP literal or the
// loopback names (srt 0.0.81 resolved-address-guard.js: "hostnames only"), so the callback refuses those itself:
// 127.0.0.1, 169.254.169.254, 2852039166, 0x7f.1, [::1], localhost and *.localhost never pass (macOS check 2026-11-06:
// without this, 127.0.0.1 and 169.254.169.254 went through the proxy).
import { isIP } from 'node:net'
import { SandboxManager } from './node_modules/@anthropic-ai/sandbox-runtime/dist/index.js'
import { canonicalizeHost } from './node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js'

/** Names of the local network and of metadata services. The same list as LOCAL_SUFFIXES in
 * shared/src/dev-env-domains.ts (this file cannot import it; tests/unit/dev-env-srt.test.ts checks that they agree). */
export const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'corp', 'home', 'home.arpa', 'intranet', 'private', 'localdomain', 'test', 'invalid', 'example']

/** A host name that is not an address, not a local name and not under a denied host; anything else is refused.
 * `denied`: the settings' deniedDomains. srt checks them before the callback, but on its own canonical form, which
 * keeps one of two trailing dots ("team.example.com.."): this check does not depend on that. */
export function fullAllows(host, denied = []) {
  const raw = String(host ?? '').replace(/^\[|\]$/g, '')
  if (!raw || raw.includes('%')) return false
  const c = (canonicalizeHost(raw) ?? '').toLowerCase()
  // one trailing dot is the same name; more than one, or an empty label, is not a host name
  const h = c.endsWith('.') ? c.slice(0, -1) : c
  if (!h || h.endsWith('.') || h.includes('..') || isIP(h) || isIP(raw)) return false
  if (LOCAL_SUFFIXES.some((s) => h === s || h.endsWith('.' + s))) return false
  for (const d of denied) {
    const n = String(d).toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
    if (n && (h === n || h.endsWith('.' + n))) return false
  }
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(h)
}

const ask = (denied) => async ({ host }) => (fullAllows(host, denied) ? true : { allow: false, reason: 'Full internet allows public host names only, not addresses, local names or the team server' })

const initialize = SandboxManager.initialize
SandboxManager.initialize = (config, _ask, ...rest) =>
  initialize(config, config?.network?.strictAllowlist === false ? ask([...(config.network.deniedDomains ?? [])]) : undefined, ...rest)

if (process.argv[2] !== '--self-test') await import('./cli.js')
else {
  const denied = ['team.trina.app']
  const no = ['127.0.0.1', '169.254.169.254', '2852039166', '0x7f.1', '127.1', '127.0.0.1.', '[::1]', '::ffff:127.0.0.1', 'localhost', 'localhost.', 'a.localhost', '10.0.0.1', 'fe80::1%eth0', 'x', '',
    'metadata.google.internal', 'printer.local', 'router.lan', 'team.trina.app', 'Team.Trina.App.', 'team.trina.app..', 'x.team.trina.app', 'a..example.com']
  const yes = ['example.com', 'example.com.', 'api.example.co.uk', 'trina.app']
  const bad = [...no.filter((h) => fullAllows(h, denied)), ...yes.filter((h) => !fullAllows(h, denied))]
  console.log(bad.length ? `bad: ${bad.join(', ')}` : 'ok')
  process.exit(bad.length ? 1 : 0)
}
