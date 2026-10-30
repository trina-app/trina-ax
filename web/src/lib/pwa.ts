// PWA: service worker registration (production builds only), the "install as an app" prompt and the facts that the
// install guide (Settings > Apps, components/settings/InstallGuide.tsx) uses: the platform, "already installed" and
// the step order. The service worker caches only hashed static files; index.html, /api and the WebSocket always go
// to the network.
import { useEffect, useState } from 'react'
import { clientKind } from './desktop'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()

export function initPwa() {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    listeners.forEach((l) => l())
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    listeners.forEach((l) => l())
  })
  if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* not fatal: the app works without it */ })
    })
  }
}

/** Installed: the browser shows the app in its own window (display-mode: standalone), or iOS Safari opened it from
 * the Home Screen (navigator.standalone). */
export const standaloneOf = (displayStandalone: boolean, navStandalone: unknown) => displayStandalone || navStandalone === true
export const isStandalone = () => typeof window !== 'undefined' && standaloneOf(!!window.matchMedia?.('(display-mode: standalone)').matches, (navigator as { standalone?: boolean }).standalone)
export type Platform = 'ios' | 'android' | 'mac' | 'windows' | 'other'
/** iPadOS Safari says "Macintosh", so a Mac with touch points is an iPad. */
export function platformOf(ua: string, navPlatform = '', maxTouchPoints = 0): Platform {
  if (/iPad|iPhone|iPod/.test(ua) || (navPlatform === 'MacIntel' && maxTouchPoints > 1)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
  if (/Windows/i.test(ua)) return 'windows'
  return 'other'
}
export function platform(): Platform {
  if (typeof navigator === 'undefined') return 'other'
  return platformOf(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)
}
export const isIos = () => platform() === 'ios'

/** The step groups of the install guide. A Mac, Windows or Linux computer uses the desktop steps. */
export type GuidePlatform = 'ios' | 'android' | 'desktop'
const GUIDES: GuidePlatform[] = ['ios', 'android', 'desktop']
/** The steps for this device first, then the others in a fixed order. */
export function guideOrder(p: Platform): GuidePlatform[] {
  const first: GuidePlatform = p === 'ios' || p === 'android' ? p : 'desktop'
  return [first, ...GUIDES.filter((g) => g !== first)]
}
/** The guide is for a web browser only. The desktop app and the phone app are already apps. */
export const installGuideShown = () => clientKind() === 'web'
/** Push needs the installed app: iOS gives web push (16.4+) only to a Home Screen app, never to a Safari tab. */
export const pushNeedsInstall = (p: Platform = platform(), standalone = isStandalone(), web = installGuideShown()) => web && p === 'ios' && !standalone

export function useInstallPrompt() {
  const [, setN] = useState(0)
  useEffect(() => {
    const l = () => setN((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return {
    canPrompt: !!deferred,
    async prompt() {
      if (!deferred) return false
      await deferred.prompt()
      const r = await deferred.userChoice
      deferred = null
      listeners.forEach((l) => l())
      return r.outcome === 'accepted'
    },
  }
}
