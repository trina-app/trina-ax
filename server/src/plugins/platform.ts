// Where a package can run: the server's OS, CPU and (Linux) glibc version against the package's platform list and
// product range. A version range alone never certifies safety; the HWP driver additionally checks its pinned
// executable and the isolation it needs when the renderer starts.
import { compareSemVer, PLUGIN_API_VERSION, SemVer, type PluginPlatform } from '@mycel/shared/plugins'
import type { PluginUnsupported } from '@mycel/shared/api'

export interface HostInfo { os: 'darwin' | 'linux' | string; arch: 'arm64' | 'x64' | string; libc: string | null }

let cached: HostInfo | undefined
/** This machine. glibc comes from `getconf GNU_LIBC_VERSION` ("glibc 2.36"); null when unknown or not glibc. */
export function hostInfo(): HostInfo {
  if (cached) return cached
  let libc: string | null = null
  if (process.platform === 'linux') {
    try {
      const r = Bun.spawnSync(['getconf', 'GNU_LIBC_VERSION'], { stdout: 'pipe', stderr: 'ignore', timeout: 2000 })
      libc = /glibc\s+(\d+\.\d+)/.exec(r.stdout.toString())?.[1] ?? null
    } catch { libc = null }
  }
  return (cached = { os: process.platform, arch: process.arch, libc })
}

const ver = (s: string) => s.split('.').map(Number) as [number, number]
const atLeast = (have: string, need: string) => { const [a, b] = ver(have), [c, d] = ver(need); return a > c || (a === c && b >= d) }

/** Why none of `platforms` fits this host, or null when one does (absent list = any server). */
export function platformMismatch(platforms: readonly PluginPlatform[] | undefined | null, host: HostInfo): PluginUnsupported | null {
  if (!platforms?.length) return null
  // the closest miss explains best: the right OS and CPU but an old glibc says "libc", not "arch"
  const rank = { os: 0, arch: 1, libc: 2 } as const
  let best: keyof typeof rank = 'os'
  const miss = (r: keyof typeof rank) => { if (rank[r] > rank[best]) best = r }
  for (const p of platforms) {
    if (p.os !== 'any' && p.os !== host.os) continue
    if (p.arch !== 'any' && p.arch !== host.arch) { miss('arch'); continue }
    if (p.libc && host.os === 'linux' && (!host.libc || !atLeast(host.libc, p.libc.minVersion))) { miss('libc'); continue }
    return null
  }
  return best
}

/** Product / host API range. */
export function productMismatch(product: { apiVersion: number; minVersion: string }, serverVersion: string): PluginUnsupported | null {
  if (product.apiVersion !== PLUGIN_API_VERSION) return 'api'
  const v = serverVersion.replace(/\+.*$/, '')
  if (!SemVer.safeParse(v).success || compareSemVer(v, product.minVersion) < 0) return 'product'
  return null
}
