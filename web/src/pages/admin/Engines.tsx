// Admin › Providers (/admin/providers, in the Connections group; it was "AI engines" plus a separate "AI connections"
// page, and /admin/engines and /admin/credentials lead here; QA TC-191 made it as quiet as Team settings): one row per
// engine (Claude Code, Codex, API): its provider's mark, its name, one state and the on/off switch, what is missing in
// one line. Under it, the provider's accounts in the order they are used, with Add account (the owner or an admin; the
// AI connection dialogs of Credentials.tsx, for this provider's kinds only). The row opens in place for the rest: the
// longer explanation, the version, how it signs in, every model, when it was checked, Check again and the API engine
// form (owner and admins) (address, model, key; ?engine=api opens that row). The team's AI settings (defaults, who picks the engine, members' own accounts, usage
// limits) are in Team settings (TeamAiSettings.tsx); the old ?tab=team address opens them there (AdminLayout.tsx).
// A phone (below 768 px): an engine is one row (its name, its state, a chevron) that opens its own page,
// /admin/providers/<engine> (adminScreens.ts; ?engine= leads there): the state, check again and the switch, what is
// missing, its accounts with Add account, how it signs in, its models and when it was checked (docs/DECISIONS.md "Admin
// and Settings on phones"). A fix that is a command on the server says to do it on a computer there.
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { EngineId, EngineStatus } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { isAdmin, useMeStrict } from '../../store/session'
import { Badge, Button, Field, Switch, inputCls, useMediaQuery } from '../../components/ui'
import { AdminPageHeader, Loadable, useAction, useLoad } from './common'
import { ENGINE_FAMILY, HowOrderWorks, ProviderAccounts, ProviderLogo, accountsNeedLook, useTeamCredentials, type ProviderMark } from './Credentials'
import { TrialCreditBar } from '../../components/TrialCreditBar'
import { useEngines } from '../../store/engines'
import { enginesChanged } from '../../store/live'
import { technicalEngineState } from './plain'
import { useAdminBar } from './phoneBar'

export default function Engines() {
  const t = useT()
  const me = useMeStrict()
  const act = useAction()
  const [params] = useSearchParams()
  const state = useLoad(() => api.call(API.engines))
  const tc = useTeamCredentials()
  // a connection added, signed in (also in the browser), checked or removed, here or in another window: the engines'
  // state again (the server dropped its last check), and the accounts list with it when another window changed it
  const reloadEngines = state.reload, reloadAccounts = tc.state.reload
  useEffect(() => enginesChanged.on(() => { void reloadEngines(); void reloadAccounts() }), [reloadEngines, reloadAccounts])
  const [checking, setChecking] = useState<EngineId | null>(null)
  const phone = useMediaQuery('(max-width: 767.98px)')

  const check = async (id: EngineId) => {
    setChecking(id)
    const r = await act(() => api.call(API.checkEngine, { params: { id } }))
    setChecking(null)
    if (r && state.data) state.setData({ ...state.data, engines: state.data.engines.map((e) => (e.id === id ? r : e)) })
  }
  const toggle = async (id: EngineId, enabled: boolean) => {
    const r = await act(() => api.call(API.updateEngines, { body: { enabled: { [id]: enabled } } }))
    if (r) state.setData(r)
  }
  // a phone: the engine whose page this is (/admin/providers/<id>); an id this server does not have: the list
  const sub = useParams().sub
  const navigate = useNavigate()
  const engine = phone && sub ? state.data?.engines.find((e) => e.id === sub) : undefined
  const unknown = phone && !!sub && !!state.data && !engine
  useEffect(() => { if (unknown) navigate('/admin/providers', { replace: true }) }, [unknown, navigate])
  useAdminBar(engine?.label ?? null)
  const apiSaved = () => {
    void check('api')
    void useEngines.getState().load(true) // the composer's list
  }
  if (phone && sub) return (
    <>
      <Loadable state={state}>
        {() => engine ? (
          <section aria-labelledby="engine-page-title" data-testid="engine-page" data-engine={engine.id}>
            <h2 id="engine-page-title" className="sr-only">{engine.label}</h2>
            <ul>
              <EngineRow e={engine} page phone accounts={ENGINE_FAMILY[engine.id] && <ProviderAccounts tc={tc} fam={ENGINE_FAMILY[engine.id]!} />} accountsShown owner={isAdmin(me)}
                initiallyOpen checking={checking === engine.id} onCheck={() => void check(engine.id)} onToggle={(v) => void toggle(engine.id, v)} onApiSaved={apiSaved} />
            </ul>
            {tc.state.data && ENGINE_FAMILY[engine.id] && <HowOrderWorks />}
          </section>
        ) : null}
      </Loadable>
      {tc.dialogs}
    </>
  )

  return (
    <>
      <AdminPageHeader title={t('admin.providers')} desc={t('providers.desc')} testId="engines-header" className="!mb-2" />
      <Loadable state={state}>
        {(d) => (
          <>
            {tc.trial.data?.credit && <TrialCreditBar credit={tc.trial.data.credit} timeZone={me.server.timeZone} className="mb-4" />}
            {phone ? (
              // a phone: one row per engine, each opening its own page
              <ul className="divide-y divide-line border-y border-line" data-testid="engine-list">
                {d.engines.map((e) => <EngineLink key={e.id} e={e} look={!!ENGINE_FAMILY[e.id] && accountsNeedLook(tc, ENGINE_FAMILY[e.id]!)} />)}
              </ul>
            ) : <ul className="divide-y divide-line" data-testid="engine-list">
              {d.engines.map((e) => (
                <EngineRow
                  key={e.id}
                  e={e}
                  accounts={ENGINE_FAMILY[e.id] && <ProviderAccounts tc={tc} fam={ENGINE_FAMILY[e.id]!} />}
                  phone={phone}
                  accountsShown={!phone || (!!ENGINE_FAMILY[e.id] && accountsNeedLook(tc, ENGINE_FAMILY[e.id]!))}
                  owner={isAdmin(me)}
                  initiallyOpen={params.get('engine') === e.id}
                  checking={checking === e.id}
                  onCheck={() => void check(e.id)}
                  onToggle={(v) => void toggle(e.id, v)}
                  onApiSaved={apiSaved}
                />
              ))}
            </ul>}
            {tc.state.data && !phone && <HowOrderWorks pricesAsOf={tc.state.data.pricesAsOf} />}
          </>
        )}
      </Loadable>
      {tc.dialogs}
    </>
  )
}

/** The mark an engine's row shows (Credentials.tsx ProviderLogo). */
const ENGINE_MARK: Record<EngineId, ProviderMark> = { 'claude-code': 'claude', codex: 'openai', api: 'api' }

/** The state word of an engine's row and page: an API engine without its settings is "Not set up". */
function engineState(t: ReturnType<typeof useT>, e: EngineStatus): { ok: boolean; text: string } {
  if (e.id === 'api' && e.status === 'not_installed') return { ok: false, text: t('adminux.engines.apiNotSet') }
  // an untested version or a failed lockdown test answers: Connected, as on the row (plain.ts)
  const technical = technicalEngineState(e.status)
  return { ok: e.status === 'ok' || technical, text: t(`engines.status.${technical ? 'ok' : e.status}`) }
}

/** A phone's row of the list: the name, the state (or Off), a chevron; it opens the engine's page. `look`: one of its
 * accounts needs a look (said on the row, the page shows which). */
function EngineLink({ e, look }: { e: EngineStatus; look: boolean }) {
  const t = useT()
  const st = engineState(t, e)
  return (
    <li>
      <Link to={`/admin/providers/${e.id}`} className="flex min-h-12 items-center gap-3 py-2 text-sm -outline-offset-2 hover:bg-hover" data-testid="engine-row" data-engine={e.id} data-look={look || undefined}>
        <ProviderLogo mark={ENGINE_MARK[e.id]} small />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{e.label}</span>
        {e.enabled ? <Badge tone={st.ok && !look ? 'ok' : 'warn'}>{st.text}</Badge> : <span className="text-xs text-faint">{t('appConnectors.off')}</span>}
        <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
      </Link>
    </li>
  )
}

/** One engine, as quiet as a Team settings row: its mark, its name and one state, the on/off switch on the right; a
 * problem in one line under the name (the fix, never cut). The name opens the rest in place: the longer explanation,
 * the version, how it signs in, every model, when it was checked, Check again and, for the API engine, its form.
 * `accountsShown`: the accounts show under the closed row too. `phone`: a fix that is a command on the server says to do
 * it on a computer. `page`: the engine's own page on a phone, everything open, its name in the bar (the page's own
 * heading is for screen readers). */
function EngineRow({ e, accounts, accountsShown, phone, page, owner, initiallyOpen, checking, onCheck, onToggle, onApiSaved }: { e: EngineStatus; accounts?: ReactNode; accountsShown: boolean; phone: boolean; page?: boolean; owner: boolean; initiallyOpen: boolean; checking: boolean; onCheck: () => void; onToggle: (v: boolean) => void; onApiSaved: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(initiallyOpen || !!page)
  const details = useId()
  const accountsId = useId()
  // an untested version or a failed lockdown test: it answers, so the row says Connected; the version detail is in
  // Admin › System › Diagnostics (plain.ts)
  const technical = technicalEngineState(e.status)
  const ok = e.status === 'ok' || technical
  const mode = e.authMode === 'api-key' && !e.provider ? t('engines.api.key') : t(`engines.mode.${e.authMode}`, { provider: e.provider ?? '' })
  const checked = e.checkedAt && t('engines.checkedAt', { date: formatDateTime(e.checkedAt, locale) })
  const models = e.models.map((m) => m.label).join(', ')
  // what to know about this engine; the row shows it when opened
  const hint = [e.authMode === 'local-login' && (phone ? t('admin.onComputerEngine') : t('engines.localHelp')), e.beta && t('engines.betaHint')].filter(Boolean).join(' ')
  // the API engine is not "installed": it has an address, a model and a key, or not yet. Its form is in the opened row,
  // so the row says "Not set up" and offers to open it (the server's text points "below", where nothing is yet)
  const apiNotSet = e.id === 'api' && e.status === 'not_installed'
  return (
    <li className="py-4 max-md:py-2" data-testid="engine-card" data-engine={e.id}>
      <div className="flex items-start gap-3">
        <span hidden={page}><ProviderLogo mark={ENGINE_MARK[e.id]} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium text-ink" hidden={page}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={open ? (accounts ? `${details} ${accountsId}` : details) : undefined}
                onClick={() => setOpen(!open)}
                className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 text-left hover:bg-hover max-md:min-h-11"
                data-testid="engine-open"
              >
                <span className="break-words">{e.label}</span>
                <ChevronRight size={14} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-90')} aria-hidden />
              </button>
            </h3>
            <Badge tone={ok ? 'ok' : 'warn'}>{apiNotSet ? t('adminux.engines.apiNotSet') : t(`engines.status.${technical ? 'ok' : e.status}`)}</Badge>
          </div>
          {apiNotSet ? (
            owner && !open && (
              <p className="text-sm text-muted" data-testid="engine-detail">
                <button type="button" className="font-medium text-accent-text underline-offset-2 hover:underline" onClick={() => {
                  setOpen(true)
                  // this button goes away with the open row: the keyboard moves on to the form's first field
                  requestAnimationFrame(() => document.getElementById(details)?.querySelector<HTMLElement>('input, select, textarea')?.focus())
                }} data-testid="engine-api-setup">
                  {t('adminux.engines.apiSetUp')}
                </button>
              </p>
            )
          ) : e.detail && !technical && !ok && (
            // a problem's line is the fix (a command to run): shown whole, never cut
            <p className="min-w-0 text-xs break-words text-warn" data-testid="engine-detail">{phone && /`[^`]+`/.test(e.detail) ? <span data-testid="engine-on-computer">{t('admin.onComputer')}</span> : <CodeText text={e.detail} />}</p>
          )}
        </div>
        <div className="flex min-h-9 shrink-0 items-center">
          <Switch checked={e.enabled} onChange={onToggle} label={t('engines.enableNamed', { name: e.label })} hideLabel testId={`engine-switch-${e.id}`} />
        </div>
      </div>
      {(accountsShown || open) && accounts && <div id={accountsId}>{accounts}</div>}
      {open && (
        <div id={details} className="mt-3 space-y-3 pl-12 max-md:pl-0" data-testid="engine-details">
          {e.id === 'api' && <p className="text-xs leading-relaxed text-muted" data-testid="engine-experimental"><span className="font-medium text-warn">{t('engines.experimental')}</span> · {t('engines.experimentalHint')}</p>}
          {e.beta && <p className="text-xs leading-relaxed text-muted" data-testid="engine-beta"><span className="font-medium text-warn">{t('engines.beta')}</span> · {hint}</p>}
          {!e.beta && hint && <p className="text-xs leading-relaxed text-muted">{hint}</p>}
          {ok && e.detail && !technical && <p className="text-xs text-muted" data-testid="engine-ok-detail">{e.detail}</p>}
          <div className="space-y-0.5 text-xs text-faint">
            <p>{[e.version && `v${e.version}`, mode].filter(Boolean).join(' · ')}</p>
            {models && <p>{t('engines.models', { list: models })}</p>}
            {checked && <p>{checked}</p>}
          </div>
          <Button size="sm" variant="secondary" onClick={onCheck} disabled={checking} data-testid="engine-check">{checking ? t('credentials.checking') : t('engines.check')}</Button>
          {e.id === 'api' && owner && <ApiEngineForm onSaved={onApiSaved} />}
        </div>
      )}
    </li>
  )
}

/** Presets of the API engine's address (any OpenAI-compatible Chat Completions API works with "custom"). */
const API_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  { id: 'anthropic', label: 'Claude API (Anthropic)', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1' },
  { id: 'ollama', label: 'Ollama (this Mac)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
] as const

/** The team's API engine settings (owner and admins): address, model, display name, key (never shown again once saved). */
function ApiEngineForm({ onSaved }: { onSaved: () => void }) {
  const t = useT()
  const act = useAction()
  const state = useLoad(() => api.call(API.getApiEngine))
  const [form, setForm] = useState<{ baseUrl: string; model: string; label: string; key: string; password: string } | null>(null)
  useEffect(() => {
    if (state.data && !form) setForm({ baseUrl: state.data.baseUrl ?? '', model: state.data.model ?? '', label: state.data.label ?? '', key: '', password: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data])
  const preset = API_PRESETS.find((p) => p.baseUrl === form?.baseUrl)?.id ?? 'custom'
  const save = async (key?: string | null) => {
    if (!form) return
    const r = await act(() => api.call(API.putApiEngine, { body: { baseUrl: form.baseUrl.trim(), model: form.model.trim(), label: form.label.trim() || undefined, ...(key !== undefined ? { key } : {}), password: form.password } }), t('common.saved'))
    if (r) { state.setData(r); setForm({ ...form, key: '', password: '' }); onSaved() }
  }
  return (
    <div className="rounded-xl border border-line p-4">
      <h4 className="text-title-sm font-semibold">{t('engines.api.title')}</h4>
      <p className="mt-0.5 mb-3 text-xs text-muted">{t('engines.api.desc')}</p>
      {form && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="api-engine-form">
          <Field label={t('engines.api.preset')}>
            <select className={inputCls} value={preset} onChange={(e) => {
              const p = API_PRESETS.find((x) => x.id === e.target.value)
              if (p) setForm({ ...form, baseUrl: p.baseUrl, model: form.model || p.model })
            }}>
              {API_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              <option value="custom">{t('engines.api.custom')}</option>
            </select>
          </Field>
          <Field label={t('engines.api.baseUrl')}>
            <input className={inputCls} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://…/v1" />
          </Field>
          <Field label={t('engines.api.model')}>
            <input className={inputCls} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </Field>
          <Field label={t('engines.api.label')}>
            <input className={inputCls} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={form.model} maxLength={40} />
          </Field>
          <Field label={t('engines.api.key')}>
            <input type="password" autoComplete="off" className={inputCls} value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder={state.data?.hasKey ? t('engines.api.keyKeep') : 'sk-…'} />
          </Field>
          <Field label={t('credentials.reauth')}>
            <input type="password" autoComplete="current-password" className={inputCls} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} data-testid="api-engine-password" />
          </Field>
          <div className="flex items-end gap-2">
            <Button disabled={!form.baseUrl.trim() || !form.model.trim() || !form.password} onClick={() => void save(form.key.trim() ? form.key.trim() : undefined)}>{t('engines.api.save')}</Button>
            {state.data?.hasKey && <Button variant="ghost" disabled={!form.password} onClick={() => void save(null)}>{t('engines.api.keyRemove')}</Button>}
          </div>
        </div>
      )}
    </div>
  )
}

/** A server line with a command in backticks ("Run `codex login --device-auth` on the server Mac"): the command shown as
 * code, without the backticks. */
function CodeText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        /^`[^`]+`$/.test(part) ? (
          <code key={i} className="rounded bg-subtle px-1 font-mono text-[0.95em] text-ink select-all max-md:text-[1em]">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  )
}
