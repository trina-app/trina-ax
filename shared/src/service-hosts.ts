// The hosted service's addresses: where hosted team addresses live, the official relay, and the pages the relay links
// to. They live here and only here. An edition with its own hosted service (editions/<name>/branding/service.json)
// writes its values into this file with `bun scripts/edition-service.ts editions/<name>/branding/service.json --apply`.
// Contract test vectors (shared/src/cloud-protocol/vectors*) keep their own example hosts on purpose.
export const SERVICE_HOSTS = {
  /** hosted team addresses are https://<team>.<teamDomain> */
  teamDomain: 'trina.app',
  /** the official relay the team server may connect to (Admin > System) */
  officialRelayUrl: 'wss://relay.trina.app/connect',
  /** where people get a claim code and manage the hosted service */
  accountHost: 'account.trina.app',
  /** the service status page */
  statusHost: 'status.trina.app',
} as const

/** Is this host the hosted service's own (the official relay, a hosted team address)? */
export function isServiceHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === SERVICE_HOSTS.teamDomain || h.endsWith(`.${SERVICE_HOSTS.teamDomain}`)
}
