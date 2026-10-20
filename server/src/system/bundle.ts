// Release bundle helpers shared by scripts/build-bundle.ts, the update tests and the install test (component G):
// write manifest.json for a version folder, sign it, and pack the folder into the .tar.zst an update stages.
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { BundleManifest, BundleSignature } from '@mycel/shared/install'
import { walkTree } from './manifest'
import { readFileChunks, writeAtomic, zstdCompress } from './streams'
import { tarStream, type TarEntryInput } from './tar'
import { keyId } from './update'

export async function writeManifest(dir: string, version: string): Promise<BundleManifest> {
  const { files } = await walkTree(dir, { exclude: ['manifest.json', 'manifest.sig'] })
  const m: BundleManifest = { format: 1, version, createdAt: new Date().toISOString(), files: {} }
  for (const f of files) {
    const h = crypto.createHash('sha256')
    for await (const c of readFileChunks(f.abs)) h.update(c)
    m.files[f.rel] = { sha256: h.digest('hex'), size: f.size, mode: f.mode }
  }
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 1) + '\n', { mode: 0o644 })
  return m
}

/** Sign manifest.json with an Ed25519 private key (PKCS#8 PEM); writes manifest.sig. */
export async function signManifest(dir: string, privateKeyPem: string): Promise<BundleSignature> {
  const raw = await fsp.readFile(path.join(dir, 'manifest.json'))
  const key = crypto.createPrivateKey(privateKeyPem)
  const pubDer = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer
  const sig: BundleSignature = { keyId: keyId(pubDer.subarray(pubDer.length - 32)), sig: crypto.sign(null, raw, key).toString('base64') }
  await fsp.writeFile(path.join(dir, 'manifest.sig'), JSON.stringify(sig) + '\n', { mode: 0o644 })
  return sig
}

/** Raw base64 public key (what RELEASE_PUBLIC_KEYS and the bootstrap's --pubkey take) of a PEM private key. */
export function publicKeyB64(privateKeyPem: string): string {
  const der = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ format: 'der', type: 'spki' }) as Buffer
  return der.subarray(der.length - 32).toString('base64')
}

/** Pack a version folder (contents, no top folder) into a .tar.zst. */
export async function packBundle(dir: string, out: string): Promise<{ size: number; sha256: string }> {
  const { files, dirs } = await walkTree(dir)
  const entries: TarEntryInput[] = [
    ...dirs.map((d) => ({ name: d.rel, type: 'dir' as const, mode: d.mode, mtimeMs: d.mtimeMs })),
    ...files.map((f) => ({ name: f.rel, type: 'file' as const, source: f.abs, mode: f.mode })),
  ]
  return writeAtomic(zstdCompress(tarStream(entries), 19), out, 0o644)
}
