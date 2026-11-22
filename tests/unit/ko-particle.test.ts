// Korean particles after a filled-in value (shared/src/ko-particle.ts): the form follows how the value ends when read
// aloud, a Latin service name as Korean speakers say it; an unknown name keeps the written-out form (QA tracking TC-3042).
import { describe, expect, test } from 'bun:test'
import { KO_PARTICLE_MARKS, koEnding, koParticle } from '../../shared/src/ko-particle'
import { SERVICE_CATALOG } from '../../shared/src/service-catalog'

const obj = (name: string) => name + koParticle(name, '을(를)')

describe('koParticle after service names', () => {
  test('the object particle fits the name: Canva를, Notion을, Gmail을, Figma를, Slack을, Linear를 …', () => {
    const cases: [string, string][] = [
      ['Canva', 'Canva를'], ['Notion', 'Notion을'], ['Gmail', 'Gmail을'], ['Figma', 'Figma를'], ['Slack', 'Slack을'],
      ['Linear', 'Linear를'], ['GitHub', 'GitHub을'], ['GitLab', 'GitLab을'], ['Google Drive', 'Google Drive를'],
      ['Google Calendar', 'Google Calendar를'], ['Google Sheets', 'Google Sheets를'], ['Google Docs', 'Google Docs를'],
      ['Google', 'Google을'], ['Jira', 'Jira를'], ['Confluence', 'Confluence를'], ['Atlassian', 'Atlassian을'],
      ['Stripe', 'Stripe를'], ['Supabase', 'Supabase를'], ['Vercel', 'Vercel을'], ['Airtable', 'Airtable을'],
      ['PayPal', 'PayPal을'], ['Zoom', 'Zoom을'], ['Dropbox', 'Dropbox를'], ['Discord', 'Discord를'], ['Microsoft Teams', 'Microsoft Teams를'],
      ['Outlook', 'Outlook을'], ['Excel', 'Excel을'], ['HubSpot', 'HubSpot을'], ['ClickUp', 'ClickUp을'], ['Intercom', 'Intercom을'],
      ['Sentry', 'Sentry를'], ['Webflow', 'Webflow를'], ['Wix', 'Wix를'], ['WordPress', 'WordPress를'], ['WordPress.com', 'WordPress.com을'],
      ['NAVER WORKS', 'NAVER WORKS를'], ['KakaoTalk', 'KakaoTalk을'], ['Mermaid Chart', 'Mermaid Chart를'], ['Claude', 'Claude를'],
      ['Codex', 'Codex를'], ['ChatGPT', 'ChatGPT를'], ['Hancom', 'Hancom을'], ['Monday', 'Monday를'], ['Neon', 'Neon을'],
    ]
    for (const [name, want] of cases) expect(obj(name)).toBe(want)
  })

  test('every particle mark takes its form: 이/가, 은/는, 와/과, (으)로 with 로 after ㄹ', () => {
    expect(koParticle('Canva', '이(가)')).toBe('가')
    expect(koParticle('Notion', '이(가)')).toBe('이')
    expect(koParticle('Gmail', '이(가)')).toBe('이')
    expect(koParticle('Figma', '은(는)')).toBe('는')
    expect(koParticle('Slack', '은(는)')).toBe('은')
    expect(koParticle('Canva', '와(과)')).toBe('와')
    expect(koParticle('Notion', '와(과)')).toBe('과')
    expect(koParticle('Canva', '(으)로')).toBe('로')
    expect(koParticle('Gmail', '(으)로')).toBe('로') // 지메일로: ㄹ takes 로
    expect(koParticle('Notion', '(으)로')).toBe('으로')
    expect(koParticle('Canva', '(을)를')).toBe('를')
    expect(KO_PARTICLE_MARKS.length).toBe(7)
  })

  test('Hangul and numbers as before; abbreviations in capitals letter by letter', () => {
    expect(['노션', '캔바', '서울', '마케팅'].map(koEnding)).toEqual(['consonant', 'vowel', 'rieul', 'consonant'])
    expect(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map(koEnding)).toEqual(['consonant', 'rieul', 'vowel', 'consonant', 'vowel', 'vowel', 'consonant', 'rieul', 'rieul', 'vowel'])
    expect(obj('v1.2.3')).toBe('v1.2.3을')
    expect(obj('Windows 11')).toBe('Windows 11을')
    expect(obj('Microsoft 365')).toBe('Microsoft 365를')
    expect(obj('MCP')).toBe('MCP를')
    expect(obj('HWP')).toBe('HWP를')
    expect(obj('SQL')).toBe('SQL을')
    expect(obj('CRM')).toBe('CRM을')
    expect(koParticle('AI', '이(가)')).toBe('가')
    expect(['PDF', 'API', 'URL', 'AWS', 'IBM'].map(obj)).toEqual(['PDF를', 'API를', 'URL을', 'AWS를', 'IBM을'])
  })

  test('a capital word with a vowel letter that is not a known abbreviation is a word, not letters: keeps 을(를)', () => {
    for (const w of ['WEB', 'APP', 'HOME', 'FILE', 'MAC', 'ACME', 'TEAM']) expect(obj(w)).toBe(`${w}을(를)`)
  })

  test('a closing quote or bracket after the value is not read', () => {
    expect(obj("'Canva'")).toBe("'Canva'를")
    expect(obj('Notion (팀)')).toBe('Notion (팀)을')
    expect(obj('「Slack」')).toBe('「Slack」을')
  })

  test('an unknown Latin name, a sign or an empty value keeps the written-out form', () => {
    for (const name of ['Acmewidget', 'quote maker', 'Zqxv', 'marketing/archive', '', '…', 'https://example.com/']) {
      expect(koParticle(name, '을(를)')).toBe('을(를)')
      expect(koParticle(name, '(으)로')).toBe('(으)로')
    }
    // a word that is not a particle mark comes back as it is
    expect(koParticle('Canva', '에서')).toBe('에서')
  })

  test('every listed service whose Korean name is known reads by that name', () => {
    const HANGUL_END = (s: string) => koEnding(s)
    for (const s of SERVICE_CATALOG) {
      const ko = ('aliases' in s ? s.aliases : []).find((a: string) => /^[가-힣]+$/.test(a) && a.length > 1)
      // Monday's Korean alias is the site's name (먼데이닷컴), WordPress.com's the product's (워드프레스); GitHub's is the
      // written-out 깃허브 people search by, while the name is read 깃헙 (GitHub을, the list above)
      if (!ko || s.id === 'monday' || s.id === 'wordpress' || s.id === 'github') continue
      expect({ name: s.name, end: koEnding(s.name) }).toEqual({ name: s.name, end: HANGUL_END(ko) })
    }
  })
})

// QA b3s TC-b3s-17: "주간 실적.xlsx을(를)", "버전 2을"
describe('koParticle after file names and numbers', () => {
  test('a file name by its extension as read', () => {
    expect(koParticle('주간 실적.xlsx', '\uc744(\ub97c)')).toBe('\ub97c')
    expect(koParticle('보고서.pdf', '\uc774(\uac00)')).toBe('\uac00')
    expect(koParticle('page.html', '(\uc73c)\ub85c')).toBe('\ub85c')
    expect(koParticle('data.json', '\uc744(\ub97c)')).toBe('\uc744')
    expect(koParticle('a.docx', '\uc744(\ub97c)')).toBe('\ub97c')
    expect(koParticle('example.com', '\uc744(\ub97c)')).toBe('\uc744(\ub97c)')
    expect(koParticle('2', '\uc744(\ub97c)')).toBe('\ub97c')
    expect(koParticle('3', '(\uc73c)\ub85c')).toBe('\uc73c\ub85c')
  })
})
