// Narrow native backend: preflight, info and one raster page. No editing, scripts, shells or arbitrary argv.
// The renderer bytes (rhwp executable, Noto font, notices) come from the HWP Preview plugin package
// (server/src/plugins); this driver, its preflight, limits, isolation and pins stay in core (docs/PLUGINS.md).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HWP_LIMITS as L, HwpPage, type HwpReason } from '@mycel/shared/hwp'
import manifest from '../../../resources/hwp/manifest.json'
import { ToolError } from '../policy/errors'
import { sha256 } from './store'
import { isolation, makeWorkDir, runIsolated, type IsolatedRun } from '../tools/isolate'
import { converterCgroup } from '../system/cgroups'

export class HwpError extends ToolError {
  constructor(readonly reason: HwpReason) { super(`HWP preview unavailable: ${reason}. Download the original to open it.`, 'hwp_' + reason) }
}
export interface RenderedPage { bytes: Buffer; meta: HwpPage }
export interface HwpEngine { readonly identity: string; render(bytes: Buffer, ext: 'hwp' | 'hwpx', page: number, signal?: AbortSignal): Promise<RenderedPage> }
const root = [path.resolve(import.meta.dir, '../../..'), path.resolve(import.meta.dir, '../..')].find(p => fs.existsSync(path.join(p, 'resources/hwp/manifest.json'))) ?? path.resolve(import.meta.dir, '../../..')
let worker: Promise<string> | undefined
async function workerScript() {
  return worker ??= (async () => {
    const built = path.join(import.meta.dir, 'hwp-preflight.js')
    if (fs.existsSync(built)) return built
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-check-')))
    process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
    const output = path.join(dir, 'hwp-preflight.js')
    // Development only: Bun's in-process bundler cannot reliably resolve workspace
    // packages after test module mocks. Release bundles already contain this worker.
    const build = Bun.spawn([process.execPath, 'build', path.join(import.meta.dir, 'hwp-preflight.ts'), '--target=bun', '--outfile', output], {
      cwd: root, stdout: 'ignore', stderr: 'ignore', timeout: 15_000,
    })
    if (await build.exited !== 0 || !fs.existsSync(output)) throw new HwpError('engine')
    return output
  })().catch(() => { worker = undefined; throw new HwpError('engine') })
}

/** Read internal SFNT metadata, never infer family/weight from a filename. */
export function fontIdentity(b: Buffer) {
  const tables = new Map<string, number>()
  for (let i = 0; i < b.readUInt16BE(4); i++) {
    const off = 12 + i * 16
    tables.set(b.toString('ascii', off, off + 4), b.readUInt32BE(off + 8))
  }
  const names = tables.get('name')!, os2 = tables.get('OS/2')!
  const values = new Map<number, string>()
  for (let i = 0; i < b.readUInt16BE(names + 2); i++) {
    const off = names + 6 + i * 12
    if (b.readUInt16BE(off) !== 3) continue
    const start = names + b.readUInt16BE(names + 4) + b.readUInt16BE(off + 10)
    const bytes = Buffer.from(b.subarray(start, start + b.readUInt16BE(off + 8)))
    values.set(b.readUInt16BE(off + 6), bytes.swap16().toString('utf16le'))
  }
  return { family: values.get(16) ?? values.get(1), postscript: values.get(6), weight: b.readUInt16BE(os2 + 4) }
}

/** Where the renderer's bytes are: a plugin package's files, or (development, tests) the repo's local assets. */
export interface HwpAssets {
  /** the rhwp executable for this OS/CPU */
  bin: string
  /** folder holding the pinned font files */
  fontsDir: string
  /** the plugin package's manifest digest: part of the engine identity, so cached pages never outlive a package */
  digest?: string
}

/** Development/test layout under a folder: native/bin/hwp/rhwp-<os>-<cpu> and resources/hwp/fonts. */
export function localHwpAssets(base = root): HwpAssets {
  return { bin: path.join(base, 'native/bin/hwp', `rhwp-${process.platform}-${process.arch}`), fontsDir: path.join(base, 'resources/hwp/fonts') }
}

export class NativeHwpEngine implements HwpEngine {
  readonly identity: string
  readonly ready: Promise<void>
  private bin: string
  private pin?: string
  private fonts: { name: string; bytes: Buffer }[] = []
  private fontHash = sha256(JSON.stringify(manifest.fonts))
  private readonly assets: HwpAssets
  constructor(assets: HwpAssets | string = localHwpAssets()) {
    const a = typeof assets === 'string' ? localHwpAssets(assets) : assets
    this.assets = a
    const target = `${process.platform}-${process.arch}` as keyof typeof manifest.targets
    this.pin = manifest.targets[target]?.binary
    this.bin = a.bin
    this.identity = `rhwp-${manifest.version}:${this.pin}:${this.fontHash}:png-${L.edge}-v1${a.digest ? `:pkg-${a.digest}` : ''}`
    // Startup verification; retain a handled promise so missing optional preview support never crashes the server.
    this.ready = this.verify(this.pin)
    void this.ready.catch(() => {})
  }
  /** The executable must still be the pinned build right before each job (a replaced file is refused). */
  private checkBinary() {
    try { if (!this.pin || sha256(fs.readFileSync(this.bin)) !== this.pin) throw new HwpError('engine') } catch { throw new HwpError('engine') }
  }
  private async verify(hash?: string) {
    try {
      if (!hash) throw new HwpError('engine')
      this.checkBinary()
      for (const pin of manifest.fonts) {
        const bytes = fs.readFileSync(path.join(this.assets.fontsDir, pin.file))
        const id = fontIdentity(bytes)
        if (sha256(bytes) !== pin.sha256 || id.family !== pin.family || id.weight !== pin.weight || id.postscript !== pin.postscript) throw new HwpError('engine')
        this.fonts.push({ name: pin.file, bytes })
      }
      if (isolation() === 'none' || (process.platform === 'linux' && process.env.MYCEL_MODE === 'prod' && !converterCgroup())) throw new HwpError('isolation')
      const r = await runIsolated({ cmd: this.bin, args: ['--version'], curatedFonts: true, timeoutMs: 3000, maxStdout: 1024, maxRssMiB: L.rssMiB })
      if (r.code !== 0 || r.stdout.toString().trim() !== `rhwp v${manifest.version}`) throw new HwpError('engine')
    } catch (e) { throw e instanceof HwpError ? e : new HwpError('engine') }
  }
  async render(bytes: Buffer, ext: 'hwp' | 'hwpx', page: number, signal?: AbortSignal): Promise<RenderedPage> {
    await this.ready
    if (signal?.aborted) throw new HwpError('cancelled')
    this.checkBinary()
    if (bytes.length > L.inputBytes || !Number.isInteger(page) || page < 1 || page > L.pages) throw new HwpError('limit')
    const work = makeWorkDir()
    const deadline = Date.now() + L.timeoutMs
    const run = async (cmd: string, args: string[], extra: Partial<IsolatedRun> = {}) => {
      if (signal?.aborted) throw new HwpError('cancelled')
      if (Date.now() >= deadline) throw new HwpError('timeout')
      const r = await runIsolated({ cmd, args, workDir: work, curatedFonts: true, timeoutMs: Math.max(1, deadline - Date.now()), maxRssMiB: L.rssMiB,
        env: { FONTCONFIG_FILE: path.join(work, 'fonts.conf') },
        maxWorkBytes: bytes.length + this.fonts.reduce((n, f) => n + f.bytes.length, 0) + L.outputBytes, maxStdout: 1024 * 1024, signal, ...extra })
      if (r.killed) throw new HwpError(r.killed === 'aborted' ? 'cancelled' : r.killed === 'timeout' ? 'timeout' : 'limit')
      return r
    }
    try {
      const input = path.join(work, `input.${ext}`), fontDir = path.join(work, 'fonts'), output = path.join(work, 'pages')
      fs.writeFileSync(input, bytes, { mode: 0o600 }); fs.mkdirSync(fontDir); fs.mkdirSync(output)
      fs.writeFileSync(path.join(work, 'fonts.conf'), '<fontconfig><dir>' + fontDir + '</dir><cachedir>' + work + '/font-cache</cachedir></fontconfig>')
      for (const f of this.fonts) fs.writeFileSync(path.join(fontDir, f.name), f.bytes, { mode: 0o600 })
      const script = path.join(work, 'hwp-preflight.js')
      fs.copyFileSync(await workerScript(), script)
      const checked = await run(process.execPath, [script, input, ext])
      if (checked.code !== 0) {
        const reason = checked.stdout.toString()
        throw new HwpError(['locked','distribution','damaged','unsupported','limit'].includes(reason) ? reason as HwpReason : 'damaged')
      }
      const info = await run(this.bin, ['info', input, '--json'])
      if (info.code !== 0) throw new HwpError('damaged')
      let data: { pageCount: number; warnings?: unknown[] }
      try { data = JSON.parse(info.stdout.toString()) } catch { throw new HwpError('damaged') }
      if (info.stderr.trim() || data.warnings?.length) throw new HwpError('loss')
      if (!Number.isInteger(data.pageCount) || data.pageCount < 1) throw new HwpError('damaged')
      if (data.pageCount > L.pages || page > data.pageCount) throw new HwpError('limit')
      const rendered = await run(this.bin, ['export-png', input, '--page', String(page - 1), '--max-dimension', String(L.edge), '--font-path', fontDir, '-o', output])
      if (rendered.code !== 0) throw new HwpError('damaged')
      // Known progress lines are stdout. Parser warnings on stderr mean possible structural loss.
      const diagnostics = rendered.stderr.split('\n').filter(line => line.trim() && !/^\d{4}-\d{2}-\d{2} [\d:.]+ rhwp[^ ]*\[\d+:\d+\] CoreText: System LastResort not available, using built-in copy\.$/.test(line))
      if (diagnostics.length) throw new HwpError('loss')
      const files = fs.readdirSync(output)
      if (files.length !== 1 || !files[0].endsWith('.png')) throw new HwpError('damaged')
      const p = path.join(output, files[0]), st = fs.lstatSync(p)
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > L.outputBytes) throw new HwpError('limit')
      const png = fs.readFileSync(p)
      if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.toString('ascii', 12, 16) !== 'IHDR') throw new HwpError('damaged')
      const meta = HwpPage.safeParse({ page, pageCount: data.pageCount, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
        sourceHash: sha256(bytes), engine: `rhwp-${manifest.version}`, fonts: this.fontHash,
        warnings: ['font_substitution', 'layout_approximation', ...(!converterCgroup() ? ['memory_watchdog'] : [])] })
      if (!meta.success) throw new HwpError('limit')
      return { bytes: png, meta: meta.data }
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }
}

/** The engine when HWP preview is not usable here (no plugin, plugin off, not supported on this server, revoked): every
 * page refused. Since the founder cleared the renderer (docs/DECISIONS.md "HWP Preview cleared"), the HWP Preview
 * plugin turned on is the only switch; the old MYCEL_HWP_PREVIEW release gate is gone and ignored. */
export const disabledHwpEngine: HwpEngine = { identity: 'hwp-disabled', async render() { throw new HwpError('disabled') } }
