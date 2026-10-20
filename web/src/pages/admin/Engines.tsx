// AI engines: per engine install / login / lockdown status (what is missing, in plain words), re-check, enable;
// team defaults (engine, model, turns at the same time); usage limits; and, folded under "advanced", company API
// keys for proxy mode (owner only, off by default — this version runs on the owner's subscriptions).
import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Budget, EngineId, EngineStatus, Group, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime, formatNumber, formatUsd } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { isOwner, useMeStrict } from '../../store/session'
import { Badge, Button, Field, IconButton, Modal, Switch, confirmDialog, inputCls } from '../../components/ui'
import { Card, Loadable, useAction, useLoad } from './common'

export default function Engines() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const act = useAction()
  const state = useLoad(() => api.call(API.engines))
  const [checking, setChecking] = useState<EngineId | null>(null)
  const [defaults, setDefaults] = useState<{ defaultEngine: EngineId; defaultModel: string | null; concurrency: number } | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [addKey, setAddKey] = useState(false)

  useEffect(() => {
    if (state.data) setDefaults({ defaultEngine: state.data.defaultEngine, defaultModel: state.data.defaultModel, concurrency: state.data.concurrency })
  }, [state.data])

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
  const saveDefaults = async () => {
    if (!defaults) return
    const r = await act(() => api.call(API.updateEngines, { body: defaults }), t('common.saved'))
    if (r) state.setData(r)
  }

  return (
    <Loadable state={state}>
      {(d) => (
        <>
          <div className="mb-6 grid gap-4 md:grid-cols-2">
            {d.engines.map((e) => (
              <EngineCard key={e.id} e={e} checking={checking === e.id} onCheck={() => check(e.id)} onToggle={(v) => toggle(e.id, v)} />
            ))}
          </div>
          {defaults && (
            <Card title={t('engines.defaults')} desc={t('engines.defaultsDesc')}>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('engines.defaultEngine')}>
                  <select className={inputCls} value={defaults.defaultEngine} onChange={(e) => setDefaults({ ...defaults, defaultEngine: e.target.value as EngineId, defaultModel: null })}>
                    {d.engines.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('engines.defaultModel')}>
                  <select className={inputCls} value={defaults.defaultModel ?? ''} onChange={(e) => setDefaults({ ...defaults, defaultModel: e.target.value || null })}>
                    <option value="">{t('composer.defaultModel')}</option>
                    {d.engines
                      .find((e) => e.id === defaults.defaultEngine)
                      ?.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label={t('engines.concurrency')} hint={t('engines.concurrencyHint')}>
                  <input className={inputCls} type="number" min={1} max={16} value={defaults.concurrency} onChange={(e) => setDefaults({ ...defaults, concurrency: Math.max(1, Math.min(16, Number(e.target.value) || 1)) })} />
                </Field>
              </div>
              <Button variant="primary" className="mt-3" onClick={saveDefaults}>
                {t('common.save')}
              </Button>
            </Card>
          )}
          <Budgets />
          {isOwner(me) && (
            <section className="mb-6">
              <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1 text-sm font-medium text-muted hover:text-ink">
                {advanced ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />} {t('engines.advanced')}
              </button>
              {advanced && (
                <Card
                  title={t('engines.keys')}
                  desc={t('engines.keysDesc')}
                  actions={
                    <Button size="sm" onClick={() => setAddKey(true)}>
                      <Plus size={14} aria-hidden /> {t('engines.addKey')}
                    </Button>
                  }
                >
                  {!d.accounts.length ? (
                    <p className="text-sm text-faint">{t('engines.noKeys')}</p>
                  ) : (
                    <ul className="divide-y divide-line text-sm">
                      {d.accounts.map((a) => (
                        <li key={a.id} className="flex items-center gap-2 py-2">
                          <span className="min-w-0 flex-1">
                            {a.label ?? a.engine} <span className="text-xs text-faint">…{a.hint}</span>
                          </span>
                          <Badge tone={a.status === 'ok' ? 'ok' : 'danger'}>{t(a.status === 'ok' ? 'engines.keyOk' : 'engines.keyInvalid')}</Badge>
                          {a.checkedAt && <span className="text-xs text-faint">{formatDateTime(a.checkedAt, locale)}</span>}
                          <IconButton
                            label={t('common.delete')}
                            onClick={async () => {
                              if (!(await confirmDialog({ title: t('engines.deleteKey'), confirm: t('common.delete'), danger: true }))) return
                              if ((await act(() => api.call(API.deleteEngineAccount, { params: { id: a.id } }))) !== undefined) void state.reload()
                            }}
                          >
                            <Trash2 size={15} />
                          </IconButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}
            </section>
          )}
          {addKey && (
            <AddKey
              onClose={() => setAddKey(false)}
              onAdded={() => {
                setAddKey(false)
                void state.reload()
              }}
            />
          )}
        </>
      )}
    </Loadable>
  )
}

function EngineCard({ e, checking, onCheck, onToggle }: { e: EngineStatus; checking: boolean; onCheck: () => void; onToggle: (v: boolean) => void }) {
  const t = useT()
  const locale = useLocale()
  const ok = e.status === 'ok'
  return (
    <section className="rounded-2xl border border-line bg-surface p-4" data-testid="engine-card" aria-labelledby={`eng-${e.id}`}>
      <div className="flex items-start gap-2">
        {ok ? <CheckCircle2 size={18} className="mt-0.5 text-ok" aria-hidden /> : <CircleAlert size={18} className="mt-0.5 text-warn" aria-hidden />}
        <div className="min-w-0 flex-1">
          <h2 id={`eng-${e.id}`} className="font-semibold">
            {e.label}
          </h2>
          <p className="text-xs text-muted">
            <Badge tone={ok ? 'ok' : 'warn'}>{t(`engines.status.${e.status}`)}</Badge> {e.version && <span className="ml-1">v{e.version}</span>} · {t(`engines.mode.${e.authMode}`)}
          </p>
        </div>
        <IconButton label={t('engines.check')} onClick={onCheck} disabled={checking}>
          <RefreshCw size={15} className={checking ? 'animate-spin' : ''} />
        </IconButton>
      </div>
      {e.detail && (
        <p className="mt-3 rounded-lg bg-subtle px-3 py-2 text-sm" data-testid="engine-detail">
          {e.detail}
        </p>
      )}
      {e.models.length > 0 && <p className="mt-2 text-xs text-faint">{t('engines.models', { list: e.models.map((m) => m.label).join(', ') })}</p>}
      <div className="mt-3 flex items-center justify-between gap-2">
        <Switch checked={e.enabled} onChange={onToggle} label={t('engines.enabled')} />
        {e.checkedAt && <span className="text-xs text-faint">{t('engines.checkedAt', { date: formatDateTime(e.checkedAt, locale) })}</span>}
      </div>
    </section>
  )
}

function AddKey({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const t = useT()
  const act = useAction()
  const [engine, setEngine] = useState<'anthropic' | 'openai'>('anthropic')
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('engines.addKey')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={secret.trim().length < 10}
            onClick={async () => {
              setBusy(true)
              const r = await act(() => api.call(API.addEngineAccount, { body: { engine, label: label.trim() || undefined, secret: secret.trim() } }))
              setBusy(false)
              if (r) onAdded()
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-warn">{t('engines.keysDesc')}</p>
        <Field label={t('engines.provider')}>
          <select className={inputCls} value={engine} onChange={(e) => setEngine(e.target.value as 'anthropic' | 'openai')}>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </Field>
        <Field label={t('engines.keyLabel')}>
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} />
        </Field>
        <Field label={t('engines.secret')} hint={t('engines.secretHint')}>
          <input className={inputCls} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function Budgets() {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const budgets = useLoad(async () => (await api.call(API.listBudgets)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const [editing, setEditing] = useState<Budget | 'new' | null>(null)
  const who = (b: Budget) => (b.subjectType === 'team' ? t('budgets.team') : b.subjectType === 'group' ? groups.data?.find((g) => g.id === b.subjectId)?.name ?? '?' : users.data?.find((u) => u.id === b.subjectId)?.name ?? '?')
  return (
    <Card
      title={t('budgets.title')}
      desc={t('budgets.desc')}
      actions={
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus size={14} aria-hidden /> {t('budgets.new')}
        </Button>
      }
    >
      <Loadable state={budgets}>
        {(list) =>
          !list.length ? (
            <p className="text-sm text-faint">{t('budgets.none')}</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {list.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{who(b)}</span> · {t(b.period === 'day' ? 'budgets.perDay' : 'budgets.perMonth')}
                    <span className="block text-xs text-faint">
                      {b.limitTokens !== null && t('budgets.tokensUsed', { used: formatNumber(b.usedTokens, locale), limit: formatNumber(b.limitTokens, locale) })}
                      {b.limitUsd > 0 && ` · ${formatUsd(b.usedUsd, locale)} / ${formatUsd(b.limitUsd, locale)}`}
                    </span>
                  </span>
                  <Badge tone={b.action === 'block' ? 'danger' : 'warn'}>{t(b.action === 'block' ? 'budgets.block' : 'budgets.warn')}</Badge>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(b)}>
                    {t('common.edit')}
                  </Button>
                  <IconButton
                    label={t('common.delete')}
                    onClick={async () => {
                      if ((await act(() => api.call(API.deleteBudget, { params: { id: b.id } }))) !== undefined) void budgets.reload()
                    }}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
      {editing && (
        <BudgetForm
          budget={editing === 'new' ? null : editing}
          users={users.data ?? []}
          groups={groups.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void budgets.reload()
          }}
        />
      )}
    </Card>
  )
}

function BudgetForm({ budget, users, groups, onClose, onSaved }: { budget: Budget | null; users: User[]; groups: Group[]; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const act = useAction()
  const [f, setF] = useState({
    subjectType: budget?.subjectType ?? ('team' as Budget['subjectType']),
    subjectId: budget?.subjectId ?? null,
    period: budget?.period ?? ('day' as Budget['period']),
    limitTokens: budget?.limitTokens ?? 1_000_000,
    limitUsd: budget?.limitUsd ?? 0,
    action: budget?.action ?? ('warn' as Budget['action']),
  })
  const [busy, setBusy] = useState(false)
  const valid = f.subjectType === 'team' || !!f.subjectId
  const save = async () => {
    setBusy(true)
    const body = { ...f, subjectId: f.subjectType === 'team' ? null : f.subjectId }
    const r = await act(() => (budget ? api.call(API.updateBudget, { params: { id: budget.id }, body }) : api.call(API.createBudget, { body })))
    setBusy(false)
    if (r) onSaved()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={budget ? t('budgets.edit') : t('budgets.new')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!valid} onClick={save}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('budgets.for')}>
          <select className={inputCls} value={f.subjectType} onChange={(e) => setF({ ...f, subjectType: e.target.value as Budget['subjectType'], subjectId: null })}>
            <option value="team">{t('budgets.team')}</option>
            <option value="group">{t('rules.group')}</option>
            <option value="user">{t('rules.person')}</option>
          </select>
        </Field>
        {f.subjectType !== 'team' && (
          <Field label={t('rules.target')}>
            <select className={inputCls} value={f.subjectId ?? ''} onChange={(e) => setF({ ...f, subjectId: e.target.value || null })}>
              <option value="">—</option>
              {(f.subjectType === 'group' ? groups : users).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('budgets.period')}>
          <select className={inputCls} value={f.period} onChange={(e) => setF({ ...f, period: e.target.value as Budget['period'] })}>
            <option value="day">{t('budgets.perDay')}</option>
            <option value="month">{t('budgets.perMonth')}</option>
          </select>
        </Field>
        <Field label={t('budgets.tokens')}>
          <input className={inputCls} type="number" min={0} value={f.limitTokens ?? 0} onChange={(e) => setF({ ...f, limitTokens: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
        </Field>
        <Field label={t('budgets.usd')} hint={t('budgets.usdHint')}>
          <input className={inputCls} type="number" min={0} step="0.01" value={f.limitUsd} onChange={(e) => setF({ ...f, limitUsd: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
        <Field label={t('budgets.action')}>
          <select className={inputCls} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value as Budget['action'] })}>
            <option value="warn">{t('budgets.warn')}</option>
            <option value="block">{t('budgets.block')}</option>
          </select>
        </Field>
      </div>
    </Modal>
  )
}
