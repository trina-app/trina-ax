// Making a free team from the desktop app (docs/decisions/20261126-desktop-create-team.md): sign in to the console
// (./console-signin.ts), read who is signed in (`GET /api/app/v1/me`), name the team (`POST /teams`, Free plan only),
// wait while it is made (`GET /teams/:id`), then open it signed in: the owner claim (`POST /teams/:id/owner-claim`)
// gives `https://<team>/app-setup#c=<claim>`, which the app's own window loads. The console contract is
// shared/src/cloud-protocol/owner-claim.ts. The team being made is kept in <userData>/create-pending.json (its id
// and name, nothing secret), so reopening the app comes back to the starting screen. Claim addresses are never logged.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_EMAIL_CODE_RE, APP_PATHS, appTeamPath, isAppEmail, parseAppError, parseAppMe, parseAppTeam, suggestTeamSlug, teamSlugOk, type AppMe, type AppTeam } from '@mycel/shared/cloud-protocol/owner-claim'
import { claimPage, noticeAction, noticeForError, oldSetupPage, slugSuffix, type CreateNotice, type CreateView } from '../common/create-team'
import type { ApiAnswer, ConsoleSignIn } from './console-signin'
import { debug } from './debug'

interface Pending { teamId: string; name: string }

/** a finish-setup after an owner claim is ignored for this long: the page's own "Get a new link" (S5 expired, Google
 * no_owner), and a link from outside the app, which also never replaces S5 on screen (main.ts) */
export const FINISH_PAGE_GAP_MS = 30_000
export const FINISH_LINK_GAP_MS = 2 * 60_000

export interface CreateTeamOptions {
  signin: ConsoleSignIn
  /** the Mac App Store build: read and open only (no create, resume, retry or waiting list) */
  store: boolean
  userData: string
  locale: () => string
  timeZone: () => string
  /** the create screens changed (the first-run screen is sent again) */
  changed: () => void
  /** open a team in the app's window at this page (remembered first if new) */
  openTeam: (origin: string, label: string, path: string) => Promise<void>
  pollMs?: number
  /** tests only: the gaps after a claim (FINISH_PAGE_GAP_MS, FINISH_LINK_GAP_MS) */
  finishGapMs?: { page: number; link: number }
}

export class CreateTeam {
  private v: CreateView = { screen: 'off' }
  private me: AppMe | null = null
  /** the team the create screens are about (the account's, or the one being made) */
  private team: AppTeam | null = null
  private pollTimer?: ReturnType<typeof setTimeout>
  /** counts flows: a step that finds it moved on (Back, Cancel, another start) stops */
  private run = 0
  private nameShownAt = 0
  /** a team whose setup failed over its address (slug_conflict): S3's button retries it with the new address */
  private slugRetry: AppTeam | null = null
  /** "Get a new link" (finishSetup): 'direct' (the team page's own button): the account's running team opens at once
   * (a new owner claim); 'confirm' (a link from outside the app): it stops at "You already have a team · Open it", and
   * only the person's press there asks for a claim */
  private finishing: false | 'direct' | 'confirm' = false
  /** when the last owner claim was issued (a finish-setup soon after it is ignored: it would revoke the claim on screen) */
  private claimAt = 0
  /** an owner-claim request is under way: one at a time */
  private claiming = false

  constructor(private readonly o: CreateTeamOptions) {}

  view(): CreateView {
    return this.v
  }

  /** a team is being made (the app was closed during the starting screen) */
  pending(): Pending | null {
    try {
      if (!existsSync(this.file())) return null
      const p = JSON.parse(readFileSync(this.file(), 'utf8')) as Partial<Pending>
      return typeof p.teamId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p.teamId) && typeof p.name === 'string' ? { teamId: p.teamId, name: p.name.slice(0, 100) } : null
    } catch {
      return null
    }
  }

  /** "Create a team for free" (S0), and the app's start with a team being made */
  start() {
    const run = this.next()
    this.finishing = false
    const p = this.pending()
    if (!this.o.signin.token()) return this.askSignIn(p?.name ?? null)
    void this.fromMe(run)
  }

  /** "Get a new link" for a team whose owner account is not made yet (the setup page expired, or was closed before
   * Continue; docs/decisions/20261128-owner-claim-recovery.md): this app's own console sign-in (S2 when its token is
   * gone), then the owner claim of the account's own team, which revokes the older ones, opened in the app's window. Never
   * a claim or an address from the caller. */
  finishSetup(from: 'page' | 'link'): 'busy' | 'recent' | null {
    // one at a time, and never right after a claim: each claim revokes the one on screen, and the console allows
    // OWNER_CLAIM issues per hour (app-teams.ts); a link from outside waits longer than the page's own button
    if (this.claiming || (this.finishing && this.v.screen !== 'off' && this.v.screen !== 'notice')) return 'busy'
    const gap = from === 'link' ? this.o.finishGapMs?.link ?? FINISH_LINK_GAP_MS : this.o.finishGapMs?.page ?? FINISH_PAGE_GAP_MS
    if (Date.now() - this.claimAt < gap) return 'recent'
    const run = this.next()
    this.finishing = from === 'page' ? 'direct' : 'confirm'
    if (!this.o.signin.token()) {
      this.askSignIn(this.pending()?.name ?? null)
      return null
    }
    void this.fromMe(run)
    return null
  }

  /** the store build's "Already made a team? Sign in", and Try again on S2: the two ways to sign in when there is no
   * good token, else straight on */
  signInAgain() {
    const run = this.next()
    if (this.o.signin.token()) void this.fromMe(run)
    else this.askSignIn(this.pending()?.name ?? null)
  }

  /** S2 [Continue with Google]: the system browser (Google allows no sign-in inside an app's own window) */
  google() {
    if (this.v.screen !== 'signin' || this.v.busy) return
    void this.browserSignIn(this.next())
  }

  /** S2 [Send code] and "Send again": a 6-digit code to this e-mail, typed in the app (no browser) */
  async sendCode(email: string) {
    const v = this.v
    if (v.screen !== 'signin' || v.busy) return
    const address = email.trim()
    if (!isAppEmail(address)) return this.show({ ...v, step: 'choose', email: address, error: 'emailInvalid' })
    const run = this.next()
    this.show({ ...v, email: address, busy: true, error: null })
    const r = await this.o.signin.emailStart(address, this.o.store)
    if (run !== this.run) return
    if (r.ok) return this.show({ ...v, step: 'code', email: address, busy: false, error: null })
    this.show({ ...v, step: v.step === 'code' ? 'code' : 'choose', email: address, busy: false, error: r.error })
  }

  /** S2's code field */
  async verifyCode(code: string) {
    const v = this.v
    if (v.screen !== 'signin' || v.step !== 'code' || v.busy || !v.email) return
    const c = code.replace(/\s+/g, '')
    if (!APP_EMAIL_CODE_RE.test(c)) return this.show({ ...v, error: 'codeInvalid' })
    const run = this.next()
    this.show({ ...v, busy: true, error: null })
    const r = await this.o.signin.emailVerify(c)
    if (run !== this.run) return
    if (r.ok) return void this.fromMe(run)
    this.show({ ...v, busy: false, error: r.error })
  }

  /** "Use another e-mail": back to the two choices with the address to change */
  otherEmail() {
    const v = this.v
    if (v.screen !== 'signin') return
    this.next()
    this.show({ ...v, step: 'choose', busy: false, error: null })
  }

  /** Back or Cancel: to the first-run screen (a team being made stays saved; reopening comes back to it) */
  cancel() {
    this.next()
    this.finishing = false
    this.o.signin.cancel()
    this.slugRetry = null
    this.show({ screen: 'off' })
  }

  /** S3's button */
  async submit(name: string, slug: string, agreedAt: number) {
    const v = this.v
    if (v.screen !== 'name' || v.busy || this.o.store) return
    // the team exists and failed over its address: the same team again with the new address (the console's retry, which
    // takes the address only: the name stays the one the team was made with, locked on the screen)
    const again = this.slugRetry
    const displayName = again ? again.name : name.trim().slice(0, 60)
    const s = slug.trim().toLowerCase() || suggestTeamSlug(displayName, slugSuffix())
    if (!displayName || !teamSlugOk(s)) return this.show({ ...v, slugError: !teamSlugOk(s) })
    const run = this.run
    this.show({ ...v, busy: true, slugError: false })
    // when the box was ticked, within this screen's time (the console records the consent with the terms version)
    const at = Number.isFinite(agreedAt) && agreedAt >= this.nameShownAt && agreedAt <= Date.now() ? agreedAt : Date.now()
    const r = again
      ? await this.o.signin.api('POST', appTeamPath(again.id, 'retry'), { v: 1, slug: s })
      : await this.o.signin.api('POST', APP_PATHS.teams, {
        v: 1, planId: 'free', displayName, slug: s, timeZone: this.o.timeZone(), locale: this.o.locale(),
        consent: { termsVersion: v.plan.termsVersion, shownAt: new Date(at).toISOString() },
      })
    if (run !== this.run) return
    const team = r.status !== null && r.status < 300 ? parseAppTeam((r.body as { team?: unknown } | null)?.team) : null
    if (team) {
      // the retry went through (its answer names the team): no longer a retry
      if (again) this.slugRetry = null
      return this.starting(run, team)
    }
    const code = this.errorCode(r)
    if (code === 'unauthorized') return this.askSignIn(null)
    if (code === 'slug_unavailable') return this.show({ ...v, busy: false, slugError: true })
    if (code === 'team_exists') return void this.fromMe(run)
    this.notice(noticeForError(code) ?? 'failed')
  }

  /** a notice's button */
  async act(kind: string) {
    const v = this.v
    if (v.screen !== 'notice' || v.busy || v.action !== kind) return
    const run = this.run
    const team = this.team
    switch (kind) {
      case 'open':
        if (team) return this.openOwned(run, team)
        return
      case 'again':
        return void this.fromMe(this.next())
      case 'resume':
      case 'retry': {
        if (!team || this.o.store) return
        this.show({ ...v, busy: true })
        const r = await this.o.signin.api('POST', appTeamPath(team.id, kind), { v: 1 })
        if (run !== this.run) return
        if (r.status !== null && r.status < 300) {
          const next = parseAppTeam((r.body as { team?: unknown } | null)?.team) ?? { ...team, state: 'provisioning' as const, provisioning: null }
          return this.starting(run, next)
        }
        const code = this.errorCode(r)
        if (code === 'unauthorized') return this.askSignIn(null)
        return this.notice(noticeForError(code) ?? 'failed')
      }
      case 'waitlist': {
        if (this.o.store) return
        this.show({ ...v, busy: true })
        const r = await this.o.signin.api('POST', APP_PATHS.waitlist, { v: 1 })
        if (run !== this.run) return
        if (r.status !== null && r.status < 300) return this.notice('waitlistDone')
        if (this.errorCode(r) === 'unauthorized') return this.askSignIn(null)
        return this.notice('failed')
      }
    }
  }

  // ---------------------------------------------------------------- the flow

  private next() {
    clearTimeout(this.pollTimer)
    return ++this.run
  }

  private show(v: CreateView) {
    this.v = v
    this.o.changed()
  }

  private notice(n: CreateNotice) {
    this.show({ screen: 'notice', notice: n, action: noticeAction(n, this.o.store), team: this.team?.name ?? this.pending()?.name ?? null, email: this.me?.email ?? null, busy: false })
  }

  private errorCode(r: ApiAnswer): string {
    if (r.status === null) return 'offline'
    if (r.status === 401) return 'unauthorized'
    return parseAppError(r.body)?.code ?? 'failed'
  }

  /** S2: the two ways to sign in (`again`: the team waiting for it, "Sign in again to finish") */
  private askSignIn(again: string | null) {
    this.next()
    this.show({ screen: 'signin', step: 'choose', email: this.v.screen === 'signin' ? this.v.email : null, error: null, again, busy: false })
  }

  private async browserSignIn(run: number) {
    const again = this.pending()?.name ?? null
    this.show({ screen: 'signin', step: 'browser', email: null, error: null, again, busy: false })
    const r = await this.o.signin.signIn(this.o.store)
    if (run !== this.run) return
    if (r.ok) return void this.fromMe(run)
    if (r.error === 'closed') return
    this.show({ screen: 'signin', step: 'choose', email: null, error: r.error === 'failed' ? 'offline' : r.error, again, busy: false })
  }

  /** who is signed in decides the next screen */
  private async fromMe(run: number) {
    const pending = this.pending()
    if (pending) return this.poll(run, pending.teamId)
    const r = await this.o.signin.api('GET', APP_PATHS.me)
    if (run !== this.run) return
    if (r.status === 401) return this.askSignIn(null)
    const me = r.status === 200 ? parseAppMe(r.body) : null
    if (!me) return this.notice(r.status === null ? 'offline' : 'failed')
    this.me = me
    this.team = me.team
    const t = me.team
    if (this.o.store) {
      if (!t) return this.notice('noTeam')
      if (t.state === 'active') return this.openOwned(run, t)
      if (t.state === 'provisioning') return this.starting(run, t)
      return this.teamNotice(t)
    }
    if (t) {
      if (t.state === 'provisioning') return this.starting(run, t)
      if (t.state === 'active') return this.finishing === 'direct' ? this.openOwned(run, t) : this.notice('hasTeam')
      return this.teamNotice(t)
    }
    if (me.waitlist) return this.notice('waitlist')
    if (!me.freeLeft) return this.notice('freeUsed')
    if (!me.freePlan) return this.notice('noFree')
    this.nameShownAt = Date.now()
    this.show({ screen: 'name', email: me.email, plan: me.freePlan, busy: false, slugError: false })
  }

  private teamNotice(t: AppTeam) {
    this.team = t
    if (t.state === 'paused') return this.notice('paused')
    if (t.state === 'suspended' || t.state === 'past_due') return this.notice('onHold')
    if (t.state === 'canceled') return this.notice(t.comeback ? 'comeback' : 'freeUsed')
    if (t.state === 'provision_failed') return this.notice('provisionFailed')
    this.notice('failed')
  }

  private starting(run: number, t: AppTeam) {
    this.team = t
    // the setup failed while the team still reads as being made: never wait on it. Its address went to another team
    // (slug_conflict): back to the name screen with the address open to change, and the button retries with the new
    // one; anything else: the failed-setup notice with Try again
    const failed = t.provisioning?.error
    if (failed) {
      this.clearPending()
      if (failed === 'slug_conflict' && this.me?.freePlan && !this.o.store) {
        this.slugRetry = t
        this.nameShownAt = Date.now()
        return this.show({ screen: 'name', email: this.me.email, plan: this.me.freePlan, busy: false, slugError: true, name: t.name, nameLocked: true })
      }
      return this.notice('provisionFailed')
    }
    this.savePending({ teamId: t.id, name: t.name })
    this.show({ screen: 'starting', team: t.name, step: t.provisioning?.step ?? 0, waitingCapacity: t.provisioning?.waitingCapacity ?? false })
    this.pollTimer = setTimeout(() => void this.poll(run, t.id), this.o.pollMs ?? 3000)
  }

  private async poll(run: number, teamId: string) {
    const name = this.pending()?.name ?? this.team?.name ?? ''
    if (this.v.screen !== 'starting') this.show({ screen: 'starting', team: name, step: this.team?.provisioning?.step ?? 0, waitingCapacity: false })
    const r = await this.o.signin.api('GET', appTeamPath(teamId))
    if (run !== this.run) return
    if (r.status === 401) {
      this.askSignIn(name)
      return
    }
    if (r.status === 404 || r.status === 403) {
      this.clearPending()
      return void this.fromMe(run)
    }
    const t = r.status === 200 ? parseAppTeam((r.body as { team?: unknown } | null)?.team) : null
    // no answer now (offline for a moment, a 5xx): ask again
    if (!t) {
      this.pollTimer = setTimeout(() => void this.poll(run, teamId), this.o.pollMs ?? 3000)
      return
    }
    this.team = t
    if (t.state === 'provisioning') return this.starting(run, t)
    this.clearPending()
    if (t.state === 'active') return this.openOwned(run, t)
    this.teamNotice(t)
  }

  /** the account's team is up: open it signed in (the owner claim while it is not set up, else its address) */
  private async openOwned(run: number, t: AppTeam) {
    const origin = new URL(t.url).origin
    if (t.setUp) return this.open(origin, t.name, '/')
    if (this.claiming) return
    if (this.v.screen === 'notice') this.show({ ...this.v, busy: true })
    this.claiming = true
    let r: ApiAnswer
    try {
      r = await this.o.signin.api('POST', appTeamPath(t.id, 'owner-claim'), { v: 1 })
    } finally {
      this.claiming = false
    }
    if (r.status === 200) this.claimAt = Date.now()
    if (run !== this.run) return
    if (r.status === 200) {
      const page = claimPage(String((r.body as { url?: unknown } | null)?.url ?? ''), t.url)
      if (page) return this.open(origin, t.name, page)
      return this.notice('failed')
    }
    const e = r.status === null ? null : parseAppError(r.body)
    if (r.status === 401) return this.askSignIn(null)
    if (e?.code === 'already_set_up') return this.open(origin, t.name, '/')
    // an older team server: its one-time setup link, in the app's window
    if (e?.code === 'unsupported') {
      const page = oldSetupPage(e.fields.setupUrl, t.url)
      return page ? this.open(origin, t.name, page) : this.notice('failed')
    }
    // too many new setup links this hour: its own words, and no button that would ask again
    if (e?.code === 'rate_limited' || r.status === 429) return this.notice('claimLimit')
    if (e?.code === 'not_ready') return this.starting(run, { ...t, state: 'provisioning', provisioning: t.provisioning ?? { step: 3, error: null, waitingCapacity: false } })
    this.notice(r.status === null ? 'offline' : 'failed')
  }

  private async open(origin: string, label: string, path: string) {
    this.clearPending()
    this.finishing = false
    debug('create: opening the new team', origin)
    this.show({ screen: 'off' })
    await this.o.openTeam(origin, label, path)
  }

  private file() {
    return join(this.o.userData, 'create-pending.json')
  }
  private savePending(p: Pending) {
    try {
      writeFileSync(this.file(), JSON.stringify(p))
    } catch {}
  }
  private clearPending() {
    try {
      rmSync(this.file(), { force: true })
    } catch {}
  }
}
