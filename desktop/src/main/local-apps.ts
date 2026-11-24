// Apps on the person's computer (docs/decisions/20261118-local-app-connectors.md): the Electron side of
// common/local-apps.ts. The confirm is the app's own dialog over its window (never the team page, which cannot answer
// it); what was confirmed and the setting values are kept in <user data>/local-apps.json, the values sealed with
// Electron's safeStorage (the system's keychain; on Linux GNOME Keyring or KWallet, never Electron's fixed-key fallback),
// per team and connection. Nothing here is sent to the team server.
import { dialog, safeStorage, type BaseWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { LocalApps, sealable, type LocalAppsDeps } from '../common/local-apps'
import { t, type UiLocale } from '../common/i18n'

interface Entry { confirmed?: string; settings?: string }
interface Saved { v: 1; teams: Record<string, Record<string, Entry>> }
/** a setting's name, as the server's contract takes it (shared/src/api/local-apps.ts LocalEnvName) */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9_-]{1,100}$/

export class LocalAppsHost {
  readonly apps: LocalApps
  private file: string
  private data: Saved

  constructor(private o: { userData: string; parent: () => BaseWindow | null; locale: () => UiLocale; teamLabel: (team: string) => string; onChange: (team: string, id: string, running: boolean) => void; onConfirmed?: (team: string, id: string) => void; onAsking?: (team: string, s: { id: string; name: string; asking: boolean }) => void; deps?: Partial<LocalAppsDeps> }) {
    this.file = path.join(o.userData, 'local-apps.json')
    this.data = this.read()
    this.apps = new LocalApps({
      confirm: (c) => this.confirm(c),
      confirmed: (team, id) => this.data.teams[team]?.[id]?.confirmed ?? null,
      setConfirmed: (team, id, hash) => this.put(team, id, { confirmed: hash }),
      settings: (team, id) => this.settings(team, id),
      onChange: o.onChange,
      onConfirmed: o.onConfirmed,
      locale: o.locale,
      ...o.deps,
    })
  }

  private read(): Saved {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (v && v.v === 1 && v.teams && typeof v.teams === 'object') return v as Saved
    } catch {}
    return { v: 1, teams: {} }
  }
  private write() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
  private put(team: string, id: string, e: Partial<Entry>) {
    const t = (this.data.teams[team] ??= {})
    t[id] = { ...t[id], ...e }
    this.write()
  }

  private settings(team: string, id: string): Record<string, string> {
    const sealed = this.data.teams[team]?.[id]?.settings
    if (!sealed || !safeStorage.isEncryptionAvailable()) return {}
    try {
      const v = JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64')))
      return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k, x]) => NAME.test(k) && typeof x === 'string')) as Record<string, string> : {}
    } catch { return {} }
  }

  /** The values typed on this computer for a connection's settings, added to the ones kept (the page never sees a
   * value, so it sends only what was typed; an empty one removes that setting). Sealed, or refused when the system has
   * no keychain for this app. */
  setSettings(team: string, id: unknown, values: unknown): 'saved' | 'unavailable' | 'invalid' {
    if (typeof id !== 'string' || !ID.test(id) || !values || typeof values !== 'object') return 'invalid'
    const typed = Object.entries(values as Record<string, unknown>)
    if (typed.length > 20) return 'invalid'
    for (const [k, v] of typed) if (!NAME.test(k) || typeof v !== 'string' || v.length > 8000 || v.includes('\0')) return 'invalid'
    if (!sealable(process.platform, () => safeStorage.isEncryptionAvailable(), () => safeStorage.getSelectedStorageBackend())) return 'unavailable'
    const clean: Record<string, string> = { ...this.settings(team, id) }
    for (const [k, v] of typed as [string, string][]) { if (v) clean[k] = v; else delete clean[k] }
    if (Object.keys(clean).length > 20) return 'invalid'
    this.put(team, id, { settings: Object.keys(clean).length ? safeStorage.encryptString(JSON.stringify(clean)).toString('base64') : undefined })
    // a running program got the old values: it starts again with the new ones on its next call
    this.apps.stop(team, id)
    return 'saved'
  }
  /** the names that have a value on this computer (never the values) */
  settingNames(team: string, id: unknown): string[] {
    return typeof id === 'string' && ID.test(id) ? Object.keys(this.settings(team, id)) : []
  }

  /** The connections of `team` confirmed on this computer (Connect pressed), by id: never a command or a value. */
  connected(team: string): string[] {
    return Object.entries(this.data.teams[team] ?? {}).filter(([id, e]) => ID.test(id) && !!e?.confirmed).map(([id]) => id)
  }
  /** Settings › Connectors' Remove: the confirm is dropped, so the next call asks again on this computer; a running
   * program of it stops. Its setting values stay. False for a malformed id or one never confirmed here. */
  forget(team: string, id: unknown): boolean {
    if (typeof id !== 'string' || !ID.test(id)) return false
    this.apps.stop(team, id)
    if (!this.data.teams[team]?.[id]?.confirmed) return false
    this.put(team, id, { confirmed: undefined })
    return true
  }

  private async confirm(c: { team: string; id: string; name: string; lines: string[]; program: string }): Promise<boolean> {
    const parent = this.o.parent()
    if (!parent) return false
    // the window comes back from the Dock or the taskbar and draws the eye (a dialog over a hidden window waited
    // unseen while the chat spun: QA on Windows, 2026-11-24); its page says it is asking until it is answered
    try { if (parent.isMinimized()) parent.restore(); parent.flashFrame(true) } catch {}
    this.o.onAsking?.(c.team, { id: c.id, name: c.name, asking: true })
    try { return await this.ask(parent, c) } finally {
      try { parent.flashFrame(false) } catch {}
      this.o.onAsking?.(c.team, { id: c.id, name: c.name, asking: false })
    }
  }

  private async ask(parent: BaseWindow, c: { team: string; name: string; lines: string[]; program: string }): Promise<boolean> {
    const L = this.o.locale()
    const opts = {
      type: 'warning' as const,
      title: t(L, 'localApp.title'),
      message: t(L, 'localApp.message'),
      detail: `${t(L, 'localApp.from', { name: c.name, team: this.o.teamLabel(c.team) })}\n\n${c.lines.join('\n')}\n\n${t(L, 'localApp.program', { program: c.program })}\n\n${t(L, 'localApp.detail')}`,
      buttons: [t(L, 'localApp.cancel'), t(L, 'localApp.connect')],
      // Enter, Escape and closing the dialog do not connect
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const r = await dialog.showMessageBox(parent, opts)
    return r.response === 1
  }
}
