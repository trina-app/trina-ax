// The Slack channel relay (plan docs/AGENTS/plan/20261127-0329-slack-channel-relay.md, step 7), 1440 and 390 wide: the
// room's ⋯ › Add an app › Slack opens one panel; the channels both I and the app are in, the sentence of who sees what,
// Connect; then the status, the header chip "#client-acme · Slack" (the mark only on a phone) that opens it again, the
// composer's "(also sent to Slack)", and a relayed message as its Slack name and plain words. The room is answered
// through page.route (rooms-mock.ts), its Slack link here.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'
import { routeRoomApps } from './room-apps-mock'

test.use({ serviceWorkers: 'block', locale: 'en-US' })

const SIZES = [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }] as const
const MINA = { id: 'mina', name: 'Mina' }

async function routeSlack(page: Page) {
  const state = { link: null as Record<string, unknown> | null, posted: [] as unknown[] }
  const status = () => ({ link: state.link, meLinked: true, signIn: true, botName: 'trina', needsReAdd: false })
  await page.route(new RegExp(`/api/rooms/${ROOM_ID}/slack(/|$)`), async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const json = (body: unknown, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(body) })
    if (path.endsWith('/slack/channels')) {
      return json({ items: [
        { id: 'C0ACME01', name: 'client-acme', private: false, extShared: false, taken: false },
        { id: 'C0ACME02', name: 'partners', private: false, extShared: true, taken: false },
        { id: 'C0ACME04', name: 'general', private: false, extShared: false, taken: true },
      ] })
    }
    if (req.method() === 'POST') {
      state.posted.push(req.postDataJSON())
      state.link = { appId: 'app-slack', channelId: 'C0ACME01', channelName: 'client-acme', private: false, extShared: false, state: 'active', createdBy: { id: 'olga', name: 'Olga' }, createdAt: new Date().toISOString(), customName: true }
      return json(status(), 201)
    }
    return json(status())
  })
  return state
}

for (const vp of SIZES) {
  test(`connect a Slack channel from Add an app (${vp.name})`, async ({ page }) => {
    await page.setViewportSize(vp.size)
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await routeRoom(page, {
      kind: 'team', members: [MINA], room: { name: 'dev' },
      messages: [{ id: '019a5f00-0000-7000-8000-00000000d001', author: MINA, body: '', extra: { author: null, app: { id: 'app-slack', name: 'Slack', kind: 'other', preset: 'slack' }, body: 'Ann Lee: \\*\\*Ship it\\*\\* today', slackAuthor: { name: 'Ann Lee', external: true } } }],
    })
    await routeRoomApps(page, { apps: [] })
    const slack = await routeSlack(page)
    await signIn(page)
    await page.goto(`/rooms/${ROOM_ID}`)
    await expect(page.getByTestId('room-messages')).toBeVisible()
    // a relayed message: the Slack name, External, plain words (no Markdown)
    await expect(page.getByTestId('slack-sender-name')).toHaveText('Ann Lee')
    await expect(page.getByTestId('slack-external')).toBeVisible()
    await expect(page.getByTestId('slack-text')).toHaveText('**Ship it** today')
    await expect(page.getByTestId('room-slack-chip')).toHaveCount(0)

    await page.getByTestId('room-menu').first().click()
    await page.getByTestId('room-menu-apps').click()
    await expect(page.getByTestId('apps-pick-slack')).toContainText('Connect a Slack channel')
    await page.getByTestId('apps-pick-slack').click()
    await expect(page.getByTestId('apps-title')).toHaveText('Connect a Slack channel')
    await expect(page.getByTestId('slack-relay-channel')).toHaveCount(3)
    await expect(page.getByTestId('slack-relay-channel-C0ACME04')).toBeDisabled()
    await expect(page.getByTestId('slack-relay-connect')).toBeDisabled()
    await page.getByTestId('slack-relay-channel-C0ACME02').check()
    await expect(page.getByTestId('slack-relay-who')).toContainText('It is shared with another organization.')
    await page.getByTestId('slack-relay-channel-C0ACME01').check()
    await expect(page.getByTestId('slack-relay-who')).not.toContainText('another organization')
    await page.getByTestId('slack-relay-connect').click()
    await expect(page.getByTestId('slack-relay-linked')).toBeVisible()
    expect(slack.posted).toEqual([{ channelId: 'C0ACME01' }])
    await expect(page.getByTestId('slack-relay-state')).toHaveText('Messages go both ways.')
    await expect(page.getByTestId('slack-relay-disconnect')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    // the chip and the composer's words
    const chip = page.getByTestId('room-slack-chip')
    await expect(chip).toBeVisible()
    if (vp.name === '1440') await expect(chip).toHaveText('#client-acme · Slack')
    await expect(page.getByTestId('room-input')).toHaveAttribute('placeholder', 'Message #client-acme (also sent to Slack)')
    const box = await page.getByTestId('room-header').boundingBox()
    expect(box!.width).toBeLessThanOrEqual(vp.size.width)
    await chip.click()
    await expect(page.getByTestId('slack-relay-linked')).toBeVisible()
  })
}
