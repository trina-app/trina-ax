import fs from 'node:fs'
import crypto from 'node:crypto'
import { sourceOf } from '../chat/read-scope'
import { broker } from './broker'
import type { FileService, ToolCtx } from '../files/service'
import { authorize } from '../policy/authorize'
import { Denied } from '../policy/errors'
import { readRegular, sha256 } from '../files/store'
import { safeText } from './strings'

export interface SourceSnapshot {
  path: string
  bytes: Buffer
  hash: string
  identity: string
  version?: string
  policy?: number
}
const identity = (s: fs.Stats) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink].join(':')

/** Bounded immutable copy, with every parent held open on Linux; never follow a source link.
 * The team-root FD is the sole approved root; all nested mounts (including same-device binds) fail closed. */
export function snapshot(files: FileService, ctx: ToolCtx, input: string, cap: number, record = true): SourceSnapshot {
  ctx.signal?.throwIfAborted()
  const policy = (files.db.query('SELECT generation FROM safe_ops_policy WHERE id=1').get() as {generation:number}).generation
  const persist = (s: SourceSnapshot): SourceSnapshot => {
    if ((files.db.query('SELECT generation FROM safe_ops_policy WHERE id=1').get() as {generation:number}).generation !== policy)
      throw new Denied(safeText(files.db,ctx.user.id,'changed'))
    if (!record) return {...s,policy}
    const version=crypto.randomUUID()
    files.db.query('INSERT INTO safe_ops_sources(id,user_id,turn_id,path,identity,hash,policy,scope,created) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(version,ctx.user.id,ctx.turnId,s.path,s.identity,s.hash,policy,JSON.stringify(sourceOf(files.db,files.rules(),s.path)),Date.now())
    return {...s,version,policy}
  }
  ctx.user = files.principal(ctx.user.id)
  const r = authorize(files.fx, files.rules(), ctx.user, input, 'read')
  let bytes: Buffer, st: fs.Stats
  if (process.platform === 'linux') {
    const result = broker(files.fx.root, ['snapshot', r.rel, String(cap)], undefined, cap + 4096)!
    const newline = result.indexOf(10)
    const meta = JSON.parse(result.subarray(0, newline).toString()) as {identity:string; dev:number; ino:number; size:number; hash:string}
    bytes = result.subarray(newline + 1)
    const now = authorize(files.fx, files.rules(), files.principal(ctx.user.id), r.rel, 'read')
    if (meta.dev !== r.st!.dev || meta.ino !== r.st!.ino || meta.size !== r.st!.size ||
        identity(now.st!) !== identity(r.st!) || bytes.length !== meta.size || sha256(bytes) !== meta.hash)
      throw new Denied(safeText(files.db, ctx.user.id, 'sourceChanged'))
    files.quarantine.assertBytes(bytes)
    return persist({path:r.rel, bytes, hash:meta.hash, identity:meta.identity})

  } else {
    ;({ bytes, st } = readRegular(r.abs, cap))
  }
  const now = authorize(files.fx, files.rules(), files.principal(ctx.user.id), r.rel, 'read')
  if (identity(now.st!) !== identity(st)) throw new Denied(safeText(files.db, ctx.user.id, 'sourceChanged'))
  files.quarantine.assertBytes(bytes)
  return persist({ path: r.rel, bytes, hash: sha256(bytes), identity: identity(st) })
}

/** Synchronous final guard: no await between this check and committing delivery/publication.
 * Account/group membership, path identity, content and policy are all read again. */
export function recheck(files: FileService, ctx: ToolCtx, source: SourceSnapshot) {
  const now = snapshot(files, ctx, source.path, source.bytes.length, false)
  if (now.hash !== source.hash || now.identity !== source.identity || (source.policy !== undefined && now.policy !== source.policy)) throw new Denied(safeText(files.db, ctx.user.id, 'sourceChanged'))
}
