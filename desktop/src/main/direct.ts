// Office-network direct connection (design tab 6 "같은 네트워크의 데스크톱 앱", tab 5 "사무실 직접 연결").
//
// The app first asks the team address (real TLS through the relay) for GET /api/connect-info
// {teamId, lanCertSha256, lanPort, lanHosts}. On the LAN it accepts only that certificate (pinned with
// setCertificateVerifyProc; never trust-on-first-use, anyone on the network can answer mDNS). A probe of
// https://<lanHost>:<port>/api/health must answer within 1 s with the pinned certificate, otherwise the window uses
// the team address. A LAN certificate that differs from the pin stops direct use and warns the person.
//
// Sign-in: the two origins have separate __Host- cookies, so the main process copies the session cookie from the
// origin that has it to the one it opens (both inside the team's own partition). The web page never sees the
// token, and images, downloads and the WebSocket keep working with plain cookies.
import { createHash, X509Certificate } from 'node:crypto'
import dns from 'node:dns/promises'
import https from 'node:https'
import type { Session } from 'electron'
import { CONNECT_INFO_PATH, ConnectInfo } from '@mycel/shared'
import { CSRF_HEADER, DEV_SESSION_COOKIE, Health, SESSION_COOKIE, type LanFailureCode } from '@mycel/shared/api'
import { normalizeFingerprint, type DirectInfo } from '../common/teams'

export type ProbeResult = 'ok' | 'mismatch' | 'unreachable' | 'timeout'
export const PROBE_TIMEOUT_MS = 1000

/** GET /api/connect-info on the team address, with the team's cookies. null when the server has none. */
export async function fetchConnectInfo(ses: Session, origin: string, timeoutMs = 3000): Promise<ConnectInfo | null> {
  try {
    const res = await ses.fetch(origin + CONNECT_INFO_PATH, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const parsed = ConnectInfo.safeParse(await res.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function directFromConnectInfo(ci: ConnectInfo, now: string): DirectInfo | null {
  if (!ci.lanCertSha256 || !ci.lanHosts.length) return null
  return { teamId: ci.teamId, fingerprint: normalizeFingerprint(ci.lanCertSha256), port: ci.lanPort, hosts: ci.lanHosts, checkedAt: now }
}

/** Probe https://host:port/api/health accepting only the pinned certificate. */
export function probePinned(host: string, port: number, fingerprint: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const pin = normalizeFingerprint(fingerprint)
  return new Promise((resolve) => {
    let settled = false
    const done = (r: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.destroy()
      resolve(r)
    }
    const isIp = /^[\d.]+$/.test(host) || host.includes(':')
    const req = https.request({
      host,
      port,
      path: '/api/health',
      method: 'GET',
      // the CA chain is not checked: the pinned fingerprint is the trust (self-signed LAN certificate)
      rejectUnauthorized: false,
      servername: isIp ? undefined : host,
      agent: false,
      headers: { accept: 'application/json' },
    })
    const timer = setTimeout(() => done('timeout'), timeoutMs)
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        const cert = (socket as import('node:tls').TLSSocket).getPeerCertificate()
        if (!cert || normalizeFingerprint(cert.fingerprint256 ?? '') !== pin) done('mismatch')
      })
    })
    req.on('response', (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        body += c
        if (body.length > 64_000) done('unreachable')
      })
      res.on('end', () => {
        if (settled) return
        try {
          done(res.statusCode === 200 && Health.safeParse(JSON.parse(body)).success ? 'ok' : 'unreachable')
        } catch {
          done('unreachable')
        }
      })
    })
    req.on('error', () => done('unreachable'))
    req.end()
  })
}

/** Try every LAN host of the team in parallel; the first 'ok' wins. 'mismatch' only when no host is ok. */
export async function probeDirect(d: DirectInfo, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ result: ProbeResult; origin?: string }> {
  const results = await Promise.all(d.hosts.map(async (h) => ({ h, r: await probePinned(h, d.port, d.fingerprint, timeoutMs) })))
  const okHost = results.find((x) => x.r === 'ok')
  if (okHost) return { result: 'ok', origin: `https://${okHost.h.includes(':') ? `[${okHost.h}]` : okHost.h}:${d.port}` }
  return { result: results.some((x) => x.r === 'mismatch') ? 'mismatch' : results.some((x) => x.r === 'timeout') ? 'timeout' : 'unreachable' }
}

/** The report code for a failed probe (design tab 4: POST /api/connect-info/lan-failure). */
export function lanFailureCode(r: ProbeResult): LanFailureCode | null {
  return r === 'ok' ? null : r === 'mismatch' ? 'cert_mismatch' : r === 'timeout' ? 'timeout' : 'unreachable'
}

const isLoopback = (h: string) => /^127\./.test(h) || h === '::1' || /^localhost$/i.test(h)

/**
 * Is the team's server Mac on this network? Its Bonjour name (<name>.local) answers only on the same link (mDNS),
 * which stands in for the design's Bonjour discovery of the same teamId (tab 4: a failure is reported only when the
 * app found the team on the network). A loopback address is this Mac itself. Private IP addresses alone prove
 * nothing: at home the same 192.168.x.y can be another device.
 */
export async function officeNameAnswers(hosts: string[], timeoutMs = 1000, lookup: (h: string) => Promise<unknown> = (h) => dns.lookup(h)): Promise<boolean> {
  if (hosts.some(isLoopback)) return true
  const local = hosts.filter((h) => /\.local$/i.test(h))
  if (!local.length) return false
  const one = (h: string) => Promise.race([lookup(h).then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))])
  return (await Promise.all(local.map(one))).some(Boolean)
}

/**
 * The code to report for a probe result, or null: nothing failed, or the server Mac is not on this network. That
 * holds for a different certificate too: away from the office another device can sit at the office server's private
 * address (a router or NAS on 8443 at home), and Diagnostics would tell the owner someone pretended to be the server.
 */
export async function lanFailureToReport(r: ProbeResult, hosts: string[], lookup?: (h: string) => Promise<unknown>): Promise<LanFailureCode | null> {
  const code = lanFailureCode(r)
  if (!code) return null
  return (await officeNameAnswers(hosts, 1000, lookup)) ? code : null
}

/** Tell the team server (through the team address) why the office address could not be used. */
export async function reportLanFailure(ses: Session, origin: string, code: LanFailureCode, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await ses.fetch(origin + CONNECT_INFO_PATH + '/lan-failure', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
      body: JSON.stringify({ code }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** SHA-256 of an Electron Certificate (PEM) as AA:BB:... */
export function certFingerprint(pem: string): string {
  try {
    return normalizeFingerprint(new X509Certificate(pem).fingerprint256)
  } catch {
    const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
    return normalizeFingerprint(createHash('sha256').update(der).digest('hex'))
  }
}

/**
 * Pin the LAN certificate in the team's app session: LAN hosts accept only the pinned certificate; every other
 * host keeps Chromium's normal verification. onMismatch fires when a LAN host shows another certificate.
 */
export function pinCertificates(ses: Session, pins: () => DirectInfo | null, onMismatch: (host: string) => void) {
  ses.setCertificateVerifyProc((req, callback) => {
    const d = pins()
    const host = req.hostname.replace(/^\[|\]$/g, '')
    if (!d || !d.hosts.includes(host)) return callback(-3) // Chromium's own result
    if (certFingerprint(req.certificate.data) === normalizeFingerprint(d.fingerprint)) return callback(0)
    onMismatch(host)
    callback(-2)
  })
}

/** Copy the sign-in cookie from one team origin to the other inside the team's partition. */
export async function mirrorSessionCookie(ses: Session, from: string, to: string): Promise<boolean> {
  const names = [SESSION_COOKIE, DEV_SESSION_COOKIE]
  const have = (await ses.cookies.get({ url: from })).find((c) => names.includes(c.name))
  if (!have) return false
  const secure = to.startsWith('https:')
  const name = secure ? SESSION_COOKIE : DEV_SESSION_COOKIE
  // __Host- cookies: Secure, Path=/, no Domain (host-only)
  await ses.cookies.set({
    url: to,
    name,
    value: have.value,
    path: '/',
    secure,
    httpOnly: true,
    sameSite: 'lax',
    ...(have.expirationDate ? { expirationDate: have.expirationDate } : {}),
  })
  return true
}
