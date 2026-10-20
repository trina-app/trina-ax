// Render build-resources/icon.png (1024x1024) with Electron's own renderer: `electron scripts/make-icon.cjs`.
// electron-builder turns it into the .icns / .ico. Rerun only when the design changes.
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center">
  <div style="width:824px;height:824px;border-radius:184px;background:linear-gradient(145deg,#14b8a6 0%,#0f766e 55%,#0b4f4a 100%);
    box-shadow:0 24px 48px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;position:relative">
    <div style="position:absolute;inset:64px;border-radius:132px;border:10px solid rgba(255,255,255,.22)"></div>
    <span style="font:800 360px/1 -apple-system,'Helvetica Neue',Arial,sans-serif;color:#fff;letter-spacing:36px;padding-left:36px;font-kerning:none">AX</span>
  </div>
</div></body></html>`

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 500))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  writeFileSync(join(__dirname, '..', 'build-resources', 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG())
  app.quit()
})
