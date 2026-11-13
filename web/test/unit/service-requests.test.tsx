// A member asks an admin to add an app the team has not set up (components/integrations/AskAdmin.tsx, the Google app's
// page, components/settings/Notifications.tsx): the button in place of the Connect that cannot work and of the "not set
// up" line, what it says after the tap and when opened again, and the two inbox notices: an admin's ("Alice and 2 others
// asked to add Gmail", which opens the app's setup while it waits) and the member's ("Gmail is ready"), which never name
// an admin.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { InboxNotification, uuidv7, type GoogleAppId, type GoogleAppView } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { noticeLink, noticeText, serviceSetupLink } from '../../src/components/settings/Notifications'
import { GoogleAppDetail, type AskProps, type GoogleAppsState } from '../../src/components/integrations/GoogleAppConnector'
import { askable, AskAdminAction, ListedAsk, type ServiceAsks } from '../../src/components/integrations/AskAdmin'
import { MemberAsks } from '../../src/components/integrations/MemberAsks'
import { GOOGLE_APP_IDS, MOCK_GOOGLE_TOOLS } from '../mock/googleApps'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const notice = (o: Partial<InboxNotification>) => InboxNotification.parse({
  id: uuidv7(), eventType: 'service.request', sourceId: 'gmail', code: 'service.request', createdAt: '2026-11-11T01:00:00.000Z', readAt: null, chatId: null, link: null, outcome: null, ...o,
})
const text = (item: InboxNotification, t = en, locale: 'en' | 'ko' = 'en') => renderToStaticMarkup(<>{noticeText(item, t, locale)}</>)

describe('the notices', () => {
  test('an admin\'s: the newest asker and how many others; someone unnamed; the app only for a former admin', () => {
    expect(text(notice({ serviceRequest: { service: 'gmail', name: 'Alice Kim', others: 0, open: true } }))).toBe('Alice Kim asked to add Gmail')
    expect(text(notice({ serviceRequest: { service: 'gmail', name: 'Erin Yoo', others: 2, open: true } }))).toBe('Erin Yoo and 2 others asked to add Gmail')
    expect(text(notice({ serviceRequest: { service: 'calendar', name: 'Erin Yoo', others: 1, open: true } }))).toBe('Erin Yoo and 1 other asked to add Google Calendar')
    expect(text(notice({ serviceRequest: { service: 'google-drive', name: 'Erin Yoo', others: 2, open: true } }), ko, 'ko')).toBe('Erin Yoo님 외 2명이 Google Drive 추가를 요청했어요')
    expect(text(notice({ serviceRequest: { service: 'docs' } }))).toBe('A member asked to add Google Docs')
    // an older server, or a row the page cannot read: the plain line
    expect(text(notice({}))).toBe(en('notifications.event.service.request'))
  })
  test('the member\'s: the app is ready; it names nobody', () => {
    const ready = notice({ eventType: 'service.ready', code: 'service.ready', sourceId: uuidv7(), serviceRequest: { service: 'sheets' } })
    expect(text(ready)).toBe('Google Sheets is ready. You can connect it now.')
    expect(text(notice({ eventType: 'service.ready', code: 'service.ready', sourceId: uuidv7() }))).toBe(en('notifications.event.service.ready'))
  })
  test('where they open: the app\'s setup while a request waits, nothing once it ended; the member\'s app page', () => {
    expect(noticeLink(notice({ serviceRequest: { service: 'gmail', name: 'A', others: 0, open: true } }))).toEqual({ to: '/admin/connectors?app=gmail', testId: 'notification-service-request-link' })
    expect(noticeLink(notice({ sourceId: 'google-drive', serviceRequest: { service: 'google-drive', name: 'A', others: 0, open: true } }))).toEqual({ to: '/admin/connectors?drive=1', testId: 'notification-service-request-link' })
    expect(noticeLink(notice({ serviceRequest: { service: 'gmail', name: 'A', others: 0, open: false, added: true } }))).toBeNull()
    // a former admin's row (the app only): no way into Admin
    expect(noticeLink(notice({ serviceRequest: { service: 'gmail' } }))).toBeNull()
    expect(noticeLink(notice({ eventType: 'service.ready', code: 'service.ready', sourceId: uuidv7(), serviceRequest: { service: 'calendar' } }))).toEqual({ to: '/settings/connectors/calendar', testId: 'notification-service-ready-link' })
    for (const s of ['gmail', 'calendar', 'docs', 'sheets'] as const) expect(serviceSetupLink(s)).toBe(`/admin/connectors?app=${s}`)
  })
  test('the five built-in apps and every listed service can be asked for (QA TC-133); nothing else', () => {
    expect(['google-drive', 'gmail', 'calendar', 'docs', 'sheets', 'notion', 'linear'].map(askable)).toEqual(['google-drive', 'gmail', 'calendar', 'docs', 'sheets', 'notion', 'linear'])
    for (const id of ['slack', 'mcp', 'Notion', '']) expect(askable(id)).toBeNull()
  })
  test('a listed service: its name in both notices, and the admin\'s opens its page in Admin › Connectors', () => {
    expect(text(notice({ sourceId: 'notion', serviceRequest: { service: 'notion', name: 'Alice Kim', others: 0, open: true } }))).toBe('Alice Kim asked to add Notion')
    expect(text(notice({ eventType: 'service.ready', code: 'service.ready', sourceId: uuidv7(), serviceRequest: { service: 'linear' } }))).toBe('Linear is ready. You can connect it now.')
    expect(noticeLink(notice({ sourceId: 'notion', serviceRequest: { service: 'notion', name: 'A', others: 0, open: true } }))).toEqual({ to: '/admin/connectors/notion', testId: 'notification-service-request-link' })
    expect(serviceSetupLink('figma')).toBe('/admin/connectors/figma')
  })
})

describe('a listed service\'s page for a member (QA TC-133)', () => {
  const asks = (state: 'none' | 'sent' | 'already', error: string | null = null) => ({
    ready: true, open: state === 'none' ? 0 : 1, stateOf: () => state, ask: async () => {}, withdraw: async () => {}, busy: null, error: error ? { service: 'notion' as const, text: error } : null, reload: async () => 0,
  }) as unknown as ServiceAsks
  const listed = (a: ServiceAsks, inline: boolean) => renderToStaticMarkup(<ListedAsk asks={a} service="notion" name="Notion" inline={inline} />)
  test('one who may connect their own: Connect stays, the ask for the team\'s is a line under it', () => {
    const out = listed(asks('none'), true)
    expect(out).toContain(en('serviceRequest.teamLine', { name: 'Notion' }))
    expect(out).toContain('data-testid="service-ask"')
    expect(out).not.toContain('service-asked-note')
  })
  test('one who may not: the ask is the page\'s action; after it, when they will hear', () => {
    expect(listed(asks('none'), false)).not.toContain('service-ask"')
    const sent = listed(asks('sent'), false)
    expect(sent).toContain('data-testid="service-asked-note"')
    expect(sent).toContain(en('serviceRequest.waiting', { name: 'Notion' }).replace("'", '&#x27;'))
    expect(listed(asks('none', 'nope'), false)).toContain('nope')
  })
  test('once asked: the status with "Cancel request" to take it back', () => {
    const out = renderToStaticMarkup(<AskAdminAction state="sent" busy={false} onAsk={() => {}} onWithdraw={() => {}} />)
    expect(out).toContain(en('serviceRequest.sent'))
    expect(out).toContain('data-testid="service-withdraw"')
    expect(out).toContain(en('serviceRequest.withdraw'))
    // no withdraw offered: the status only
    expect(renderToStaticMarkup(<AskAdminAction state="already" busy={false} onAsk={() => {}} />)).not.toContain('service-withdraw')
  })
})

describe('Admin › Connectors: what members asked for', () => {
  const page = (items: { service: string; askers: { id: string; name: string }[] }[]) => renderToStaticMarkup(
    <MemberAsks asks={{ items: items.map((x) => ({ ...x, askedAt: '2026-11-12T00:00:00.000Z' })), setItems: () => {}, reload: async () => {} } as never} onAdd={() => {}} />)
  test('nothing when nobody asked; one line per service with who asked, Add and Dismiss', () => {
    expect(page([])).toBe('')
    const out = page([{ service: 'notion', askers: [{ id: 'e', name: 'Erin Yoo' }, { id: 'a', name: 'Alice Kim' }] }, { service: 'gmail', askers: [{ id: 'a', name: 'Alice Kim' }] }])
    expect(out).toContain(en('serviceRequest.admin.title'))
    expect(out).toContain('Notion')
    expect(out).toContain('Gmail')
    expect(out).toContain(en('serviceRequest.admin.more', { name: 'Erin Yoo', n: 1 }))
    expect(out).toContain(en('serviceRequest.admin.one', { name: 'Alice Kim' }))
    expect(out.split('data-testid="member-ask-add"').length - 1).toBe(2)
    expect(out.split('data-testid="member-ask-dismiss"').length - 1).toBe(2)
  })
})

describe('a Google app\'s page for a member, not set up', () => {
  const flow = { flow: null, inProgress: false, busy: false, error: false, authorizationUrl: null, start: async () => {}, cancel: async () => {}, complete: async () => {}, setError: () => {} }
  const g = (apps: GoogleAppView[]) => ({ apps, load: async () => {}, busy: null, setPolicy: async () => {}, disconnect: async () => {}, flows: Object.fromEntries(GOOGLE_APP_IDS.map((id) => [id, flow])) as unknown as Record<GoogleAppId, GoogleAppsState['flows']['gmail']> }) as unknown as GoogleAppsState
  const v: GoogleAppView = { id: 'gmail', available: false, reason: 'not_set_up', status: 'disconnected', account: null, writePolicy: 'ask', serviceDown: false, tools: MOCK_GOOGLE_TOOLS.gmail }
  const page = (ask?: AskProps) => renderToStaticMarkup(<MemoryRouter><GoogleAppDetail v={v} g={g([v])} ask={ask} /></MemoryRouter>)
  const ask = (state: AskProps['state'], error: string | null = null): AskProps => ({ state, busy: false, onAsk: () => {}, error })

  test('the button takes the place of the Connect that cannot work and of the "not set up" line', () => {
    const html = page(ask('none'))
    expect(html).toContain('data-testid="service-ask"')
    expect(html).toContain('Ask admin to add it')
    expect(html).not.toContain('data-testid="gapp-connect"')
    expect(html).not.toContain('data-testid="gapp-unavailable"')
    expect(html).not.toContain('data-testid="service-asked-note"')
    // without asking (an owner or admin, or an older server): the page as before
    const before = page()
    expect(before).toMatch(/data-testid="gapp-connect" disabled=""/)
    expect(before).toContain('data-testid="gapp-unavailable"')
    expect(before).not.toContain('data-testid="service-ask"')
  })
  test('after the tap and opened again alike "Request sent" (one word, QA final), with when they will hear; a refusal in words', () => {
    const sent = page(ask('sent'))
    expect(sent).toMatch(/data-testid="service-asked" data-state="sent"/)
    expect(sent).toContain('Request sent')
    expect(sent).not.toContain('data-testid="service-ask"')
    expect(sent).toContain("We&#x27;ll tell you when Gmail is ready.")
    const already = page(ask('already'))
    expect(already).toMatch(/data-state="already"/)
    expect(already).toContain('Request sent')
    expect(already).not.toContain('Already asked')
    expect(page(ask('none', en('serviceRequest.tooMany')))).toContain('data-testid="service-ask-error"')
  })
  test('the member\'s words are there in every language, plain, and name nobody; the button says who it goes to', () => {
    for (const [locale, d] of Object.entries(DICTS)) {
      for (const k of ['serviceRequest.ask', 'serviceRequest.sent', 'serviceRequest.waiting', 'serviceRequest.asked', 'notifications.event.service.readyNamed'] as const) {
        expect({ locale, k, set: !!d[k] }).toEqual({ locale, k, set: true })
        expect({ locale, k, jargon: /\b(MCP|OAuth|token|request id)\b/i.test(d[k]) }).toEqual({ locale, k, jargon: false })
      }
    }
    expect(en('serviceRequest.ask')).toBe('Ask admin to add it')
    expect(ko('serviceRequest.ask')).toContain('관리자')
    expect(DICTS.ja['serviceRequest.ask']).toContain('管理者')
    expect(DICTS.id['serviceRequest.ask']).toContain('admin')
  })
})
