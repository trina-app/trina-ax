// A short name for a signed-in device from its user agent: "Chrome on macOS", "Safari on iPhone". Settings › Security
// & devices shows it instead of the raw string (the raw string stays in the tooltip). Only the browser and the system;
// no versions. Unknown parts give null, and the caller then shows the client kind ("Web browser").

export interface DeviceName {
  /** the browser, or null for the desktop or phone app (the caller names the app) */
  browser: string | null
  os: string | null
}

const BROWSERS: [RegExp, string][] = [
  // the order matters: Edge, Opera and Samsung also say "Chrome", and Chrome also says "Safari"
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\b(OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(Firefox|FxiOS)\//, 'Firefox'],
  [/(Chrome|CriOS|Chromium)\//, 'Chrome'], // also HeadlessChrome
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  // the order matters: iPad and iPhone also say "Mac OS X", Android also says "Linux"
  [/\biPhone\b|\biPod\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
]

const find = (ua: string, list: [RegExp, string][]) => list.find(([re]) => re.test(ua))?.[1] ?? null

/** The browser and the system of a user agent. `app`: the session comes from the desktop or phone app (no browser). */
export function parseUserAgent(ua: string | null | undefined, app = false): DeviceName {
  const s = ua ?? ''
  return { browser: app ? null : find(s, BROWSERS), os: find(s, SYSTEMS) }
}

type DeviceKey = 'settings.deviceOn' | 'settings.deviceApp' | `client.${'web' | 'desktop' | 'mobile'}`

/** The line a device shows: "Chrome on macOS" for a browser, "{product} app on Windows" for the desktop or phone app,
 * the client kind ("Web browser") when the user agent says too little. */
export function deviceLabel(client: 'web' | 'desktop' | 'mobile', ua: string | null | undefined, t: (key: DeviceKey, params?: Record<string, string>) => string): string {
  const d = parseUserAgent(ua, client !== 'web')
  const app = client === 'web' ? d.browser : t('settings.deviceApp')
  if (!app || !d.os) return d.browser ?? t(`client.${client}`)
  return t('settings.deviceOn', { app, os: d.os })
}

/** What kind of device a session is, for its icon: the phone app or a browser on an iPhone or an Android phone is a
 * phone, an iPad (or an Android tablet) a tablet, the desktop app a laptop, any other browser a computer. */
export function deviceKind(client: 'web' | 'desktop' | 'mobile', ua: string | null | undefined): 'phone' | 'tablet' | 'laptop' | 'computer' {
  const os = parseUserAgent(ua, client !== 'web').os
  if (os === 'iPad' || (os === 'Android' && !/\bMobile\b/.test(ua ?? '') && client !== 'mobile')) return 'tablet'
  if (client === 'mobile' || os === 'iPhone' || os === 'Android') return 'phone'
  return client === 'desktop' ? 'laptop' : 'computer'
}
