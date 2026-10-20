// Audit log: admin actions, file changes, tool calls, sign-ins. Filter by kind, person, path and dates; paged.
import { useEffect, useState } from 'react'
import type { AuditEntry } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { DICTS, useLocale, useT, type MessageKey } from '../../i18n'
import { Badge, Button, ErrorNote, Field, Skeleton, inputCls } from '../../components/ui'
import { Card, useLoad } from './common'

type Source = 'admin' | 'file' | 'tool' | 'auth'

export default function Audit() {
  const t = useT()
  const locale = useLocale()
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const [source, setSource] = useState<Source | ''>('')
  const [actor, setActor] = useState('')
  const [path, setPath] = useState('')
  const [items, setItems] = useState<AuditEntry[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  const load = async (more: boolean) => {
    setBusy(true)
    try {
      const r = await api.call(API.audit, { query: { limit: 100, cursor: more ? cursor ?? undefined : undefined, source: source || undefined, actor: actor || undefined, path: path.trim() || undefined } })
      setItems((cur) => (more && cur ? [...cur, ...r.items] : r.items))
      setCursor(r.nextCursor)
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(false), 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, actor, path])

  return (
    <Card title={t('admin.audit')} desc={t('audit.desc')}>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label={t('audit.kind')}>
          <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value as Source | '')}>
            <option value="">{t('audit.all')}</option>
            {(['admin', 'file', 'tool', 'auth'] as Source[]).map((s) => (
              <option key={s} value={s}>
                {t(`audit.source.${s}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('audit.actor')}>
          <select className={inputCls} value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">{t('audit.everyone')}</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('audit.path')}>
          <input className={inputCls} value={path} onChange={(e) => setPath(e.target.value)} placeholder="finance/2026" />
        </Field>
      </div>
      {error && <ErrorNote onRetry={() => void load(false)}>{error}</ErrorNote>}
      {!items && !error && <Skeleton lines={6} />}
      {items && !items.length && <p className="text-sm text-faint">{t('audit.none')}</p>}
      {items && items.length > 0 && (
        <ul className="divide-y divide-line text-sm" data-testid="audit-list">
          {items.map((e) => (
            <li key={e.id} className="py-2">
              <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)} disabled={!e.detail}>
                <span className="w-36 shrink-0 text-xs text-faint tabular-nums">{formatDateTime(e.at, locale)}</span>
                <Badge>{t(`audit.source.${e.source}`)}</Badge>
                <span className="font-medium">{e.actor?.name ?? t('files.byAi')}</span>
                <span className="text-muted" title={e.action}>
                  {actionLabel(t, e)}
                </span>
                {e.target && <code className="min-w-0 truncate rounded bg-subtle px-1 text-xs">{e.target}</code>}
                <ToolOutcome e={e} />
              </button>
              {open === e.id && e.detail && <pre className="mt-2 overflow-x-auto rounded bg-subtle p-2 text-xs">{JSON.stringify(e.detail, null, 2)}</pre>}
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <div className="pt-3 text-center">
          <Button size="sm" busy={busy} onClick={() => void load(true)}>
            {t('common.loadMore')}
          </Button>
        </div>
      )}
    </Card>
  )
}

/**
 * What happened, in words: admin and sign-in actions ("auth.login" → "로그인"), file events ("conflict" → "충돌 사본
 * 만듦"). Tool calls keep the tool's name (read, write, web_fetch: the summary next to it says what it did); the id
 * stays in the tooltip for anyone matching it with the server log. Unknown ids are shown as they are.
 */
function actionLabel(t: ReturnType<typeof useT>, e: AuditEntry): string {
  const key = e.source === 'file' ? `audit.file.${e.action}` : e.source === 'tool' ? (e.action === '(connect)' ? 'audit.tool.connect' : '') : `audit.act.${e.action}`
  return key && key in DICTS.ko ? t(key as MessageKey) : e.action
}

/** Tool calls: whether the call was refused (permission) or failed, and its one-line summary ("read groups/x -> denied: ..."). */
function ToolOutcome({ e }: { e: AuditEntry }) {
  const t = useT()
  if (e.source !== 'tool' || !e.detail) return null
  const summary = typeof e.detail.summary === 'string' ? e.detail.summary : ''
  const failed = e.detail.ok === 0 || e.detail.ok === false
  const denied = failed && /-> denied\b/.test(summary)
  return (
    <>
      {failed && (
        <Badge tone="danger">
          {t(denied ? 'audit.denied' : 'audit.failed')}
        </Badge>
      )}
      {summary && <span className="min-w-0 basis-full truncate text-xs text-faint sm:pl-38">{summary}</span>}
    </>
  )
}
