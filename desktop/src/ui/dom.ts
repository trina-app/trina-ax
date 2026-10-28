// Tiny DOM helpers and the preload API types for the desktop's own screens (no framework: two small screens).
import { PRODUCT, type DesktopPaneState } from '@mycel/shared'
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import type { UiKey, UiLocale } from '../common/i18n'
import type { PaneActivity } from '../common/pane-activity'

export interface WelcomeState {
  mode: 'welcome' | 'team' | 'offline'
  teams: { id: string; label: string; origin: string; current: boolean }[]
  canGoBack: boolean
  offline: { address: string } | null
  /** a kit build's team address to fill in on the first run */
  suggested?: string | null
}
export interface PanePrompt {
  id: string
  scope: 'site' | 'private'
  host: string
  url: string
  tool: string
  /** the third site question in a row: say where "Allow all websites" is (once) */
  hint?: boolean
}
export type { PaneActivity } from '../common/pane-activity'
export interface SiteSettings {
  always: string[]
  privateAlways: string[]
  siteAccess: 'ask' | 'all'
  /** the team lets people choose "all" (Admin > Team settings) */
  teamAllowsAll: boolean
}

export interface MycelUi {
  strings(): { locale: UiLocale; strings: Record<UiKey, string> } | null
  /** the language changed (the team page reported another one, or it was picked on the team list) */
  onLocale(cb: (p: { locale: UiLocale; strings: Record<UiKey, string> }) => void): () => void
  /** pick the language on the team list screen (welcome view only) */
  setLocale(locale: UiLocale): void
  welcome: {
    state(): Promise<WelcomeState | null>
    onState(cb: (s: WelcomeState) => void): () => void
    add(address: string): Promise<{ ok: true; teamId: string } | { ok: false; error: string; message: string } | null>
    open(id: string): void
    remove(id: string): Promise<void>
    back(): void
    retry(): void
  }
  pane: {
    state(): Promise<DesktopPaneState | null>
    onState(cb: (s: DesktopPaneState) => void): () => void
    onPrompts(cb: (p: PanePrompt[]) => void): () => void
    onActivity(cb: (a: PaneActivity) => void): () => void
    /** another team's pane took over the toolbar: start an empty log */
    onActivityReset(cb: () => void): () => void
    /** the site settings changed (an answer saved a site, the setting changed, another team's pane) */
    onSites(cb: (s: SiteSettings) => void): () => void
    navigate(url: string): void
    history(dir: 'back' | 'forward' | 'reload'): void
    newTab(): void
    select(id: string): void
    closeTab(id: string): void
    close(): void
    stop(): void
    answer(id: string, decision: 'once' | 'always' | 'deny'): void
    toolbarHeight(h: number): void
    resize(screenX: number): void
    sites(): Promise<SiteSettings | null>
    removeSite(host: string): void
    clearSites(): void
    setSiteAccess(v: 'ask' | 'all'): void
  }
}

export const ui = (window as unknown as { mycelUi: MycelUi }).mycelUi

const loaded = ui.strings()
export let locale: UiLocale = loaded?.locale ?? 'en'
let strings = loaded?.strings
document.documentElement.lang = locale

/** Redraw with new strings when the language changes (screens call this with their render function). */
export function onLocaleChange(render: () => void) {
  ui.onLocale((p) => {
    locale = p.locale
    strings = p.strings
    document.documentElement.lang = locale
    render()
  })
}

export function tr(key: UiKey, params: Record<string, string> = {}): string {
  const s = strings?.[key] ?? key
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k === 'app' ? (strings?.['app.name'] ?? PRODUCT.displayName) : k === 'domain' ? SERVICE_HOSTS.teamDomain : (params[k] ?? m)))
}

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>
type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v)
    else if (k === 'class') el.className = String(v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, String(v))
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c)
  return el
}
