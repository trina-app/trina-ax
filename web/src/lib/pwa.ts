// PWA: service worker registration (production builds only) and the "install as an app" prompt.
// The service worker caches only hashed static files; index.html, /api and the WebSocket always go to the network.
import { useEffect, useState } from 'react'

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

export const isStandalone = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true)
export const isIos = () => typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
export type Platform = 'ios' | 'android' | 'mac' | 'windows' | 'other'
export function platform(): Platform {
  if (typeof navigator === 'undefined') return 'other'
  if (isIos()) return 'ios'
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
  if (/Windows/i.test(ua)) return 'windows'
  return 'other'
}

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
