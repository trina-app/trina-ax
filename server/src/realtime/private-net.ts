// Is a browser URL an office-network (private) address? Such pages need the person's OK before the AI opens them
// in the in-app browser (tab 3 "사내망 주소는 사람 확인"). The browser runs on the person's computer, so this is a
// best-effort check from the server: literal private IPs, local names, and names that resolve to private IPs here.
import dns from 'node:dns/promises'
import net from 'node:net'

const LOCAL_SUFFIXES = ['.local', '.internal', '.intranet', '.lan', '.corp', '.home', '.home.arpa', '.localdomain', '.localhost', '.test']

function v4Private(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true
  const [a, b] = p as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}
function v6Private(ip: string): boolean {
  const s = ip.toLowerCase()
  if (s === '::' || s === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (mapped) return v4Private(mapped[1]!)
  return /^(fc|fd|fe8|fe9|fea|feb|fec|fed|fee|fef|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2002:') || s.startsWith('100::')
}
export function privateIp(ip: string): boolean {
  const k = net.isIP(ip)
  if (k === 4) return v4Private(ip)
  if (k === 6) return v6Private(ip)
  return false
}

/** Host part of a URL the AI wants to open (https:// is added when missing, like the desktop app does). */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch { return null }
}

export async function isPrivateHost(host: string, resolve: (h: string) => Promise<string[]> = defaultResolve): Promise<boolean> {
  if (!host) return false
  if (net.isIP(host)) return privateIp(host)
  if (host === 'localhost' || !host.includes('.') || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true
  try {
    const ips = await resolve(host)
    return ips.some(privateIp)
  } catch { return false }
}

async function defaultResolve(host: string): Promise<string[]> {
  const t = new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 1500))
  const r = dns.lookup(host, { all: true }).then((xs) => xs.map((x) => x.address))
  return Promise.race([r, t])
}
