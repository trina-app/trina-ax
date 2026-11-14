// The demo's address on its site: at the root, or under a path such as https://ax.trina.app/demo/ (DEMO_BASE, Vite's
// `base`; web/demo/vite.ts). The app itself knows nothing of it and keeps its own addresses ("/c/…", "/rooms/…"):
// - the browser's addresses get the base when the app writes them (pushState, replaceState);
// - they lose it where the app reads them: its history is handed a window whose `location` shows the app's address, and
//   its few direct reads of `window.location.pathname` read that location (demo-only transforms in vite.ts);
// - /api and the app's public files keep their root addresses: the page answers /api itself, and the worker (sw.js)
//   fetches the public files from under the base.
export const BASE: string = import.meta.env.BASE_URL

/** a browser path as the app knows it (the base taken off) */
export const appPath = (p: string) => (BASE !== '/' && `${p}/`.startsWith(BASE) ? `/${p.slice(BASE.length)}` : p)
export const appPathNow = () => appPath(location.pathname)
/** an app path as the browser shows it (under the base) */
export const sitePath = (p: string) => (BASE === '/' || !p.startsWith('/') || `${p}/`.startsWith(BASE) ? p : BASE + p.slice(1))

const sitePathOf = (to: string) => {
  const u = new URL(to, location.href)
  return u.origin === location.origin ? sitePath(u.pathname) + u.search + u.hash : to
}

/** before the app's modules run (web/demo/main.tsx); nothing at the root */
export function installBase() {
  if (BASE === '/') return
  for (const k of ['pushState', 'replaceState'] as const) {
    const real = History.prototype[k]
    History.prototype[k] = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
      return real.call(this, data, unused, url === undefined || url === null ? url : sitePathOf(String(url)))
    }
  }
  const loc = new Proxy(window.location, {
    get(t, p) {
      if (p === 'pathname') return appPath(t.pathname)
      if (p === 'href') return t.origin + appPath(t.pathname) + t.search + t.hash
      if (p === 'assign' || p === 'replace') return (to: string | URL) => t[p](sitePathOf(String(to)))
      const v = Reflect.get(t, p, t) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
    },
  })
  const win = new Proxy(window, {
    get(t, p) {
      if (p === 'location') return loc
      const v = Reflect.get(t, p, t) as unknown
      // the window's own methods (addEventListener, …) on the real window; constructors as they are
      return typeof v === 'function' && !/^[A-Z]/.test(String(p)) ? (v as (...a: unknown[]) => unknown).bind(t) : v
    },
  })
  Object.assign(globalThis, { __mycelDemoWindow: win, __mycelDemoLocation: loc })
}
