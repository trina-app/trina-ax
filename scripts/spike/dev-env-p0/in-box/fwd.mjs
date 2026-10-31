// In-box TCP -> unix socket forwarder: tools in the box that only speak TCP (Claude Code's ANTHROPIC_BASE_URL, npm's
// HTTPS_PROXY) reach the per-box proxy sockets. The socket path, not an IP address, tells the proxy which box calls.
import net from 'node:net'
for (const spec of process.argv.slice(2)) {
  const [listen, sock] = spec.split('=')
  const [host, port] = listen.split(':')
  net.createServer((c) => {
    const u = net.connect(sock)
    c.pipe(u).pipe(c)
    const end = () => { c.destroy(); u.destroy() }
    c.on('error', end); u.on('error', end)
  }).listen(Number(port), host)
}
