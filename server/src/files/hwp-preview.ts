import { randomUUID } from 'node:crypto'
import { HWP_LIMITS as L } from '@mycel/shared/hwp'
import type { TeamFiles } from '../team-files/service'
import { ToolError } from '../policy/errors'
import { readRegular, sha256 } from './store'
import { HwpError, nativeHwpEngine, type HwpEngine, type RenderedPage } from './hwp-engine'

interface Cached { key: string; id: string; source: string; result: RenderedPage; expires: number }
/** Cache IDs are random and never capabilities. Every lookup opens and authorizes the source again. */
export class HwpPreviews {
  private cache = new Map<string, Cached>()
  private running = new Set<string>()
  private generation = 0
  constructor(private files: TeamFiles, readonly engine: HwpEngine = nativeHwpEngine()) {}
  invalidate() { this.generation++; this.cache.clear() }
  private source(user: string, source: string) {
    const f = this.files.fileForDownload(user, source)
    if (!/\.hwpx?$/i.test(f.name)) throw new HwpError('unsupported')
    let read: ReturnType<typeof readRegular>
    try { read = readRegular(f.abs, L.inputBytes) } catch (e) {
      if (e instanceof ToolError && e.message === 'file is too large') throw new HwpError('limit')
      throw e
    }
    const { bytes, st } = read
    return { bytes, hash: sha256(bytes), version: `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`, ext: /\.hwpx$/i.test(f.name) ? 'hwpx' as const : 'hwp' as const }
  }
  async page(user: string, source: string, page: number, signal?: AbortSignal, cacheId?: string): Promise<RenderedPage & { id: string }> {
    if (signal?.aborted) throw new HwpError('cancelled')
    // Check permission even on invalid cache IDs and before busy errors.
    const f = this.source(user, source)
    if (!Number.isInteger(page) || page < 1 || page > L.pages) throw new HwpError('limit')
    const key = `${source}:${f.version}:${f.hash}:${this.engine.identity}:${page}`
    for (const [k, c] of this.cache) if (c.expires < Date.now()) this.cache.delete(k)
    const hit = this.cache.get(key)
    if (cacheId && (!hit || hit.id !== cacheId)) throw new HwpError('changed')
    if (hit) return { ...hit.result, id: hit.id }
    if (this.running.has(user) || this.running.size >= L.perServer) throw new HwpError('busy')
    this.running.add(user)
    const generation = this.generation
    try {
      const result = await this.engine.render(f.bytes, f.ext, page, signal)
      if (signal?.aborted) throw new HwpError('cancelled')
      // Includes disabled-account and role/group/ACL changes while the renderer was running.
      const now = this.source(user, source)
      if (generation !== this.generation || now.version !== f.version || now.hash !== f.hash) throw new HwpError('changed')
      if (result.meta.sourceHash !== f.hash || result.bytes.length > L.outputBytes) throw new HwpError('damaged')
      let size = result.bytes.length
      for (const c of this.cache.values()) size += c.result.bytes.length
      while ((size > L.cacheBytes || this.cache.size >= 128) && this.cache.size) {
        const first = this.cache.entries().next().value!
        size -= first[1].result.bytes.length; this.cache.delete(first[0])
      }
      const id = randomUUID()
      this.cache.set(key, { key, source, id, result, expires: Date.now() + 600000 })
      return { ...result, id }
    } finally { this.running.delete(user) }
  }
}
