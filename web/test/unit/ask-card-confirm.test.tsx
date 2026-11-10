// The server's yes/no cards (components/chat/AskCard.tsx): two buttons, the "no" neutral and the "yes" primary, with no
// radios, no [답하기] and no [건너뛰기]; each sends its own option's value. A server question with more choices (an
// address with "allow this site", a schedule with "and let it write") keeps its radios and [답하기], unless it says its
// three choices are buttons (`buttons`: a room's change card), which are then one row of buttons with the line under it.
import { expect, test } from 'bun:test'
import type { TurnRequest } from '@mycel/shared/api'
import AskCard from '../../src/components/chat/AskCard'
import { installDom, mount, removeDom } from './dom-host'
import { ko } from '../../src/i18n/ko'

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
const serverCard = (options: Ask['options']): Ask => ({
  kind: 'ask_user', origin: 'server', requestId: 'r1', question: 'Allow it?', multiple: false, allowText: false, options,
  details: [{ label: 'What it would change', fields: [{ name: 'File', value: 'shared/a.txt' }], text: 'hello' }],
})

for (const [which, testId, value] of [['no', 'ask-no', 'skip'], ['yes', 'ask-yes', 'allow']] as const) {
  test(`two options: [${which}] answers with its own value, no radios or skip`, async () => {
    installDom()
    const answers: unknown[] = []
    const m = await mount(<AskCard req={{ request: serverCard([{ label: 'Allow', value: 'allow' }, { label: "Don't", value: 'skip' }]) }} onAnswer={async (_id, body) => void answers.push(body)} />)
    try {
      const html = m.html()
      expect(html).not.toContain('type="radio"')
      expect(html).not.toContain('data-testid="ask-send"')
      expect(m.get('ask-card').getAttribute('data-kind')).toBe('confirm')
      expect(m.get('ask-no').textContent).toBe("Don't")
      expect(m.get('ask-yes').textContent).toBe('Allow')
      // the fields and the text as plain lines
      expect(m.get('ask-detail-fields').textContent).toContain('shared/a.txt')
      expect(m.get('ask-detail-text').textContent).toBe('hello')
      await m.click(testId)
      expect(answers).toEqual([{ kind: 'ask_user', answer: value }])
    } finally {
      await m.unmount()
      removeDom()
    }
  })
}

test('three options keep the radios and [답하기]', async () => {
  installDom()
  const m = await mount(<AskCard req={{ request: serverCard([{ label: 'Open', value: 'allow' }, { label: 'Allow this site', value: 'site' }, { label: "Don't open", value: 'deny' }]) }} onAnswer={async () => {}} />)
  try {
    const html = m.html()
    expect(html.split('type="radio"').length - 1).toBe(3)
    expect(html).toContain('data-testid="ask-send"')
    expect(m.find('ask-yes')).toBeNull()
  } finally {
    await m.unmount()
    removeDom()
  }
})

test('three choices the server marks as buttons: in the page in its order (main, secondary, quiet), shown as a row with the main one last, the line under it, no radios', async () => {
  installDom()
  const answers: unknown[] = []
  const card: Ask = { ...serverCard([{ label: '이번만 허용', value: 'allow' }, { label: '이 방에서는 항상 허용', value: 'always' }, { label: '허용 안 함', value: 'skip' }]), buttons: true, note: '내가 부를 때, 이 폴더에 새 파일을 만들 때만 적용돼요.' }
  const m = await mount(<AskCard req={{ request: card }} onAnswer={async (_id, body) => void answers.push(body)} />)
  try {
    const html = m.html()
    expect(html).not.toContain('type="radio"')
    expect(html).not.toContain('data-testid="ask-send"')
    expect(m.get('ask-card').getAttribute('data-kind')).toBe('buttons')
    const buttons = m.get('ask-choices').querySelectorAll('[data-testid="ask-choice"]')
    // the reading order (keyboard, screen reader) is the phone's: the main one first
    expect(buttons.map((b) => b.textContent)).toEqual(['이번만 허용', '이 방에서는 항상 허용', '허용 안 함'])
    expect(buttons.map((b) => b.getAttribute('data-value'))).toEqual(['allow', 'always', 'skip'])
    expect(buttons[0]!.className).toContain('bg-accent')
    expect(buttons[1]!.className).toContain('border-field-border')
    expect(buttons[2]!.className).toContain('text-muted')
    // a phone stacks them in that order; a computer shows the row reversed, [허용 안 함] … [이번만 허용]
    const row = m.get('ask-choices').className.split(' ')
    expect(row).toContain('flex-col')
    expect(row).not.toContain('flex-col-reverse')
    expect(row).toContain('sm:flex-row-reverse')
    expect(buttons.every((b) => b.className.includes('max-sm:w-full'))).toBe(true)
    expect(m.get('ask-note').textContent).toBe('내가 부를 때, 이 폴더에 새 파일을 만들 때만 적용돼요.')
    expect(m.get('ask-detail-text').textContent).toBe('hello')
    await m.click(buttons[1]!)
    expect(answers).toEqual([{ kind: 'ask_user', answer: 'always' }])
  } finally {
    await m.unmount()
    removeDom()
  }
})

test("a failed answer's reason comes after the three buttons, in the page and on screen", async () => {
  installDom()
  const card: Ask = { ...serverCard([{ label: '이번만 허용', value: 'allow' }, { label: '이 방에서는 항상 허용', value: 'always' }, { label: '허용 안 함', value: 'skip' }]), buttons: true }
  const m = await mount(<AskCard req={{ request: card }} onAnswer={async () => { throw new Error('the card closed meanwhile') }} />)
  try {
    await m.click(m.get('ask-choices').querySelectorAll('button')[0]!)
    const alert = await m.until(() => m.container.querySelector('[role="alert"]'), 'the error line')
    expect(alert.textContent).toContain('the card closed meanwhile')
    const html = m.html()
    expect(html.indexOf('role="alert"')).toBeGreaterThan(html.lastIndexOf('data-testid="ask-choice"'))
    // not inside the row of buttons: under it
    expect(m.get('ask-choices').querySelector('[role="alert"]')).toBeNull()
  } finally {
    await m.unmount()
    removeDom()
  }
})

for (const kind of ['browser_site', 'dev_env_site'] as const) {
  test(`the ${kind} card: its three buttons in the same order, the main one first in the page (shown last on a computer); each sends its decision`, async () => {
    installDom()
    const answers: unknown[] = []
    const request: TurnRequest = kind === 'browser_site'
      ? { kind, requestId: 'r-site', host: 'intranet.acme.test', url: 'https://intranet.acme.test/wiki' }
      : { kind, requestId: 'r-dev', host: 'api.acme.test', command: 'curl -s https://api.acme.test/v1' }
    const m = await mount(<AskCard req={{ request }} onAnswer={async (_id, body) => void answers.push(body)} />)
    try {
      const row = m.get('ask-choices')
      const buttons = row.querySelectorAll('button')
      expect(buttons.map((b) => (b.className.includes('bg-accent') ? 'primary' : b.className.includes('border-field-border') ? 'secondary' : 'ghost'))).toEqual(['primary', 'secondary', 'ghost'])
      expect(row.className.split(' ')).toContain('sm:flex-row-reverse')
      await m.click(buttons[0]!)
      expect(answers).toEqual([{ kind, decision: 'once' }])
    } finally {
      await m.unmount()
      removeDom()
    }
  })
}

test('the server card is titled "확인해 주세요" in Korean', () => {
  expect(ko['ask.serverTitle']).toBe('확인해 주세요')
})
