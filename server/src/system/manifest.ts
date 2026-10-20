// Team-folder file lists for incremental backups (spike B: bsdtar has no --listed-incremental, so the app compares
// lists itself). A manifest maps every regular file to its size and mtime (whole milliseconds); a file whose size or
// mtime differs from the previous manifest goes into the next archive, a path that disappeared goes into deleted.json.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'

export interface ManifestEntry { s: number; m: number }
export type Manifest = Record<string, ManifestEntry>

export interface WalkOptions {
  /** relative paths (forward slashes) to leave out entirely, with everything below them */
  exclude?: string[]
}

export interface WalkedFile { rel: string; abs: string; size: number; mtimeMs: number; mode: number }
export interface WalkedDir { rel: string; mode: number; mtimeMs: number }

/** Every regular file and folder under root (no symlinks, no special files, no server temp files). */
export async function walkTree(root: string, o: WalkOptions = {}): Promise<{ files: WalkedFile[]; dirs: WalkedDir[] }> {
  const exclude = new Set((o.exclude ?? []).map((p) => p.replace(/\/+$/, '')))
  const files: WalkedFile[] = []
  const dirs: WalkedDir[] = []
  async function walk(rel: string): Promise<void> {
    const abs = rel ? path.join(root, rel) : root
    let ents
    try { ents = await fsp.readdir(abs, { withFileTypes: true }) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const d of ents) {
      const r = rel ? `${rel}/${d.name}` : d.name
      if (exclude.has(r) || d.name.startsWith(PRODUCT.tmpPrefix)) continue
      if (d.isDirectory()) {
        const st = await fsp.lstat(path.join(root, r)).catch(() => null)
        if (!st) continue
        dirs.push({ rel: r, mode: st.mode & 0o777, mtimeMs: Math.floor(st.mtimeMs) })
        await walk(r)
      } else if (d.isFile()) {
        const st = await fsp.lstat(path.join(root, r)).catch(() => null)
        if (!st || !st.isFile()) continue
        files.push({ rel: r, abs: path.join(root, r), size: st.size, mtimeMs: Math.floor(st.mtimeMs), mode: st.mode & 0o777 })
      }
    }
  }
  await walk('')
  return { files, dirs }
}

export function toManifest(files: WalkedFile[]): Manifest {
  const m: Manifest = {}
  for (const f of files) m[f.rel] = { s: f.size, m: f.mtimeMs }
  return m
}

/** What changed from `prev` to `now`: new or modified files, and paths that are gone. */
export function diffManifest(prev: Manifest, now: Manifest): { changed: string[]; deleted: string[] } {
  const changed: string[] = []
  for (const [p, e] of Object.entries(now)) {
    const o = prev[p]
    if (!o || o.s !== e.s || o.m !== e.m) changed.push(p)
  }
  const deleted = Object.keys(prev).filter((p) => !(p in now))
  return { changed, deleted }
}
