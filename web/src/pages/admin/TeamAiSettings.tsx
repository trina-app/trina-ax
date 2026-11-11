// Admin › Team settings, the AI groups (they were the "Team provider settings" tab of Admin › Providers, Engines.tsx;
// /admin/providers?tab=team and /admin/engines?tab=team open them at #ai, a usage-limits link at #ai-limits):
// - AI defaults (#ai): the engine and model of new chats, and how many answers run at the same time.
// - Who picks the engine: whether members may pick another engine ("팀원이 엔진 고르기 허용", off: owner and admins
//   only) and "다른 AI로 대신 답하기" (the other of Claude Code and Codex answers when a chat's engine has no working
//   connection or Claude hits its limit; off on self-hosted servers, on for hosted ones; warns that data then also goes
//   to that AI's company).
// - Members' own AI accounts: whether members may add their own Claude or Codex account, whether a subscription may be
//   shared (it warns first), and the accounts members connected.
// - Usage limits (#ai-limits).
// Each group saves through its own endpoint as before: AI defaults and Who picks the engine show Cancel and Save once
// something in them changed; the switches and the limits save at once. They stay apart from the Team settings form and
// its save bar, which saves another endpoint (PATCH /api/admin/settings).
import clsx from 'clsx'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type Ref } from 'react'
import { useLocation } from 'react-router-dom'
import type { Budget, EngineId, EnginesResponse, Group, MemberEngineChoice, User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { formatNumber, formatUsd } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { Badge, Button, Field, IconButton, Modal, Switch, confirmDialog, inputCls, noKeyRepeat } from '../../components/ui'
import { Loadable, OneLine, SettingRow, SettingsSection, useAction, useActionOk, useFocusAfterRemove, useLoad, useOneAtATime } from './common'
import { PersonalCredentialList, useTeamCredentials, type TeamCredentials } from './Credentials'
import { useKeptDraft } from '../../lib/keptDraft'

type EnginesData = EnginesResponse

/** The AI groups of Team settings; `#ai` and `#ai-limits` in the address bring their group into view. `part`: a phone's
 * group of Team settings (teamSettingsGroups.ts): the engine's groups, or the usage limits alone. */
export default function TeamAiSettings({ part }: { part?: 'engine' | 'limits' }) {
  const { hash } = useLocation()
  if (part === 'limits') return <div data-testid="team-ai-settings"><Budgets openHere={hash === '#ai-limits'} /></div>
  return <EngineGroups limits={part !== 'engine'} />
}

function EngineGroups({ limits }: { limits: boolean }) {
  const { hash } = useLocation()
  const state = useLoad(() => api.call(API.engines))
  const tc = useTeamCredentials()
  const top = useRef<HTMLHeadingElement>(null)
  // opened at #ai (an old "Team provider settings" link): this group into view, the focus on its title
  useEffect(() => {
    if (hash !== '#ai' || !state.data) return
    top.current?.scrollIntoView({ block: 'start' })
    top.current?.focus({ preventScroll: true })
  }, [hash, state.data])
  return (
    <div data-testid="team-ai-settings">
      <Loadable state={state}>
        {(d) => (
          <>
            <Defaults data={d} onSaved={(r) => state.setData(r)} headingRef={top} />
            <MemberChoice data={d} onSaved={(r) => state.setData(r)} />
            <MemberAccounts tc={tc} />
            {limits && <Budgets openHere={hash === '#ai-limits'} />}
          </>
        )}
      </Loadable>
      {tc.dialogs}
    </div>
  )
}

/** Cancel and Save under a group, once something in it changed. */
function GroupSave({ busy, onSave, onCancel, testId }: { busy?: boolean; onSave: () => void; onCancel: () => void; testId?: string }) {
  const t = useT()
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pt-2" data-testid={testId ? `${testId}-bar` : undefined}>
      <span className="mr-auto text-sm text-muted" role="status">{t('teamSettings.unsaved')}</span>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button variant="primary" size="sm" busy={busy} onClick={onSave} data-testid={testId}>
        {t('common.save')}
      </Button>
    </div>
  )
}

/** AI defaults: the engine and model of new chats, and how many answers run at the same time. */
function Defaults({ data, onSaved, headingRef }: { data: EnginesData; onSaved: (r: EnginesData) => void; headingRef?: Ref<HTMLHeadingElement> }) {
  const t = useT()
  const act = useAction()
  const saved = { defaultEngine: data.defaultEngine, defaultModel: data.defaultModel, concurrency: data.concurrency }
  const [f, setF] = useState(saved)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setF({ defaultEngine: data.defaultEngine, defaultModel: data.defaultModel, concurrency: data.concurrency })
  }, [data.defaultEngine, data.defaultModel, data.concurrency])
  // a phone's group page: the draft stays when the page is left (lib/keptDraft.ts)
  useKeptDraft('ai-defaults', saved, f, setF)
  const dirty = f.defaultEngine !== saved.defaultEngine || f.defaultModel !== saved.defaultModel || f.concurrency !== saved.concurrency
  const max = data.concurrencyMax ?? 16
  const save = async () => {
    setBusy(true)
    const r = await act(() => api.call(API.updateEngines, { body: f }), t('common.saved'))
    setBusy(false)
    if (r) onSaved(r)
  }
  return (
    <SettingsSection title={t('teamAi.defaults')} desc={t('engines.defaultsDesc')} id="ai" testId="engine-defaults" headingRef={headingRef}>
      <SettingRow id="ai-engine" title={t('engines.defaultEngine')}
        control={
          <select id="ai-engine" className={clsx(inputCls, 'md:w-64')} value={f.defaultEngine} onChange={(e) => setF({ ...f, defaultEngine: e.target.value as EngineId, defaultModel: null })}>
            {data.engines.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        } />
      <SettingRow id="ai-model" title={t('engines.defaultModel')}
        control={
          <select id="ai-model" className={clsx(inputCls, 'md:w-64')} value={f.defaultModel ?? ''} onChange={(e) => setF({ ...f, defaultModel: e.target.value || null })}>
            <option value="">{t('composer.defaultModel')}</option>
            {data.engines
              .find((e) => e.id === f.defaultEngine)
              ?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
          </select>
        } />
      <SettingRow id="ai-concurrency" inline title={t('engines.concurrency')} desc={t('engines.concurrencyHint')}
        below={data.concurrencyMax !== undefined && data.concurrencyMax < 16 && <p className="mt-1 text-xs text-faint">{t('engines.concurrencyPlan', { max: data.concurrencyMax })}</p>}
        control={
          // the plan's maximum on the hosted cloud (concurrencyMax; older servers: 16)
          <input id="ai-concurrency" aria-describedby="ai-concurrency-desc" className={clsx(inputCls, 'text-right tabular-nums')} style={{ width: '6.5rem' }} type="number" min={1} max={max} data-testid="engines-concurrency" value={f.concurrency}
            onChange={(e) => setF({ ...f, concurrency: Math.max(1, Math.min(max, Number(e.target.value) || 1)) })} />
        } />
      {dirty && <GroupSave busy={busy} onSave={() => void save()} onCancel={() => setF(saved)} testId="engine-defaults-save" />}
    </SettingsSection>
  )
}

/** "팀원이 엔진 고르기 허용" and "다른 AI로 대신 답하기". */
function MemberChoice({ data, onSaved }: { data: EnginesData; onSaved: (r: EnginesData) => void }) {
  const t = useT()
  const act = useAction()
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const [choice, setChoice] = useState<MemberEngineChoice>(data.memberChoice)
  const [fallback, setFallback] = useState(data.limitFallback)
  const [busy, setBusy] = useState(false)
  // back to the saved choice only when it really changed: saving the AI defaults above replaces `data` with a new
  // object holding the same choice, and keying on the object threw away ticks not saved yet (QA TC-217)
  const savedChoice = JSON.stringify(data.memberChoice)
  useEffect(() => {
    setChoice(JSON.parse(savedChoice) as MemberEngineChoice)
    setFallback(data.limitFallback)
  }, [savedChoice, data.limitFallback])
  useKeptDraft('ai-choice', { choice: data.memberChoice, fallback: data.limitFallback }, { choice, fallback }, (d) => { setChoice(d.choice); setFallback(d.fallback) })
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
    <SettingsSection title={t('engines.choice')} desc={<OneLine>{t('engines.choiceDesc')}</OneLine>} testId="engine-choice">
      <SettingRow heading title={t('engines.choice.allow')} desc={t('engines.choice.hint')}
        below={
          <>
            <div className="mt-3 flex flex-wrap gap-1 rounded-lg bg-subtle p-0.5 sm:inline-flex" role="radiogroup" aria-label={t('engines.choice.allow')}>
              {(['off', 'everyone', 'selected'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={choice.mode === mode}
                  onClick={() => setChoice({ ...choice, mode })}
                  className={clsx('rounded-md px-3 py-1.5 text-sm max-md:min-h-11', choice.mode === mode ? 'bg-surface font-medium text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink')}
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
          </>
        } />
      <SettingRow id="ai-fallback" inline title={t('engines.fallback')}
        desc={data.limitFallbackAvailable ? t('engines.fallbackDesc') : t('engines.fallbackUnavailable')}
        more={data.limitFallbackAvailable ? t('engines.fallbackHint2') : undefined}
        below={fallbackOn && (
          <p role="alert" className="mt-2 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="fallback-warning">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden /> {t('engines.fallbackWarning')}
          </p>
        )}
        control={<Switch id="ai-fallback" external describedBy="ai-fallback-desc" checked={fallbackOn} disabled={!data.limitFallbackAvailable} onChange={setFallback} label={t('engines.fallback')} />} />
      {dirty && <GroupSave busy={busy} onSave={() => void save()} onCancel={() => { setChoice(data.memberChoice); setFallback(data.limitFallback) }} testId="engine-choice-save" />}
    </SettingsSection>
  )
}

/** Members' own AI accounts: whether members may add their own Claude or Codex account, whether a subscription may be
 * shared with the team (it warns first), and the accounts members connected. The switches are the owner's and the admins'. */
function MemberAccounts({ tc }: { tc: TeamCredentials }) {
  const t = useT()
  const d = tc.state.data
  if (!d) return null
  return (
    <SettingsSection title={t('providers.memberAccounts')} testId="member-accounts">
      <SettingRow id="ai-member-own" inline title={t('credentials.memberOwn')} desc={t('credentials.memberOwnHint')}
        control={
          <Switch id="ai-member-own" external describedBy="ai-member-own-desc" checked={d.memberOwn} disabled={!tc.owner} label={t('credentials.memberOwn')} testId="member-own-switch" onChange={async (v) => {
            const r = await tc.act(() => api.call(API.updateCredentialSettings, { body: { memberOwn: v } }))
            if (r) tc.state.setData({ ...d, memberOwn: r.memberOwn })
          }} />
        } />
      <SettingRow id="ai-shared-subscriptions" inline title={t('credentials.sharedSubscriptions')}
        desc={<span className={d.sharedSubscriptions ? 'text-warn' : undefined}>{t('teamAi.sharedTermsShort')}</span>}
        more={t('credentials.sharedRiskWarning')}
        testId="shared-subscriptions-row"
        control={
          <div data-testid="shared-subscriptions-setting">
            <Switch id="ai-shared-subscriptions" external describedBy="ai-shared-subscriptions-desc" checked={d.sharedSubscriptions} disabled={!tc.owner} label={t('credentials.sharedSubscriptions')} onChange={async (v) => {
              if (v && !(await confirmDialog({ title: t('credentials.sharedRiskTitle'), body: t('credentials.sharedRiskWarning'), confirm: t('credentials.sharedRiskConfirm'), danger: true }))) return
              const r = await tc.act(() => api.call(API.updateCredentialSettings, { body: { sharedSubscriptions: v, ...(v ? { acknowledgedSharedSubscriptionRisk: true } : {}) } }))
              if (r) void tc.state.reload()
            }} />
          </div>
        } />
      {d.items.some((x) => x.scope === 'personal') && (
        <SettingRow heading title={t('credentials.personalList')} below={<div className="mt-2"><PersonalCredentialList tc={tc} /></div>} />
      )}
    </SettingsSection>
  )
}

/** Usage limits (#ai-limits): tokens or dollars a day or a month, for a person, a group or the team. */
function Budgets({ openHere }: { openHere?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const actOk = useActionOk()
  const budgets = useLoad(async () => (await api.call(API.listBudgets)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const [editing, setEditing] = useState<Budget | 'new' | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  // opened from a "Usage limits" link (Usage, AI providers): bring this group into view and put the focus on its title,
  // so a keyboard or screen reader starts here
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
      id="ai-limits"
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
