// "About this person and place" (server/src/chat/situation.ts; docs/DECISIONS.md "The AI knows who it is talking to"):
// per state, the facts the AI must have are there and the false ones are not. The owner saw the AI send people to
// screens they cannot open; the audit table is in the PR (fix/ai-knows-the-person).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { appOf, situationOf, situationSection, serverWhere, type Situation } from '../../server/src/chat/situation'
import { buildTurnContext, buildTurnPrompt, environmentSection, ENVIRONMENT, GUEST_ENVIRONMENT, type PromptInput } from '../../server/src/chat/prompt'
import { SCREEN } from '../../server/src/policy/refusal'
import { PRODUCT } from '@mycel/shared'
import { setPlanForTests } from '../../server/src/system/limits'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { DICTS } from '../../web/src/i18n'

setDefaultTimeout(30_000)
const LOCALES = ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const
const base: Situation = { role: 'member', guest: false, app: 'web', ai: 'team', ownAi: true, ownConnectors: true, plan: null, web: true }
const say = (s: Partial<Situation>, L: (typeof LOCALES)[number] = 'en') => situationSection({ ...base, ...s }, L)

describe('screen names the AI is told match the app', () => {
  test('each place in the person\'s language, as the web app names it', () => {
    for (const L of LOCALES) {
      const d = DICTS[L] as Record<string, string>
      expect(SCREEN.settings(L)).toBe(`Settings ("${d['settings.title']}")`)
      expect(SCREEN.meTab(L)).toBe(`the Me tab ("${d['tabs.me']}")`)
      expect(SCREEN.ownProviders(L)).toBe(`Settings › AI providers ("${d['settings.title']} › ${d['settings.providers']}")`)
      expect(SCREEN.adminProviders(L)).toBe(`Admin › AI providers ("${d['admin.title']} › ${d['admin.providers']}")`)
      expect(SCREEN.usage(L)).toBe(`Settings › Usage ("${d['settings.title']} › ${d['settings.usage']}")`)
      expect(SCREEN.adminSystem(L)).toBe(`Admin › System ("${d['admin.title']} › ${d['admin.system']}")`)
      expect(SCREEN.connectors(L)).toBe(`Settings › Connectors ("${d['settings.title']} › ${d['integrations.title']}")`)
      expect(SCREEN.adminMcp(L)).toBe(`Admin › Connected apps ("${d['admin.title']} › ${d['admin.integrations']}")`)
      expect(SCREEN.adminSettings(L)).toBe(`Admin ("${d['admin.title']}")`)
      expect(SCREEN.sharedWithMe(L)).toBe(`Files › Shared with me ("${d['sidebar.files']} › ${d['filesPanel.shared']}")`)
      expect(SCREEN.restoreButton(L)).toBe(`Restore ("${d['common.restore']}")`)
    }
  })
})

describe('the block per state', () => {
  test('owner: can open Admin; the team\'s AI account is in Admin › AI providers', () => {
    const t = say({ role: 'owner' }, 'ko')
    expect(t).toContain('## About this person and place')
    expect(t).toContain('Role: the team\'s owner. They can open Admin ("관리자")')
    expect(t).toContain('Admin › AI providers ("관리자 › AI 제공사")')
    expect(t).not.toContain('They cannot open Admin')
  })

  test('admin: can open Admin', () => {
    const t = say({ role: 'admin' })
    expect(t).toContain('Role: an admin. They can open Admin')
    expect(t).not.toContain('never send them to an Admin page')
  })

  test('member: cannot open Admin, never sent there; their own things are in Settings', () => {
    const t = say({ role: 'member' }, 'ko')
    expect(t).toContain('Role: a member. They cannot open Admin')
    expect(t).toContain('never send them to an Admin page')
    expect(t).toContain('Settings ("설정")')
    // no Admin page named as a place for them to go
    expect(t).not.toContain('Admin › AI providers')
    expect(t).not.toContain('Admin › System')
    expect(t).not.toContain('They can open Admin')
  })

  test('a member whose AI is their own sign-in, and one on the team\'s account', () => {
    expect(say({ ai: 'own' })).toContain('your answers use their own AI account (Settings › AI providers).')
    // in English the name is said once; in another language with the app's own words next to it
    expect(say({ role: 'owner' })).toContain('They can open Admin for team-wide changes, and Settings for their own.')
    expect(say({ ai: 'own' }, 'ja')).toContain('(Settings › AI providers ("設定 › AIプロバイダー")).')
    const team = say({ ai: 'team' })
    expect(team).toContain('your answers use an AI account the team set up.')
    expect(team).toContain('They can add their own AI sign-in in Settings › AI providers')
    expect(team).not.toContain('their own AI account (')
  })

  test('a member whose admin turned off personal AI sign-ins: never told to add one', () => {
    const t = say({ ai: 'team', ownAi: false })
    expect(t).toContain('Adding their own AI account is turned off for this team by an admin: do not suggest it')
    expect(t).not.toContain('They can add their own AI sign-in')
    // an admin hears where the switch is
    expect(say({ role: 'admin', ai: 'team', ownAi: false })).toContain('Adding their own AI account is turned off for this team (Admin › AI providers')
  })

  test('a member with no usable AI connection now: nothing claimed about whose account answers', () => {
    const t = say({ ai: null })
    expect(t).not.toContain('your answers use')
    expect(t).toContain('They can add their own AI sign-in')
  })

  test('Office Mac (the server\'s own sign-in): not "your own account", not the team\'s AI connections', () => {
    const t = say({ ai: 'host' })
    expect(t).toContain(`the AI sign-in of the computer the team's ${PRODUCT.displayName} runs on, set up by the owner`)
    // no "server" for the AI to repeat (ADM-07.member, 2026-11-17)
    expect(t).not.toMatch(/\bservers?\b/)
    expect(t).not.toContain('They can add their own AI sign-in')
    expect(say({ role: 'owner', ai: 'host' })).toContain('runs on (Admin › AI providers')
  })

  test('personal connected services turned off: no card offered to a member', () => {
    const t = say({ ownConnectors: false })
    expect(t).toContain('Adding their own connected services is turned off for this team by an admin: do not offer to connect one for them')
    expect(t).not.toContain('Settings › Connectors')
    expect(say({ ownConnectors: true })).toContain('Settings › Connectors')
  })

  test('their own usage is in Settings › Usage, for everyone but a guest', () => {
    expect(say({}, 'ko')).toContain('Settings › Usage ("설정 › 사용량")')
  })

  test('the app: web, phone (Settings under Me; Admin there for staff), desktop with and without the browser, Slack, a scheduled run', () => {
    expect(say({ app: 'web' })).toContain('App: Trina AX in a web browser.')
    const phone = say({ app: 'mobile' }, 'ko')
    expect(phone).toContain('App: the Trina AX phone app. There Settings ("설정") is the Me tab ("나") at the bottom: its list has the same pages.')
    expect(say({ app: 'mobile' })).toContain('There Settings is the Me tab at the bottom')
    expect(phone).not.toContain('Admin is in that list')
    expect(say({ app: 'mobile', role: 'admin' })).toContain('and Admin is in that list too')
    const desktop = say({ app: 'desktop' })
    expect(desktop).toContain('desktop app, but its browser is not connected to this answer: if they need a website')
    // no web reading in this chat: no web tools named
    expect(say({ app: 'desktop', web: false })).not.toContain('web tools')
    expect(say({ app: 'desktop-browser' })).toContain('desktop app, with its browser next to the chat')
    const slack = say({ app: 'slack' })
    expect(slack).toContain('they asked from Slack')
    expect(slack).toContain('give the team path of any file you save, next to its link')
    expect(say({ app: 'schedule' })).toContain('scheduled task\'s run; nobody is watching')
    // nobody can answer a card in Slack or a scheduled run: none is offered there
    for (const app of ['slack', 'schedule'] as const) expect(say({ app })).not.toContain('card in this chat')
    expect(say({ app: 'web' })).toContain('or connect one with a card in this chat')
    expect(say({ app: null })).not.toContain('App:')
  })

  test('the team\'s plan: to the owner and admins only (a trial team)', () => {
    const plan = { name: 'Trial', people: 5, guests: 10 }
    const owner = say({ role: 'owner', plan })
    expect(owner).toContain('Team plan: Trial (up to 5 active people including the owner, and 10 guests); Admin › System shows it.')
    // situationOf never gives a member the plan; the section leaves it out when there is none
    expect(say({ role: 'member' })).not.toContain('Team plan')
    // a plan file without a display name: the caps, never the plan's id
    expect(say({ role: 'owner', plan: { name: null, people: 15, guests: 3 } })).toContain('Team plan: up to 15 active people including the owner, and 3 guests; Admin › System')
  })

  test('a guest: only the app line (what a guest can do is the guest part\'s), nothing about Admin, AI accounts or plans', () => {
    const t = say({ role: 'guest', guest: true, app: 'mobile', plan: { name: 'Trial', people: 5, guests: 10 } })
    expect(t).toContain('App: the Trina AX phone app.')
    for (const no of ['Admin', 'Settings', 'AI providers', 'Usage', 'Connectors', 'Team plan', 'Role:']) expect(t).not.toContain(no)
    expect(say({ role: 'guest', guest: true, app: null })).toBe('')
    expect(say({ role: 'guest', guest: true, app: 'desktop' })).toContain('App: the Trina AX desktop app.')
    for (const app of ['web', 'desktop', 'desktop-browser'] as const) {
      const g = say({ role: 'guest', guest: true, app, web: false })
      for (const no of ['Admin', 'Settings', 'AI providers', 'web tools', 'Role:']) expect(g).not.toContain(no)
      if (app !== 'web') expect(g).not.toContain('browser')
    }
  })

  // QA TC-5570: on a free-roam demo the block sent visitors to Settings › Usage and Settings › Profile › Delete account
  // over the demo's own rule (prompt.ts demoRule); it names no page the demo fences (demo/guard.ts) or hides (web
  // lib/freeRoam.ts FREE_ROAM_HIDDEN_SETTINGS, FREE_ROAM_HIDDEN_PAGES)
  test('a free-roam demo: no fenced or hidden page named, for every role, app and locale; a normal install unchanged', () => {
    const plan = { name: 'Trial', people: 5, guests: 10 }
    const fencedEn = ['Settings › Usage', 'Delete account', 'AI providers', 'Settings › Connectors', 'card in this chat', 'Settings › Security',
      'Settings › Apps', 'Settings › AI apps', 'Admin ›', 'Transfer ownership', 'Team plan', 'They can open Admin', 'Admin is in that list', 'Connected folders']
    for (const L of LOCALES) {
      for (const role of ['owner', 'admin', 'member'] as const) {
        for (const app of ['web', 'mobile', 'desktop', 'desktop-browser'] as const) {
          for (const ai of ['own', 'team', 'host', null] as const) {
            const t = say({ freeRoam: true, role, app, ai, plan: role === 'member' ? null : plan, connectedFolders: false }, L)
            expect(t).toContain('## About this person and place')
            expect(t).toContain('not in the demo: never send them to an Admin page')
            for (const no of [SCREEN.usage(L), SCREEN.deleteAccount(L), SCREEN.ownProviders(L), SCREEN.adminProviders(L), SCREEN.connectors(L), SCREEN.handover(L),
              SCREEN.adminSystem(L), SCREEN.adminSettings(L), SCREEN.connectedFolders(L)]) expect(t).not.toContain(no)
            if (L === 'en') for (const no of fencedEn) expect(t).not.toContain(no)
            // what the demo has stays: their own Settings, and a file's earlier versions
            expect(t).toContain('Their own things are in Settings')
            // the name and e-mail are the demo's (QA TC-5745): said, and no page named for them
            expect(t).toContain('their name and e-mail address stay as they are in this demo')
            expect(t).toContain('earlier versions are in')
          }
        }
      }
    }
    // the same states on a normal install still name every page (Usage and Delete account above all)
    const owner = say({ role: 'owner', plan, connectedFolders: true })
    for (const yes of ['Settings › Usage', 'Settings › Profile › Delete account', 'Transfer ownership', 'They can open Admin', 'Admin › AI providers', 'Team plan', 'Admin › System › Connected folders']) expect(owner).toContain(yes)
    const member = say({ role: 'member' })
    for (const yes of ['Settings › Usage', 'Settings › Profile › Delete account', 'Settings › AI providers', 'Settings › Connectors', 'card in this chat']) expect(member).toContain(yes)
    expect(say({ freeRoam: false, role: 'member' })).toBe(member)
  })

  test('appOf: the session\'s client, the desktop browser first', () => {
    expect(appOf('desktop', true)).toBe('desktop-browser')
    expect(appOf('desktop', false)).toBe('desktop')
    expect(appOf('mobile', false)).toBe('mobile')
    expect(appOf('slack', false)).toBe('slack')
    expect(appOf('schedule', false)).toBe('schedule')
    expect(appOf(null, false)).toBeNull()
    expect(appOf('something', false)).toBeNull()
  })
})

describe('where the server runs', () => {
  test('hosted: in the cloud, never "in the office"; office: a Mac in the office; own server', () => {
    expect(environmentSection('hosted')).toContain(serverWhere('hosted'))
    expect(environmentSection('hosted')).toContain('in the cloud')
    expect(environmentSection('hosted')).not.toContain('office')
    expect(environmentSection('office')).toContain('a Mac in the team\'s office')
    expect(environmentSection('selfhost')).toContain('a computer the team runs itself')
    expect(ENVIRONMENT).toBe(environmentSection('selfhost'))
    for (const k of ['hosted', 'office', 'selfhost', 'dev'] as const) expect(environmentSection(k)).toContain('NOT on the user\'s computer')
    // no "server" for the AI to repeat: "I'd do more on the team's server" reached a member (ADM-07.member, 2026-11-17)
    for (const k of ['hosted', 'office', 'selfhost', 'dev'] as const) for (const sub of [false, true]) expect(environmentSection(k, sub)).not.toMatch(/\bservers?\b/i)
    expect(GUEST_ENVIRONMENT).not.toMatch(/\bservers?\b/i)
  })
})

describe('built from real state', () => {
  let h: Harness
  let alice: TestSocket, dana: TestSocket
  beforeAll(async () => {
    h = await startHarness({ name: 'ai-situation' })
    alice = await h.ws('alice', { windowId: 'win-alice-sit' })
    dana = await h.ws('dana', { windowId: 'win-dana-sit', client: 'mobile' })
    await alice.next('hello'); await dana.next('hello')
  })
  afterAll(async () => { setPlanForTests(undefined); await h.close() })
  const of = (userId: string, role: 'owner' | 'admin' | 'member', extra: { engine?: string; managed?: boolean; turnManaged?: boolean } = {}) =>
    situationOf({ db: h.ctx.db, config: { ...h.ctx.config, engine: { ...h.ctx.config.engine, authMode: extra.managed ? 'managed' : 'local-login' } } as never },
      { userId, role, clientKind: 'web', browser: false, engine: extra.engine ?? 'claude-code', locale: 'en', ...(extra.turnManaged !== undefined ? { managed: extra.turnManaged } : {}) })
  const setting = (key: string, value: unknown) => h.ctx.db.query('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))

  test('the switches an admin turns: own AI sign-ins and own connected services', () => {
    expect(of('alice', 'member').ownAi).toBe(true)
    setting('credentials.memberOwn', false)
    try { expect(of('alice', 'member').ownAi).toBe(false) } finally { setting('credentials.memberOwn', true) }
    expect(of('alice', 'member').ownConnectors).toBe(true)
    setting('personalIntegrations', false)
    try { expect(of('alice', 'member').ownConnectors).toBe(false) } finally { setting('personalIntegrations', true) }
  })

  test('the turn decides whether its engine runs on AI connections: Codex on an installed local-login server does, a dev-mode one does not', () => {
    // engine.authMode local-login, but the turn's Codex runs behind the model proxy (chat/engines.ts mode prod)
    expect(of('alice', 'member', { engine: 'codex', turnManaged: true }).ai).not.toBe('host')
    // engine.authMode managed, but the turn's engine signs in on its own
    expect(of('alice', 'member', { engine: 'codex', managed: true, turnManaged: false }).ai).toBe('host')
  })

  test('whose AI: the server\'s own sign-in without AI connections, the team\'s connection, nothing once that is gone, the API key', () => {
    expect(of('alice', 'member').ai).toBe('host')
    // the harness team has a team-wide AI connection
    expect(of('alice', 'member', { managed: true }).ai).toBe('team')
    const rows = h.ctx.db.query('SELECT id, disabled FROM engine_credentials').all() as { id: string; disabled: number }[]
    h.ctx.db.query('UPDATE engine_credentials SET disabled = 1').run()
    try { expect(of('alice', 'member', { managed: true }).ai).toBeNull() } finally { for (const r of rows) h.ctx.db.query('UPDATE engine_credentials SET disabled = ? WHERE id = ?').run(r.disabled, r.id) }
    expect(of('alice', 'member', { managed: true, engine: 'api' }).ai).toBe('team')
  })

  test('the plan only for the owner and admins', () => {
    setPlanForTests({ format: 1, plan: 'trial', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 20, reserveMiB: 768, turnMemoryMaxMiB: null, turnPidsMax: 256, turnDiskMaxMiB: 1024, readMaxMiB: 200, convMemoryMaxMiB: null, localBackupRetentionDays: 14, maxActiveMembers: 5, display: { name: { ko: '체험', en: 'Trial', id: 'Uji coba', ja: 'トライアル', es: 'Prueba', zh: '试用' } }, links: null, maxGuests: 10 } as never)
    try {
      expect(of('dana', 'owner').plan).toEqual({ name: 'Trial', people: 5, guests: 10 })
      expect(of('carol', 'admin').plan?.name).toBe('Trial')
      expect(of('alice', 'member').plan).toBeNull()
    } finally { setPlanForTests(undefined) }
  })

  test('a free-roam demo instance is told apart from a normal install (app-config.ts isFreeRoam)', () => {
    const cfg = (demo: unknown) => ({ ...h.ctx.config, demo } as never)
    const p = { userId: 'alice', role: 'member' as const, clientKind: 'web', browser: false, engine: 'claude-code', locale: 'en' as const }
    const demo = situationOf({ db: h.ctx.db, config: cfg({ kind: 'freeRoam', company: 'Steepling' }) }, p)
    expect(demo.freeRoam).toBe(true)
    expect(situationSection(demo, 'en')).not.toContain('Settings › Usage')
    for (const other of [null, { kind: 'scripted', company: 'Steepling' }]) {
      const normal = situationOf({ db: h.ctx.db, config: cfg(other) }, p)
      expect(normal.freeRoam).toBeUndefined()
      expect(situationSection(normal, 'en')).toContain('Settings › Usage')
    }
  })

  test('a real turn: a member on the web gets the member block; the owner on the phone gets hers', async () => {
    const fake = (d: unknown) => '@fake ' + JSON.stringify(d)
    const a = await h.api('alice').call(API.createChat, { body: {} })
    const s = (await ask(h, alice, 'alice', a.id, fake({ echo: 'system' }))).done.content
    expect(s).toContain('## About this person and place')
    expect(s).toContain('Role: a member. They cannot open Admin')
    expect(s).toContain('App: Trina AX in a web browser.')
    expect(s).toContain('a computer the team runs itself')
    expect(s).not.toContain('a computer in the office')
    const d = await h.api('dana', { client: 'mobile' }).call(API.createChat, { body: {} })
    const t = (await ask(h, dana, 'dana', d.id, fake({ echo: 'system' }), { client: 'mobile' })).done.content
    expect(t).toContain('Role: the team\'s owner. They can open Admin')
    expect(t).toContain('App: the Trina AX phone app.')
    expect(t).toContain('and Admin is in that list too')
    // a resumed session gets it in front of the message too
    const m = (await ask(h, dana, 'dana', d.id, fake({ echo: 'message' }), { client: 'mobile' })).done.content
    expect(m).toContain('Role: the team\'s owner.')
  })

  test('a shared chat carries the block as the person\'s own chat does (docs/decisions/20261126-shared-chat-everything.md)', () => {
    const input: PromptInput = {
      user: h.ctx.files.principal('alice'), groupNames: [], locale: 'en', timeZone: 'UTC', memories: [], project: null, browser: false, tools: [], history: null,
      situation: { ...base }, shared: { project: 'Atlas', audience: 3, asker: 'Alice Kim' },
    }
    expect(buildTurnPrompt(h.ctx.files, input)).toContain('About this person and place')
    expect(buildTurnContext(h.ctx.files, input).includes('About this person and place')).toBe(buildTurnContext(h.ctx.files, { ...input, shared: null }).includes('About this person and place'))
    expect(buildTurnPrompt(h.ctx.files, { ...input, shared: null })).toContain('About this person and place')
  })

  test('where things are in the app (chat/app-map.ts): in the first instructions, never for a guest, never in the per-turn context', () => {
    const input: PromptInput = {
      user: h.ctx.files.principal('alice'), groupNames: [], locale: 'en', timeZone: 'UTC', memories: [], project: null, browser: false, tools: [], history: null,
      appMap: { view: 'member', managed: false, devEnv: false, office: false },
    }
    expect(buildTurnPrompt(h.ctx.files, input)).toContain('## Where things are in the app')
    expect(buildTurnContext(h.ctx.files, input)).not.toContain('Where things are in the app')
    expect(buildTurnPrompt(h.ctx.files, { ...input, guest: { places: [], inviter: null } })).not.toContain('Where things are in the app')
  })
})
