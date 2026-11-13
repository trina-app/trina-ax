// The last step of `bun run build` before the notices (docs/DECISIONS.md "First load: compressed files, one language, formatting on demand"): a Brotli
// (`<file>.br`) and a gzip (`<file>.gz`) copy of every text file of web/dist, made once per build at the best
// compression, so the team server sends them as they are (server/src/routes/web-static.ts staticResponse) and never
// compresses on the fly. Brotli for https (Chrome and Safari send `br` only there), gzip for an office address over
// plain http. A copy that saves less than COPY_MIN_SAVING is not written: the file goes out as it is.
// Not here: the notice folder (dist/licenses, written by build-notices.ts after this, and again by a bundle build).
//   bun scripts/compress-dist.ts [dist]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { COMPRESSIBLE, NOT_COMPRESSED_DIRS } from '../../server/src/routes/web-static'

const brotli = promisify(zlib.brotliCompress)
const gzip = promisify(zlib.gzip)
/** smaller files gain nothing that a round trip does not cost already */
export const COPY_MIN_BYTES = 1024
/** a copy must be at least this much smaller than the file */
export const COPY_MIN_SAVING = 0.1

/** The files of `dist` that get copies (relative paths, `/`-separated). */
export function compressTargets(dist: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name)
      const rel = path.relative(dist, file).split(path.sep).join('/')
      if (e.isDirectory()) {
        if (!NOT_COMPRESSED_DIRS.includes(rel)) walk(file)
      } else if (e.isFile() && COMPRESSIBLE.test(e.name) && fs.statSync(file).size >= COPY_MIN_BYTES) out.push(rel)
    }
  }
  walk(dist)
  return out.sort()
}

/** Write the copies of one file; an old copy that is no longer worth it is removed. */
async function compressOne(dist: string, rel: string): Promise<{ raw: number; br: number; gz: number }> {
  const file = path.join(dist, rel)
  const raw = fs.readFileSync(file)
  const [br, gz] = await Promise.all([
    brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
    gzip(raw, { level: 9 }),
  ])
  const keep = (copy: Buffer, ext: string) => {
    const target = `${file}.${ext}`
    if (copy.length <= raw.length * (1 - COPY_MIN_SAVING)) { fs.writeFileSync(target, copy); return copy.length }
    fs.rmSync(target, { force: true })
    return raw.length
  }
  return { raw: raw.length, br: keep(br, 'br'), gz: keep(gz, 'gz') }
}

export async function compressDist(dist: string, parallel = 8): Promise<{ files: number; raw: number; br: number; gz: number }> {
  const targets = compressTargets(dist)
  const total = { files: targets.length, raw: 0, br: 0, gz: 0 }
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const r = await compressOne(dist, targets[next++]!)
      total.raw += r.raw; total.br += r.br; total.gz += r.gz
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))
  return total
}

if (import.meta.main) {
  const dist = path.resolve(process.argv[2] ?? path.join(import.meta.dir, '..', 'dist'))
  const t0 = Date.now()
  const r = await compressDist(dist)
  const mb = (n: number) => (n / 1048576).toFixed(1) + ' MB'
  console.log(`compress-dist: ${r.files} files, ${mb(r.raw)} -> br ${mb(r.br)}, gzip ${mb(r.gz)} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
}
