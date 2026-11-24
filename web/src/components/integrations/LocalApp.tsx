// An app on the person's own computer as a connector (docs/decisions/20261118-local-app-connectors.md). Aside and ego lite
// have cards of their own in Settings › Connectors (lib/localApps.ts, pages/Connectors.tsx), which connect their preset
// command with no picker; any other program is added through "Add custom connector" › "On this computer"
// (IntegrationDialog.tsx), whose fields are here (useLocalProgram): the program and its arguments, a name, and settings.
// Nothing here is a shell. The desktop app asks once in its own window before the program runs, so this page never
// confirms anything itself. Setting values go to the desktop app only (DesktopBridge.localApps.setSettings); the team
// server gets their names. Also here: the part of such a connection's page that is its own (where it works, what runs,
// Running and Stop, the settings kept on this computer).
import { useEffect, useState, type ReactNode } from 'react'
import { commandStyleFor, localCommandLines, splitCommand, type Integration, type LocalAppSpec } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { desktop, settingsNotKeptKey } from '../../lib/desktop'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button, Field, Modal, inputCls } from '../ui'
import { Note } from './GoogleAppConnector'
import { Detail } from './AppDetail'

/** The desktop app's part for apps on this computer, when this window is a desktop app new enough to have it. */
export const localAppsBridge = () => desktop()?.localApps ?? null

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** "NAME=value" lines as the settings: names for the server, values for this computer. null: a line that is not one. */
export function settingLines(text: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const at = line.indexOf('=')
    const k = at > 0 ? line.slice(0, at).trim() : ''
    if (!NAME.test(k)) return null
    out[k] = line.slice(at + 1)
  }
  return out
}

/** Add an app on this computer: the desktop app asks in its own window while this waits (the check runs the program
 * once). */
export const createLocalApp = (name: string, spec: LocalAppSpec) => api.call(API.createLocalIntegration, { body: { name, spec } })

/** "A program on this computer" in Add custom connector (IntegrationDialog.tsx): its fields and its save. `save` gives
 * the new connection, or null when a field needs fixing or the server refused (the error shows in `fields`). */
export function useLocalProgram(): { fields: ReactNode; save: () => Promise<Integration | null>; busy: boolean } {
  const t = useT()
  const locale = useLocale()
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [settings, setSettings] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: 'command' | 'settings' | null; text: string } | null>(null)

  const save = async (): Promise<Integration | null> => {
    if (busy) return null
    setError(null)
    // read as this computer reads a command line: on Windows a backslash is part of a path (C:\Tools\x.exe)
    const argv = splitCommand(command, commandStyleFor(desktop()?.platform))
    if (!argv) { setError({ field: 'command', text: t('localApps.error.command') }); return null }
    const values = settingLines(settings)
    if (!values) { setError({ field: 'settings', text: t('localApps.error.settings') }); return null }
    const label = name.trim() || argv[0]!.split(/[\\/]/).pop()!.slice(0, 60)
    setBusy(true)
    try {
      let i = await createLocalApp(label, { adapter: 'mcp', command: argv[0]!, args: argv.slice(1), env: Object.keys(values) })
      // the values go to this computer only (the desktop app seals them); the server keeps their names
      if (Object.keys(values).length) {
        const kept = await localAppsBridge()?.setSettings(i.id, values)
        if (kept !== 'saved') toast({ level: 'warn', text: t(settingsNotKeptKey(kept)) })
        else i = await api.call(API.refreshIntegration, { params: { id: i.id }, body: {} })
      }
      return i
    } catch (e) {
      setError({ field: null, text: errorText(e, locale, t('error.network')) })
      return null
    } finally { setBusy(false) }
  }

  const fields = (
    <div className="space-y-4" data-testid="local-app-program">
      <Field label={t('localApps.field.command')} hint={t('localApps.field.commandHint')} error={error?.field === 'command' ? error.text : undefined}>
        <input className={`${inputCls} font-mono`} value={command} autoComplete="off" spellCheck={false} maxLength={2000} placeholder="npx @playwright/mcp@latest" onChange={(e) => setCommand(e.target.value)} data-autofocus data-testid="local-app-command" />
      </Field>
      <Field label={t('localApps.field.name')}>
        <input className={inputCls} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="local-app-name" />
      </Field>
      <Field label={t('localApps.field.settings')} hint={t('localApps.field.settingsHint')} error={error?.field === 'settings' ? error.text : undefined}>
        <textarea className={`${inputCls} min-h-16 font-mono`} value={settings} spellCheck={false} autoComplete="off" placeholder="API_KEY=…" onChange={(e) => setSettings(e.target.value)} data-testid="local-app-settings" />
      </Field>
      {error && !error.field && <p role="alert" className="text-sm text-danger" data-testid="local-app-error">{error.text}</p>}
    </div>
  )
  return { fields, save, busy }
}

/** On an app on the computer's page, under its name: it works only from the desktop app on the computer it was added on. */
export function LocalAppWhere() {
  const t = useT()
  return <Note testId="local-app-where">{t(localAppsBridge() ? 'localApps.whereHere' : 'localApps.whereElsewhere')}</Note>
}

/** On an app on the computer's page, in its details: what runs, Running and Stop (in the desktop app), and its settings
 * kept on this computer. `onChanged`: settings were saved (the page checks the connection again). */
export function LocalAppDetails({ i, onChanged }: { i: Integration; onChanged: () => void }) {
  const t = useT()
  const bridge = localAppsBridge()
  const [running, setRunning] = useState(false)
  const [names, setNames] = useState<string[]>([])
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!bridge) return
    let live = true
    void bridge.running().then((ids) => { if (live) setRunning(ids.includes(i.id)) }).catch(() => {})
    void bridge.settingNames(i.id).then((n) => { if (live) setNames(n) }).catch(() => {})
    const off = bridge.onRunning((s) => { if (s.id === i.id) setRunning(s.running) })
    return () => { live = false; off() }
  }, [bridge, i.id])
  const spec = i.local
  return (
    <>
      {spec && (
        <Detail label={t('localApps.runs')} testId="local-app-command">
          <span className="font-mono text-xs break-all">{localCommandLines(spec, bridge ? commandStyleFor(desktop()?.platform) : undefined).map((l) => <span key={l} className="block">{l}</span>)}</span>
        </Detail>
      )}
      {bridge && (
        <Detail label={t('localApps.state')} testId="local-app-state">
          <span className="flex flex-wrap items-center gap-2">
            <span data-state={running ? 'running' : 'stopped'}>{t(running ? 'localApps.running' : 'localApps.stopped')}</span>
            {running && <Button size="sm" onClick={() => bridge.stop(i.id)} data-testid="local-app-stop">{t('localApps.stop')}</Button>}
          </span>
        </Detail>
      )}
      {bridge && spec && spec.env.length > 0 && (
        <Detail label={t('localApps.settings')} testId="local-app-settings-state">
          <span className="flex flex-wrap items-center gap-2">
            {/* each setting by its name and, in words, whether this computer keeps a value for it (no ✓ / — marks) */}
            {spec.env.map((n) => (
              <span key={n} className="inline-flex items-baseline gap-1.5">
                <span className="font-mono text-xs">{n}</span>
                <span className="text-muted">{t(names.includes(n) ? 'localApps.settingSaved' : 'localApps.settingEmpty')}</span>
              </span>
            ))}
            <Button size="sm" onClick={() => setEditing(true)} data-testid="local-app-settings-edit">{t('common.edit')}</Button>
          </span>
        </Detail>
      )}
      {editing && spec && bridge && <SettingsDialog i={i} names={spec.env} onClose={() => setEditing(false)} onSaved={(n) => { setNames(n); setEditing(false); onChanged() }} />}
    </>
  )
}

/** The values of an app's settings, typed on this computer and kept there (the desktop app seals them). */
function SettingsDialog({ i, names, onClose, onSaved }: { i: Integration; names: string[]; onClose: () => void; onSaved: (kept: string[]) => void }) {
  const t = useT()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const bridge = localAppsBridge()
    if (!bridge) return
    setBusy(true)
    try {
      const r = await bridge.setSettings(i.id, Object.fromEntries(Object.entries(values).filter(([, v]) => v)))
      if (r !== 'saved') return toast({ level: 'warn', text: t(settingsNotKeptKey(r)) })
      onSaved(await bridge.settingNames(i.id))
    } finally { setBusy(false) }
  }
  return (
    <Modal open title={t('localApps.settingsTitle', { name: i.name })} onClose={onClose} width={480}
      footer={<>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} onClick={() => void save()} data-testid="local-app-settings-save">{t('common.save')}</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">{t('localApps.settingsHint')}</p>
        {names.map((n) => (
          <Field key={n} label={n}>
            <input className={inputCls} type="password" autoComplete="off" value={values[n] ?? ''} onChange={(e) => setValues({ ...values, [n]: e.target.value })} data-testid="local-app-setting" />
          </Field>
        ))}
      </div>
    </Modal>
  )
}
