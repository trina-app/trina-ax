// Full internet for one run of the dev environment (docs/DECISIONS.md "Dev environment: sites a person allows").
// install-srt.sh puts this file next to srt's cli.js as full.mjs, owned by root. It runs srt's own CLI, but gives
// SandboxManager an ask callback for the hosts that are on no list. srt calls the callback only when strictAllowlist is
// false (the runner writes false only for a person who turned Full internet on), and only after its deny list (the
// team server, metadata names). With strictAllowlist true this file acts as cli.js.
//
// The callback allows a host NAME only. srt's resolved-address guard then refuses a name that resolves to a loopback,
// link-local, metadata, private (deniedResolvedAddresses) or own address. The guard does not judge an IP literal or the
// loopback names (srt 0.0.81 resolved-address-guard.js: "hostnames only"), so the callback refuses those itself:
// 127.0.0.1, 169.254.169.254, 2852039166, 0x7f.1, [::1], localhost and *.localhost never pass (macOS check 2026-11-06:
// without this, 127.0.0.1 and 169.254.169.254 went through the proxy).
import { isIP } from 'node:net'
import { SandboxManager } from './node_modules/@anthropic-ai/sandbox-runtime/dist/index.js'
import { canonicalizeHost } from './node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js'

/** a host name that is not an address and not a loopback name; anything else is refused */
export function fullAllows(host) {
  const raw = String(host ?? '').replace(/^\[|\]$/g, '')
  if (!raw || raw.includes('%')) return false
  const h = (canonicalizeHost(raw) ?? '').toLowerCase().replace(/\.$/, '')
  if (!h || isIP(h) || isIP(raw)) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return false
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(h)
}

const ask = async ({ host }) => (fullAllows(host) ? true : { allow: false, reason: 'Full internet allows host names only, not addresses or local names' })

const initialize = SandboxManager.initialize
SandboxManager.initialize = (config, _ask, ...rest) =>
  initialize(config, config?.network?.strictAllowlist === false ? ask : undefined, ...rest)

if (process.argv[2] !== '--self-test') await import('./cli.js')
else {
  const no = ['127.0.0.1', '169.254.169.254', '2852039166', '0x7f.1', '127.1', '[::1]', '::ffff:127.0.0.1', 'localhost', 'a.localhost', '10.0.0.1', 'fe80::1%eth0', 'x', '']
  const yes = ['example.com', 'api.example.co.uk']
  const bad = [...no.filter((h) => fullAllows(h)), ...yes.filter((h) => !fullAllows(h))]
  console.log(bad.length ? `bad: ${bad.join(', ')}` : 'ok')
  process.exit(bad.length ? 1 : 0)
}
