// AI engines, in two tabs (?tab=team for the second, so a link opens either):
// - Providers: one quiet row per engine (Claude Code, Codex, API, …): its state as a chip, one dim line (how it signs
//   in · its models · when it was checked), what is missing in one line, check again and the on/off switch. The row
//   opens in place for the rest: the longer explanation, the version and every model, and the owner's API engine form
//   (address, model, key; ?engine=api opens that row).
// - Team provider settings: settings rows (words on the left, the control on the right): team defaults (engine, model, turns at
//   the same time); who else may pick the engine ("팀원이 엔진 고르기 허용", off: owner and admins only) and the optional
//   Claude-limit fallback to Codex (off; warns that data then also goes to OpenAI; unavailable while Codex is off);
//   usage limits. A section shows Save only once something in it changed.
// The accounts the engines use (Claude subscription tokens, API keys, ChatGPT sign-ins) are on Admin > AI connections
// (Credentials.tsx); company keys moved there.
import clsx from 'clsx'
import { AlertTriangle, ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Budget, EngineId, EnginesResponse, EngineStatus, Group, MemberEngineChoice, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatDateTime, formatNumber, formatUsd } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { isOwner, useMeStrict } from '../../store/session'
import { Badge, Button, Field, IconButton, Modal, Switch, TabPanel, Tabs, inputCls, noKeyRepeat } from '../../components/ui'
import { AdminPageHeader, Loadable, OneLine, useAction, useActionOk, useFocusAfterRemove, useLoad, useOneAtATime } from './common'
import { useEngines } from '../../store/engines'

type EnginesTab = 'providers' | 'team'

export default function Engines() {
  const t = useT()
  const me = useMeStrict()
  const act = useAction()
  const [params, setParams] = useSearchParams()
  const tab: EnginesTab = params.get('tab') === 'team' ? 'team' : 'providers'
  const setTab = (v: EnginesTab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (v === 'team') n.set('tab', 'team')
        else n.delete('tab')
        n.delete('engine')
        n.delete('focus')
        return n
      },
      { replace: true },
    )
  const panels = useId()
  const state = useLoad(() => api.call(API.engines))
  const [checking, setChecking] = useState<EngineId | null>(null)

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

  return (
    <>
      <AdminPageHeader title={t('admin.engines')} testId="engines-header" className="mb-2">
        <Tabs
          segmented
          value={tab}
          onChange={setTab}
          label={t('admin.engines')}
          panels={panels}
          items={[{ id: 'providers', label: t('engines.tab.providers') }, { id: 'team', label: t('engines.tab.team') }]}
        />
      </AdminPageHeader>
      <TabPanel base={panels} value={tab}>
        <Loadable state={state}>
          {(d) =>
            tab === 'providers' ? (
              <ul className="-mx-2 divide-y divide-line" data-testid="engine-list">
                {d.engines.map((e) => (
                  <EngineRow
                    key={e.id}
                    e={e}
                    owner={isOwner(me)}
                    initiallyOpen={params.get('engine') === e.id}
                    checking={checking === e.id}
                    onCheck={() => void check(e.id)}
                    onToggle={(v) => void toggle(e.id, v)}
                    onApiSaved={() => {
                      void check('api')
                      void useEngines.getState().load(true) // the composer's list
                    }}
                  />
                ))}
              </ul>
            ) : (
              <>
                <Defaults data={d} onSaved={(r) => state.setData(r)} />
                <MemberChoice data={d} onSaved={(r) => state.setData(r)} />
                <Budgets openHere={params.get('focus') === 'limits'} />
              </>
            )
          }
        </Loadable>
      </TabPanel>
    </>
  )
}

/** One engine: name and state on the first line, one dim line under it, what is missing in one line (it opens with
 * "More"); check again and the switch on the right. The name opens the rest in place. */
function EngineRow({ e, owner, initiallyOpen, checking, onCheck, onToggle, onApiSaved }: { e: EngineStatus; owner: boolean; initiallyOpen: boolean; checking: boolean; onCheck: () => void; onToggle: (v: boolean) => void; onApiSaved: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(initiallyOpen)
  const details = useId()
  const ok = e.status === 'ok'
  const mode = e.authMode === 'api-key' && !e.provider ? t('engines.api.key') : t(`engines.mode.${e.authMode}`, { provider: e.provider ?? '' })
  const checked = e.checkedAt && t('engines.checkedAt', { date: formatDateTime(e.checkedAt, locale) })
  const models = e.models.map((m) => m.label).join(', ')
  // the dim line under the name: how it signs in · its models · when it was checked
  const meta = [mode, models, checked].filter(Boolean).join(' · ')
  // what to know about this engine; the row shows it when opened
  const hint = [e.authMode === 'local-login' && t('engines.localHelp'), e.beta && t('engines.betaHint'), e.id === 'api' && t('engines.experimentalHint')].filter(Boolean).join(' ')
  // the API engine is not "installed": it has an address, a model and a key, or not yet. Its form is in the opened row,
  // so the row says "Not set up" and offers to open it (the server's text points "below", where nothing is yet)
  const apiNotSet = e.id === 'api' && e.status === 'not_installed'
  return (
    <li className="px-2 py-3" data-testid="engine-card" data-engine={e.id}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={open ? details : undefined}
                onClick={() => setOpen(!open)}
                className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 text-left hover:bg-hover"
                data-testid="engine-open"
              >
                <ChevronRight size={14} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-90')} aria-hidden />
                <span className="break-words">{e.label}</span>
              </button>
            </h3>
            <Badge tone={ok ? 'ok' : 'warn'}>{apiNotSet ? t('adminux.engines.apiNotSet') : t(`engines.status.${e.status}`)}</Badge>
            {e.beta && <Badge tone="warn">{t('engines.beta')}</Badge>}
            {e.id === 'api' && <span data-testid="engine-experimental"><Badge tone="warn">{t('engines.experimental')}</Badge></span>}
          </div>
          <p className="mt-0.5 truncate pl-5 text-xs text-faint" title={meta}>{meta}</p>
          {apiNotSet ? (
            <p className="mt-1 pl-5 text-xs text-warn" data-testid="engine-detail">
              {t(owner ? 'adminux.engines.apiNotSetHint' : 'adminux.engines.apiNotSetOwner')}{' '}
              {owner && !open && (
                <button type="button" className="font-medium text-accent-text underline" onClick={() => {
                  setOpen(true)
                  // this button goes away with the open row: the keyboard moves on to the form's first field
                  requestAnimationFrame(() => document.getElementById(details)?.querySelector<HTMLElement>('input, select, textarea')?.focus())
                }} data-testid="engine-api-setup">
                  {t('adminux.engines.apiSetUp')}
                </button>
              )}
            </p>
          ) : e.detail && (
            <div className="mt-1 flex min-w-0 items-baseline gap-2 pl-5">
              {/* a problem's line is the fix (a command to run): shown whole, never cut behind "More" */}
              {ok ? (
                <OneLine className="min-w-0 flex-1 text-xs text-muted" testId="engine-detail">{e.detail}</OneLine>
              ) : (
                <p className="min-w-0 flex-1 text-xs break-words text-warn" data-testid="engine-detail"><CodeText text={e.detail} /></p>
              )}
              {e.authMode === 'managed' && e.status === 'not_logged_in' && (
                <Link to="/admin/credentials" className="shrink-0 text-xs font-medium text-accent-text underline" data-testid="engine-go-credentials">{t('engines.goCredentials')}</Link>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton label={t('engines.check')} onClick={onCheck} disabled={checking}>
            <RefreshCw size={15} className={checking ? 'animate-spin' : ''} />
          </IconButton>
          <Switch checked={e.enabled} onChange={onToggle} label={t('engines.enableNamed', { name: e.label })} hideLabel testId={`engine-switch-${e.id}`} />
        </div>
      </div>
      {open && (
        <div id={details} className="mt-3 space-y-3 pl-5" data-testid="engine-details">
          {hint && <p className="text-xs leading-relaxed text-muted" data-testid={e.beta ? 'engine-beta' : undefined}>{hint}</p>}
          <div className="space-y-0.5 text-xs text-faint">
            <p>{[e.version && `v${e.version}`, mode].filter(Boolean).join(' · ')}</p>
            {models && <p>{t('engines.models', { list: models })}</p>}
            {checked && <p>{checked}</p>}
          </div>
          {e.id === 'api' && owner && <ApiEngineForm onSaved={onApiSaved} />}
        </div>
      )}
    </li>
  )
}

/** A settings section: its title and one line on what it is for, then rows with hairlines between, then (only once
 * something changed) Save and Cancel. */
function SettingsSection({ title, desc, actions, footer, children, headingRef, testId }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode; footer?: ReactNode; children: ReactNode; headingRef?: Ref<HTMLHeadingElement>; testId?: string }) {
  return (
    <section className="mb-10" data-testid={testId}>
      <header className="flex flex-wrap items-start gap-3 pb-2">
        <div className="min-w-0 flex-1">
          <h3 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="scroll-mt-28 text-base font-semibold">{title}</h3>
          {desc && <OneLine className="mt-0.5 text-xs text-muted">{desc}</OneLine>}
        </div>
        {actions}
      </header>
      <div className="divide-y divide-line border-t border-line">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-line pt-3">{footer}</div>}
    </section>
  )
}

/** A settings row: the words on the left (with a one-line hint), the control on the right; `stacked`: the control goes
 * under the words (a wide one). On a phone the control always goes under. */
function SettingRow({ label, hint, htmlFor, stacked, children }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; stacked?: boolean; children: ReactNode }) {
  return (
    <div className={clsx('flex flex-col gap-2 py-4', !stacked && 'sm:flex-row sm:items-center sm:gap-6')}>
      <div className="min-w-0 flex-1">
        {htmlFor ? <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label> : <p className="text-sm font-medium">{label}</p>}
        {hint && <OneLine className="mt-0.5 text-xs text-muted">{hint}</OneLine>}
      </div>
      <div className={clsx('min-w-0', !stacked && 'sm:w-64 sm:shrink-0')}>{children}</div>
    </div>
  )
}

/** Save and Cancel for a section, once something in it changed. */
function SaveBar({ busy, onSave, onCancel, testId }: { busy?: boolean; onSave: () => void; onCancel: () => void; testId?: string }) {
  const t = useT()
  return (
    <>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button variant="primary" size="sm" busy={busy} onClick={onSave} data-testid={testId}>
        {t('common.save')}
      </Button>
    </>
  )
}

/** Team defaults: the engine and model of new chats, and how many answers run at the same time. */
function Defaults({ data, onSaved }: { data: EnginesData; onSaved: (r: EnginesData) => void }) {
  const t = useT()
  const act = useAction()
  const ids = useId()
  const saved = { defaultEngine: data.defaultEngine, defaultModel: data.defaultModel, concurrency: data.concurrency }
  const [f, setF] = useState(saved)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setF({ defaultEngine: data.defaultEngine, defaultModel: data.defaultModel, concurrency: data.concurrency })
  }, [data.defaultEngine, data.defaultModel, data.concurrency])
  const dirty = f.defaultEngine !== saved.defaultEngine || f.defaultModel !== saved.defaultModel || f.concurrency !== saved.concurrency
  const max = data.concurrencyMax ?? 16
  const save = async () => {
    setBusy(true)
    const r = await act(() => api.call(API.updateEngines, { body: f }), t('common.saved'))
    setBusy(false)
    if (r) onSaved(r)
  }
  return (
    <SettingsSection title={t('engines.defaults')} desc={t('engines.defaultsDesc')} testId="engine-defaults" footer={dirty && <SaveBar busy={busy} onSave={() => void save()} onCancel={() => setF(saved)} testId="engine-defaults-save" />}>
      <SettingRow label={t('engines.defaultEngine')} htmlFor={`${ids}-engine`}>
        <select id={`${ids}-engine`} className={inputCls} value={f.defaultEngine} onChange={(e) => setF({ ...f, defaultEngine: e.target.value as EngineId, defaultModel: null })}>
          {data.engines.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label={t('engines.defaultModel')} htmlFor={`${ids}-model`}>
        <select id={`${ids}-model`} className={inputCls} value={f.defaultModel ?? ''} onChange={(e) => setF({ ...f, defaultModel: e.target.value || null })}>
          <option value="">{t('composer.defaultModel')}</option>
          {data.engines
            .find((e) => e.id === f.defaultEngine)
            ?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
        </select>
      </SettingRow>
      <SettingRow label={t('engines.concurrency')} hint={t('engines.concurrencyHint')} htmlFor={`${ids}-concurrency`}>
        {/* the plan's maximum on the hosted cloud (concurrencyMax; older servers: 16) */}
        <input id={`${ids}-concurrency`} className={inputCls} type="number" min={1} max={max} data-testid="engines-concurrency" value={f.concurrency} onChange={(e) => setF({ ...f, concurrency: Math.max(1, Math.min(max, Number(e.target.value) || 1)) })} />
        {data.concurrencyMax !== undefined && data.concurrencyMax < 16 && <span className="mt-1 block text-xs text-faint">{t('engines.concurrencyPlan', { max: data.concurrencyMax })}</span>}
      </SettingRow>
    </SettingsSection>
  )
}

function Budgets({ openHere }: { openHere?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const actOk = useActionOk()
  const budgets = useLoad(async () => (await api.call(API.listBudgets)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const [editing, setEditing] = useState<Budget | 'new' | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  // opened from a "Usage limits" link (Usage, AI connections): bring this section into view and put the focus on its
  // title, so a keyboard or screen reader starts here
  useEffect(() => {
    if (!openHere) return
    heading.current?.scrollIntoView({ block: 'start' })
    heading.current?.focus({ preventScroll: true })
  }, [openHere])
  // a limit goes at once, with no confirm dialog: the focus goes on to the next row's Edit (else the title), never to its
  // delete, one delete runs at a time, and a held key does not repeat it
  const focus = useFocusAfterRemove(budgets.data, () => heading.current)
  const once = useOneAtATime<string>()
  const remove = (b: Budget) =>
    once.run(b.id, async () => {
      if (!(await actOk(() => api.call(API.deleteBudget, { params: { id: b.id } })))) return
      focus.removed(budgets.data?.findIndex((x) => x.id === b.id) ?? 0)
      await budgets.reload()
    })
  const who = (b: Budget) => (b.subjectType === 'team' ? t('budgets.team') : b.subjectType === 'group' ? groups.data?.find((g) => g.id === b.subjectId)?.name ?? '?' : users.data?.find((u) => u.id === b.subjectId)?.name ?? '?')
  const period = (b: Budget) => t(b.period === 'day' ? 'budgets.perDay' : 'budgets.perMonth')
  return (
    <SettingsSection
      headingRef={heading}
      title={t('budgets.title')}
      desc={t('budgets.desc')}
      testId="engine-budgets"
      actions={
        <Button size="sm" onClick={() => setEditing('new')} data-testid="budget-new">
          <Plus size={14} aria-hidden /> {t('budgets.new')}
        </Button>
      }
    >
      <div ref={focus.box}>
        <Loadable state={budgets}>
          {(list) =>
            !list.length ? (
              <p className="py-4 text-sm text-faint">{t('budgets.none')}</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {list.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-2 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{who(b)}</span> · {period(b)}
                      <span className="block text-xs text-faint">
                        {b.limitTokens !== null && t('budgets.tokensUsed', { used: formatNumber(b.usedTokens, locale), limit: formatNumber(b.limitTokens, locale) })}
                        {b.limitUsd > 0 && ` · ${formatUsd(b.usedUsd, locale)} / ${formatUsd(b.limitUsd, locale)}`}
                      </span>
                    </span>
                    <Badge tone={b.action === 'block' ? 'danger' : 'warn'}>{t(b.action === 'block' ? 'budgets.block' : 'budgets.warn')}</Badge>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(b)} onKeyDown={noKeyRepeat} data-row-focus>
                      {t('common.edit')}
                    </Button>
                    <IconButton
                      label={t('common.deleteNamed', { name: `${who(b)} · ${period(b)}` })}
                      onClick={() => void remove(b)}
                      onKeyDown={noKeyRepeat}
                      aria-disabled={once.busy !== null || undefined}
                      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )
          }
        </Loadable>
      </div>
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
    </SettingsSection>
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

type EnginesData = EnginesResponse

/** "팀원이 엔진 고르기 허용" and "Claude 한도에 닿으면 Codex로 넘기기". */
function MemberChoice({ data, onSaved }: { data: EnginesData; onSaved: (r: EnginesData) => void }) {
  const t = useT()
  const act = useAction()
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const [choice, setChoice] = useState<MemberEngineChoice>(data.memberChoice)
  const [fallback, setFallback] = useState(data.limitFallback)
  const [busy, setBusy] = useState(false)
  const ids = useId()
  useEffect(() => {
    setChoice(data.memberChoice)
    setFallback(data.limitFallback)
  }, [data.memberChoice, data.limitFallback])
  const toggleIn = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id))
  // owner and admins always pick: only members are listed
  const members = (users.data ?? []).filter((u) => u.role === 'member' && u.status === 'active')
  const save = async () => {
    setBusy(true)
    const r = await act(() => api.call(API.updateEngines, { body: { memberChoice: choice, limitFallback: fallback && data.limitFallbackAvailable } }), t('common.saved'))
    setBusy(false)
    if (r) onSaved(r)
  }
  const dirty = JSON.stringify(choice) !== JSON.stringify(data.memberChoice) || fallback !== data.limitFallback
  const fallbackOn = fallback && data.limitFallbackAvailable
  return (
    <SettingsSection
      title={t('engines.choice')}
      desc={t('engines.choiceDesc')}
      testId="engine-choice"
      footer={dirty && <SaveBar busy={busy} onSave={() => void save()} onCancel={() => { setChoice(data.memberChoice); setFallback(data.limitFallback) }} testId="engine-choice-save" />}
    >
      <SettingRow label={t('engines.choice.allow')} hint={t('engines.choice.hint')} stacked>
        <div className="flex flex-wrap gap-1 rounded-lg bg-subtle p-0.5 sm:inline-flex" role="radiogroup" aria-label={t('engines.choice.allow')}>
          {(['off', 'everyone', 'selected'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={choice.mode === mode}
              onClick={() => setChoice({ ...choice, mode })}
              className={clsx('rounded-md px-3 py-1.5 text-sm', choice.mode === mode ? 'bg-surface font-medium text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink')}
              data-testid={`engine-choice-${mode}`}
            >
              {t(`engines.choice.${mode}`)}
            </button>
          ))}
        </div>
        {choice.mode === 'selected' && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t('engines.choice.groups')}</p>
              {(groups.data ?? []).length === 0 && <p className="text-xs text-faint">{t('engines.choice.noGroups')}</p>}
              {(groups.data ?? []).map((g) => (
                <label key={g.id} className="flex items-center gap-2 py-1 text-sm">
                  <input type="checkbox" checked={choice.groupIds.includes(g.id)} onChange={(e) => setChoice({ ...choice, groupIds: toggleIn(choice.groupIds, g.id, e.target.checked) })} />
                  {g.name}
                </label>
              ))}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t('engines.choice.people')}</p>
              {members.map((u) => (
                <label key={u.id} className="flex items-center gap-2 py-1 text-sm">
                  <input type="checkbox" checked={choice.userIds.includes(u.id)} onChange={(e) => setChoice({ ...choice, userIds: toggleIn(choice.userIds, u.id, e.target.checked) })} />
                  {u.name} <span className="text-xs text-faint">{u.username}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </SettingRow>
      <div>
        <SettingRow
          label={t('engines.fallback')}
          htmlFor={`${ids}-fallback`}
          hint={data.limitFallbackAvailable ? `${t('engines.fallbackDesc')} ${t('engines.fallbackHint2')}` : t('engines.fallbackUnavailable')}
        >
          <div className="flex sm:justify-end">
            <Switch id={`${ids}-fallback`} external checked={fallbackOn} disabled={!data.limitFallbackAvailable} onChange={setFallback} label={t('engines.fallback')} />
          </div>
        </SettingRow>
        {fallbackOn && (
          <p role="alert" className="mb-4 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="fallback-warning">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden /> {t('engines.fallbackWarning')}
          </p>
        )}
      </div>
    </SettingsSection>
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

/** The team's API engine settings (owner): address, model, display name, key (never shown again once saved). */
function ApiEngineForm({ onSaved }: { onSaved: () => void }) {
  const t = useT()
  const act = useAction()
  const state = useLoad(() => api.call(API.getApiEngine))
  const [form, setForm] = useState<{ baseUrl: string; model: string; label: string; key: string } | null>(null)
  useEffect(() => {
    if (state.data && !form) setForm({ baseUrl: state.data.baseUrl ?? '', model: state.data.model ?? '', label: state.data.label ?? '', key: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data])
  const preset = API_PRESETS.find((p) => p.baseUrl === form?.baseUrl)?.id ?? 'custom'
  const save = async (key?: string | null) => {
    if (!form) return
    const r = await act(() => api.call(API.putApiEngine, { body: { baseUrl: form.baseUrl.trim(), model: form.model.trim(), label: form.label.trim() || undefined, ...(key !== undefined ? { key } : {}) } }), t('common.saved'))
    if (r) { state.setData(r); setForm({ ...form, key: '' }); onSaved() }
  }
  return (
    <div className="rounded-xl border border-line p-4">
      <h4 className="text-sm font-medium">{t('engines.api.title')}</h4>
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
          <div className="flex items-end gap-2">
            <Button disabled={!form.baseUrl.trim() || !form.model.trim()} onClick={() => void save(form.key.trim() ? form.key.trim() : undefined)}>{t('engines.api.save')}</Button>
            {state.data?.hasKey && <Button variant="ghost" onClick={() => void save(null)}>{t('engines.api.keyRemove')}</Button>}
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
          <code key={i} className="rounded bg-subtle px-1 font-mono text-[0.95em] text-ink select-all">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  )
}
