// The HTML print's request interception on its own (files/html-pdf.ts): run with MYCEL_ISOLATION=none, so no OS
// sandbox stands between the browser and the network, and count what reaches a TCP listener on this machine. Prints
// one JSON line: { isolation, cases: { name: connections[] } }. Used by tests/unit/html-pdf.test.ts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findPdfBrowser, renderHtmlPdf } from '../../server/src/files/html-pdf'
import { isolation } from '../../server/src/tools/isolate'

const browser = findPdfBrowser()
if (!browser) { console.log(JSON.stringify({ skipped: 'no browser' })); process.exit(0) }
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-icpt-'))
const conns: string[] = []
const srv = Bun.listen({
  hostname: '127.0.0.1', port: 0, socket: {
    open() { conns.push('open') },
    data(s, d) { conns.push(d.toString().split('\r\n')[0]!); s.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); s.end() },
  },
})
const O = `http://127.0.0.1:${srv.port}`
const cases: Record<string, string> = {
  img: `<img src="${O}/img.png">`,
  srcset: `<img srcset="${O}/srcset.png 1x">`,
  cssBackground: `<div style="height:10px;background:url(${O}/bg.png)"></div>`,
  imageSet: `<div style="height:10px;background-image:image-set('${O}/set.png' 1x)"></div>`,
  stylesheet: `<link rel="stylesheet" href="${O}/style.css">`,
  cssImport: `<style>@import url(${O}/imp.css);</style>`,
  font: `<style>@font-face{font-family:X;src:url(${O}/f.woff2)} p{font-family:X}</style>`,
  preconnect: `<link rel="preconnect" href="${O}"><link rel="dns-prefetch" href="${O}">`,
  prefetch: `<link rel="prefetch" href="${O}/prefetch"><link rel="preload" as="image" href="${O}/preload.png">`,
  iframe: `<iframe src="${O}/frame"></iframe><iframe src="http://localhost:${srv.port}/frame2"></iframe>`,
  srcdoc: `<iframe srcdoc="<img src=${O}/srcdoc.png>"></iframe><iframe sandbox srcdoc="<img src=${O}/sandboxed.png>"></iframe>`,
  objectEmbed: `<object data="${O}/object"></object><embed src="${O}/embed">`,
  svgImage: `<svg width="10" height="10"><image href="${O}/svg.png" width="10" height="10"/></svg>`,
  metaRefresh: `<meta http-equiv="refresh" content="0;url=${O}/refresh">`,
  script: `<script src="${O}/s.js"></script><script>fetch('${O}/fetch')</script>`,
  video: `<video poster="${O}/poster.png" src="${O}/v.mp4"></video><audio src="${O}/a.mp3"></audio>`,
  form: `<form action="${O}/form"><input type="image" src="${O}/input.png"></form>`,
}
const out: Record<string, string[]> = {}
for (const [name, body] of Object.entries(cases)) {
  conns.length = 0
  try { await renderHtmlPdf({ browser, html: Buffer.from(`<!doctype html>${body}<p>end</p>`), page: 'a/b.html', workBase: base, asset: () => null, limits: { timeoutMs: 20_000 } }) } catch (e) { out[name + ':error'] = [String(e)] }
  await Bun.sleep(150)
  out[name] = [...conns]
}
srv.stop(true)
fs.rmSync(base, { recursive: true, force: true })
console.log(JSON.stringify({ isolation: isolation(), cases: out }))
process.exit(0)
