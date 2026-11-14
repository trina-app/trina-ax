// The hosted service's addresses: where hosted team addresses live, the official relay, the pages the relay links
// to, and the default phone push gateway. They live here and only here. An edition with its own hosted service (editions/<name>/branding/service.json)
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
  /** the phone push gateway a team server uses when its operator sets none (MYCEL_PUSH_GATEWAY, push.gatewayUrl);
   *  '' = no default, phone push stays off until the operator sets one (server/src/app-config.ts) */
  pushGatewayUrl: 'https://push.trina.app',
} as const

/** Is this host the hosted service's own (the official relay, a hosted team address)? */
export function isServiceHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === SERVICE_HOSTS.teamDomain || h.endsWith(`.${SERVICE_HOSTS.teamDomain}`)
}
