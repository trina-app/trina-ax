// What arrived at an app's address, as an event for the room (docs/DECISIONS.md "Apps posting in rooms"). One reader per
// kind: Sentry's integration-platform resources, GitHub's repository events, our Google Forms script's JSON, and for
// "Other" a Slack-shaped {"text": …} (also Discord's "content", a few simple fields, form-encoded `payload`, plain
// text). Every field used is read by type and bounded (card.ts); everything else in the body is ignored. A body that is
// not one of these is a 'format' refusal; an event no switch covers is skipped (200, nothing shown).
//
// Vendor facts (checked 2026-11-14, plan "Vendor facts"): Sentry-Hook-Resource names the resource; issue actions
// created / resolved / assigned / archived / unresolved with data.issue; event_alert (triggered) with data.event and
// data.triggered_rule; metric_alert with data.metric_alert. GitHub: X-GitHub-Event, X-GitHub-Delivery.
import crypto from 'node:crypto'
import type { Locale, RoomAppKind } from '@mycel/shared/api'
import { line, lines, safeLink } from './card'
import { appText } from './text'

/** One event for the room. `switch`: the app's switch that must be on. `key`: the thing it is about (one thread per
 * key, kept `keyDays` after its last event, else `keyMinutes`). `card`: the first card of the thing; `reply`: the short
 * line in its thread when a card for the key is there already. `state`: the thing's state now (the root's status line
 * follows it). `back`: a regression (Sentry's unresolved, a reopened issue or pull request): the thread reply goes to
 * the room too. `alert`: Sentry's alert rule fired (its switch turns on by itself, once). `extra`: more plain text than
 * the card shows. `delivery`: the vendor's id of this delivery (a retry has the same), kept `deliveryMinutes`. */
export interface AppEvent {
  switch: string
  delivery: string
  /** a second delivery key (GitHub: the body itself, so a replay under a new X-GitHub-Delivery posts nothing) */
  alsoDelivery?: string
  deliveryMinutes?: number
  key?: string
  keyMinutes?: number
  card: { kind?: string; title: string; details?: string[]; status?: string; link?: string; unverified?: boolean }
  reply?: { title: string; details?: string[]; unverified?: boolean }
  state?: string
  status?: string
  back?: boolean
  alert?: boolean
  extra?: string
}
export type Parsed = { skip: true; connected?: boolean } | { event: AppEvent } | { refuse: 'format' }

export interface Arrival {
  kind: RoomAppKind
  headers: Headers
  contentType: string
  raw: Uint8Array
  /** the request carried a signature that matched a saved secret (actor names are then not marked) */
  signed: boolean
  locale: Locale
  /** the app's switches now (Forms' respondent email) */
  events: Record<string, boolean>
}

const sha = (s: string | Uint8Array) => crypto.createHash('sha256').update(s).digest('hex')
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
/** a nested value: get(o, 'data', 'issue', 'id') */
function get(o: unknown, ...path: string[]): unknown {
  let v: unknown = o
  for (const p of path) { const x = obj(v); if (!x) return undefined; v = x[p] }
  return v
}
const str = (o: unknown, ...path: string[]) => { const v = get(o, ...path); return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '' }
const firstLine = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? ''

function json(a: Arrival): unknown {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(a.raw)
  if (a.contentType === 'application/x-www-form-urlencoded') {
    const p = new URLSearchParams(text).get('payload')
    if (p === null) return undefined
    try { return JSON.parse(p) } catch { return undefined }
  }
  try { return JSON.parse(text) } catch { return undefined }
}

export function parseArrival(a: Arrival): Parsed {
  switch (a.kind) {
    case 'sentry': return sentry(a)
    case 'github': return github(a)
    case 'google_forms': return forms(a)
    case 'other': return other(a)
  }
}

// ---------------- Sentry ----------------
function sentry(a: Arrival): Parsed {
  const body = obj(json(a))
  if (!body) return { refuse: 'format' }
  const resource = a.headers.get('sentry-hook-resource') ?? ''
  const L = a.locale
  const action = str(body, 'action')
  // the timestamp header is not signed: the delivery is the resource and the body
  const delivery = sha(`${resource}\n${new TextDecoder().decode(a.raw)}`)
  const actor = (name: string) => (a.signed ? name : `${name} ${appText('unverified', L)}`)
  if (resource === 'issue') {
    const issue = get(body, 'data', 'issue')
    const id = str(issue, 'id')
    if (!obj(issue) || !id) return { refuse: 'format' }
    const project = str(issue, 'project', 'slug') || str(issue, 'project', 'name')
    const level = str(issue, 'level')
    const head = (k: string) => [k, project, level].filter(Boolean).join(' · ')
    const title = str(issue, 'title') || str(issue, 'shortId') || id
    const culprit = str(issue, 'culprit')
    const link = str(issue, 'web_url') || str(issue, 'permalink')
    const key = `issue:${id}`
    const statusOf = (s: string) => appText('status', L, { status: s })
    const who = line(str(body, 'actor', 'name'), 80)
    const card = (k: string, status: string, unverified = false) => ({ kind: head(k), title, details: culprit ? [culprit] : [], status: statusOf(status), link, unverified })
    switch (action) {
      case 'created': return { event: { switch: 'new_issue', delivery, key, card: card(appText('sentryNew', L), appText('statusUnresolved', L)), state: 'unresolved', status: statusOf(appText('statusUnresolved', L)) } }
      case 'resolved': {
        const r = who ? appText('sentryResolvedBy', L, { actor: actor(who) }) : appText('sentryResolved', L)
        return { event: { switch: 'resolved', delivery, key, card: card(r, appText('sentryResolved', L), !!who && !a.signed), reply: { title: r, unverified: !!who && !a.signed }, state: 'resolved', status: statusOf(appText('sentryResolved', L)) } }
      }
      case 'archived': {
        const r = appText('sentryArchived', L)
        return { event: { switch: 'resolved', delivery, key, card: card(r, r), reply: { title: r }, state: 'archived', status: statusOf(r) } }
      }
      case 'unresolved': {
        const r = appText('sentryBack', L)
        return { event: { switch: 'came_back', delivery, key, card: card(r, appText('statusUnresolved', L)), reply: { title: r }, state: 'unresolved', status: statusOf(appText('statusUnresolved', L)), back: true } }
      }
      case 'assigned': {
        const to = line(str(issue, 'assignedTo', 'name') || str(body, 'data', 'assignee', 'name'), 80)
        if (!to) return { skip: true }
        const r = appText('sentryAssigned', L, { name: actor(to) })
        return { event: { switch: 'assigned', delivery, key, card: card(r, appText('statusUnresolved', L), !a.signed), reply: { title: r, unverified: !a.signed } } }
      }
      default: return { skip: true }
    }
  }
  if (resource === 'event_alert') {
    if (action !== 'triggered') return { skip: true }
    const ev = get(body, 'data', 'event')
    if (!obj(ev)) return { refuse: 'format' }
    const rule = line(str(body, 'data', 'triggered_rule'), 120)
    const issueId = str(ev, 'issue_id') || str(ev, 'groupID')
    const k = appText('sentryAlert', L, { rule: rule || '…' })
    const title = str(ev, 'title') || str(ev, 'message') || rule || '…'
    return { event: { switch: 'alert', alert: true, delivery, ...(issueId ? { key: `issue:${issueId}` } : {}), card: { kind: [k, str(ev, 'level')].filter(Boolean).join(' · '), title, details: str(ev, 'culprit') ? [str(ev, 'culprit')] : [], link: str(ev, 'web_url') }, reply: { title: k } } }
  }
  if (resource === 'metric_alert') {
    const m = get(body, 'data', 'metric_alert')
    const id = str(m, 'id')
    if (!obj(m) || !id) return { refuse: 'format' }
    const status = line(action, 40) || '…'
    const k = appText('sentryMetric', L, { status })
    const title = str(body, 'data', 'description_title') || str(m, 'alert_rule', 'name') || id
    return { event: { switch: 'metric', delivery, key: `metric:${id}`, card: { kind: k, title, details: str(body, 'data', 'description_text') ? [str(body, 'data', 'description_text')] : [], link: str(body, 'data', 'web_url') }, reply: { title: k } } }
  }
  // installation, comment, error, seer, preprod_artifact, anything newer: not shown
  return { skip: true }
}

// ---------------- GitHub ----------------
function github(a: Arrival): Parsed {
  const event = a.headers.get('x-github-event') ?? ''
  const body = obj(json(a))
  if (!body) return { refuse: 'format' }
  const L = a.locale
  const delivery = line(a.headers.get('x-github-delivery') ?? '', 100) || sha(a.raw)
  const alsoDelivery = `body:${sha(a.raw)}`
  if (event === 'ping') return { skip: true, connected: true }
  const repoId = str(body, 'repository', 'id')
  const repo = line(str(body, 'repository', 'full_name'), 140)
  const by = (login: string) => (login ? appText('byActor', L, { actor: a.signed ? line(login, 60) : `${line(login, 60)} ${appText('unverified', L)}` }) : '')
  const sender = str(body, 'sender', 'login')
  const action = str(body, 'action')
  const statusOf = (k: 'statusOpen' | 'statusMerged' | 'statusClosed' | 'statusFailed') => appText('status', L, { status: appText(k, L) })
  if (event === 'pull_request' || event === 'issues') {
    const pr = event === 'pull_request'
    const item = get(body, pr ? 'pull_request' : 'issue')
    const n = str(item, 'number')
    if (!obj(item) || !n || !repoId) return { refuse: 'format' }
    const key = `${repoId}:${pr ? 'pr' : 'issue'}:${n}`
    const title = str(item, 'title') || `#${n}`
    const where = `${repo}#${n}`
    const link = str(item, 'html_url')
    const unverified = !a.signed
    const mk = (k: string, status: 'statusOpen' | 'statusMerged' | 'statusClosed', who: string, state: string, back = false): Parsed => ({
      event: {
        switch: pr ? 'pull_request' : 'issue', delivery, alsoDelivery, key, state, status: statusOf(status), back,
        card: { kind: `${k} · ${where}`, title, details: who ? [by(who)] : [], status: statusOf(status), link, unverified: unverified && !!who },
        reply: { title: [k, by(who)].filter(Boolean).join(' · '), unverified: unverified && !!who },
      },
    })
    if (pr) {
      switch (action) {
        case 'opened': return mk(appText('prOpened', L), 'statusOpen', str(item, 'user', 'login'), 'open')
        case 'reopened': return mk(appText('prReopened', L), 'statusOpen', sender, 'open', true)
        case 'ready_for_review': return mk(appText('prReady', L), 'statusOpen', sender, 'open')
        case 'closed': return get(item, 'merged') === true ? mk(appText('prMerged', L), 'statusMerged', str(item, 'merged_by', 'login') || sender, 'merged') : mk(appText('prClosed', L), 'statusClosed', sender, 'closed')
        default: return { skip: true }
      }
    }
    switch (action) {
      case 'opened': return mk(appText('issueOpened', L), 'statusOpen', str(item, 'user', 'login'), 'open')
      case 'reopened': return mk(appText('issueReopened', L), 'statusOpen', sender, 'open', true)
      case 'closed': return mk(appText('issueClosed', L), 'statusClosed', sender, 'closed')
      default: return { skip: true }
    }
  }
  if (event === 'workflow_run') {
    const run = get(body, 'workflow_run')
    if (!obj(run)) return { refuse: 'format' }
    const conclusion = str(run, 'conclusion')
    if (action !== 'completed' || (conclusion !== 'failure' && conclusion !== 'timed_out')) return { skip: true }
    const name = line(str(run, 'name') || str(body, 'workflow', 'name'), 120) || '…'
    const branch = line(str(run, 'head_branch'), 120)
    const k = appText('checksFailed', L, { workflow: name })
    const title = firstLine(str(run, 'display_title') || str(run, 'head_commit', 'message')) || name
    return { event: {
      switch: 'checks_failed', delivery, alsoDelivery, ...(repoId ? { key: `${repoId}:wf:${str(run, 'workflow_id')}:${branch}` } : {}),
      card: { kind: k, title, details: [[repo, branch].filter(Boolean).join(' · ')].filter(Boolean), status: statusOf('statusFailed'), link: str(run, 'html_url') },
      reply: { title: k, details: [title] },
    } }
  }
  if (event === 'release') {
    if (action !== 'published') return { skip: true }
    const tag = line(str(body, 'release', 'tag_name'), 80) || '…'
    return { event: { switch: 'release', delivery, alsoDelivery, card: { kind: appText('release', L, { tag }), title: str(body, 'release', 'name') || tag, details: repo ? [repo] : [], link: str(body, 'release', 'html_url') } } }
  }
  if (event === 'push') {
    const commits = Array.isArray(body.commits) ? body.commits.length : 0
    const ref = str(body, 'ref')
    if (!commits || !ref.startsWith('refs/heads/')) return { skip: true }
    const branch = line(ref.slice('refs/heads/'.length), 120)
    const k = commits === 1 ? appText('pushedOne', L, { branch }) : appText('pushedMany', L, { n: commits, branch })
    return { event: { switch: 'push', delivery, alsoDelivery, card: { kind: k, title: firstLine(str(body, 'head_commit', 'message')) || branch, details: [[repo, by(sender)].filter(Boolean).join(' · ')], link: str(body, 'compare'), unverified: !a.signed && !!sender } } }
  }
  return { skip: true }
}

// ---------------- Google Forms (our script) ----------------
const FORM_ANSWERS_MAX = 50
const FORM_ANSWER_MAX = 1000
function forms(a: Arrival): Parsed {
  const body = obj(json(a))
  if (!body) return { refuse: 'format' }
  const L = a.locale
  const form = line(str(body, 'form'), 120)
  const id = line(str(body, 'id'), 200)
  const at = line(str(body, 'at'), 60)
  if (!form || !id || !Array.isArray(body.answers) || body.answers.length > FORM_ANSWERS_MAX) return { refuse: 'format' }
  const answers = body.answers.map((x) => ({ q: line(str(x, 'q'), 200), a: lines(str(x, 'a'), FORM_ANSWER_MAX).replace(/\n+/g, ' / ') })).filter((x) => x.q || x.a)
  const qa = (x: { q: string; a: string }) => (x.q ? `${x.q}: ${x.a}` : x.a)
  // the respondent's email only while the app's switch is on (owner decision 12: on unless turned off)
  const emailRaw = line(str(body, 'email'), 254)
  const email = a.events.email && /^[^\s@]+@[^\s@]+$/.test(emailRaw) ? emailRaw : ''
  let details = [...(email ? [appText('formsEmail', L, { email })] : []), ...answers.slice(1).map(qa)]
  if (details.length > 3) details = [...details.slice(0, 2), appText('formsMore', L, { n: details.length - 2 })]
  return { event: {
    switch: 'response', delivery: at ? sha(`${id}\n${at}`) : sha(a.raw), key: `response:${id}`,
    card: { kind: appText('formsNew', L, { form }), title: answers[0] ? qa(answers[0]) : form, details },
    reply: { title: appText('formsEdited', L), details: answers[0] ? [qa(answers[0])] : [] },
    extra: lines([...(email ? [appText('formsEmail', L, { email })] : []), ...answers.map(qa)].join('\n')),
  } }
}

// ---------------- Other (Slack-shaped and friends) ----------------
/** Slack's <https://x|label>, <https://x>, <!here>, <@U123>: the text people read, and the first https link. A label that
 * looks like a different address shows the real address instead. */
export function slackText(s: string): { text: string; link?: string } {
  let link: string | undefined
  const text = s.replace(/<([^<>|\s]+)(?:\|([^<>]*))?>/g, (_m, target: string, label?: string) => {
    if (/^(https?|mailto):/i.test(target)) {
      const safe = safeLink(target)
      if (safe && !link) link = safe.url
      const l = (label ?? '').trim()
      if (!l) return target
      // a label that is itself an address must be the same address, else the real one is shown
      if (/^[a-z][a-z0-9+.-]*:\/\/|^www\.|^[^\s]+\.[a-z]{2,}(\/|$)/i.test(l)) {
        const same = (() => { try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(l) ? l : `https://${l}`).host === new URL(target).host } catch { return false } })()
        return same ? l : target
      }
      return l
    }
    // <!here>, <@U123|name>, <#C123|channel>: their words only, never a mention
    return (label ?? target.replace(/^[!@#]/, '').replace(/^subteam\^/, '')).trim()
  })
  return { text, ...(link ? { link } : {}) }
}

function other(a: Arrival): Parsed {
  let text = '', title = '', link = '', thread = ''
  if (a.contentType === 'text/plain') {
    text = new TextDecoder('utf-8', { fatal: false }).decode(a.raw)
  } else {
    const body = obj(json(a))
    if (!body) return { refuse: 'format' }
    text = str(body, 'text') || str(body, 'content')
    if (!text) {
      // Block Kit and attachments: their text and fallback only
      const parts: string[] = []
      for (const b of Array.isArray(body.blocks) ? body.blocks.slice(0, 20) : []) parts.push(str(b, 'text', 'text') || str(b, 'text'))
      for (const at of Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : []) parts.push(str(at, 'text') || str(at, 'fallback') || str(at, 'title'))
      text = parts.filter(Boolean).join('\n')
    }
    title = str(body, 'title')
    link = str(body, 'link') || str(body, 'url')
    thread = line(str(body, 'thread'), 200)
  }
  const s = slackText(text)
  const clean = lines(s.text)
  const head = line(title) || line(firstLine(clean))
  if (!clean && !head) return { refuse: 'format' }
  const rest = clean.split('\n').map((x) => x.trim()).filter(Boolean)
  const body = title ? rest : rest.slice(1)
  const idem = line(a.headers.get('idempotency-key') ?? '', 200)
  return { event: {
    switch: 'message',
    delivery: idem ? `idem:${idem}` : sha(a.raw), ...(idem ? {} : { deliveryMinutes: 10 }),
    key: thread ? `thread:${thread}` : `text:${sha(clean || head)}`, ...(thread ? {} : { keyMinutes: 60 }),
    card: { title: head, details: body.slice(0, 3), link: safeLink(link)?.url ?? s.link },
    reply: { title: head, details: body.slice(0, 1) },
    ...(body.length > 3 ? { extra: body.join('\n') } : {}),
  } }
}
