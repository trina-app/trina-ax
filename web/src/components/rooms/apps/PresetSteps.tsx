// The numbered steps of the presets' guides (plan docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md "Guide per
// preset"): Notion, Typeform, Tally, Jotform, Stripe, Shopify and Zendesk, written with each service's own screen labels
// (roomApps.vendorLabel.*, checked against the live services in QA TC-1634). What is ticked in the service shows as
// chips in its step (Stripe), a body to paste has its Copy inside the step where it is pasted (Zendesk), and optional
// steps say so (Shopify's other events, Zendesk's second trigger). Other app's "Don't see your app?" with the Zapier and
// Make how-tos is here too. The Webhook URL and its Copy stay at the top of the guide (AppsDialog).
import { roomAppZendeskBody, type RoomApp } from '@mycel/shared/api'
import { useT } from '../../../i18n'
import { FORM_SERVICES, MAKE_BODY, STRIPE_EVENTS, switchesOf, type RoomAppPresetId } from '../../../lib/roomApps'
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
  }
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
