// The few Bun globals web/test/mock/server.ts uses, for the demo build where it runs in the browser
// (docs/AGENTS/plan/20261114-0507-mina-demo.md). Imported first by web/demo/main.tsx, before the mock's module.
import { sha256 } from './sha256'

const enc = new TextEncoder()
const bytes = (d: string | ArrayBuffer | ArrayBufferView): Uint8Array =>
  typeof d === 'string' ? enc.encode(d) : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength)

class CryptoHasher {
  private parts: Uint8Array[] = []
  constructor(algorithm: string) {
    if (algorithm !== 'sha256') throw new Error(`demo: no ${algorithm}`)
  }
  update(d: string | ArrayBuffer | ArrayBufferView) {
    this.parts.push(bytes(d))
    return this
  }
  digest(encoding?: 'hex' | 'base64') {
    const all = new Uint8Array(this.parts.reduce((n, p) => n + p.byteLength, 0))
    let at = 0
    for (const p of this.parts) { all.set(p, at); at += p.byteLength }
    const out = sha256(all)
    if (encoding === 'hex') return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('')
    if (encoding === 'base64') return btoa(String.fromCharCode(...out))
    return out
  }
}

/** FNV-1a style, 53 bits: the mock uses Bun.hash only for ids that must repeat for the same input */
function hash(d: string | ArrayBuffer | ArrayBufferView): number {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (const b of bytes(d)) { h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ b, 0x5bd1e995) >>> 0 }
  return (h2 & 0x1fffff) * 0x100000000 + h1
}

const spawnSync = () => ({ exitCode: 1, success: false, stdout: new Uint8Array(), stderr: new Uint8Array() })

;(globalThis as unknown as { Bun: unknown }).Bun = { CryptoHasher, hash, spawnSync }
