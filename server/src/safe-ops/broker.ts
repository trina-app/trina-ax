import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { nativeBinDir } from '../config'
import { ToolError } from '../policy/errors'

/** Broker-only operations: FD 3 is the authorized root, stdin contains bounded bytes.
 * No shell, parser, model argv or environment; Linux openat2 has no fallback. */
export function broker(root: string, args: string[], input?: Uint8Array, cap = 32 * 1024 ** 2 + 4096) {
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    const r = spawnSync(path.join(nativeBinDir(), 'mycel-safeops'), args, {
      input, stdio: ['pipe', 'pipe', 'pipe', fd], timeout: 10_000, maxBuffer: cap,
      env: { PATH: '/nonexistent', GOMAXPROCS: '2' },
    })
    if (r.status === 4) return null
    if (r.error || r.status !== 0) throw new ToolError('Safe filesystem operation unavailable or changed.', 'safe_ops_changed')
    return r.stdout
  } finally { fs.closeSync(fd) }
}
