// The numbered steps of the presets' guides (plan docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md "Guide per
// preset"): Notion, Typeform, Tally, Jotform, Stripe, Shopify, Zendesk, Jira, HubSpot, Toss Payments, Channel Talk and
// PortOne, written with each service's own screen labels
// (roomApps.vendorLabel.*, checked against the live services in QA TC-1634). What is ticked in the service shows as
// chips in its step (Stripe), a body to paste has its Copy inside the step where it is pasted (Zendesk), and optional
// steps say so (Shopify's other events, Zendesk's second trigger). Other app's "Don't see your app?" with the Zapier and
// Make how-tos is here too. The Webhook URL and its Copy stay at the top of the guide (AppsDialog).
import { roomAppJiraBody, roomAppZendeskBody, type RoomApp } from '@mycel/shared/api'
import { useT } from '../../../i18n'
import { FORM_SERVICES, HUBSPOT_ROWS, MAKE_BODY, STRIPE_EVENTS, switchesOf, TOSS_EVENTS, type RoomAppPresetId } from '../../../lib/roomApps'
import { Chips, CopyBody, Fold, Step, useVendor } from './GuideParts'

export function PresetSteps({ preset, app }: { preset: RoomAppPresetId; app: RoomApp | null }) {
  const t = useT()
  const v = useVendor()
  const on = (key: string, def: boolean) => app?.events[key] ?? def
  const answers = FORM_SERVICES.includes(preset) && <p className="text-xs text-muted" data-testid="apps-forms-answers">{t('roomApps.formsAnswers')}</p>
  switch (preset) {
    case 'notion': return <>
      <Step n={1}><p>{t('roomApps.notion1', { automations: v('notionAutomations'), new: v('notionNew') })}</p></Step>
      <Step n={2}><p>{t('roomApps.notion2', { trigger: v('notionTrigger') })}</p></Step>
      <Step n={3}><p>{t('roomApps.notion3', { add: v('notionAdd'), send: v('notionSend') })}</p></Step>
      <Step n={4}><p>{t('roomApps.notion4', { create: v('notionCreate') })}</p></Step>
    </>
    case 'typeform': return <>
      <Step n={1}><p>{t('roomApps.typeform1', { path: v('typeformPath'), add: v('typeformAdd') })}</p></Step>
      <Step n={2}><p>{t('roomApps.typeform2', { save: v('typeformSave') })}</p></Step>
      <Step n={3}><p>{t('roomApps.typeform3')}</p>{answers}</Step>
    </>
    case 'tally': return <>
      <Step n={1}><p>{t('roomApps.tally1', { path: v('tallyPath'), connect: v('tallyConnect') })}</p></Step>
      <Step n={2}><p>{t('roomApps.tally2', { url: v('tallyUrl') })}</p></Step>
      <Step n={3}><p>{t('roomApps.tally3', { connect: v('tallyConnect') })}</p>{answers}</Step>
    </>
    case 'jotform': return <>
      <Step n={1}><p>{t('roomApps.jotform1', { path: v('jotformPath'), hooks: v('jotformHooks') })}</p></Step>
      <Step n={2}><p>{t('roomApps.jotform2', { complete: v('jotformComplete'), finish: v('jotformFinish') })}</p>{answers}</Step>
    </>
    case 'stripe': {
      // the events of the switches that are on: what Trina would show anyway
      const events = switchesOf('stripe').filter((s) => on(s.key, s.on)).flatMap((s) => STRIPE_EVENTS[s.key] ?? [])
      return <>
        <Step n={1}><p>{t('roomApps.stripe1', { path: v('stripePath'), create: v('stripeCreate') })}</p></Step>
        <Step n={2}>
          <p>{t('roomApps.stripe2', { continue: v('stripeContinue'), endpoint: v('stripeEndpoint') })}</p>
          <Chips items={events} testId="apps-stripe-events" />
        </Step>
        <Step n={3}><p>{t('roomApps.stripe3', { url: v('stripeUrl'), create: v('stripeCreateDest') })}</p></Step>
      </>
    }
    case 'shopify': return <>
      <Step n={1}><p>{t('roomApps.shopify1', { path: v('shopifyPath'), create: v('shopifyCreate') })}</p></Step>
      <Step n={2}><p>{t('roomApps.shopify2', { event: v('shopifyOrder'), json: v('shopifyJson'), save: v('shopifySave') })}</p></Step>
      <Step n={3} optional><p>{t('roomApps.shopify3', { paid: v('shopifyPaid'), cancelled: v('shopifyCancelled'), refund: v('shopifyRefund') })}</p></Step>
    </>
    case 'zendesk': return <>
      <Step n={1}><p>{t('roomApps.zendesk1', { path: v('zendeskPath'), create: v('zendeskCreate'), trigger: v('zendeskTrigger'), next: v('zendeskNext') })}</p></Step>
      <Step n={2}><p>{t('roomApps.zendesk2', { url: v('zendeskUrl'), method: v('zendeskMethod'), format: v('zendeskFormat'), create: v('zendeskCreate') })}</p></Step>
      <Step n={3}>
        <p>{t('roomApps.zendesk3', { triggers: v('zendeskTriggers'), createTrigger: v('zendeskCreateTrigger'), created: v('zendeskCreated'), notify: v('zendeskNotify'), body: v('zendeskBody'), save: v('zendeskSave') })}</p>
        <CopyBody body={roomAppZendeskBody('created')} testId="apps-copy-body" />
        <p className="text-xs text-muted">{t('roomApps.zendeskBodyNote')}</p>
      </Step>
      <Step n={4} optional>
        <p>{t('roomApps.zendesk4', { updated: v('zendeskUpdated') })}</p>
        {/* its own body: "event":"updated" tells Trina which trigger sent it */}
        <CopyBody body={roomAppZendeskBody('updated')} testId="apps-copy-body-updated" />
      </Step>
    </>
    case 'jira': return <>
      <Step n={1}><p>{t('roomApps.jira1', { settings: v('jiraSettings'), automation: v('jiraAutomation'), create: v('jiraCreate') })}</p></Step>
      <Step n={2}><p>{t('roomApps.jira2', { created: v('jiraCreated') })}</p></Step>
      <Step n={3}>
        <p>{t('roomApps.jira3', { send: v('jiraSend'), url: v('jiraUrl'), method: v('jiraMethod'), body: v('jiraBody'), custom: v('jiraCustom') })}</p>
        <CopyBody body={roomAppJiraBody('created')} testId="apps-copy-body" />
        <p className="text-xs text-muted">{t('roomApps.zendeskBodyNote')}</p>
      </Step>
      <Step n={4}><p>{t('roomApps.jira4', { turnOn: v('jiraTurnOn') })}</p></Step>
      <Step n={5} optional>
        <p>{t('roomApps.jira5', { transitioned: v('jiraTransitioned') })}</p>
        <CopyBody body={roomAppJiraBody('transitioned')} testId="apps-copy-body-transitioned" />
      </Step>
      <Step n={6} optional>
        <p>{t('roomApps.jira6', { commented: v('jiraCommented') })}</p>
        <CopyBody body={roomAppJiraBody('commented')} testId="apps-copy-body-commented" />
      </Step>
    </>
    case 'hubspot': return <>
      <Step n={1}><p>{t('roomApps.hubspot1', { path: v('hubspotPath'), create: v('hubspotCreate'), deal: v('hubspotDealBased') })}</p></Step>
      <Step n={2}><p>{t('roomApps.hubspot2', { dataOps: v('hubspotDataOps'), send: v('hubspotSend'), method: v('hubspotMethod'), url: v('hubspotUrl') })}</p></Step>
      <Step n={3}>
        <p>{t('roomApps.hubspot3', { customize: v('hubspotCustomize') })}</p>
        <KeyRows rows={HUBSPOT_ROWS.deal} testId="apps-hubspot-deal" />
        <p className="text-xs text-muted">{t('roomApps.hubspotPrivacy')}</p>
      </Step>
      <Step n={4}><p>{t('roomApps.hubspot4', { turnOn: v('hubspotTurnOn') })}</p></Step>
      <Step n={5} optional>
        <p>{t('roomApps.hubspot5', { contact: v('hubspotContactBased') })}</p>
        <KeyRows rows={HUBSPOT_ROWS.contact} testId="apps-hubspot-contact" />
      </Step>
      <Step n={6} optional>
        <p>{t('roomApps.hubspot6', { ticket: v('hubspotTicketBased') })}</p>
        <KeyRows rows={HUBSPOT_ROWS.ticket} testId="apps-hubspot-ticket" />
      </Step>
    </>
    case 'toss_payments': return <>
      <Step n={1}><p>{t('roomApps.toss1', { path: v('tossPath'), add: v('tossAdd') })}</p></Step>
      <Step n={2}>
        <p>{t('roomApps.toss2', { url: v('tossUrl') })}</p>
        <Chips items={TOSS_EVENTS} testId="apps-toss-events" />
      </Step>
      <Step n={3}><p>{t('roomApps.toss3', { save: v('tossSave') })}</p></Step>
    </>
    case 'channel_talk': return <>
      <Step n={1}><p>{t('roomApps.channel1', { path: v('channelPath'), create: v('channelCreate') })}</p></Step>
      <Step n={2}>
        <p>{t('roomApps.channel2', { url: v('channelUrl'), types: v('channelTypes') })}</p>
        {/* Channel Talk's one option for customer chats (their messages come with it; group chats are a separate option, left off) */}
        <Chips items={[t('roomApps.vendorLabel.channelTypeChat')]} testId="apps-channel-types" />
      </Step>
      <Step n={3}><p>{t('roomApps.channel3', { save: v('channelSave') })}</p></Step>
    </>
    case 'portone': return <>
      <Step n={1}><p>{t('roomApps.portone1', { path: v('portonePath') })}</p></Step>
      <Step n={2}><p>{t('roomApps.portone2', { version: v('portoneVersion'), url: v('portoneUrl'), save: v('portoneSave') })}</p></Step>
      <Step n={3}><p>{t('roomApps.portone3', { test: v('portoneTest') })}</p></Step>
    </>
  }
}

/** HubSpot's "Customize request body" rows: the key to type on the left, the property (or the static value) on the
 * right. */
function KeyRows({ rows, testId }: { rows: readonly (readonly [string, string, 'static' | 'property'])[]; testId: string }) {
  const t = useT()
  const v = useVendor()
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid={testId}>
      {rows.map(([k, f, how]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-code-sm text-ink">{k}</dt>
          <dd className="min-w-0 text-muted">{how === 'static' ? t('roomApps.hubspotStatic', { value: f, add: v('hubspotAddStatic') }) : v(f)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Other app's "Don't see your app?": a field for a Slack, Discord or JANDI webhook URL takes this one; neither: Zapier
 * or Make, each with one worked example (a Google Calendar event), Make's body with its Copy in its step. */
export function DontSeeYourApp() {
  const t = useT()
  const v = useVendor()
  return (
    <div className="space-y-2 rounded-lg border border-line p-3 text-sm" data-testid="apps-dont-see">
      <p className="font-medium text-ink">{t('roomApps.dontSee')}</p>
      <ul className="list-disc space-y-1 pl-5 text-ink">
        <li>{t('roomApps.dontSeeField')}</li>
        <li>{t('roomApps.dontSeeNeither')}</li>
      </ul>
      <Fold summary={t('roomApps.zapierTitle')} testId="apps-zapier">
        <p className="text-xs text-muted" data-testid="apps-zapier-needs">{t('roomApps.needs.zapier')}</p>
        <p className="text-muted">{t('roomApps.howtoExample')}</p>
        <ol className="space-y-3">
          <Step n={1}><p>{t('roomApps.zapier1', { app: v('zapierCalendar'), event: v('zapierNewEvent') })}</p></Step>
          <Step n={2}><p>{t('roomApps.zapier2', { hooks: v('zapierHooks'), post: v('zapierPost'), url: v('zapierUrl'), payload: v('zapierPayload'), json: v('zapierJson') })}</p></Step>
          <Step n={3}>
            <p>{t('roomApps.zapier3', { data: v('zapierData') })}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="apps-zapier-rows">
              {([['title', v('zapierSummary')], ['text', `${v('zapierStart')} ${v('zapierLocation')}`], ['link', v('zapierLink')], ['thread', v('zapierId')]] as const).map(([k, f]) => (
                <div key={k} className="contents">
                  <dt className="font-mono text-code-sm text-ink">{k}</dt>
                  <dd className="min-w-0 text-muted">{f}</dd>
                </div>
              ))}
            </dl>
          </Step>
          <Step n={4}><p>{t('roomApps.zapier4', { test: v('zapierTest'), publish: v('zapierPublish') })}</p></Step>
        </ol>
      </Fold>
      <Fold summary={t('roomApps.makeTitle')} testId="apps-make">
        <p className="text-muted">{t('roomApps.howtoExample')}</p>
        <ol className="space-y-3">
          <Step n={1}><p>{t('roomApps.make1', { app: v('makeCalendar'), watch: v('makeWatch') })}</p></Step>
          <Step n={2}><p>{t('roomApps.make2', { http: v('makeHttp'), request: v('makeRequest'), url: v('makeUrl'), method: v('makeMethod'), type: v('makeType'), json: v('makeJson') })}</p></Step>
          <Step n={3}>
            <p>{t('roomApps.make3', { input: v('makeInput'), jsonString: v('makeJsonString'), content: v('makeContent') })}</p>
            <CopyBody body={MAKE_BODY} testId="apps-copy-make-body" />
          </Step>
          <Step n={4}><p>{t('roomApps.make4', { run: v('makeRun') })}</p></Step>
        </ol>
      </Fold>
    </div>
  )
}
