// The usage limit dialog, shared by Admin › Team settings › Usage limits (TeamAiSettings.tsx Budgets) and a person's
// "Usage limit…" in Admin › Members (QA TC-2507..2511).
// - Team settings: any limit (the whole team, a group or a person), new or the one being edited.
// - A person (`person`): no "Applies to", the title names them. The Period picks which of their limits is shown: the
//   one they have for that period is edited, else a new one is made, so a day limit and a month limit are both reachable
//   and neither is hidden. Editing one: what is used of it, and Remove limit.
// The same endpoints and roles either way (owner and admins: shared/src/api/admin.ts listBudgets … deleteBudget).
import { useState } from 'react'
import type { Budget, Group, Locale, User } from '@mycel/shared/api'
import { api, API, isApiError } from '../../lib/api'
import { formatNumber, formatUsd } from '../../lib/format'
import { useLocale, useT, type MessageKey, type Params } from '../../i18n'
import { Button, Field, Modal, inputCls } from '../../components/ui'
import { useAction } from './common'

/** Every usage limit with what is used of it, kept as the 'budgets' admin read (store/adminPeople.ts) so Team settings
 * and Members show the same list. */
export const loadBudgets = async () => (await api.call(API.listBudgets)).items

type Form = Pick<Budget, 'subjectType' | 'subjectId' | 'period' | 'limitTokens' | 'limitUsd' | 'action'>

const formOf = (b: Budget | null, start: Pick<Form, 'subjectType' | 'subjectId' | 'period'>): Form =>
  b
    ? { subjectType: b.subjectType, subjectId: b.subjectId, period: b.period, limitTokens: b.limitTokens, limitUsd: b.limitUsd, action: b.action }
    : { ...start, limitTokens: 1_000_000, limitUsd: 0, action: 'warn' }

/** A person's own limits (not the team's or their groups'), day before month. */
export function personBudgets(budgets: Budget[] | null | undefined, userId: string): Budget[] {
  return (budgets ?? []).filter((b) => b.subjectType === 'user' && b.subjectId === userId).sort((a, b) => (a.period === b.period ? 0 : a.period === 'day' ? -1 : 1))
}

/** Used up, as the server counts it (server/src/admin/budgets.ts checkBudgets): a USD limit of 0 is no money limit. */
export const budgetExceeded = (b: Budget) => (b.limitUsd > 0 && b.usedUsd >= b.limitUsd) || (b.limitTokens !== null && b.usedTokens >= b.limitTokens)

/** "1,000,000 tokens a month" (or "$20.00 a month" for a limit in dollars only). */
export function budgetLimitText(t: (k: MessageKey, v?: Params) => string, locale: Locale, b: Budget): string {
  const day = b.period === 'day'
  if (b.limitTokens !== null) return t(day ? 'budgets.tokensPerDay' : 'budgets.tokensPerMonth', { tokens: formatNumber(b.limitTokens, locale) })
  return t(day ? 'budgets.usdPerDay' : 'budgets.usdPerMonth', { amount: formatUsd(b.limitUsd, locale) })
}

/** "120,000 of 1,000,000 tokens this month" (or "$4.00 of $20.00 this month"). */
export function budgetUsedText(t: (k: MessageKey, v?: Params) => string, locale: Locale, b: Budget): string {
  const day = b.period === 'day'
  if (b.limitTokens !== null) return t(day ? 'budgets.usedTokensToday' : 'budgets.usedTokensMonth', { used: formatNumber(b.usedTokens, locale), limit: formatNumber(b.limitTokens, locale) })
  return t(day ? 'budgets.usedUsdToday' : 'budgets.usedUsdMonth', { used: formatUsd(b.usedUsd, locale), limit: formatUsd(b.limitUsd, locale) })
}

export function BudgetForm({ budget = null, person, budgets, users = [], groups = [], onClose, onSaved }: {
  /** Team settings: the limit to edit (null: a new one) */
  budget?: Budget | null
  /** a person's limit (Members): their limits are taken from `budgets`, read as the dialog opens and kept while it is
   * open (Members.tsx openLimit) */
  person?: Pick<User, 'id' | 'name'>
  budgets?: Budget[]
  users?: User[]
  groups?: Group[]
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const mine = person ? personBudgets(budgets, person.id) : []
  // a person: opens on the limit they have (a month one before a day one when they have both), else a new month one
  const [f, setF] = useState<Form>(() => {
    if (!person) return formOf(budget, { subjectType: 'team', subjectId: null, period: 'day' })
    const first = mine.find((b) => b.period === 'month') ?? mine[0] ?? null
    return formOf(first, { subjectType: 'user', subjectId: person.id, period: 'month' })
  })
  // the limit this dialog saves into: Team settings' own, or the person's for the period picked
  const target = person ? mine.find((b) => b.period === f.period) ?? null : budget
  const [busy, setBusy] = useState(false)
  // a limit needs a number: tokens, or an amount above 0 (an emptied tokens field is no token limit, not 0 tokens,
  // which the server counts as used up at once)
  const valid = (f.subjectType === 'team' || !!f.subjectId) && (f.limitTokens !== null || f.limitUsd > 0)
  const save = async () => {
    setBusy(true)
    const body = { ...f, subjectId: f.subjectType === 'team' ? null : f.subjectId }
    const r = await act(() => (target ? api.call(API.updateBudget, { params: { id: target.id }, body }) : api.call(API.createBudget, { body })).catch((e: unknown) => {
      // one limit per subject and period (server/src/admin/budgets.ts checkNoDuplicate): say whose, in the UI language
      const text = isApiError(e, 'conflict') && e.body.params?.reason === 'budget_duplicate' ? duplicateText() : null
      throw text ? new Error(text) : e
    }))
    setBusy(false)
    if (r) onSaved()
  }
  // whose limit it is, by name (null: no name to hand, so the server's own line is shown)
  const duplicateText = (): string | null => {
    if (f.subjectType === 'team') return t('budgets.duplicateTeam')
    // a person (Members): no list here; the dialog reads the limits again when it opens
    if (person) return t('budgets.duplicatePerson', { who: person.name })
    const who = (f.subjectType === 'group' ? groups : users).find((x) => x.id === f.subjectId)?.name
    return who ? t('budgets.duplicate', { who }) : null
  }
  const remove = async () => {
    if (!target) return
    setBusy(true)
    const r = await act(() => api.call(API.deleteBudget, { params: { id: target.id } }).then(() => true))
    setBusy(false)
    if (r) onSaved()
  }
  const setPeriod = (period: Budget['period']) => {
    if (!person) return setF({ ...f, period })
    // a person: the other period is another limit, shown as it is saved (or a new one)
    setF(formOf(mine.find((b) => b.period === period) ?? null, { subjectType: 'user', subjectId: person.id, period }))
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={person ? t('budgets.forPerson', { name: person.name }) : budget ? t('budgets.edit') : t('budgets.new')}
      footer={
        <>
          {person && target && (
            <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => void remove()} data-testid="budget-remove">
              {t('budgets.remove')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!valid} onClick={save} data-testid="budget-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" data-testid="budget-form" data-editing={target ? target.id : undefined}>
        {!person && (
          <>
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
          </>
        )}
        <Field label={t('budgets.period')}>
          <select className={inputCls} value={f.period} onChange={(e) => setPeriod(e.target.value as Budget['period'])} data-testid="budget-period">
            <option value="day">{t('budgets.perDay')}</option>
            <option value="month">{t('budgets.perMonth')}</option>
          </select>
        </Field>
        <Field label={t('budgets.tokens')}>
          <input className={inputCls} type="number" min={0} value={f.limitTokens ?? ''} onChange={(e) => setF({ ...f, limitTokens: e.target.value.trim() === '' ? null : Math.max(0, Math.floor(Number(e.target.value) || 0)) })} data-testid="budget-tokens" />
        </Field>
        <Field label={t('budgets.usd')} hint={t('budgets.usdHint')}>
          <input className={inputCls} type="number" min={0} step="0.01" value={f.limitUsd} onChange={(e) => setF({ ...f, limitUsd: Math.max(0, Number(e.target.value) || 0) })} data-testid="budget-usd" />
        </Field>
        <Field label={t('budgets.action')}>
          <select className={inputCls} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value as Budget['action'] })} data-testid="budget-action">
            <option value="warn">{t('budgets.warn')}</option>
            <option value="block">{t('budgets.block')}</option>
          </select>
        </Field>
        {person && target && (
          <p className="text-sm text-muted sm:col-span-2" data-testid="budget-used">{budgetUsedText(t, locale, target)}</p>
        )}
      </div>
    </Modal>
  )
}
