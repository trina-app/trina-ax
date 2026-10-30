// Run WITHOUT Playwright/CDP: a second debugger can accidentally resume a stuck worker.
import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { guardAppView, APP_WEB_PREFERENCES } from '../../src/main/security'

app.commandLine.appendSwitch('disable-features', 'IsolateSandboxedIframes')
app.commandLine.appendSwitch('site-per-process')
app.setPath('userData', process.env.RTC_TEST_PROFILE!)
const reports: Record<string, any> = {}
const attached: string[] = []
const pageCommands: string[] = []
const sessions = new Map<string, string>()
let port = 0
const html = (js: string) => `<body><script>${js}</script></body>`
const literal = (value: string) => JSON.stringify(value).replaceAll('<', '\\u003c')
const report = (key: string) => `fetch('http://127.0.0.1:${port}/report?'+encodeURIComponent(JSON.stringify({key:${JSON.stringify(key)},rtc:typeof RTCPeerConnection,media:typeof navigator.mediaDevices,data:typeof RTCDataChannel})))`
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'text/html')
  const url = new URL(req.url!, 'http://localhost')
  if (url.pathname === '/report') {
    const value = JSON.parse(decodeURIComponent(url.search.slice(1)))
    reports[value.key] = value
    res.end('ok'); return
  }
  if (url.pathname === '/child') {
    const key = url.searchParams.get('key')!
    res.end(html(`${report(key)}; const f=document.createElement('iframe');f.src='http://127.0.0.1:${port}/grandchild?key=${key}-nested';document.body.append(f)`)); return
  }
  if (url.pathname === '/grandchild') { res.end(html(report(url.searchParams.get('key')!))); return }
  if (url.pathname.endsWith('.js')) {
    res.setHeader('Content-Type', 'text/javascript')
    const value = `{key:K,rtc:typeof RTCPeerConnection,data:typeof RTCDataChannel,media:typeof navigator.mediaDevices}`
    if (url.pathname === '/worker.js') res.end(`const K='dedicated';postMessage(${value})`)
    else if (url.pathname === '/shared.js') res.end(`const K='shared';onconnect=e=>e.ports[0].postMessage(${value})`)
    else res.end(`const K='service';oninstall=()=>skipWaiting();onactivate=e=>e.waitUntil(clients.claim());onmessage=e=>e.source.postMessage(${value})`)
    return
  }
  res.end(`<body><iframe src="http://localhost:${port}/child?key=oopif"></iframe><script>
    const send=data=>fetch('/report?'+encodeURIComponent(JSON.stringify(data)));
    window.worker=new Worker('/worker.js');worker.onmessage=e=>send(e.data);
    window.shared=new SharedWorker('/shared.js');shared.port.onmessage=e=>send(e.data);
    navigator.serviceWorker.onmessage=e=>send(e.data);
    navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(r=>r.active.postMessage('probe'));
    const blank=document.createElement('iframe');document.body.append(blank);
    send({key:'blank',rtc:typeof blank.contentWindow.RTCPeerConnection});
    send({key:'popup',denied:window.open('about:blank')===null});
    send({key:'top',rtc:typeof RTCPeerConnection});
    const srcdoc=document.createElement('iframe');srcdoc.srcdoc=${literal(html(report('srcdoc')))};document.body.append(srcdoc);
    const blob=document.createElement('iframe');blob.src=URL.createObjectURL(new Blob([${literal(html(report('blob')))}],{type:'text/html'}));document.body.append(blob);
    const data=document.createElement('iframe');data.src='data:text/html,'+encodeURIComponent(${literal(html(report('data')))});document.body.append(data);
    const js=document.createElement('iframe');js.src='javascript:'+encodeURIComponent(JSON.stringify(${literal(html(report('javascript')))}));document.body.append(js);
    setTimeout(()=>{const f=document.createElement('iframe');f.src='http://localhost:${port}/child?key=late';document.body.append(f)},100);
  </script></body>`)
})
void (async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  await app.whenReady()
  const win = new BrowserWindow({ show: false, webPreferences: APP_WEB_PREFERENCES })
  await win.loadURL('about:blank')
  const dbg = win.webContents.debugger
  dbg.on('message', (_event, method, params) => {
    if (method === 'Target.attachedToTarget') {
      attached.push(params.targetInfo.type)
      sessions.set(params.sessionId, params.targetInfo.type)
    }
  })
  const send = dbg.sendCommand.bind(dbg)
  dbg.sendCommand = ((method: string, params?: any, sid?: string) => {
    if (method.startsWith('Page.')) pageCommands.push(sid ? sessions.get(sid) ?? 'unknown' : 'page')
    return send(method, params, sid)
  }) as typeof dbg.sendCommand
  await guardAppView(win.webContents, () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  await win.loadURL(`http://127.0.0.1:${port}/`)
  const expected = ['oopif','oopif-nested','late','late-nested','blank','srcdoc','blob','data','javascript','popup','top','dedicated','shared','service']
  const deadline = Date.now() + 15_000
  while (!expected.every(key => reports[key]) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  const frames = win.webContents.mainFrame.framesInSubtree.map(f => ({ url: f.url, processId: f.processId }))
  console.log('RTC_RESULT ' + JSON.stringify({ reports, attached, pageCommands, frames }))
  win.destroy()
  server.close()
  app.exit(expected.every(key => reports[key]) ? 0 : 1)
})().catch(error => { console.error(error); app.exit(1) })
