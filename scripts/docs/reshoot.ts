// `bun run docs:reshoot`: every docs screenshot from fresh fictional data, in one command. It starts the Acme demo
// company (`bun run demo:company --local`) and the quickstart's demo (`bun run demo`) on free ports with new data
// folders, fills Acme with scripts/docs/acme-scene.ts, shoots the acme and quickstart sets in English and in
// Simplified Chinese (scripts/docs/screenshots.ts), then stops both servers and deletes both data folders.
//
//   bun run build:native && bun run build:web     (once per worktree)
//   bun run docs:reshoot [--lang en|zh] [--only chats] [--keep]
//
// --keep leaves both servers running after the shots (Ctrl-C stops them), to look around or shoot again by hand.
// The Acme chats get real AI answers from this computer's Claude Code sign-in (as `bun run demo:company` does), so the
// first part takes a few minutes. The mock shots of the connection pages (Slack, the company's own Google app) need the
// web e2e mock server and stay a separate step: see screenshots.ts.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from './site'
import { dress } from './acme-scene'
import { shoot, type Lang } from './screenshots'

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const a = s.address() as net.AddressInfo; s.close(() => resolve(a.port)) })
})

/** a server script of this repository, its output kept in a log file; resolves once a line matches `ready` */
function start(name: string, args: string[], ready: RegExp, logFile: string) {
  const out = fs.openSync(logFile, 'a')
  const child = Bun.spawn([process.execPath, ...args], { cwd: ROOT, stdin: 'ignore', stdout: 'pipe', stderr: out })
  let seen = ''
  const up = (async () => {
    const reader = child.stdout.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`${name} stopped before it was ready; see ${logFile}`)
      const text = dec.decode(value)
      fs.appendFileSync(logFile, text)
      seen = (seen + text).slice(-4000)
      if (ready.test(seen)) break
    }
    // keep draining into the log so the server never blocks on a full pipe
    void (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; fs.appendFileSync(logFile, dec.decode(value)) } })()
  })()
  return { child, up }
}

async function main() {
  const a = process.argv.slice(2)
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined }
  const langs: Lang[] = get('--lang') ? [get('--lang') as Lang] : ['en', 'zh']
  const only = get('--only')
  const keep = a.includes('--keep')
  const tag = `${Date.now().toString(36)}`
  // short folders in the home directory: the server's sockets live under them and a socket path has a length limit
  const acmeData = path.join(os.homedir(), `.trina-docs-${tag}-acme`)
  const quickData = path.join(os.homedir(), `.trina-docs-${tag}-qs`)
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trina-docs-reshoot-'))
  const [acmePort, relayPort, quickPort] = [await freePort(), await freePort(), await freePort()]
  console.log(`[reshoot] logs in ${logDir}`)
  const servers: ReturnType<typeof start>[] = []
  const stop = async () => {
    for (const s of servers) s.child.kill('SIGTERM')
    await Promise.all(servers.map((s) => s.child.exited))
    for (const d of [acmeData, quickData]) fs.rmSync(d, { recursive: true, force: true })
    console.log('[reshoot] both servers stopped, their data folders deleted')
  }
  process.on('SIGINT', () => void stop().then(() => process.exit(130)))
  const failed: string[] = []
  try {
    // one after the other: each server builds the web app when its sources changed, and two builds at once collide
    const acme = start('the Acme demo', ['scripts/demo/company/start.ts', '--local', '--port', String(acmePort), '--relay-port', String(relayPort), '--data', acmeData], /\[acme\] ready/, path.join(logDir, 'acme.log'))
    servers.push(acme)
    await acme.up
    const quick = start('the quickstart demo', ['scripts/demo/start.ts', '--port', String(quickPort), '--data', quickData], /\[demo\] Ready/, path.join(logDir, 'quickstart.log'))
    servers.push(quick)
    await quick.up
    const acmeUrl = `http://127.0.0.1:${acmePort}`, quickUrl = `http://127.0.0.1:${quickPort}`
    console.log(`[reshoot] Acme on ${acmeUrl}, the quickstart demo on ${quickUrl}; filling Acme (real AI answers, a few minutes)`)
    const ownerPassword = fs.readFileSync(path.join(acmeData, 'owner-password'), 'utf8').trim()
    await dress(acmeUrl, ownerPassword, (s) => console.log(`[acme-scene] ${s}`))
    for (const lang of langs) {
      failed.push(...await shoot({ url: acmeUrl, set: 'acme', lang, only, user: 'acme-admin', password: ownerPassword }))
      failed.push(...await shoot({ url: quickUrl, set: 'quickstart', lang, only, user: 'alice', password: 'teamax-demo-1' }))
    }
    if (keep) {
      console.log(`[reshoot] --keep: Acme ${acmeUrl} (jordan / teamax-demo-1, owner acme-admin), quickstart ${quickUrl} (alice / teamax-demo-1). Ctrl-C stops them.`)
      await Promise.race(servers.map((s) => s.child.exited))
    }
  } finally {
    await stop()
  }
  if (failed.length) { console.error(`[reshoot] not taken:\n${failed.join('\n')}`); process.exitCode = 1 }
}

if (import.meta.main) await main()
