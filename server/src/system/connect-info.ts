// GET /api/connect-info (design tab 4 "설치·연결", tab 5/6 "사무실 직접 연결"). Component G.
//
// The desktop app asks the team address (real TLS through the relay) for the office address and the SHA-256 of the
// office certificate, then accepts only that certificate on the LAN (setCertificateVerifyProc; never trust on first
// use: anyone on the network can answer mDNS). A re-created certificate reaches the apps the same way.
// lanHosts: the Mac's Bonjour name (<LocalHostName>.local) and its private IPv4 addresses. The app tries each one
// with the pinned certificate, so the certificate's SAN list does not have to cover them.
import os from 'node:os'
import { uuidv7, type ConnectInfo } from '@mycel/shared/api'
import { getSetting, setSetting } from '../admin/settings'
import type { AppContext } from '../context'
import { certFingerprint, connectionStatus } from './connection'

const TEAM_ID_KEY = 'connect.teamId'

/** A stable id of this team server (created once, kept in settings; survives restarts and backups). */
export function serverTeamId(db: AppContext['db']): string {
  const v = getSetting<string>(db, TEAM_ID_KEY)
  if (typeof v === 'string' && v) return v
  const id = uuidv7()
  setSetting(db, TEAM_ID_KEY, id)
  return id
}

/** 10/8, 172.16/12, 192.168/16: the addresses an office network hands out. */
export function isPrivateV4(a: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a)
  if (!m) return false
  const [x, y] = [Number(m[1]), Number(m[2])]
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
}

export interface HostSources {
  /** macOS LocalHostName (scutil --get LocalHostName), null when unknown */
  localHostName: () => string | null
  interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>
}

const defaultSources: HostSources = {
  localHostName() {
    if (process.platform === 'darwin') {
      try {
        const r = Bun.spawnSync(['/usr/sbin/scutil', '--get', 'LocalHostName'], { stdout: 'pipe', stderr: 'ignore', timeout: 2000 })
        const n = r.stdout.toString().trim()
        if (r.exitCode === 0 && n) return n
      } catch {}
    }
    const h = os.hostname().replace(/\.local$/i, '')
    return h && !h.includes('.') ? h : null
  },
  interfaces: () => os.networkInterfaces(),
}

/** "<name>.local" first, then the private IPv4 addresses (at most 8 in all). */
export function lanHosts(src: HostSources = defaultSources): string[] {
  const out: string[] = []
  const name = src.localHostName()
  if (name && /^[A-Za-z0-9-]{1,63}$/.test(name)) out.push(`${name}.local`)
  for (const list of Object.values(src.interfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !isPrivateV4(i.address) || out.includes(i.address)) continue
      out.push(i.address)
    }
  }
  return out.slice(0, 8)
}

let hostCache: { at: number; v: string[] } | null = null

export function connectInfo(ctx: AppContext, src?: HostSources): ConnectInfo {
  const tls = ctx.config.tls
  const fp = tls ? certFingerprint(tls.certFile) : null
  let hosts: string[] = []
  if (tls && fp) {
    if (src) hosts = lanHosts(src)
    else {
      // the network can change (Wi-Fi), so a minute at most
      if (!hostCache || Date.now() - hostCache.at > 60_000) hostCache = { at: Date.now(), v: lanHosts() }
      hosts = hostCache.v
    }
  }
  let canonicalOrigin: string | null = null
  try {
    const a = connectionStatus(ctx).address
    if (a) canonicalOrigin = new URL(a).origin
  } catch {}
  return {
    teamId: serverTeamId(ctx.db),
    lanCertSha256: fp,
    lanPort: tls?.port ?? 8443,
    lanHosts: hosts,
    canonicalOrigin,
  }
}
