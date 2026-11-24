// The browser commands of a run (docs/decisions/20261123-box-browser-default.md). Debian's chromium aborts in a run: srt's
// seccomp filter refuses socket(AF_UNIX) and its ProcessSingleton needs one. So `chromium` and the names people expect
// are, in the server's read-only bin folder that comes first on a run's PATH, a small script that starts the pinned
// chrome-headless-shell with the flags a run needs. Chromium ignores the login in a proxy address, so when the command
// names no proxy the script starts a relay for that one browser: it listens on 127.0.0.1 in the run's own network
// namespace, forwards only to the run's proxy (which keeps every site rule), adds the login there, and ends with the
// browser. The login stays in the environment: never in an argument, a file or the output.
import fs from 'node:fs'
import path from 'node:path'

export const BOX_BROWSER_CMD = 'chromium'
export const BOX_BROWSER_ALIASES = ['chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'] as const
export const BOX_BROWSER_RELAY = 'browser-proxy-relay.cjs'

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The relay: argv[2] is the browser's pid (the script execs into the browser, so it is the relay's parent). */
export const browserRelaySource = () => String.raw`'use strict'
// the dev environment's browser proxy relay (server/src/devenv/srt/box-browser.ts, generated). Do not edit.
const http = require('node:http'), net = require('node:net'), fs = require('node:fs')
const parent = Number(process.argv[2]), up = new URL(process.env.HTTPS_PROXY || process.env.HTTP_PROXY)
const auth = 'Basic ' + Buffer.from(decodeURIComponent(up.username) + ':' + decodeURIComponent(up.password)).toString('base64')
const host = up.hostname, port = Number(up.port) || 80
const server = http.createServer((req, res) => {
  if (!/^http:\/\//i.test(req.url || '')) { res.writeHead(400); return res.end() }
  const headers = { ...req.headers, 'proxy-authorization': auth }
  delete headers['proxy-connection']
  const out = http.request({ host, port, method: req.method, path: req.url, headers, agent: false }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res) })
  out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
  req.pipe(out)
})
server.on('connect', (req, client, head) => {
  const s = net.connect(port, host)
  let buf = Buffer.alloc(0), open = false
  const stop = () => { s.destroy(); client.destroy() }
  s.on('error', stop); client.on('error', stop); client.on('close', () => s.destroy())
  s.on('connect', () => s.write('CONNECT ' + req.url + ' HTTP/1.1\r\nHost: ' + req.url + '\r\nProxy-Authorization: ' + auth + '\r\n\r\n'))
  const first = (d) => {
    buf = Buffer.concat([buf, d])
    const end = buf.indexOf('\r\n\r\n')
    if (end < 0) { if (buf.length > 65536) stop(); return }
    s.off('data', first); open = /^HTTP\/1\.[01] 2/.test(buf.toString('latin1', 0, 16))
    client.write(buf)
    if (!open) return void client.end(() => s.destroy())
    if (head.length) s.write(head)
    s.pipe(client); client.pipe(s)
  }
  s.on('data', first)
})
server.on('clientError', (_e, c) => c.destroy())
setInterval(() => { if (process.ppid !== parent) process.exit(0) }, 500)
// one connection's fault never ends the relay of the browser
process.on('uncaughtException', () => {})
// stdout stays open: node's stream.pipe looks at process.stdout, which throws on a closed descriptor
server.listen(0, '127.0.0.1', () => { fs.writeSync(1, server.address().port + '\n') })
`

/** The command. A flag it does not know goes to the browser as it is. */
export const browserWrapperSource = (o: { browser: string; node: string; relay: string }) => `#!/bin/bash
# the dev environment's browser command (server/src/devenv/srt/box-browser.ts, generated). Do not edit.
B=${sq(o.browser)}
output=0 proxy=0
for a in "$@"; do
  case "$a" in
    --version|--product-version) exec "$B" --version ;;
    --help|-h) echo "Headless browser. Use --screenshot=FILE, --print-to-pdf=FILE or --dump-dom with a URL, or a debugging port or pipe."; exit 0 ;;
    --remote-debugging-*|--screenshot|--screenshot=*|--print-to-pdf|--print-to-pdf=*|--dump-dom) output=1 ;;
    --proxy-server=*|--no-proxy-server|--proxy-pac-url=*|--proxy-auto-detect) proxy=1 ;;
  esac
done
if [ "$output" = 0 ]; then
  echo "$(basename "$0"): there is no screen here. Add --screenshot=FILE, --print-to-pdf=FILE or --dump-dom." >&2
  exit 64
fi
set -- --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-crash-reporter --disable-breakpad "$@"
P=\${HTTPS_PROXY:-$HTTP_PROXY}
if [ "$proxy" = 0 ] && [[ "$P" == *@* ]]; then
  exec 9< <(exec 3>&- 4>&-; exec env -u NODE_USE_ENV_PROXY -u NODE_OPTIONS ${sq(o.node)} ${sq(o.relay)} "$$" </dev/null 2>/dev/null)
  port=
  read -r -t 5 port <&9 || true
  exec 9<&-
  case "$port" in
    ''|*[!0-9]*) echo "$(basename "$0"): the proxy relay did not start; remote pages will answer 407." >&2 ;;
    *) set -- "--proxy-server=http://127.0.0.1:$port" "$@" ;;
  esac
fi
exec "$B" "$@"
`

function put(file: string, src: string, mode: number) {
  try { if (fs.readFileSync(file, 'utf8') === src && (fs.statSync(file).mode & 0o777) === mode) return } catch {}
  const tmp = `${file}.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, src, { mode })
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, file)
}
function link(file: string, to: string) {
  try { if (fs.readlinkSync(file) === to) return } catch {}
  const tmp = `${file}.${process.pid}.${Date.now()}`
  fs.symlinkSync(to, tmp)
  fs.renameSync(tmp, file)
}

/** The commands in the server's bin folder, or none when this server has no browser for runs (`browser` null). */
export function writeBoxBrowser(bin: string, browser: string | null, node: string) {
  const names = [BOX_BROWSER_CMD, ...BOX_BROWSER_ALIASES, BOX_BROWSER_RELAY]
  if (!browser) { for (const n of names) fs.rmSync(path.join(bin, n), { force: true }); return }
  fs.mkdirSync(bin, { recursive: true, mode: 0o755 })
  const relay = path.join(bin, BOX_BROWSER_RELAY)
  put(relay, browserRelaySource(), 0o644)
  put(path.join(bin, BOX_BROWSER_CMD), browserWrapperSource({ browser, node, relay }), 0o755)
  for (const a of BOX_BROWSER_ALIASES) link(path.join(bin, a), BOX_BROWSER_CMD)
}
