// Prometheus metrics (control-plane 3.6.6) on the PRIVATE listener: GET /metrics, text format 0.0.4. No team label
// anywhere (team ids, names and addresses stay out of the monitoring system, like the relay log: log.ts). Grafana
// Alloy on the relay host scrapes <tailnet ip>:8090/metrics.
import { monitorEventLoopDelay, type ELDHistogram } from 'node:perf_hooks'

export interface MetricsSource {
  teams: { active: number; suspended: number }
  teamsOnline: number
  ctlConnections: number
  openStreams: number
  clientWebsockets: number
  counters: Record<string, number>
}

let loop: ELDHistogram | null = null
let loopTried = false
/** event-loop delay histogram (perf_hooks; absent in runtimes that lack it, e.g. the unit tests under Bun) */
function loopDelay(): ELDHistogram | null {
  if (loopTried) return loop
  loopTried = true
  try {
    loop = monitorEventLoopDelay({ resolution: 20 })
    loop.enable()
  } catch {
    loop = null
  }
  return loop
}

type Line = [name: string, labels: Record<string, string> | null, value: number]

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')

export function renderMetrics(s: MetricsSource): string {
  const c = (k: string) => s.counters[k] ?? 0
  const out: string[] = []
  const metric = (name: string, type: 'gauge' | 'counter', help: string, lines: Line[]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
    for (const [n, labels, v] of lines) {
      const l = labels ? `{${Object.entries(labels).map(([k, x]) => `${k}="${esc(x)}"`).join(',')}}` : ''
      out.push(`${n}${l} ${Number.isFinite(v) ? v : 0}`)
    }
  }
  metric('relay_teams', 'gauge', 'Registered team addresses by status.', [['relay_teams', { status: 'active' }, s.teams.active], ['relay_teams', { status: 'suspended' }, s.teams.suspended]])
  metric('relay_teams_online', 'gauge', 'Teams with at least one live control connection.', [['relay_teams_online', null, s.teamsOnline]])
  metric('relay_ctl_connections', 'gauge', 'Team-server control connections.', [['relay_ctl_connections', null, s.ctlConnections]])
  metric('relay_open_streams', 'gauge', 'Streams (HTTP and WebSocket) in flight.', [['relay_open_streams', null, s.openStreams]])
  metric('relay_client_websockets', 'gauge', 'Browser WebSockets proxied right now.', [['relay_client_websockets', null, s.clientWebsockets]])
  metric('relay_ctl_connects_total', 'counter', 'Control connections authenticated.', [['relay_ctl_connects_total', null, c('ctlConnects')]])
  metric('relay_ctl_drops_total', 'counter', 'Control connections that went away.', [['relay_ctl_drops_total', null, c('ctlDrops')]])
  metric('relay_silent_drops_total', 'counter', 'Control connections dropped for silence (half-open).', [['relay_silent_drops_total', null, c('silentDrops')]])
  metric('relay_stall_drops_total', 'counter', 'Control connections dropped by the stall probe.', [['relay_stall_drops_total', null, c('stallDrops')]])
  metric('relay_auth_failures_total', 'counter', 'Control connections refused at authentication.', [['relay_auth_failures_total', null, c('authFail')]])
  metric('relay_tls_client_errors_total', 'counter', 'TLS handshakes refused (no or wrong client certificate, bad TLS).', [['relay_tls_client_errors_total', null, c('tlsClientErrors')]])
  metric('relay_http_requests_total', 'counter', 'Visitor HTTP requests by outcome.', [
    ['relay_http_requests_total', { outcome: 'proxied' }, c('http')],
    ['relay_http_requests_total', { outcome: 'offline' }, c('httpOffline')],
    ['relay_http_requests_total', { outcome: 'suspended' }, c('httpSuspended')],
    ['relay_http_requests_total', { outcome: 'unknown' }, c('httpUnknown')],
    ['relay_http_requests_total', { outcome: 'maintenance' }, c('httpMaintenance')],
    ['relay_http_requests_total', { outcome: 'redirect' }, c('httpRedirect')],
  ])
  metric('relay_ws_total', 'counter', 'Visitor WebSocket upgrades by outcome.', [
    ['relay_ws_total', { outcome: 'proxied' }, c('ws')],
    ['relay_ws_total', { outcome: 'offline' }, c('wsOffline')],
    ['relay_ws_total', { outcome: 'suspended' }, c('wsSuspended')],
    ['relay_ws_total', { outcome: 'unknown' }, c('wsUnknown')],
  ])
  metric('relay_bytes_total', 'counter', 'Bytes relayed (in = from visitors, out = to visitors).', [['relay_bytes_total', { dir: 'in' }, c('bytesIn')], ['relay_bytes_total', { dir: 'out' }, c('bytesOut')]])
  metric('relay_registrations_total', 'counter', 'Team addresses registered by kind.', [
    ['relay_registrations_total', { kind: 'pow' }, c('regPow')],
    ['relay_registrations_total', { kind: 'claim' }, c('regClaim')],
    ['relay_registrations_total', { kind: 'operator' }, c('regOperator')],
  ])
  metric('relay_ops_requests_total', 'counter', 'Operator API requests (all outcomes).', [['relay_ops_requests_total', null, c('opsRequests')]])
  metric('relay_ops_auth_failures_total', 'counter', 'Operator API requests refused (signature, clock, replay).', [['relay_ops_auth_failures_total', null, c('opsAuthFailures')]])
  const h = loopDelay()
  if (h) metric('nodejs_eventloop_lag_p99_seconds', 'gauge', 'Event-loop delay, 99th percentile since the last scrape.', [['nodejs_eventloop_lag_p99_seconds', null, h.percentile(99) / 1e9]])
  h?.reset()
  metric('process_resident_memory_bytes', 'gauge', 'Resident set size.', [['process_resident_memory_bytes', null, process.memoryUsage().rss]])
  return out.join('\n') + '\n'
}
