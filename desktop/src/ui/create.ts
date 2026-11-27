// The create screens of the first-run screen (docs/decisions/20261126-desktop-create-team.md): S2 sign in in the
// browser, S3 name your team, S4 starting, and the state lines. The main process runs the flow (main/create-team.ts)
// and says which screen to show; these only draw it and name the button that was pressed. Lean on purpose: one
// primary button per screen, Back always.
import { suggestTeamSlug, teamSlugOk } from '@mycel/shared/cloud-protocol/owner-claim'
import { freePlanLines, slugSuffix, startSteps, teamHost, type CreateView } from '../common/create-team'
import type { UiKey } from '../common/i18n'
import { h, tr, ui } from './dom'

type Ctx = { store: boolean; teams: boolean; rerender: () => void }

/** the name screen's own typing (kept while the screen redraws) */
const form = { name: '', slug: null as string | null, editing: false, agreed: false, agreedAt: 0, suffix: slugSuffix() }
let formFor: CreateView | null = null

const slugNow = () => form.slug ?? suggestTeamSlug(form.name, form.suffix)

export function createScreen(v: CreateView, ctx: Ctx): HTMLElement {
  if (v.screen === 'name') {
    // a new name screen (not a redraw of the same one): fresh typing; an address the console refused opens for editing
    if (formFor?.screen !== 'name') Object.assign(form, { name: '', slug: null, editing: false, agreed: false, agreedAt: 0, suffix: slugSuffix() })
    if (v.slugError && !form.editing) {
      form.editing = true
      form.slug = slugNow()
    }
  }
  formFor = v
  switch (v.screen) {
    case 'signin': return signIn(v)
    case 'name': return nameTeam(v, ctx)
    case 'starting': return starting(v, ctx)
    case 'notice': return notice(v)
    default: return h('section', { class: 'card' })
  }
}

/** the keyboard to the new screen's first control */
export function focusCreate(v: CreateView) {
  const id = v.screen === 'name' ? (v.slugError ? 'team-slug' : 'team-name') : v.screen === 'signin' && v.step === 'code' ? 'signin-code' : null
  ;(id ? document.getElementById(id) : document.querySelector<HTMLElement>('.create [data-autofocus]'))?.focus()
}

const card = (testid: string, title: string, ...children: (Node | string | null)[]) =>
  h('section', { class: 'card create', 'aria-labelledby': 'create-title', 'data-testid': testid }, h('div', { class: 'brand' }, tr('app.name')), h('h1', { id: 'create-title' }, title), ...children)

const back = (primary = false) => h('button', { type: 'button', class: primary ? 'primary' : undefined, 'data-testid': 'create-back', 'data-autofocus': primary, onclick: () => ui.create.cancel() }, tr('nav.back'))

/** S2's typing (kept while the screen redraws) */
const signForm = { email: '', code: '' }

const SIGNIN_ERROR: Record<NonNullable<Extract<CreateView, { screen: 'signin' }>['error']>, UiKey> = {
  cancelled: 'signin.cancelled', expired: 'signin.expired', offline: 'signin.offline', emailInvalid: 'signin.emailInvalid',
  codeInvalid: 'signin.codeInvalid', codeExpired: 'signin.codeExpired', tooMany: 'signin.tooMany', failed: 'signin.failed',
}

/** "By continuing you agree to the Terms and Privacy." with the console's two pages */
const agreeLine = () =>
  h(
    'p',
    { class: 'note legal-line', 'data-testid': 'signin-agree' },
    tr('signin.agree'),
    ' ',
    h('button', { type: 'button', class: 'inline', 'data-testid': 'signin-terms', onclick: () => ui.welcome.openLink('consoleTerms') }, tr('signin.terms')),
    ' · ',
    h('button', { type: 'button', class: 'inline', 'data-testid': 'signin-privacy', onclick: () => ui.welcome.openLink('consolePrivacy') }, tr('signin.privacy')),
  )

/**
 * S2, three steps. `choose`: [Continue with Google] (the system browser: Google allows no sign-in inside an app's own
 * window) or, in the app with no browser, an e-mail and [Send code]. `browser`: "Continue in your browser to sign in."
 * [Cancel]. `code`: the 6-digit code, "Send again", "Use another email". Back always; the terms line under it.
 */
function signIn(v: Extract<CreateView, { screen: 'signin' }>) {
  const title = v.again ? tr('signin.againTitle') : tr('signin.title')
  const why = v.error ? h('p', { class: 'error', role: 'alert', 'data-testid': 'create-error' }, tr(SIGNIN_ERROR[v.error])) : null
  if (v.step === 'browser') {
    return card(
      'create-signin-view',
      title,
      h('p', { class: 'waking-title', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), tr('signin.body')),
      h('div', { class: 'actions' }, h('button', { type: 'button', 'data-autofocus': true, 'data-testid': 'create-cancel', onclick: () => ui.create.cancel() }, tr('welcome.cancel'))),
    )
  }
  if (v.step === 'code') {
    return card(
      'create-signin-view',
      tr('signin.codeTitle'),
      h('p', { class: 'sub' }, tr('signin.codeBody', { email: v.email ?? '' })),
      h(
        'form',
        { onsubmit: (e: Event) => { e.preventDefault(); ui.create.verify(signForm.code) } },
        h('label', { for: 'signin-code', class: 'field-label' }, tr('signin.codeLabel')),
        h('input', {
          id: 'signin-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, value: signForm.code, disabled: v.busy,
          'aria-invalid': v.error === 'codeInvalid' || v.error === 'codeExpired' ? 'true' : undefined, 'aria-describedby': 'signin-code-error',
          oninput: (e: Event) => { signForm.code = (e.target as HTMLInputElement).value },
        }),
        why ? h('div', { id: 'signin-code-error' }, why) : null,
        h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary', 'data-testid': 'signin-verify', disabled: v.busy }, tr('signin.verify')), back()),
      ),
      h(
        'div',
        { class: 'help-links' },
        h('button', { type: 'button', class: 'ghost', 'data-testid': 'signin-send-again', disabled: v.busy, onclick: () => { signForm.code = ''; ui.create.sendCode(v.email ?? signForm.email) } }, tr('signin.sendAgain')),
        h('button', { type: 'button', class: 'ghost', 'data-testid': 'signin-other-email', onclick: () => { signForm.code = ''; ui.create.otherEmail() } }, tr('signin.otherEmail')),
      ),
    )
  }
  if (v.email && !signForm.email) signForm.email = v.email
  return card(
    'create-signin-view',
    title,
    v.again ? h('p', { class: 'sub' }, tr('signin.againBody', { team: v.again })) : null,
    h('div', { class: 'choices' }, h('button', { type: 'button', class: 'choice', 'data-autofocus': true, 'data-testid': 'signin-google', disabled: v.busy, onclick: () => ui.create.google() }, h('span', { class: 'choice-title' }, tr('signin.google')))),
    h('p', { class: 'or', 'aria-hidden': 'true' }, tr('signin.or')),
    h(
      'form',
      { onsubmit: (e: Event) => { e.preventDefault(); signForm.code = ''; ui.create.sendCode(signForm.email) } },
      h('label', { for: 'signin-email', class: 'field-label' }, tr('signin.emailLabel')),
      h(
        'div',
        { class: 'field' },
        h('input', {
          id: 'signin-email', type: 'email', autocomplete: 'email', spellcheck: 'false', placeholder: tr('signin.emailPlaceholder'), value: signForm.email, disabled: v.busy,
          'aria-invalid': v.error === 'emailInvalid' ? 'true' : undefined,
          oninput: (e: Event) => { signForm.email = (e.target as HTMLInputElement).value },
        }),
        h('button', { type: 'submit', class: 'primary', 'data-testid': 'signin-send', disabled: v.busy }, v.busy ? tr('signin.sending') : tr('signin.sendCode')),
      ),
      why,
    ),
    agreeLine(),
    h('div', { class: 'actions' }, back()),
  )
}

/** S3: one field, the address small under it ("acme.trina.app · Change"), the Free plan's rules, one agree box */
function nameTeam(v: Extract<CreateView, { screen: 'name' }>, ctx: Ctx) {
  // back from a failed setup over its address (slug_conflict): the name the person typed, to keep
  if (v.name && (!form.name || v.nameLocked)) form.name = v.name
  const slugOk = () => teamSlugOk(slugNow())
  const ready = () => form.name.trim() !== '' && form.agreed && slugOk() && !v.busy
  const submit = h('button', { type: 'submit', class: 'primary', 'data-testid': 'create-submit', disabled: !ready() }, v.busy ? tr('create.creating') : tr('create.submit'))
  const host = h('span', { id: 'team-host', 'data-testid': 'team-host' }, teamHost(slugNow()))
  const refresh = () => {
    host.textContent = teamHost(slugNow())
    ;(submit as HTMLButtonElement).disabled = !ready()
  }
  const nameInput = h('input', {
    id: 'team-name', type: 'text', autocomplete: 'organization', spellcheck: 'false', maxlength: 60, placeholder: tr('create.namePlaceholder'), value: form.name, disabled: v.busy || v.nameLocked === true,
    oninput: (e: Event) => { form.name = (e.target as HTMLInputElement).value; refresh() },
  })
  const slugLine = form.editing
    ? h(
        'div',
        { class: 'slug-edit' },
        h('label', { for: 'team-slug', class: 'sr-only' }, tr('create.address')),
        h('input', {
          id: 'team-slug', type: 'text', spellcheck: 'false', autocapitalize: 'off', maxlength: 40, value: slugNow(), disabled: v.busy,
          'aria-invalid': v.slugError || !slugOk() ? 'true' : undefined, 'aria-describedby': 'slug-error',
          oninput: (e: Event) => {
            form.slug = (e.target as HTMLInputElement).value.trim().toLowerCase()
            refresh()
          },
        }),
        h('span', { class: 'slug-domain' }, `.${teamHost('x').slice(2)}`),
      )
    : h(
        'p',
        { class: 'slug-line' },
        host,
        ' · ',
        h('button', { type: 'button', class: 'inline', 'data-testid': 'slug-change', onclick: () => { form.editing = true; form.slug = slugNow(); ctx.rerender(); document.getElementById('team-slug')?.focus() } }, tr('create.change')),
      )
  const plan = h('ul', { class: 'plan', 'aria-label': tr('create.planTitle'), 'data-testid': 'free-plan' }, ...freePlanLines(v.plan).map((l) => h('li', {}, tr(l.key, l.n ? { n: l.n } : {}))))
  return card(
    'create-name',
    tr('create.nameTitle'),
    h('p', { class: 'sub' }, tr('create.signedInAs', { email: v.email })),
    h(
      'form',
      {
        onsubmit: (e: Event) => {
          e.preventDefault()
          if (ready()) ui.create.submit(form.name, slugNow(), form.agreedAt)
        },
      },
      h('label', { for: 'team-name', class: 'field-label' }, tr('create.nameLabel')),
      nameInput,
      slugLine,
      h('p', { id: 'slug-error', class: 'error', role: 'alert', 'data-testid': 'slug-error' }, v.slugError ? tr('create.slugError') : ''),
      h('p', { class: 'plan-title' }, tr('create.planTitle')),
      plan,
      h(
        'label',
        { class: 'agree' },
        h('input', {
          type: 'checkbox', id: 'agree', 'data-testid': 'agree', checked: form.agreed, disabled: v.busy,
          onchange: (e: Event) => { form.agreed = (e.target as HTMLInputElement).checked; form.agreedAt = Date.now(); refresh() },
        }),
        h('span', {}, tr('create.agree')),
      ),
      h(
        'div',
        { class: 'legal' },
        h('button', { type: 'button', class: 'inline', 'data-testid': 'terms', onclick: () => ui.welcome.openLink('terms') }, tr('create.terms'), h('span', { class: 'out', 'aria-hidden': 'true' }, ' ↗')),
        h('button', { type: 'button', class: 'inline', 'data-testid': 'privacy', onclick: () => ui.welcome.openLink('privacy') }, tr('create.privacy'), h('span', { class: 'out', 'aria-hidden': 'true' }, ' ↗')),
      ),
      h('div', { class: 'actions' }, submit, back()),
    ),
  )
}

/** S4: "Setting up {team}… about a minute or two. You can close the app." and its 3 steps */
function starting(v: Extract<CreateView, { screen: 'starting' }>, ctx: Ctx) {
  const steps = startSteps(v.step)
  return card(
    'create-starting',
    tr('starting.title', { team: v.team }),
    h('p', { class: 'sub' }, tr('starting.body')),
    h(
      'ol',
      { class: 'start-steps', 'data-testid': 'start-steps' },
      ...(['starting.step1', 'starting.step2', 'starting.step3'] as const).map((k, i) =>
        h('li', { class: steps[i], 'data-state': steps[i], 'aria-current': steps[i] === 'now' ? 'step' : undefined }, steps[i] === 'now' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : h('span', { class: 'dot', 'aria-hidden': 'true' }), tr(k)),
      ),
    ),
    v.waitingCapacity ? h('p', { class: 'note', role: 'status' }, tr('starting.waiting')) : null,
    // the wait goes on with the app closed; with other teams on this computer, Back leaves it for now
    ctx.teams ? h('div', { class: 'help-links' }, h('button', { type: 'button', class: 'ghost', 'data-testid': 'create-back', onclick: () => ui.create.cancel() }, tr('nav.back'))) : null,
  )
}

const NOTICE_TEXT: Record<Extract<CreateView, { screen: 'notice' }>['notice'], UiKey> = {
  hasTeam: 'notice.hasTeam', freeUsed: 'notice.freeUsed', comeback: 'notice.comeback', paused: 'notice.paused', awakeLimit: 'notice.awakeLimit',
  onHold: 'notice.onHold', capacityFull: 'notice.capacityFull', waitlist: 'notice.waitlist', waitlistDone: 'notice.waitlistDone',
  networkLimit: 'notice.networkLimit', emailUnverified: 'notice.emailUnverified', noFreeRegion: 'notice.noFreeRegion',
  provisionFailed: 'notice.provisionFailed', noFree: 'notice.noFree', noTeam: 'notice.noTeam', offline: 'notice.offline', failed: 'notice.failed',
}
const ACTION_TEXT: Record<NonNullable<Extract<CreateView, { screen: 'notice' }>['action']>, UiKey> = {
  open: 'notice.open', plans: 'notice.plans', console: 'notice.console', resume: 'notice.resume', waitlist: 'notice.waitlistJoin', retry: 'notice.retry', again: 'notice.again',
}

/** A state line: its words, its one button (a link out for plans and the console), Back */
function notice(v: Extract<CreateView, { screen: 'notice' }>) {
  const a = v.action
  const press = () => {
    if (a === 'plans') ui.welcome.openLink('pricing')
    else if (a === 'console') ui.welcome.openLink('console')
    else if (a) ui.create.act(a)
  }
  const out = a === 'plans' || a === 'console'
  return card(
    'create-notice',
    tr(NOTICE_TEXT[v.notice], { team: v.team ?? '', email: v.email ?? '' }),
    v.notice === 'waitlist' && v.email ? h('p', { class: 'sub' }, tr('create.signedInAs', { email: v.email })) : null,
    h(
      'div',
      { class: 'actions', 'data-notice': v.notice },
      a ? h('button', { type: 'button', class: 'primary', 'data-autofocus': true, 'data-testid': 'notice-action', 'data-action': a, disabled: v.busy, onclick: press }, tr(ACTION_TEXT[a]), out ? h('span', { class: 'out', 'aria-hidden': 'true' }, ' ↗') : null) : null,
      back(!a),
    ),
  )
}
