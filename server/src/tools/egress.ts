// This server's public exit addresses (design tab 7 "내부망 공격", tab 3 web_fetch SSRF). web_fetch runs on the server,
// outside the engine firewall. A public page can link to the address this server's own requests come from (the page
// sees it when we fetch it), and a fetch of that address loops back through the router or NAT in front of the server
// (hairpin NAT): an office router's admin page, a NAS or camera with a port forward, or whatever a cloud host answers
// on its own public address. web_fetch and connected services refuse these addresses on every hop.
//
// How the server learns them (docs/DECISIONS.md "Exit address on every install"):
//  - the relay: its handshake answer AuthOk.seenIp, the address the control connection came from (noteEgressIp);
//  - the release feed: `GET <feed>/ip` (scripts/release/worker.js answers with the CF-Connecting-IP it saw), at start
//    and every 30 minutes, once over IPv4 and once over IPv6, through the path web_fetch's own requests take (the
//    system resolver, a raw socket pinned to the resolved address, no proxy from the environment), so it is the
//    address those requests leave from. Every install type does this (office Mac, Mac role-account install, Linux
//    self-install, hosted); a server behind a Cloudflare tunnel without a relay used to never learn it.
// "known" = since this server started, the relay reported an address, or the feed told the IPv4 one, or (a server
// without IPv4) the IPv6 one. Until then — no internet, the feed unreachable or an older feed Worker without /ip,
// MYCEL_EXIT_ADDRESS_CHECK=off — every web_fetch address needs the person's confirmation (url-gate.ts), and an
// unattended run opens none. Learned addresses are kept (up to 8): refusing an old one costs nothing.
import dns from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { PRODUCT, RELEASE_CHANNEL } from '@mycel/shared'
import type { Logger } from '../log'
import { isLocalAddress, isPublicAddress, normIp, pinnedRequest, type Target } from './web-fetch'

/** addresses kept per server (an address can change; refusing an old one costs nothing) */
export const MAX_EGRESS_IPS = 8
/** the feed's "what is my address" path (scripts/release/worker.js) */
export const EXIT_ADDRESS_PATH = '/ip'
export const EXIT_ADDRESS_URL = new URL(RELEASE_CHANNEL.feed).origin + EXIT_ADDRESS_PATH
/** one probe round (lookup, connect, answer) gives up after this */
export const PROBE_TIMEOUT_MS = 5_000
/** asked again this often once known (a changed office address is learned within this time) */
export const EGRESS_REFRESH_MS = 30 * 60_000
/** while unknown: 1, 2, 5, 10, then every 30 minutes */
export const EGRESS_RETRY_MS: readonly number[] = [60_000, 120_000, 300_000, 600_000, EGRESS_REFRESH_MS]
/** web_fetch and the schedule card wait this long at most for the first round after a start */
export const EGRESS_WAIT_MS = PROBE_TIMEOUT_MS + 1_000

interface Egress {
  ips: string[]
  /** the relay reported an address since this server started */
  relay: boolean
  /** learned from the feed since this server started */
  v4: string | null
  v6: string | null
  /** the last IPv4 round found that this machine has no IPv4 route (no address of its own, or the network unreachable) */
  v4NoRoute: boolean
  /** the first round after start (web_fetch waits for it a moment instead of asking right after a restart) */
  first: Promise<void> | null
}
const byCtx = new WeakMap<object, Egress>()
function stateOf(ctx: object): Egress {
  let e = byCtx.get(ctx)
  if (!e) { e = { ips: [], relay: false, v4: null, v6: null, v4NoRoute: false, first: null }; byCtx.set(ctx, e) }
  return e
}
function remember(e: Egress, ip: string): string {
  const n = normIp(ip)
  e.ips = [n, ...e.ips.filter((x) => x !== n)].slice(0, MAX_EGRESS_IPS)
  return n
}

/** The relay's report (AuthOk.seenIp). `ctx`: the server's AppContext (any object identifying one server instance). */
export function noteEgressIp(ctx: object, ip: string): void {
  const e = stateOf(ctx)
  remember(e, ip)
  e.relay = true
}

/** known = this server has learned its own exit address since it started (see the head of this file) */
export function egressOf(ctx: object): { known: boolean; ips: string[] } {
  const e = byCtx.get(ctx)
  return { known: !!e && (e.relay || !!e.v4 || (!!e.v6 && e.v4NoRoute)), ips: e?.ips ?? [] }
}

/** What Admin › System › Diagnostics says about it (system/ops.ts): known or not, and from where. Never the address. */
export function egressStatus(ctx: object): { known: boolean; relay: boolean; ipv4: boolean; ipv6: boolean } {
  const e = byCtx.get(ctx)
  return { known: egressOf(ctx).known, relay: !!e?.relay, ipv4: !!e?.v4, ipv6: !!e?.v6 }
}

/** Right after a start the first round may still run: wait for it, at most `ms`, before deciding "unknown". */
export async function egressSettled(ctx: object, ms = EGRESS_WAIT_MS): Promise<void> {
  const first = byCtx.get(ctx)?.first
  if (!first || egressOf(ctx).known) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([first, new Promise<void>((r) => { timer = setTimeout(r, ms) })])
  clearTimeout(timer)
}

// ---------------- asking the feed ----------------
export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>
const sysLookup: Lookup = (h) => dns.lookup(h, { all: true, verbatim: true })

/** One family's answer: the address the feed saw (`family` is the answer's own), no route of that family on this
 * machine, or why it is not known. */
export type FamilyResult = { ip: string; family: 4 | 6 } | { noRoute: string } | { error: string }
export interface ProbeResult { v4: FamilyResult; v6: FamilyResult }

export interface ProbeOptions {
  url?: string
  lookup?: Lookup
  timeoutMs?: number
  /** this machine's interfaces (tests) */
  interfaces?: ReturnType<typeof os.networkInterfaces>
  /** tests only: a local fake feed counts as public and may use any port and plain http */
  testAllow?: (ip: string) => boolean
  insecureTlsForTests?: boolean
  /** does this machine have an IPv4 default route (tests; default ipv4DefaultRoute) */
  defaultRoute4?: () => boolean | null
  /** the request (tests; default web_fetch's pinnedRequest) */
  request?: typeof pinnedRequest
}

/** Connect errors that can mean "no route of this family on this machine". EAFNOSUPPORT: the kernel has no such family.
 * ENETUNREACH and EADDRNOTAVAIL are also what a router's or firewall's ICMP "network unreachable / prohibited" answer to
 * the feed's address (or a forged one) gives, while every other IPv4 site still opens and leaves through the NAT'd
 * address nobody learned; so for IPv4 they count as "no route" only when the routing table has no IPv4 default route.
 * Otherwise the round failed (fail-safe), not "this machine has no IPv4". */
const NO_ROUTE = /could not connect \((ENETUNREACH|EADDRNOTAVAIL|EAFNOSUPPORT)\)/

/** /proc/net/route text: is there an IPv4 default route (destination and mask 0, the route up)? */
export function hasDefaultRoute4(table: string): boolean {
  return table.split('\n').slice(1).some((l) => {
    const f = l.trim().split(/\s+/)
    return f.length >= 8 && f[1] === '00000000' && f[7] === '00000000' && (parseInt(f[3]!, 16) & 1) === 1
  })
}
/** Does this machine have an IPv4 default route? Linux reads its main routing table; null = cannot tell (other systems,
 * unreadable), which never counts as "no route". */
export function ipv4DefaultRoute(): boolean | null {
  if (process.platform !== 'linux') return null
  try { return hasDefaultRoute4(fs.readFileSync('/proc/net/route', 'latin1')) } catch { return null }
}

/** Does this machine have an address of the family that can reach the internet (not loopback, not link-local)? */
function hasFamily(fam: 4 | 6, ifaces: ReturnType<typeof os.networkInterfaces>): boolean {
  return Object.values(ifaces).flat().some((i) => {
    if (!i || i.internal) return false
    const f = i.family === 'IPv4' || (i.family as unknown) === 4 ? 4 : 6
    if (f !== fam) return false
    return fam === 4 ? !i.address.startsWith('169.254.') : !/^fe[89ab]/i.test(i.address)
  })
}

const UA = `${PRODUCT.artifactBase}-exit-address/1`

/** Ask the feed which address this server's requests come from, over IPv4 and over IPv6, like web_fetch connects. */
export async function probeExitAddresses(o: ProbeOptions = {}): Promise<ProbeResult> {
  const url = new URL(o.url ?? EXIT_ADDRESS_URL)
  const deadline = Date.now() + (o.timeoutMs ?? PROBE_TIMEOUT_MS)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (url.protocol !== 'https:' && !o.testAllow) { const r = { error: 'the feed must be https' }; return { v4: r, v6: r } }
  let addrs: { address: string; family: number }[]
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }]
  else {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      addrs = await Promise.race([(o.lookup ?? sysLookup)(host), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), Math.max(0, deadline - Date.now())) })])
    } catch { const r = { error: `could not resolve ${host}` }; return { v4: r, v6: r } } finally { clearTimeout(timer) }
  }
  const ifaces = o.interfaces ?? os.networkInterfaces()
  // the feed's addresses pass web_fetch's own address rules
  const usable = (ip: string) => !!o.testAllow?.(ip) || (isPublicAddress(ip) && !isLocalAddress(ip))
  const one = async (fam: 4 | 6): Promise<FamilyResult> => {
    if (!hasFamily(fam, ifaces)) return { noRoute: `no IPv${fam} address on this machine` }
    const a = addrs.find((x) => x.family === fam && usable(x.address))
    if (!a) return { error: `${host} has no usable IPv${fam} address` }
    if (port !== 443 && port !== 80 && !o.testAllow) return { error: 'only ports 80 and 443' }
    const t: Target = { url, host, ip: a.address, family: fam, port }
    let r: Awaited<ReturnType<typeof pinnedRequest>>
    try {
      r = await (o.request ?? pinnedRequest)(t, { method: 'GET', headers: [['User-Agent', UA], ['Accept', 'text/plain'], ['Cache-Control', 'no-store']], deadline, maxBytes: 1024, insecureTlsForTests: o.insecureTlsForTests })
    } catch (e) {
      const m = String((e as Error)?.message ?? e).slice(0, 200)
      const code = NO_ROUTE.exec(m)?.[1]
      // IPv4 "no route" makes the IPv6 answer enough (egressOf): believed only from the machine itself (see NO_ROUTE)
      if (code && (fam === 6 || code === 'EAFNOSUPPORT' || (o.defaultRoute4 ?? ipv4DefaultRoute)() === false)) return { noRoute: m }
      return { error: m }
    }
    // an older feed Worker answers 404 here (scripts/release/hosting.ts setup deploys the new one)
    if (r.status !== 200) return { error: `the feed answered HTTP ${r.status}` }
    const s = r.body.toString('latin1').trim()
    const f = s.length <= 64 ? net.isIP(s) : 0
    if (f !== 4 && f !== 6) return { error: 'the feed did not answer with an address' }
    const ip = normIp(s)
    if (!o.testAllow?.(ip) && !isPublicAddress(ip)) return { error: 'the feed answered with an address that is not public' }
    return { ip, family: f }
  }
  const [v4, v6] = await Promise.all([one(4), one(6)])
  return { v4, v6 }
}

/** Take one round's answers. An answer of the other family than asked is refused like the rest but counts for neither. */
export function learnExitAddresses(ctx: object, r: ProbeResult): { changed: (4 | 6)[] } {
  const e = stateOf(ctx)
  const changed: (4 | 6)[] = []
  for (const fam of [4, 6] as const) {
    const a = fam === 4 ? r.v4 : r.v6
    if ('ip' in a) {
      remember(e, a.ip)
      if (a.family !== fam) continue
      const before = fam === 4 ? e.v4 : e.v6
      if (before !== a.ip) changed.push(fam)
      if (fam === 4) { e.v4 = a.ip; e.v4NoRoute = false } else e.v6 = a.ip
    } else if (fam === 4) e.v4NoRoute = 'noRoute' in a
  }
  return { changed }
}

const why = (a: FamilyResult) => ('ip' in a ? 'ok' : 'noRoute' in a ? `no route (${a.noRoute})` : a.error)

/**
 * Learn this server's exit addresses from the feed now and keep them fresh (production and office mode; main.ts).
 * Returns the stop function (also run when the server closes).
 */
export function startEgressLearning(ctx: { log: Logger; onClose(f: () => void): void }, o: { probe?: () => Promise<ProbeResult>; refreshMs?: number; retryMs?: readonly number[] } = {}): () => void {
  const e = stateOf(ctx)
  const probe = o.probe ?? (() => probeExitAddresses())
  const refresh = o.refreshMs ?? EGRESS_REFRESH_MS
  const retry = o.retryMs ?? EGRESS_RETRY_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let failures = 0
  let saidUnknown = false
  const round = async () => {
    let r: ProbeResult
    try { r = await probe() } catch (err) { const x = { error: String((err as Error)?.message ?? err).slice(0, 200) }; r = { v4: x, v6: x } }
    if (stopped) return
    // the IPv4 address matters most (NAT): until it is known (or there is no IPv4), ask again soon
    let again = true
    try {
      const wasKnown = egressOf(ctx).known
      const { changed } = learnExitAddresses(ctx, r)
      const known = egressOf(ctx).known
      again = !(known && (('ip' in r.v4 && r.v4.family === 4) || 'noRoute' in r.v4))
      // the address itself stays out of the log (like the relay's seenIp)
      if (known && !wasKnown) ctx.log.info('exit address learned: web addresses the AI opens follow the normal rules', { ipv4: !!e.v4, ipv6: !!e.v6 })
      else if (known && changed.length && wasKnown) ctx.log.info('exit address changed', { families: changed.map((f) => `IPv${f}`) })
      else if (!known && !saidUnknown) {
        saidUnknown = true
        ctx.log.info('exit address not known yet: every web address the AI opens needs a person until the server learns it', { ipv4: why(r.v4), ipv6: why(r.v6) })
      } else if (!('ip' in r.v4) || !('ip' in r.v6)) ctx.log.debug('exit address check', { ipv4: why(r.v4), ipv6: why(r.v6) })
    } finally {
      failures = again ? failures + 1 : 0
      const wait = failures === 0 ? refresh : retry[Math.min(failures - 1, retry.length - 1)]!
      timer = setTimeout(() => { e.first = null; round().catch(() => {}) }, Math.round(wait * (0.9 + Math.random() * 0.2)))
      timer.unref?.()
    }
  }
  // a round that threw (it should not) has still armed the next one; it never rejects web_fetch's wait
  e.first = round().catch(() => {})
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); timer = null }
  ctx.onClose(stop)
  return stop
}

/** MYCEL_EXIT_ADDRESS_CHECK=off (or 0, false, no): the server never asks the feed (then only the relay tells it). */
export function exitAddressCheckOff(env: Record<string, string | undefined> = process.env): boolean {
  return /^(off|0|false|no)$/i.test((env[PRODUCT.envPrefix + 'EXIT_ADDRESS_CHECK'] ?? '').trim())
}
