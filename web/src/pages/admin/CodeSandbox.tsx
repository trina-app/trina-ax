// Admin > Team settings "Code sandbox" (docs/DECISIONS.md "Code sandbox", D1): who may let the AI run bash and python3
// in a separate sandbox per chat (no network, only the chat's work folder). Off by default. Turning it on shows the
// warning; the owner or admin accepts it (the server records who, when and which warning version in the audit log).
// The server refuses to turn it on when this installation cannot run code (the office Mac, a plan without it).
import { useEffect, useState } from 'react'
import { AlertTriangle, Terminal } from 'lucide-react'
import type { CodeSandboxResponse, CodeSandboxScope } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { useSession } from '../../store/session'
import { Button } from '../../components/ui'
import { Card, Loadable, useAction, useLoad } from './common'

export default function CodeSandboxCard() {
  const state = useLoad(() => api.call(API.codeSandbox))
  return (
    <Loadable state={state}>
      {() => state.data && <CodeSandboxForm data={state.data} onSaved={(r) => state.setData(r)} />}
    </Loadable>
  )
}

function CodeSandboxForm({ data, onSaved }: { data: CodeSandboxResponse; onSaved: (r: CodeSandboxResponse) => void }) {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const refreshMe = useSession((s) => s.refreshMe)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const [scope, setScope] = useState<CodeSandboxScope>(data.scope)
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => setScope(data.scope), [data.scope])
  const toggleIn = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id))
  const active = (users.data ?? []).filter((u) => u.status === 'active')
  const avail = data.availability
  // a scope other than off needs the current warning accepted (stored, or the box ticked now)
  const consentCurrent = data.consent?.warningVersion === data.warningVersion
  const needsAccept = scope.mode !== 'off' && !consentCurrent
  const canSave = scope.mode === 'off' || (avail.available && (!needsAccept || accepted))
  const save = async () => {
    setBusy(true)
    const r = await act(() => api.call(API.updateCodeSandbox, { body: { scope, ...(needsAccept && accepted ? { acceptWarning: data.warningVersion } : {}) } }), t('common.saved'))
    setBusy(false)
    if (r) {
      onSaved(r)
      setAccepted(false)
      void refreshMe()
    }
  }
  const runtimes = Object.entries(avail.runtimes ?? {}).filter(([, v]) => v).map(([k]) => k)
  return (
    <Card title={t('codeSandbox.title')} desc={t('codeSandbox.desc')}>
      <div className="space-y-4" data-testid="code-sandbox">
        {!avail.available && (
          <p role="status" className="flex items-start gap-2 rounded-lg bg-hover px-3 py-2 text-sm text-muted" data-testid="code-sandbox-unavailable">
            <Terminal size={15} className="mt-0.5 shrink-0" aria-hidden /> {t(`codeSandbox.unavailable.${avail.reason ?? 'launcher'}`)}
          </p>
        )}
        <fieldset disabled={!avail.available && data.scope.mode === 'off'}>
          <legend className="mb-2 text-sm font-medium">{t('codeSandbox.who')}</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('codeSandbox.who')}>
            {(['off', 'everyone', 'selected'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={scope.mode === mode}
                onClick={() => setScope({ ...scope, mode })}
                className={`rounded-lg border px-3 py-2 text-sm ${scope.mode === mode ? 'border-accent bg-accent-soft font-medium' : 'border-line hover:bg-hover'}`}
                data-testid={`code-sandbox-${mode}`}
              >
                {t(`codeSandbox.mode.${mode}`)}
              </button>
            ))}
          </div>
          {scope.mode === 'selected' && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium text-muted">{t('codeSandbox.groups')}</p>
                {(groups.data ?? []).length === 0 && <p className="text-xs text-faint">{t('codeSandbox.noGroups')}</p>}
                {(groups.data ?? []).map((g) => (
                  <label key={g.id} className="flex items-center gap-2 py-1 text-sm">
                    <input type="checkbox" checked={scope.groupIds.includes(g.id)} onChange={(e) => setScope({ ...scope, groupIds: toggleIn(scope.groupIds, g.id, e.target.checked) })} />
                    {g.name}
                  </label>
                ))}
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted">{t('codeSandbox.people')}</p>
                {active.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 py-1 text-sm">
                    <input type="checkbox" checked={scope.userIds.includes(u.id)} onChange={(e) => setScope({ ...scope, userIds: toggleIn(scope.userIds, u.id, e.target.checked) })} />
                    <span className="min-w-0 truncate">{u.name}</span> <span className="text-xs text-faint">{u.username}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <p className="mt-2 text-xs text-faint">{t('codeSandbox.hint')}</p>
        </fieldset>
        {scope.mode !== 'off' && (
          <div role="alert" className="space-y-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="code-sandbox-warning">
            <p className="flex items-start gap-2 font-medium">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden /> {t('codeSandbox.warningTitle')}
            </p>
            <p>{t('codeSandbox.warning')}</p>
            {needsAccept && (
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} data-testid="code-sandbox-accept" />
                <span>{t('codeSandbox.accept')}</span>
              </label>
            )}
          </div>
        )}
        {data.consent && (
          <p className="text-xs text-muted" data-testid="code-sandbox-consent">
            {t('codeSandbox.consent', { name: data.consent.by?.name ?? '-', date: new Date(data.consent.at).toLocaleString(locale), version: String(data.consent.warningVersion) })}
          </p>
        )}
        {avail.available && runtimes.length > 0 && <p className="text-xs text-faint">{t('codeSandbox.runtimes', { list: runtimes.join(', ') })}</p>}
        <Button variant="primary" busy={busy} disabled={!canSave} onClick={save} data-testid="code-sandbox-save">
          {t('common.save')}
        </Button>
      </div>
    </Card>
  )
}
