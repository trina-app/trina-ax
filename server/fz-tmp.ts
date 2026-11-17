import zlib from 'node:zlib'
import UPNG from '../node_modules/.bun/@pdf-lib+upng@1.0.1/node_modules/@pdf-lib/upng/UPNG.js'
import pako from '../node_modules/.bun/pako@1.0.11/node_modules/pako/index.js'
const inflate = (z: Uint8Array, size: number) => { const buf = new Uint8Array(size); const dd = new Uint8Array(z.length + 64); dd.set(z); return (UPNG as any).decode._inflate(dd, buf) as Uint8Array }
let seed = Number(process.argv[2] ?? 1)
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const fails: Record<string, number> = {}; let n = 0
for (let it = 0; it < Number(process.argv[3] ?? 300); it++) {
  const w = 10 + Math.floor(rnd() * 150), h = 10 + Math.floor(rnd() * 150)
  const raw = new Uint8Array((w * 4 + 1) * h)
  const cx = rnd() * w, cy = rnd() * h, rr = rnd() * Math.min(w, h), noise = rnd() < 0.3
  const col = [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), 255]
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) raw.set(noise && rnd() < 0.1 ? [Math.floor(rnd() * 256), 0, 0, 255] : ((x - cx) ** 2 + (y - cy) ** 2 < rr * rr ? col : [0, 0, 0, 0]), y * (w * 4 + 1) + 1 + x * 4) }
  const variants: [string, () => Uint8Array][] = [
    ['zlib6', () => zlib.deflateSync(raw)],
    ['zlib1', () => zlib.deflateSync(raw, { level: 1 })],
    ['zlib9', () => zlib.deflateSync(raw, { level: 9 })],
    ['zlibRLE', () => zlib.deflateSync(raw, { strategy: 3 })],
    ['zlibHuff', () => zlib.deflateSync(raw, { strategy: 2 })],
    ['zlibFixed', () => zlib.deflateSync(raw, { strategy: 4 })],
    ['bunDeflate', () => { const d = Bun.deflateSync(raw); const o = new Uint8Array(d.length + 6); o[0] = 0x78; o[1] = 0x9c; o.set(d, 2); return o }],
    ['bunDeflate1', () => { const d = Bun.deflateSync(raw, { level: 1 }); const o = new Uint8Array(d.length + 6); o[0] = 0x78; o[1] = 0x9c; o.set(d, 2); return o }],
    ['bunDeflate9', () => { const d = Bun.deflateSync(raw, { level: 9 }); const o = new Uint8Array(d.length + 6); o[0] = 0x78; o[1] = 0x9c; o.set(d, 2); return o }],
    ['bunLibdeflate', () => { try { const d = (Bun as any).deflateSync(raw, { library: 'libdeflate', level: 12 }); const o = new Uint8Array(d.length + 6); o[0] = 0x78; o[1] = 0x9c; o.set(d, 2); return o } catch { return zlib.deflateSync(raw) } }],
    ['pako6', () => pako.deflate(raw)],
    ['pako9', () => pako.deflate(raw, { level: 9 })],
  ]
  for (const [name, f] of variants) {
    n++
    const z = f()
    let ok = false
    try { const out = inflate(z, raw.length); ok = out.length >= raw.length && Buffer.from(out.subarray(0, raw.length)).equals(Buffer.from(raw)) } catch {}
    if (!ok) fails[name] = (fails[name] ?? 0) + 1
  }
}
console.log(process.platform, process.arch, Bun.version, 'tried', n, 'fails', JSON.stringify(fails))
