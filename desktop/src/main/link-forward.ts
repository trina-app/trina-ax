// macOS: a link that a second start of the app received is handed to the app that is already running.
//
// Why (owner 2026-11-22, the "Google Drive 공유" dialog that kept waiting): macOS hands a `trina-ax://` link to ONE
// registered copy of the app, chosen by LaunchServices, not necessarily the one that is running. When it picks another
// copy (an older build, a mounted installer, a copy elsewhere on the disk), macOS starts that copy. It shares the user
// data folder, loses the single-instance lock and quits. The running app then got 'second-instance' with no link
// (macOS puts the link in an open-url event of the second process, never in its command line), came to the front,
// and the sign-in code was lost.
//
// Now the running app listens on a socket in its user data folder (only this user can reach it), and a second start
// on macOS waits a moment for its open-url and sends the link there before it quits. The running app checks the link
// like any other (linkFromArgv, then AppWindow.offerLink): nothing here trusts what it is sent.
// Copies older than this change still quit without passing the link; for those, unregister the stale copies.
import { chmodSync, rmSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

/** The socket in the user data folder; null when its path is too long for a Unix socket (104 bytes on macOS). */
export function linkSocketPath(userData: string): string | null {
  const p = join(userData, 'link.sock')
  return Buffer.byteLength(p) <= 100 ? p : null
}

/** The longest line a second start may send (the same bound as a link on a command line, common/address.ts). */
const MAX = 4096

/** The running app: each connection sends one link, one line. */
export function listenForLinks(path: string, onLine: (line: string) => void): net.Server {
  try { rmSync(path, { force: true }) } catch { /* a socket a crashed run left: replaced below */ }
  const server = net.createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.setTimeout(2000, () => sock.destroy())
    sock.on('error', () => sock.destroy())
    sock.on('data', (d: string) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) { if (buf.length > MAX) sock.destroy(); return }
      sock.end()
      if (i <= MAX) onLine(buf.slice(0, i))
    })
  })
  server.on('error', () => { /* no forwarding this run: links still come in through open-url */ })
  server.listen(path, () => { try { chmodSync(path, 0o600) } catch { /* the folder is the user's own */ } })
  return server
}

/** A second start: send the link to the running app; true when it was written. Gives up after `timeoutMs`. */
export function forwardLink(path: string, link: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(path)
    const done = (ok: boolean) => { sock.destroy(); resolve(ok) }
    const timer = setTimeout(() => done(false), timeoutMs)
    sock.on('error', () => { clearTimeout(timer); done(false) })
    sock.on('connect', () => sock.end(link.slice(0, MAX) + '\n', () => { clearTimeout(timer); done(true) }))
  })
}
