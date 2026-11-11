// Settings › Apps: which phone and desktop app rows show on each device and in each build, and what each offers
// (lib/apps.ts, components/settings/AppList.tsx). Fixture links only: nothing here is fetched.
import { describe, expect, test } from 'bun:test'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { APP_DOWNLOADS } from '@mycel/shared'
import { currentLocale, translate, type MessageKey } from '../../src/i18n'
import { computerApps, noComputerApps, phoneApps, type AppClient, type AppRow } from '../../src/lib/apps'
import { ComputerApps, PhoneApps } from '../../src/components/settings/AppList'

/** an edition like Trina's today: App Store for iPhone and Mac, no Google Play or Microsoft Store yet, a download page */
const ACME = { page: 'https://acme.example/download', iphone: 'https://apps.example/acme?platform=iphone', android: '', mac: 'https://apps.example/acme?platform=mac', windows: '' }
const FULL = { ...ACME, android: 'https://play.example/acme', windows: 'https://store.example/acme' }
/** store listings but no download page: one QR code per phone */
const NO_PAGE = { ...FULL, page: '' }
/** a self-hosted build or another edition: nothing */
const NONE = { page: '', iphone: '', android: '', mac: '', windows: '' }
const win = { platform: 'windows' as const, file: 'Acme-Setup-0.1.0-x64.exe', version: '0.1.0', size: 1000 }
const mac = { platform: 'mac' as const, file: 'Acme-0.1.0-mac-universal.dmg', version: '0.1.0' }

const web = (here: AppClient['here']): AppClient => ({ kind: 'web', here, store: false })
const desktop = (here: AppClient['here'], store = false): AppClient => ({ kind: 'desktop', here, store })
const phoneApp = (here: 'ios' | 'android'): AppClient => ({ kind: 'mobile', here, store: false })
/** a row in short: "os:action[+files][:this-app][:this-device]" (+files: the server's installers folded under it) */
const short = (rows: AppRow[]) => rows.map((r) => [`${r.action?.kind ?? '-'}${r.more ? '+files' : ''}`, r.thisApp && 'this-app', r.thisDevice && 'this-device'].reduce<string>((a, b) => (b ? `${a}:${b}` : a), r.os))
const l = currentLocale()
/** a message as it reads in the markup (quotes escaped) */
const inHtml = (k: MessageKey) => renderToStaticMarkup(createElement(Fragment, null, translate(l, k)))

describe('phone apps', () => {
  test('a computer lists iPhone and Android, with one QR code of the download page', () => {
    for (const c of [web('mac'), web('windows'), web('other'), desktop('windows', true), desktop('mac')]) {
      const p = phoneApps(ACME, c)
      expect(short(p.rows), JSON.stringify(c)).toEqual(['iphone:store', 'android:page'])
      expect(p.qr).toBe(ACME.page)
    }
    expect(phoneApps(FULL, web('mac')).rows.map((r) => r.action)).toEqual([{ kind: 'store', href: FULL.iphone }, { kind: 'store', href: FULL.android }])
  })
  test('a phone in a browser shows only its own store', () => {
    expect(short(phoneApps(ACME, web('ios')).rows)).toEqual(['iphone:store:this-device'])
    expect(short(phoneApps(ACME, web('android')).rows)).toEqual(['android:page:this-device'])
    expect(short(phoneApps(FULL, web('android')).rows)).toEqual(['android:store:this-device'])
    expect(phoneApps(FULL, web('ios')).qr).toBeNull()
  })
  test('the phone app collapses to "This app", in any build', () => {
    for (const links of [ACME, NONE]) {
      expect(short(phoneApps(links, phoneApp('ios')).rows)).toEqual(['iphone:-:this-app:this-device'])
      expect(short(phoneApps(links, phoneApp('android')).rows)).toEqual(['android:-:this-app:this-device'])
      expect(phoneApps(links, phoneApp('ios')).qr).toBeNull()
    }
  })
  test('the Mac App Store build names no other mobile platform (App Review 2.3.10): iPhone only, the QR code to the page', () => {
    const p = phoneApps(FULL, desktop('mac', true))
    expect(short(p.rows)).toEqual(['iphone:store'])
    expect(p.qr).toBe(FULL.page)
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(PhoneApps, { links: FULL, client: desktop('mac', true) }),
      createElement(ComputerApps, { links: FULL, client: desktop('mac', true), downloads: [win, mac], owner: true })))
    expect(html).not.toMatch(/Android|Google Play/)
  })
  test('without links: no rows (the section is left out); without a page: no shared QR code', () => {
    for (const c of [web('mac'), web('ios'), web('android'), desktop('mac', true)]) expect(phoneApps(NONE, c)).toEqual({ rows: [], qr: null })
    expect(phoneApps(NO_PAGE, web('mac')).qr).toBeNull()
    expect(short(phoneApps({ ...NONE, page: ACME.page }, web('mac')).rows)).toEqual(['iphone:page', 'android:page'])
  })
  test('what it renders: links that open outside, one small QR code on a computer, none on a phone', () => {
    const qrLabel = translate(l, 'apps.qrLabel')
    const computer = renderToStaticMarkup(createElement(PhoneApps, { links: ACME, client: web('mac') }))
    expect(computer).toContain(`href="${ACME.iphone}"`)
    expect(computer).toContain(`href="${ACME.page}"`)
    expect(computer.match(/target="_blank" rel="noopener noreferrer"/g)).toHaveLength(2)
    expect(computer.match(/<svg role="img"/g)).toHaveLength(1)
    expect(computer).toContain(`aria-label="${qrLabel}"`)
    expect(computer).toContain('App Store')
    expect(computer).toContain(translate(l, 'apps.scanQr').replaceAll("'", '&#x27;'))
    const phone = renderToStaticMarkup(createElement(PhoneApps, { links: ACME, client: web('ios') }))
    expect(phone).not.toContain('<svg role="img"')
    expect(phone).not.toContain('app-row-android')
    expect(phone).toContain(`href="${ACME.iphone}"`)
    // no page: each phone its own small code
    expect(renderToStaticMarkup(createElement(PhoneApps, { links: NO_PAGE, client: web('mac') })).match(/<svg role="img"/g)).toHaveLength(2)
    // the phone app: "This app", no link
    const app = renderToStaticMarkup(createElement(PhoneApps, { links: ACME, client: phoneApp('ios') }))
    expect(app).toContain(translate(l, 'apps.thisApp'))
    expect(app).not.toContain('href=')
    expect(renderToStaticMarkup(createElement(PhoneApps, { links: NONE, client: web('mac') }))).toBe('')
  })
})

describe('desktop apps', () => {
  test("Windows: the team server's installer first, else the store listing, else the download page", () => {
    expect(short(computerApps(ACME, web('mac'), []))).toEqual(['mac:store:this-device', 'windows:page'])
    expect(short(computerApps(ACME, web('mac'), [win]))).toEqual(['mac:store:this-device', 'windows:files'])
    expect(short(computerApps(FULL, web('windows'), [win]))).toEqual(['mac:store', 'windows:files:this-device'])
    expect(short(computerApps(FULL, web('other'), []))).toEqual(['mac:store', 'windows:store'])
    expect(short(computerApps(ACME, phoneApp('ios'), [win]))).toEqual(['mac:store', 'windows:files'])
  })
  test("the Mac: the App Store first, the server's installer folded under it only when the server has one (owner, 2026-11-11)", () => {
    // without a server installer: the App Store alone
    expect(short(computerApps(ACME, web('mac'), []))).toEqual(['mac:store:this-device', 'windows:page'])
    expect(computerApps(ACME, web('mac'), [win])[0]).toEqual({ os: 'mac', action: { kind: 'store', href: ACME.mac }, thisApp: false, thisDevice: true })
    // with one: still the App Store, the installer second
    expect(short(computerApps(ACME, web('mac'), [mac, win]))).toEqual(['mac:store+files:this-device', 'windows:files'])
    expect(computerApps(ACME, web('mac'), [win, mac])[0]).toEqual({ os: 'mac', action: { kind: 'store', href: ACME.mac }, thisApp: false, thisDevice: true, more: [mac] })
    for (const c of [web('windows'), web('other'), web('ios'), phoneApp('ios'), phoneApp('android'), desktop('windows')])
      expect(short(computerApps(ACME, c, [mac, win]))[0], JSON.stringify(c)).toBe('mac:store+files')
    // no App Store listing (another edition, a self-hosted build, only a download page): the installer first, as before
    expect(short(computerApps(NONE, web('mac'), [mac]))).toEqual(['mac:files:this-device'])
    expect(short(computerApps({ ...NONE, page: ACME.page }, web('windows'), [mac]))).toEqual(['mac:files', 'windows:page:this-device'])
    // unchanged: the Mac App Store build offers no installer; the desktop app from the team server only its own
    expect(short(computerApps(ACME, desktop('mac', true), [mac, win]))).toEqual(['mac:-:this-app:this-device', 'windows:page'])
    expect(short(computerApps(ACME, desktop('mac'), [mac, win]))).toEqual(['mac:files:this-app:this-device', 'windows:files'])
  })
  test("what the Mac row renders: the App Store link, then a closed fold with the installer and its steps", () => {
    const html = renderToStaticMarkup(createElement(ComputerApps, { links: ACME, client: web('mac'), downloads: [mac, win], owner: false }))
    const store = html.indexOf(`href="${ACME.mac}"`)
    const details = html.indexOf('<details')
    const dmg = html.indexOf('href="/downloads/Acme-0.1.0-mac-universal.dmg" download=""')
    const end = html.indexOf('</details>')
    expect(store).toBeGreaterThan(-1)
    expect(details).toBeGreaterThan(store)
    expect(dmg).toBeGreaterThan(details)
    expect(dmg).toBeLessThan(end)
    expect(html).toContain('data-testid="app-more-mac"')
    expect(html).not.toMatch(/<details[^>]* open/)
    expect(html.slice(details)).toContain(inHtml('apps.installerFile'))
    // the warning the file brings is inside the fold, on the Mac it is for
    expect(html.indexOf(inHtml('apps.macGatekeeper'))).toBeGreaterThan(details)
    expect(html.indexOf(inHtml('apps.macGatekeeper'))).toBeLessThan(end)
    expect(html).not.toContain(inHtml('apps.winSmartScreen'))
    // on a Windows PC the Mac's fold has the file but not the steps
    const pc = renderToStaticMarkup(createElement(ComputerApps, { links: ACME, client: web('windows'), downloads: [mac, win], owner: false }))
    expect(pc).toContain('data-testid="app-more-mac"')
    expect(pc).not.toContain(inHtml('apps.macGatekeeper'))
    expect(pc).toContain(inHtml('apps.winSmartScreen'))
    // no installer on the server, or the Mac App Store build: no fold
    for (const [client, downloads] of [[web('mac'), [win]], [desktop('mac', true), [mac, win]]] as const) {
      const none = renderToStaticMarkup(createElement(ComputerApps, { links: ACME, client, downloads: [...downloads], owner: false }))
      expect(none, JSON.stringify(client)).not.toContain('<details')
      expect(none).not.toContain(inHtml('apps.installerFile'))
      expect(none).not.toContain('.dmg')
    }
  })
  test('a store build: its own row is "This app" with no action, and no installer file anywhere', () => {
    expect(short(computerApps(ACME, desktop('mac', true), [win, mac]))).toEqual(['mac:-:this-app:this-device', 'windows:page'])
    expect(short(computerApps(FULL, desktop('windows', true), [win, mac]))).toEqual(['mac:store', 'windows:-:this-app:this-device'])
    expect(short(computerApps(NONE, desktop('mac', true), [win]))).toEqual(['mac:-:this-app:this-device'])
    expect(noComputerApps(computerApps(NONE, desktop('mac', true), []), { store: true })).toBe(false)
  })
  test("an Apple build (Mac App Store, iPhone app) reaches another platform's store only through the download page (App Review 2.3.10)", () => {
    expect(computerApps(FULL, desktop('mac', true), []).find((r) => r.os === 'windows')?.action).toEqual({ kind: 'page', href: FULL.page })
    expect(computerApps(FULL, phoneApp('ios'), []).find((r) => r.os === 'windows')?.action).toEqual({ kind: 'page', href: FULL.page })
    expect(computerApps(FULL, phoneApp('ios'), []).find((r) => r.os === 'mac')?.action).toEqual({ kind: 'store', href: FULL.mac })
    // elsewhere the listing itself
    expect(computerApps(FULL, desktop('windows', true), []).find((r) => r.os === 'mac')?.action).toEqual({ kind: 'store', href: FULL.mac })
    expect(computerApps(FULL, phoneApp('android'), []).find((r) => r.os === 'windows')?.action).toEqual({ kind: 'store', href: FULL.windows })
    expect(computerApps(FULL, web('mac'), []).find((r) => r.os === 'windows')?.action).toEqual({ kind: 'store', href: FULL.windows })
    // and an Apple build without a page has no such row
    expect(short(computerApps({ ...FULL, page: '' }, desktop('mac', true), []))).toEqual(['mac:-:this-app:this-device'])
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(PhoneApps, { links: FULL, client: phoneApp('ios') }),
      createElement(ComputerApps, { links: FULL, client: phoneApp('ios'), downloads: [win, mac], owner: true })))
    expect(html).not.toMatch(/Android|Google Play|Microsoft Store/)
  })
  test('the desktop app from the team server: "This app" with its installer, and how it updates', () => {
    expect(short(computerApps(NONE, desktop('windows'), [win]))).toEqual(['windows:files:this-app:this-device'])
    // its own row offers only the server's installer: a store listing is another build, with its own data
    expect(short(computerApps(ACME, desktop('mac'), []))).toEqual(['mac:-:this-app:this-device', 'windows:page'])
    const pc = renderToStaticMarkup(createElement(ComputerApps, { links: NONE, client: desktop('windows'), downloads: [win], owner: false }))
    expect(pc).toContain(translate(l, 'apps.thisApp'))
    expect(pc).toContain(translate(l, 'apps.updatesItself'))
    const dmg = renderToStaticMarkup(createElement(ComputerApps, { links: NONE, client: desktop('mac'), downloads: [mac], owner: false }))
    expect(dmg).toContain(translate(l, 'apps.macUpdates'))
  })
  test('no links and no installers: nothing to list, the empty state instead', () => {
    for (const c of [web('mac'), web('windows'), web('other'), web('ios'), phoneApp('android'), desktop('mac'), desktop('windows')]) expect(noComputerApps(computerApps(NONE, c, []), c)).toBe(true)
    // the desktop app from the team server, nothing on the server: the empty state and the owner's hint, as before
    const app = renderToStaticMarkup(createElement(ComputerApps, { links: NONE, client: desktop('mac'), downloads: 'none', owner: true }))
    expect(app).toContain('teamax desktop add')
    expect(app).not.toContain('app-row-mac')
    // only the other computer's installer: this app's row says the server has none
    const other = renderToStaticMarkup(createElement(ComputerApps, { links: NONE, client: desktop('mac'), downloads: [win], owner: false }))
    expect(other).toContain(translate(l, 'apps.noMacApp'))
    expect(other).toContain(translate(l, 'apps.thisApp'))
    // a Mac in a browser keeps its row only when there is something else to show
    expect(short(computerApps(NONE, web('mac'), [win]))).toEqual(['mac:-:this-device', 'windows:files'])
    const html = renderToStaticMarkup(createElement(ComputerApps, { links: NONE, client: web('mac'), downloads: 'none', owner: false }))
    expect(html).toBe(`<p class="text-sm text-muted">${translate(l, 'apps.noDownloads')}</p>`)
  })
  test('store listings and the download page open outside; installer files download from the team server', () => {
    const html = renderToStaticMarkup(createElement(ComputerApps, { links: ACME, client: web('mac'), downloads: [win], owner: false }))
    expect(html).toContain(`href="${ACME.mac}"`)
    expect(html).toContain('href="/downloads/Acme-Setup-0.1.0-x64.exe" download=""')
    expect(html).toContain(translate(l, 'apps.thisComputer'))
    // the owner of a server without installers still learns where they come from, under the rows; members do not
    const owner = renderToStaticMarkup(createElement(ComputerApps, { links: ACME, client: web('mac'), downloads: 'none', owner: true, server: 'hosted-feed' }))
    expect(owner).toContain(`href="${ACME.page}"`)
    expect(owner).toContain('data-testid="apps-owner-hint"')
    expect(owner).toContain('Diagnostics')
    expect(renderToStaticMarkup(createElement(ComputerApps, { links: ACME, client: web('mac'), downloads: 'none', owner: false, server: 'hosted-feed' }))).not.toContain('apps-owner-hint')
    expect(renderToStaticMarkup(createElement(ComputerApps, { links: ACME, client: web('mac'), downloads: [win], owner: true, server: 'hosted-feed' }))).not.toContain('apps-owner-hint')
    expect(renderToStaticMarkup(createElement(ComputerApps, { links: ACME, client: desktop('mac', true), downloads: 'none', owner: true, server: 'hosted-feed' }))).not.toContain('apps-owner-hint')
    // a loading list (no store build) is a skeleton, not an empty state
    expect(renderToStaticMarkup(createElement(ComputerApps, { links: ACME, client: web('mac'), downloads: null, owner: false }))).toContain('animate-pulse')
  })
})

test("the build's own links are https addresses or empty, and none is a file the page would download", () => {
  for (const [k, v] of Object.entries(APP_DOWNLOADS)) {
    if (v) expect(v, k).toMatch(/^https:\/\/[^/'"\s]+/)
    if (v) expect(new URL(v).pathname, k).not.toMatch(/\.(apk|aab|exe|msi|msix|appx|dmg|pkg|zip)$/i)
  }
})
