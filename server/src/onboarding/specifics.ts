// What must not stay in a team skill made from one run of a piece of work (docs/DECISIONS.md "S — The lead's way
// becomes a team skill"; onboarding/skill-draft.ts). Two checks over what teammates' AI would follow (the title, the
// line, the steps, the form's words):
//   - specificsOf / leftoversIn: what belonged to THAT run: its people (the team's accounts named in it, the attendee
//     line, names with 님/씨, a surname with a job title), companies with a company suffix, dates, money amounts and
//     contact data, read from the run's request, answer and file names. Structure words (headings, form labels, role
//     words such as 고객사님 or 원장님, counts such as 1,000개, a bare year) are not specifics: flagging them only
//     cost good skills their card;
//   - outsideIn: what no team skill made this way may carry at all, whatever the run held: links, e-mail addresses,
//     domains, phone and account numbers, team paths it does not list as its files, the names of tools that reach
//     outside, and wording that sends, uploads or shares something outside.
// Korean words here are what is looked for in the text (job titles, surnames, words that are no one's name, day
// names, money words, sending verbs), never screen text.
import path from 'node:path'
import { parse as parseDomain } from 'tldts'
import type { SkillInput } from '@mycel/shared/api'
import { BROWSER_TOOL_NAMES } from '../realtime/browser-tools'

/** A date in a file name: 2026-11-03, 20261103, 11-03, 11월 3일, 2026년 11월. */
export const DATED = /(?:\d{4}[-._ ]?\d{1,2}[-._ ]?\d{1,2})|(?:^|[^\d])\d{1,2}[-.]\d{1,2}(?:[^\d]|$)|\d{1,2}월|\d{4}년|(?:^|[^\d])\d{6}(?:[^\d]|$)/

const TITLE_WORDS = '대리|과장|부장|차장|팀장|사원|주임|이사|실장|본부장|대표|매니저|프로'
/** the common Korean surnames: "이 대리" is a person, "각 팀장" or "내 책임" is not */
const SURNAMES = '김|이|박|최|정|강|조|윤|장|임|한|오|서|신|권|황|안|송|류|유|전|홍|고|문|양|손|배|백|허|남|심|노|하|곽|성|차|주|우|구|민|진|나|지|엄|채|원|천|방|공|현|함|변|염|여|추|도|소|석|선|설|마|길|연|위|표|명|기|반|라|왕|금|옥|육|인|맹|제|모|탁|국|어|은|편|용|예|경|봉|사|부|가|복|태|목|형|피|두|감|음|빈|동|온|호|범|좌|팽|승|간|상|시|갈|단|견|당'
/** words before 님/씨 that are no one's name (roles, relations, people in general) */
const NOT_NAMES = new Set(['팀장', '대표', '고객', '담당자', '여러분', '선생', '부장', '과장', '대리', '사원', '주임', '차장', '이사', '실장', '본부장', '매니저', '회원', '손님', '사장', '회장', '원장', '부모', '어머', '아버', '형', '누나', '언니', '오빠', '교수', '박사', '기사', '작가', '팀원', '관리자', '참석자', '담당', '모두', '전원', '팀', '본인', '당신', '귀하', '사용자', '이름', '작성자', '신청자', '요청자', '수신자', '발신자', '고객사', '거래처', '협력사', '선배', '후배', '동료', '상사', '직원', '학생', '환자', '보호자', '대상자', '구매자', '판매자', '임원', '주주', '소장', '국장', '청장', '총장', '반장', '조장', '점장', '센터장', '대표님', '각자', '여러', '모든'])
/** a role word: three syllables ending like 고객사, 수신자, 담당자 (a person's name rarely does) */
const ROLE_END = /^[가-힣]{2}[사자장원객생수님]$/

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * What belonged to that one run. The team's own name and the company's are not specifics (a skill may name its own
 * company). A given name alone is a common word too often (하나, 지원): only its forms with 님/씨 count.
 */
export function specificsOf(m: { question: string; answer: string; files: readonly string[] }, o: { people: readonly string[]; own: readonly string[] }): string[] {
  const text = [m.question, m.answer, ...m.files.map((f) => path.posix.basename(f))].join('\n').normalize('NFC')
  const out = new Set<string>()
  const own = o.own.map((x) => x.normalize('NFC').trim().toLowerCase()).filter(Boolean)
  const put = (raw: string) => {
    const s = raw.normalize('NFC').trim()
    if (s.length < 2 || own.some((x) => s.toLowerCase() === x || x.includes(s.toLowerCase()))) return
    out.add(s)
  }
  /** a given name: only as it is addressed ("민지님", "민지 씨") */
  const given = (g: string) => { for (const f of [`${g}님`, `${g} 님`, `${g}씨`, `${g} 씨`]) put(f) }
  const fullName = (n: string) => {
    if (/^[가-힣]{2,4}$/.test(n)) { put(n); if (n.length === 3) given(n.slice(1)) }
    else for (const w of n.split(/\s+/)) if (/^[A-Z][a-zA-Z'-]{2,}$/.test(w)) put(w)
  }
  // the team's accounts named in the run
  for (const name of o.people) {
    const n = name.normalize('NFC').trim()
    if (!n) continue
    if (/^[가-힣]{2,4}$/.test(n)) {
      if (text.includes(n)) fullName(n)
      else if (n.length === 3 && new RegExp(`${n.slice(1)}\\s?(?:님|씨)`).test(text)) given(n.slice(1))
    } else for (const w of n.split(/\s+/)) if (/^[A-Z][a-zA-Z'-]{2,}$/.test(w) && new RegExp(`\\b${esc(w)}\\b`).test(text)) put(w)
  }
  // the attendees of meeting notes
  for (const x of text.matchAll(/(?:참석자?|참여자?|Attendees?|Participants?)\s*[:：]\s*([^\n]+)/gi)) {
    for (const raw of x[1]!.replace(/\([^)]*\)/g, '').split(/[,，、·/]|\s+및\s+|\s+and\s+/)) {
      const n = raw.trim().replace(/\s*(?:님|씨)$/, '').replace(new RegExp(`\\s*(?:${TITLE_WORDS})$`), '')
      if (/^[가-힣]{2,4}$/.test(n) && !NOT_NAMES.has(n)) fullName(n)
      else if (/^[A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)*$/.test(n)) fullName(n)
    }
  }
  // names as they are addressed: "정민지님", "민지 씨" (role words are not names)
  for (const x of text.matchAll(/(?<![가-힣])([가-힣]{2,4})\s?(?:님|씨)(?=$|[^가-힣]|[이은는께의과와도을를에])/gm)) {
    const w = x[1]!
    if (NOT_NAMES.has(w) || ROLE_END.test(w)) continue
    if (w.length >= 3) { put(w); given(w.slice(1)) }
    given(w)
  }
  // a surname with a job title: "이 대리", "김팀장"
  for (const x of text.matchAll(new RegExp(`(?<![가-힣])(${SURNAMES})\\s?(${TITLE_WORDS})(?![가-힣])`, 'g'))) { put(`${x[1]} ${x[2]}`); put(`${x[1]}${x[2]}`) }
  // companies with a company suffix
  for (const x of text.matchAll(/(?:주식회사|유한회사|㈜|\(주\))\s?([가-힣A-Za-z0-9&]{2,20})/g)) put(x[1]!)
  for (const x of text.matchAll(/([가-힣A-Za-z0-9&]{2,20})\s?(?:주식회사|유한회사|㈜|\(주\))/g)) put(x[1]!)
  for (const x of text.matchAll(/\b([A-Z][A-Za-z0-9&]{1,30})\s+(?:Inc|Corp|Co|Ltd|LLC|GmbH)\b/g)) put(x[1]!)
  // dates (a day, or a month of a year; a year alone is often a rule's own: "2024년 개정")
  const dates = [
    /\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g, /\b\d{4}[-./]\d{1,2}\b(?![-./]\d)/g, /\b20\d{6}\b/g, /(?<![\d,.])\d{1,2}\/\d{1,2}(?![\d/])/g,
    /(?<![\d,.])\d{1,2}\.\d{1,2}(?=\s?\((?:월|화|수|목|금|토|일)\))/g, /(?<![\d-])\d{2}-\d{2}(?![\d-])/g,
    /\d{1,2}월\s?\d{1,2}일/g, /\d{4}년\s?\d{1,2}월/g, /(?<!\d)\d{1,2}\s?\((?:월|화|수|목|금|토|일)\)/g,
  ]
  for (const re of dates) for (const x of text.matchAll(re)) put(x[0])
  // money (with its currency), and numbers of a million or more (a count such as 1,000개 is a rule's own)
  const amounts = [/[₩$€¥]\s?\d[\d,]*(?:\.\d+)?/g, /\d[\d,]*(?:\.\d+)?\s?(?:만\s?원|억\s?원|천\s?원|원|만원|달러|엔|USD|KRW|EUR|JPY)(?![가-힣A-Za-z])/g, /\b\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?\b/g]
  for (const re of amounts) for (const x of text.matchAll(re)) put(x[0])
  // contact data
  for (const x of text.matchAll(CONTACT)) put(x[0])
  return [...out]
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
/** phone numbers (02-000-0000, 010 1234 5678, +82 10-…) and account-like numbers (000-000000-00-000) */
const PHONE = /(?<![\w-])(?:\+\d{1,3}[-.\s]?)?0?\d{1,3}[-.\s]\d{3,4}[-.\s]\d{4}(?![\w-])/g
const ACCOUNT = /(?<![\w-])\d{2,6}-\d{2,8}-\d{2,8}(?:-\d{1,6})?(?![\w-])/g
const CONTACT = new RegExp(`${EMAIL.source}|${PHONE.source}|${ACCOUNT.source}`, 'g')
const LINK = /https?:\/\/[^\s)>\]'"`]+/g
/** extensions of files: "report.md" is a file, not a Moldovan site */
const FILE_EXT = new Set(['md', 'txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'csv', 'ppt', 'pptx', 'hwp', 'hwpx', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'json', 'html', 'htm', 'zip', 'mp3', 'mp4', 'mov', 'wav', 'm4a', 'ai', 'psd', 'py', 'js', 'ts', 'sh', 'key', 'pages', 'numbers'])
/** tools that reach outside the team's files (by name in instructions, a skill would call them); of the browser's,
 * only the names no sentence uses ("find" or "computer" are words) */
const OUTSIDE_TOOLS = new Set(['web_fetch', 'web_search', 'WebSearch', 'WebFetch', 'save_url', 'api_request', 'curl', 'wget', ...[...BROWSER_TOOL_NAMES].filter((n) => n.includes('_'))])
const TEAM_PATH = /(?<![\w/])(?:groups|shared|users|skills|projects)\/[^\s`'")\]>,]+/g
/** sending, uploading or sharing something outside */
const SENDING = [
  /(?:메일|이메일|문자|카톡|카카오톡|슬랙|텔레그램|외부|웹)(?:로|으로|에|에서)?\s?[^\n.]{0,12}?(?:보내|전송|발송|공유|올려|업로드|게시)/g,
  /(?:업로드|전송|발송|게시)(?:하|해|합)/g,
  /\b(?:upload|forward|publish)\b[^\n.]{0,40}?\b(?:to|via|on)\b/gi,
  /\b(?:send|e-?mail|post)\b[^\n.]{0,30}?\b(?:to|via)\b[^\n.]{0,20}?\b(?:e-?mail|slack|the web|a website|a server|an? (?:external|outside)\b|address)/gi,
  /\bshare\b[^\n.]{0,30}?\b(?:outside|externally|publicly|online)\b/gi,
]

/**
 * What no team skill made this way may carry, whatever the run held: links, e-mail addresses, domains, phone and
 * account numbers, team paths it does not list as its files (`files`: the paths in its "쓰는 자료"), the names of tools
 * that reach outside, and wording that sends, uploads or shares something outside.
 */
export function outsideIn(text: string, files: readonly string[]): string[] {
  const t = text.normalize('NFC')
  const found = new Set<string>()
  for (const re of [LINK, EMAIL, PHONE, ACCOUNT]) for (const x of t.matchAll(re)) found.add(x[0].replace(/[.,;:]+$/, ''))
  // a domain without a scheme ("acme.co.kr", "www.example.com"), not a file name
  for (const x of t.replace(LINK, ' ').replace(EMAIL, ' ').matchAll(/(?<![\w@/.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\w.-]*\/?\w)/gi)) {
    const d = parseDomain(x[0])
    if (!d.domain || !d.isIcann || FILE_EXT.has((d.publicSuffix ?? '').toLowerCase())) continue
    found.add(x[0])
  }
  const listed = files.map((f) => f.normalize('NFC').replace(/\/+$/, ''))
  for (const x of t.matchAll(TEAM_PATH)) {
    const p = x[0].normalize('NFC').replace(/[.,;:]+$/, '').replace(/\/+$/, '')
    if (!listed.some((f) => p === f || p.startsWith(`${f}/`))) found.add(p)
  }
  for (const x of t.matchAll(/\b[A-Za-z_][\w]*\b/g)) if (OUTSIDE_TOOLS.has(x[0])) found.add(x[0])
  for (const x of t.matchAll(/\b(?:mcp__\w+__)?(?:my|team)_[a-z0-9-]+__\w+/g)) found.add(x[0])
  for (const re of SENDING) for (const x of t.matchAll(re)) found.add(x[0].trim())
  return [...found]
}

/** The specifics of the run found in what teammates' AI would follow, and anything outsideIn finds there. */
export function leftoversIn(d: { title: string; description: string; steps: string; inputs: readonly SkillInput[] }, specifics: readonly string[], files: readonly string[] = []): string[] {
  const text = [d.title, d.description, d.steps, ...d.inputs.flatMap((i) => [i.label, i.placeholder ?? '', ...(i.options ?? []).map((x) => x.label)])].join('\n').normalize('NFC')
  const found = new Set<string>()
  for (const s of specifics) {
    if (/^[\d\s,./()월일년₩$€¥만억천원:+-]+$/.test(s) || /^[가-힣]/.test(s)) { if (text.includes(s)) found.add(s) }
    else if (new RegExp(`(?<![A-Za-z0-9])${esc(s)}(?![A-Za-z0-9])`).test(text)) found.add(s)
  }
  for (const x of outsideIn(text, files)) found.add(x)
  // a word inside a longer one found too ("민지님" in "정민지님", "1,200,000" in "1,200,000원") is said once, as the longer
  const all = [...found]
  return all.filter((x) => !all.some((y) => y !== x && y.includes(x))).slice(0, 12)
}

/** The words of a dated file's name without the date, the extension or a copy number: "2026-11-03_주간회의.md" →
 * "주간회의", "월간 보고 2026-10 (2).docx" → "월간 보고"; "" when nothing is left. */
export function nameStem(name: string): string {
  return name.normalize('NFC').replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/\s*\(\d+\)$/, '')
    .replace(/\d{4}[-._ ]?\d{1,2}(?:[-._ ]?\d{1,2})?|\d{1,2}[-.]\d{1,2}|\d{1,2}월(?:\s?\d{1,2}일)?|\d{4}년|\d{6,8}|\d{1,2}주(?:차)?/g, ' ')
    .replace(/[\s_.\-()[\]]+/g, ' ').trim().slice(0, 60)
}
