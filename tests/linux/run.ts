// Linux job in Docker (separate unprivileged server / engine / person accounts): build the image, run it, check
// every reported check. Used by `bun run test:stage1` and CI. Needs native/bin/linux-<arch> built first.
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const sh = (cmd: string[]) => { const p = Bun.spawnSync(cmd, { cwd: ROOT, env: process.env }); return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() } }

export interface LinuxJobResult { ok: boolean; summary: string; detail?: unknown }

export function runLinuxJob(): LinuxJobResult {
  const b = sh(['docker', 'build', '-q', '-f', 'tests/linux/Dockerfile', '-t', 'mycel-linux-test', '.'])
  if (b.code) return { ok: false, summary: 'docker build failed: ' + b.out.slice(-800) }
  const r = sh(['docker', 'run', '--rm', 'mycel-linux-test'])
  const line = r.out.split('\n').find((l) => l.startsWith('MYCEL_LINUX_RESULT '))
  if (!line) return { ok: false, summary: r.out.slice(-1500) }
  const o = JSON.parse(line.slice('MYCEL_LINUX_RESULT '.length))
  const failed = o.checks.filter((c: { ok: boolean }) => !c.ok)
  return {
    ok: r.code === 0 && !failed.length,
    summary: `${o.checks.length - failed.length}/${o.checks.length} checks; fuzz inproc ${o.fuzz_inproc.calls} calls ${o.fuzz_inproc.fails} fails, socket ${o.fuzz_socket.calls} calls ${o.fuzz_socket.fails} fails; unit ${String(o.unit).replace(/\s+/g, ' ')}`,
    detail: failed.length ? failed : o.checks,
  }
}

if (import.meta.main) {
  const r = runLinuxJob()
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.summary}`)
  if (!r.ok) console.log(JSON.stringify(r.detail, null, 1))
  process.exit(r.ok ? 0 : 1)
}
