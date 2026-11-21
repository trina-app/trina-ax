// The scripted demo's anonymous events, sent to the website's own POST /e (same origin, so the demo's CSP
// `connect-src 'self'` allows it). Only on ax.trina.app: a self-hosted build, a preview or a local run never sends
// anything. No cookie, no id: the event name, the page path, the language and one short value (a step number, a
// link's place).
export const BEACON_HOST = 'ax.trina.app'
export const BEACON_PATH = '/e'

export type DemoEvent = 'demo_start' | 'demo_step' | 'demo_finish' | 'try_click' | 'cta_click'

export interface BeaconEnv {
  location: { hostname: string; pathname: string }
  lang: string
  send: (url: string, body: string) => boolean
}

const browserEnv = (): BeaconEnv | null => {
  if (typeof location === 'undefined' || typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return null
  return { location, lang: document.documentElement.lang, send: (url, body) => navigator.sendBeacon(url, body) }
}

/** send one event; true when it went out (never throws: counting must never break the demo) */
export function beacon(e: DemoEvent, x: string | number = '', env: BeaconEnv | null = browserEnv()): boolean {
  try {
    if (!env || env.location.hostname !== BEACON_HOST) return false
    const v = String(x).toLowerCase()
    const body = JSON.stringify({ e, p: env.location.pathname.slice(0, 100), l: env.lang, x: /^[a-z0-9_:-]{0,40}$/.test(v) ? v : '' })
    return env.send(BEACON_PATH, body)
  } catch { return false }
}
