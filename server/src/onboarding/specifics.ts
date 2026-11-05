// What belongs to one run of a piece of work and must not stay in a team skill made from it (docs/DECISIONS.md "S —
// The lead's way becomes a team skill"; onboarding/skill-draft.ts): the names of people, customers and companies,
// dates, amounts and links. Read from the run's request, answer and file names, then looked for in what teammates' AI
// would follow (the title, the line, the steps, the form's words). Korean words here are what is looked for in the
// text (job titles, words that are no one's name, day names, money words), never screen text.
import path from 'node:path'
import type { SkillInput } from '@mycel/shared/api'

/** A date in a file name: 2026-11-03, 20261103, 11-03, 11월 3일, 2026년 11월. */
export const DATED = /(?:\d{4}[-._ ]?\d{1,2}[-._ ]?\d{1,2})|(?:^|[^\d])\d{1,2}[-.]\d{1,2}(?:[^\d]|$)|\d{1,2}월|\d{4}년|(?:^|[^\d])\d{6}(?:[^\d]|$)/

const TITLE_WORDS = '대리|과장|부장|차장|팀장|사원|주임|이사|실장|본부장|대표|선임|책임|수석|매니저|프로'
/** words before 님/씨 that are no one's name */
const NOT_NAMES = new Set(['팀장', '대표', '고객', '담당자', '여러분', '선생', '부장', '과장', '대리', '사원', '주임', '차장', '이사', '실장', '본부장', '매니저', '회원', '손님', '사장', '팀원', '작가', '기사', '고객님', '관리자', '참석자', '담당', '모두', '전원', '팀', '본인', '당신', '귀하', '사용자', '이름', '작성자', '신청자', '요청자'])
/** headings of the general skills' answers that are no one's name */
const NOT_NAME_HEADINGS = new Set(['결정', '안건', '참석자', '논의', '요약', '핵심', '일정', '기한', '메모', '공지', '출처', '결과', '기타', '정리', '다음', '이번', '내용', '목표', '위험', '내할일', '팀전체', '확인필요', '틀', '할일', '자료', '참고'])
const EN_HEADINGS = new Set(['Frame', 'Decided', 'Everyone', 'Still Open', 'My Tasks', 'Needs Checking', 'Unclear Owner', 'Key Points', 'Notes', 'Summary', 'Tasks', 'Decisions', 'Agenda', 'Attendees', 'Kept As It Is', 'Filled In Each Time', 'Whole Team', 'Next Steps', 'Risks'])

/**
 * What belonged to that one run: names of people (the team's accounts named in it, names before 님/씨 or a job title,
 * the per-person headings of the answer), company names with a company suffix, dates, amounts and links. The team's
 * own name and the company's are not specifics (a skill may name its own company).
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
  for (const name of o.people) {
    const n = name.normalize('NFC').trim()
    if (!n) continue
    const hangul = /^[가-힣]{2,4}$/.test(n)
    if (hangul && text.includes(n)) { put(n); if (n.length === 3) put(n.slice(1)) }
    else if (hangul && n.length === 3 && new RegExp(`${n.slice(1)}(?=\\s?(?:님|씨))`).test(text)) put(n.slice(1))
    else if (!hangul) for (const w of n.split(/\s+/)) if (/^[A-Z][a-zA-Z'-]{2,}$/.test(w) && new RegExp(`\\b${w}\\b`).test(text)) put(w)
  }
  for (const x of text.matchAll(/([가-힣]{2,4})(?=\s?(?:님|씨)(?![가-힣]))/g)) if (!NOT_NAMES.has(x[1]!)) put(x[1]!)
  for (const x of text.matchAll(new RegExp(`(?<![가-힣])([가-힣])\\s?(${TITLE_WORDS})(?![가-힣])`, 'g'))) { put(`${x[1]} ${x[2]}`); put(`${x[1]}${x[2]}`) }
  for (const x of text.matchAll(/^#{2,4}\s+([가-힣]{2,4})\s*$/gm)) if (!NOT_NAME_HEADINGS.has(x[1]!)) put(x[1]!)
  for (const x of text.matchAll(/^#{2,4}\s+([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})\s*$/gm)) {
    const h = x[1]!.replace(/\b\w/g, (c) => c.toUpperCase())
    if (!EN_HEADINGS.has(h)) put(x[1]!)
  }
  for (const x of text.matchAll(/(?:주식회사|유한회사|㈜|\(주\))\s?([가-힣A-Za-z0-9&]{2,20})/g)) put(x[1]!)
  for (const x of text.matchAll(/([가-힣A-Za-z0-9&]{2,20})\s?(?:주식회사|유한회사|㈜|\(주\))/g)) put(x[1]!)
  for (const x of text.matchAll(/\b([A-Z][A-Za-z0-9&]{1,30})\s+(?:Inc|Corp|Co|Ltd|LLC|GmbH)\b/g)) put(x[1]!)
  const dates = [
    /\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g, /\b\d{4}[-./]\d{1,2}\b/g, /\b\d{8}\b/g, /(?<![\d,.])\d{1,2}\/\d{1,2}(?![\d/])/g,
    /(?<![\d,.])\d{1,2}\.\d{1,2}(?=\s?\((?:월|화|수|목|금|토|일)\))/g, /(?<![\d-])\d{2}-\d{2}(?![\d-])/g,
    /\d{1,2}월\s?\d{1,2}일/g, /\d{4}년(?:\s?\d{1,2}월)?/g, /(?<!\d)\d{1,2}\s?\((?:월|화|수|목|금|토|일)\)/g,
  ]
  for (const re of dates) for (const x of text.matchAll(re)) put(x[0])
  const amounts = [/[₩$€¥]\s?\d[\d,]*(?:\.\d+)?/g, /\d[\d,]*(?:\.\d+)?\s?(?:만\s?원|억\s?원|천\s?원|원|만원|억|달러|엔|USD|KRW|EUR|JPY)(?![가-힣A-Za-z])/g, /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g]
  for (const re of amounts) for (const x of text.matchAll(re)) put(x[0])
  return [...out]
}

/** The specifics of the run found in what teammates' AI would follow (and every link). */
export function leftoversIn(d: { title: string; description: string; steps: string; inputs: readonly SkillInput[] }, specifics: readonly string[]): string[] {
  const text = [d.title, d.description, d.steps, ...d.inputs.flatMap((i) => [i.label, i.placeholder ?? '', ...(i.options ?? []).map((x) => x.label)])].join('\n').normalize('NFC')
  const found = new Set<string>()
  for (const s of specifics) {
    if (/^[\d\s,./()월일년₩$€¥만억천원:-]+$/.test(s) || /^[가-힣]/.test(s)) { if (text.includes(s)) found.add(s) }
    else if (new RegExp(`(?<![A-Za-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(text)) found.add(s)
  }
  for (const x of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) found.add(x[0])
  // a word inside a longer one found too ("민지" in "정민지", "1,200,000" in "1,200,000원") is said once, as the longer
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
