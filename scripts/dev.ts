// `bun run dev`: the dev server plus every workspace that has a "dev" script (web: Vite on 19140, ...).
// Output is prefixed per process; Ctrl-C stops everything. Workspaces join automatically when they add a dev script.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const procs: { name: string; cmd: string[]; cwd: string }[] = [{ name: 'server', cmd: ['bun', '--watch', 'server/src/main.ts'], cwd: ROOT }]
for (const ws of ['web', 'desktop', 'relay']) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, ws, 'package.json'), 'utf8'))
    if (pkg.scripts?.dev) procs.push({ name: ws, cmd: ['bun', 'run', 'dev'], cwd: path.join(ROOT, ws) })
  } catch {}
}

const colors = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m']
const running = procs.map((p, i) => {
  const child = Bun.spawn(p.cmd, { cwd: p.cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'inherit', env: process.env })
  const tag = `${colors[i % colors.length]}[${p.name}]\x1b[0m `
  for (const stream of [child.stdout, child.stderr]) {
    ;(async () => {
      let buf = ''
      for await (const ch of stream as ReadableStream<Uint8Array>) {
        buf += new TextDecoder().decode(ch)
        let n
        while ((n = buf.indexOf('\n')) >= 0) { process.stdout.write(tag + buf.slice(0, n) + '\n'); buf = buf.slice(n + 1) }
      }
      if (buf) process.stdout.write(tag + buf + '\n')
    })()
  }
  return { ...p, child }
})
console.log(`dev: ${running.map((p) => p.name).join(', ')} (Ctrl-C to stop)`)

const stop = () => { for (const p of running) p.child.kill('SIGTERM') }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
const codes = await Promise.all(running.map((p) => p.child.exited))
process.exit(codes.find((c) => c !== 0) ?? 0)
