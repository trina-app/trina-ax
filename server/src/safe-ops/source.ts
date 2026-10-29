import fs from 'node:fs'
import type { FileService, ToolCtx } from '../files/service'
import { authorize } from '../policy/authorize'
import { Denied } from '../policy/errors'
import { readRegular, sha256 } from '../files/store'

export interface SourceSnapshot {
  path: string
  bytes: Buffer
  hash: string
  identity: string
}
const identity = (s: fs.Stats) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink].join(':')

/** Bounded immutable copy, with every parent held open on Linux; never follow a source link.
 * Explicit mounted folders are supported only on the root filesystem in 1A; other mounts fail closed. */
export function snapshot(files: FileService, ctx: ToolCtx, input: string, cap: number): SourceSnapshot {
  ctx.signal?.throwIfAborted()
  ctx.user = files.principal(ctx.user.id)
  const r = authorize(files.fx, files.rules(), ctx.user, input, 'read')
  let bytes: Buffer, st: fs.Stats
  if (process.platform === 'linux') {
    const fds: number[] = []
    try {
      let fd = fs.openSync(files.fx.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
      fds.push(fd)
      const dev = fs.fstatSync(fd).dev
      for (let i = 0; i < r.segs.length; i++) {
        fd = fs.openSync(
          `/proc/self/fd/${fd}/${r.segs[i]}`,
          fs.constants.O_RDONLY |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK |
            (i < r.segs.length - 1 ? fs.constants.O_DIRECTORY : 0),
        )
        fds.push(fd)
        if (fs.fstatSync(fd).dev !== dev) throw new Denied('source mount is not qualified for safe operations')
      }
      st = fs.fstatSync(fd)
      if (!st.isFile() || st.nlink !== 1 || st.size > cap || identity(st) !== identity(r.st!))
        throw new Denied('source changed or exceeds the safety limit')
      bytes = Buffer.alloc(st.size)
      let off = 0
      while (off < bytes.length) {
        const n = fs.readSync(fd, bytes, off, bytes.length - off, off)
        if (!n) break
        off += n
      }
      if (off !== bytes.length || identity(fs.fstatSync(fd)) !== identity(st))
        throw new Denied('source changed while reading')
    } finally {
      for (const fd of fds.reverse()) fs.closeSync(fd)
    }
  } else {
    ;({ bytes, st } = readRegular(r.abs, cap))
  }
  const now = authorize(files.fx, files.rules(), files.principal(ctx.user.id), r.rel, 'read')
  if (identity(now.st!) !== identity(st)) throw new Denied('source changed while reading')
  return { path: r.rel, bytes, hash: sha256(bytes), identity: identity(st) }
}

/** Synchronous final guard: no await between this check and committing delivery/publication.
 * Account/group membership, path identity, content and policy are all read again. */
export function recheck(files: FileService, ctx: ToolCtx, source: SourceSnapshot) {
  const now = snapshot(files, ctx, source.path, source.bytes.length)
  if (now.hash !== source.hash || now.identity !== source.identity) throw new Denied('source changed; read it again')
}
