// An app on the person's own computer as a connector (docs/decisions/20261118-local-app-connectors.md): the dialog that
// adds one (Settings › Connectors › Discover › "An app on your computer", only in the desktop app) and the part of its
// page that is its own (where it works, what runs, Running and Stop, the settings kept on this computer). The person
// picks a known tool (Aside, ego lite) or types a program and its arguments; nothing here is a shell. The desktop app
// asks once in its own window before the program runs, so this page never confirms anything itself. Setting values go
// to the desktop app only (DesktopBridge.localApps.setSettings); the team server gets their names.
import { useEffect, useState } from 'react'
import { LOCAL_APP_PRESETS, localCommandLines, splitCommand, type Integration, type LocalAppSpec } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { desktop, settingsNotKeptKey } from '../../lib/desktop'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button, Field, Modal, inputCls } from '../ui'
import { Choices } from './IntegrationDialog'
import { Note } from './GoogleAppConnector'
import { Detail } from './AppDetail'

/** The desktop app's part for apps on this computer, when this window is a desktop app new enough to have it. */
export const localAppsBridge = () => desktop()?.localApps ?? null

type Pick = 'aside' | 'ego-lite' | 'other'
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

/** Add an app on this computer. `onSaved`: the new connection (its page opens next). */
export function LocalAppDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (i: Integration) => void }) {
  const t = useT()
  const locale = useLocale()
  const [pick, setPick] = useState<Pick>('aside')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [settings, setSettings] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: 'command' | 'settings' | 'name' | null; text: string } | null>(null)
  const preset = LOCAL_APP_PRESETS.find((p) => p.id === pick)

  const save = async () => {
    setError(null)
    let spec: LocalAppSpec
    let values: Record<string, string> = {}
    let label = preset?.name ?? name.trim()
    if (preset) spec = preset.spec
    else {
      const argv = splitCommand(command)
      if (!argv) return setError({ field: 'command', text: t('localApps.error.command') })
      const parsed = settingLines(settings)
      if (!parsed) return setError({ field: 'settings', text: t('localApps.error.settings') })
      values = parsed
      label = name.trim() || argv[0]!.split('/').pop()!.slice(0, 60)
      spec = { adapter: 'mcp', command: argv[0]!, args: argv.slice(1), env: Object.keys(values) }
    }
    setBusy(true)
    try {
      // the desktop app asks in its own window while this waits (the check runs the program once)
      let i = await api.call(API.createLocalIntegration, { body: { name: label, spec } })
      if (Object.keys(values).length) {
        const kept = await localAppsBridge()?.setSettings(i.id, values)
        if (kept !== 'saved') toast({ level: 'warn', text: t(settingsNotKeptKey(kept)) })
        else i = await api.call(API.refreshIntegration, { params: { id: i.id }, body: {} })
      }
      onSaved(i)
    } catch (e) {
      setError({ field: null, text: errorText(e, locale, t('error.network')) })
    } finally { setBusy(false) }
  }

  return (
    <Modal open title={t('localApps.title')} onClose={onClose} width={520}
      footer={<>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} onClick={() => void save()} data-testid="local-app-save">{t('localApps.connect')}</Button>
      </>}>
      <div className="space-y-4" data-testid="local-app-dialog">
        <p className="text-sm text-muted">{t('localApps.intro')}</p>
        <Choices<Pick>
          legend={t('localApps.which')}
          value={pick}
          onChange={(v) => { setPick(v); setError(null) }}
          options={[
            { value: 'aside', label: 'Aside', desc: t('localApps.aside'), testId: 'local-app-aside' },
            { value: 'ego-lite', label: 'ego lite', desc: t('localApps.egoLite'), testId: 'local-app-ego' },
            { value: 'other', label: t('localApps.other'), desc: t('localApps.otherHint'), testId: 'local-app-other' },
          ]}
        />
        {preset && (
          <p className="rounded-lg bg-subtle px-3 py-2 font-mono text-xs break-all text-ink" data-testid="local-app-command-preview">
            {localCommandLines(preset.spec).map((l) => <span key={l} className="block">{l}</span>)}
          </p>
        )}
        {pick === 'other' && (
          <>
            <Field label={t('localApps.field.command')} hint={t('localApps.field.commandHint')} error={error?.field === 'command' ? error.text : undefined}>
              <input className={`${inputCls} font-mono`} value={command} autoComplete="off" spellCheck={false} maxLength={2000} placeholder="npx @playwright/mcp@latest" onChange={(e) => setCommand(e.target.value)} data-testid="local-app-command" />
            </Field>
            <Field label={t('localApps.field.name')} error={error?.field === 'name' ? error.text : undefined}>
              <input className={inputCls} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="local-app-name" />
            </Field>
            <Field label={t('localApps.field.settings')} hint={t('localApps.field.settingsHint')} error={error?.field === 'settings' ? error.text : undefined}>
              <textarea className={`${inputCls} min-h-16 font-mono`} value={settings} spellCheck={false} autoComplete="off" placeholder="API_KEY=…" onChange={(e) => setSettings(e.target.value)} data-testid="local-app-settings" />
            </Field>
          </>
        )}
        {error && !error.field && <p role="alert" className="text-sm text-danger" data-testid="local-app-error">{error.text}</p>}
      </div>
    </Modal>
  )
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
          <span className="font-mono text-xs break-all">{localCommandLines(spec).map((l) => <span key={l} className="block">{l}</span>)}</span>
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
