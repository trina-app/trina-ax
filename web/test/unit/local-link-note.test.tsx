// QA TC-211: a link made while the app is open at this computer's own address (an SSH tunnel: http://127.0.0.1:47820)
// opens on this computer only. The invite, lead, reset and team link dialogs say so and where to set the team address.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { translate } from '../../src/i18n'
import { isThisComputerOnly, LocalLinkNote } from '../../src/components/LocalLinkNote'


test('only this computer: 127.x, localhost and its names, ::1; a team address or a LAN address is not', () => {
  for (const u of ['http://127.0.0.1:47820/invite/abc', 'http://127.1.2.3/x', 'http://localhost:19100/invite/x', 'http://demo.localhost:19161/join#t=1', 'http://[::1]:47820/invite/x'])
    expect([u, isThisComputerOnly(u)]).toEqual([u, true])
  for (const u of ['https://acme.trina.app/invite/abc', 'https://192.168.0.10:47821/invite/x', 'https://127.0.0.1.example.com/x', '/invite/relative', 'not a url'])
    expect([u, isThisComputerOnly(u)]).toEqual([u, false])
})

test('the note names where to set the team address; nothing for a team address', () => {
  // rendered on the server the page reads the store's first language (English here); the words in Korean below
  const en = renderToStaticMarkup(<LocalLinkNote url="http://127.0.0.1:47820/invite/abc" />)
  expect(en).toContain("other computers can&#x27;t open it")
  expect(en).toContain(`${translate('en', 'admin.title')} › ${translate('en', 'admin.system')} › ${translate('en', 'system.connection')}`)
  expect(en).toContain('role="note"')
  expect(renderToStaticMarkup(<LocalLinkNote url="https://acme.trina.app/invite/abc" />)).toBe('')
  const path = `${translate('ko', 'admin.title')} › ${translate('ko', 'admin.system')} › ${translate('ko', 'system.connection')}`
  expect(translate('ko', 'links.thisComputerOnly', { path })).toBe(`이 링크는 이 컴퓨터의 주소라서 다른 컴퓨터에서는 열리지 않아요. 팀원에게 보내려면 ${path}에서 팀 주소를 정하고, 그 주소로 들어와 링크를 다시 만들어 주세요.`)
})
