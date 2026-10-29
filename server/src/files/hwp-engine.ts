// Narrow native backend: preflight, info and one raster page. No editing, scripts, shells or arbitrary argv.
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

export class NativeHwpEngine implements HwpEngine {
  readonly identity: string
  readonly ready: Promise<void>
  private bin: string
  private fonts: { name: string; bytes: Buffer }[] = []
  private fontHash = sha256(JSON.stringify(manifest.fonts))
  constructor(private readonly bundleRoot = root) {
    const target = `${process.platform}-${process.arch}` as keyof typeof manifest.targets
    const pin = manifest.targets[target]
    this.bin = path.join(bundleRoot, 'native/bin/hwp', `rhwp-${target}`)
    this.identity = `rhwp-${manifest.version}:${pin?.binary}:${this.fontHash}:png-${L.edge}-v1`
    // Startup verification; retain a handled promise so missing optional preview support never crashes the server.
    this.ready = this.verify(pin?.binary)
    void this.ready.catch(() => {})
  }
  private async verify(hash?: string) {
    try {
      if (!hash || sha256(fs.readFileSync(this.bin)) !== hash) throw new HwpError('engine')
      for (const pin of manifest.fonts) {
        const bytes = fs.readFileSync(path.join(this.bundleRoot, 'resources/hwp/fonts', pin.file))
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
      const script = await workerScript()
      const checked = await run(process.execPath, [script, input, ext], { readPaths: [path.dirname(script)] })
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

let defaultEngine: NativeHwpEngine | undefined
/** One verified immutable engine/font bundle per process; jobs still use fresh isolated processes. */
export function nativeHwpEngine(): HwpEngine { return defaultEngine ??= new NativeHwpEngine() }
