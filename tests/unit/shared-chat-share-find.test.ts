// Shared-chat share and find fixes (AI scenarios 2026-11-17, docs/decisions/20261117-shared-chat-share-find.md):
// - FSH-01: "<name> 님이랑 공유해줘" names the recipient (share with that person), so a shared chat's folder share goes on;
// - SHR-01: a file is named by what it is, without the date or number at its end; a group the asker is not in gets
//   the plain limit and what works;
// - SWM-01: files shared with the person one by one are named as not available in a shared chat, with where they are;
// - FIND-01: a shared project chat's search without a path says it stayed in the project folder, and "/" looks further.
// Korean as escapes (no Korean text outside the language tables).
import { describe, expect, test } from 'bun:test'
import { coreName, namesFile, namesFileCore, namesFileLoose, namesRecipient } from '../../server/src/chat/shared-actions'
import { looksLikeGroup } from '../../server/src/chat/share-with-person'
import { SHARE_NO } from '../../server/src/chat/share-words'
import { sharedSection } from '../../server/src/chat/prompt'
import { inProjectOnly, noSearchPath, PROJECT_SEARCH_NOTE, wholeTeamPath } from '../../server/src/chat/search-path'

const MINHO = { names: ['\uBC15\uBBFC\uD638', 'minho'], person: true }

describe('FSH-01: a person named with "(님)이랑 / 와 / 하고" right before the share word', () => {
  test('the scenario message names 민호', () => {
    expect(namesRecipient('\uB0B4 \uD30C\uC77C \uC548\uC5D0 \uC788\uB294 "\uC81C\uC548\uC11C-\uCD08\uC548" \uD3F4\uB354\uB97C \uBBFC\uD638 \uB2D8\uC774\uB791 \uACF5\uC720\uD574\uC918. \uC55E\uC73C\uB85C \uAC70\uAE30 \uB123\uB294 \uD30C\uC77C\uB3C4 \uB2E4 \uBCF4\uC774\uAC8C.', '\uBBFC\uD638', MINHO)).toBe(true)
    expect(namesRecipient('\uBBFC\uD638 \uB2D8\uC774\uB791 \uACF5\uC720\uD574\uC918', '\uBBFC\uD638 \uB2D8', MINHO)).toBe(true)
    expect(namesRecipient('\uBBFC\uD638\uB791 \uACF5\uC720\uD574 \uC918', '\uBBFC\uD638', MINHO)).toBe(true)
    expect(namesRecipient('\uBC15\uBBFC\uD638 \uC528\uC640 \uACF5\uC720\uD574\uC918', undefined, MINHO)).toBe(true)
    expect(namesRecipient('\uC774 \uD3F4\uB354 \uBBFC\uD638 \uB2D8\uD558\uACE0 \uACF5\uC720\uD574 \uC8FC\uC138\uC694', '\uBBFC\uD638', MINHO)).toBe(true)
  })
  test('a name joined to something else is still not a recipient', () => {
    // a meeting with 민호, shared with nobody named
    expect(namesRecipient('\uBBFC\uD638 \uB2D8\uACFC \uD68C\uC758\uD55C \uB0B4\uC6A9 \uACF5\uC720\uD574\uC918', '\uBBFC\uD638', MINHO)).toBe(false)
    expect(namesRecipient('\uBBFC\uD638 \uB2D8\uC774\uB791 \uAC19\uC774 \uC4F4 \uBCF4\uACE0\uC11C \uACF5\uC720\uD574\uC918', '\uBBFC\uD638', MINHO)).toBe(false)
    // only the request itself: not a past share, a "don't", or one that did not happen (review finding 1)
    expect(namesRecipient('\uBBFC\uD638\uB791 \uACF5\uC720\uD558\uBA74 \uC548 \uB418\uB2C8\uAE4C \uC9C0\uC218\uD55C\uD14C\uB9CC \uACF5\uC720\uD574\uC918', '\uBBFC\uD638', MINHO)).toBe(false)
    expect(namesRecipient('\uBBFC\uD638 \uB2D8\uC774\uB791 \uACF5\uC720\uD588\uB358 \uACAC\uC801\uC11C \uC9C0\uC218\uD55C\uD14C \uACF5\uC720\uD574\uC918', '\uBBFC\uD638', MINHO)).toBe(false)
    expect(namesRecipient('"Q4" \uD3F4\uB354, \uBBFC\uD638\uB791 \uACF5\uC720 \uC548 \uB41C \uAC70 \uC9C0\uC218\uD55C\uD14C \uACF5\uC720\uD574\uC918', '\uBBFC\uD638', MINHO)).toBe(false)
    // the request word going on as thanks, a question, a permission or a report (second review)
    for (const said of ['\uBBFC\uD638\uB791 \uACF5\uC720\uD574\uC918\uC11C \uACE0\uB9C8\uC6CC\uC694', '\uBBFC\uD638\uB791 \uACF5\uC720\uD574\uC918\uC57C \uD558\uB098\uC694?', '\uBBFC\uD638\uB791 \uACF5\uC720\uD574\uC918\uB3C4 \uB418\uB098?', '\uBBFC\uD638\uB791 \uACF5\uC720\uD574 \uB2EC\uB77C\uACE0 \uD588\uB358 \uD30C\uC77C \uC9C0\uC218\uD55C\uD14C \uBCF4\uB0B4\uC918']) expect([said, namesRecipient(said, '\uBBFC\uD638', MINHO)]).toEqual([said, false])
    expect(namesRecipient('\uBBFC\uD638\uB791 \uACF5\uC720\uD574 \uC8FC\uC138\uC694.', '\uBBFC\uD638', MINHO)).toBe(true)
    // another person's name is not 민호
    expect(namesRecipient('\uC9C0\uC6B0 \uB2D8\uC774\uB791 \uACF5\uC720\uD574\uC918', '\uBBFC\uD638', MINHO)).toBe(false)
  })
})

describe('SHR-01: a file named without the date or number at its end', () => {
  test('coreName', () => {
    expect(coreName('\uB2E8\uAC00\uD45C-2026')).toBe('\uB2E8\uAC00\uD45C')
    expect(coreName('report_v2')).toBe('report')
    expect(coreName('\uACAC\uC801\uC11C-\uB77C\uB9C8\uBC14\uCE74\uD398-2026-11')).toBe('\uACAC\uC801\uC11C-\uB77C\uB9C8\uBC14\uCE74\uD398')
    expect(coreName('Q4 plan')).toBe('Q4 plan')
    expect(coreName('2026')).toBe('2026')
  })
  test('namesFileCore: weaker than namesFile, which keeps its old rule (no card is skipped and who_can_open is unchanged)', () => {
    expect(namesFileCore('\uB2E8\uAC00\uD45C \uB9C8\uCF00\uD305\uD300\uB3C4 \uBCFC \uC218 \uC788\uAC8C \uACF5\uC720\uD574\uC918', 'groups/\uC601\uC5C5/\uB2E8\uAC00\uD45C-2026.xlsx')).toBe(true)
    expect(namesFile('\uB2E8\uAC00\uD45C \uB9C8\uCF00\uD305\uD300\uB3C4 \uBCFC \uC218 \uC788\uAC8C \uACF5\uC720\uD574\uC918', 'groups/\uC601\uC5C5/\uB2E8\uAC00\uD45C-2026.xlsx')).toBe(false)
    expect(namesFileCore('share the report with Jun', 'users/u/report_v2.docx')).toBe(true)
    expect(namesFile('share the report with Jun', 'users/u/report_v2.docx')).toBe(false)
    expect(namesFileCore('\uACAC\uC801\uC11C \uB77C\uB9C8\uBC14\uCE74\uD398 \uACF5\uC720\uD574\uC918', 'projects/x/\uACAC\uC801\uC11C-\uB77C\uB9C8\uBC14\uCE74\uD398-2026-11.pdf')).toBe(true)
    expect(namesFileLoose('\uACAC\uC801\uC11C \uB77C\uB9C8\uBC14\uCE74\uD398 \uACF5\uC720\uD574\uC918', 'projects/x/\uACAC\uC801\uC11C-\uB77C\uB9C8\uBC14\uCE74\uD398-2026-11.pdf')).toBe(false)
    // a part of the name that is not all of it but its date is not enough
    expect(namesFileCore('\uACAC\uC801\uC11C \uACF5\uC720\uD574\uC918', 'projects/x/\uACAC\uC801\uC11C-\uB77C\uB9C8\uBC14\uCE74\uD398-2026-11.pdf')).toBe(false)
    // another date or number right after the name names another file
    expect(namesFileCore('ledger-3.txt please', 'users/bob/ledger-4.txt')).toBe(false)
    expect(namesFileCore('\uB2E8\uAC00\uD45C-2025 \uACF5\uC720\uD574\uC918', 'groups/\uC601\uC5C5/\uB2E8\uAC00\uD45C-2026.xlsx')).toBe(false)
    expect(namesFileCore('\uACAC\uC801\uC11C \uB77C\uB9C8\uBC14\uCE74\uD398 2025 \uACF5\uC720\uD574\uC918', 'projects/x/\uACAC\uC801\uC11C-\uB77C\uB9C8\uBC14\uCE74\uD398-2026-11.pdf')).toBe(false)
    // "report" inside another word is not the file; a name with nothing cut is namesFile's
    expect(namesFileCore('share the reports page', 'users/u/report_v2.docx')).toBe(false)
    expect(namesFileCore('share notes.md', 'users/u/notes.md')).toBe(false)
  })
  test('a group the member is not in: the plain limit and the options, the same whether such a group exists', () => {
    expect(looksLikeGroup('\uB9C8\uCF00\uD305\uD300')).toBe(true)
    expect(looksLikeGroup('Marketing team')).toBe(true)
    expect(looksLikeGroup('group:g1')).toBe(true)
    expect(looksLikeGroup('\uD558\uB098')).toBe(false)
    expect(looksLikeGroup('\uD300')).toBe(false)
    const t = SHARE_NO.nobody('\uB9C8\uCF00\uD305\uD300', { group: true, staff: false })
    expect(t).toContain('the user is not in a group by that name, and a member shares files only with groups they are in')
    expect(t).toContain('sharing it with the people of that group by name')
    expect(t).toContain('ask for the names once, in your answer (not with ask_user)')
    expect(t).toContain('asking the team owner or an admin')
    expect(t).toMatch(/^Nothing was shared: /)
    // an admin shares with any group: no such group exists, so no member's limit
    expect(SHARE_NO.nobody('\uB9C8\uCF00\uD305\uD300', { group: true, staff: true })).not.toContain('a member shares files only')
    expect(SHARE_NO.nobody('Jun')).not.toContain('If they mean a group')
  })
})

describe('SWM-01 and FIND-01: what a shared project chat tells the AI', () => {
  const section = (L: 'ko' | 'en' = 'en') => sharedSection({ project: 'Lamaba', audience: 4, asker: 'Hana Choi' }, L, true)
  test('files shared with the person one by one work here, behind the read card (docs/decisions/20261126-shared-chat-everything.md)', () => {
    expect(section()).toContain('files and folders teammates shared with Hana Choi one by one (shared_with_me, then read by their links)')
    expect(section()).not.toContain('they are Hana Choi\'s alone')
  })
  test('a search without a path stays in the project folder; "/" alone looks through every folder, behind the card', () => {
    expect(section()).toContain('grep and glob without a path look in the project folder only. Give a path to look in one other place, or path "/" to look through every team folder Hana Choi can open (either may ask first).')
    expect(wholeTeamPath('/')).toBe(true)
    expect(wholeTeamPath(' / ')).toBe(true)
    for (const p of ['', '.', './', '//', undefined]) expect(wholeTeamPath(p)).toBe(false)
    expect(noSearchPath('/')).toBe(true)
    // the note's searches: no path, or the project folder itself or a folder in it; never "/" or another folder
    for (const p of [undefined, '', '.', 'projects/falcon', './projects/falcon/', 'Projects/Falcon/docs']) expect([p, inProjectOnly(p, 'projects/falcon')]).toEqual([p, true])
    for (const p of ['/', 'groups', 'projects', 'projects/falcon-2', 'users/alice']) expect([p, inProjectOnly(p, 'projects/falcon')]).toEqual([p, false])
    expect(PROJECT_SEARCH_NOTE).toContain('Only this project\'s folder was searched')
    expect(PROJECT_SEARCH_NOTE).toContain('search again before you answer, with path "/"')
    expect(PROJECT_SEARCH_NOTE).toContain('(not their own folder)')
  })
})
