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
// English names are read by where they stand, from surest to least sure: a team account named in the run (then its
// given name, "Sarah K.", the full name and the family name all count), a name with a title ("Ms. Rivera": that form
// and the bare surname), the lines that list people ("Attendees:", "Present:", "Owner:", "Prepared by:" …), a name by
// its form ("Sarah K.", "Mike from sales", "Mike (sales)", a role's line with a full name: "Designer: Nora Quinn"), a
// task's owner at the start of a line ("- Dan to …", "- Priya — …", "Sarah: …", only when the run says the name more
// than once: a label said once is no one, "Tone: friendly") and a per-person heading ("### Sarah Klein", only when a
// word of it is also named outside the headings). A word of the stoplist (STOP: structure and form words, roles, days
// and months, the verbs steps start with, a team's work words) is never a name on its own; the less sure places (a
// name's form, a task's owner, a heading) also refuse a word the text writes in lower case somewhere ("webinar"), the
// last two also words shaped like nouns (…tion, …ment, …ing). A name that is also a word (WORD_NAMES: Will, May, Mark,
// Grace) is taken only where it is clearly a name (an account, a list of people, a title, "June from sales", "Will
// T."), and in a skill it counts only where it reads as one: not as the first word of a sentence that goes on ("Mark
// each task", "Will you …"), not as a month ("May 20", "in June"). Dates are a day (11/20, Nov 20, November 20th, 20
// November, 11/03/2026) or a month of a year (November 2026); a weekday ("by Thursday") or a month alone ("December
// newsletter") is how a recurring rule talks. A number with k is money only beside a budget word ("1.2k over budget";
// "1.2k signups" is a count).
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

/** a word of a Latin name: Sarah, O'Brien, McKay, José, Anne-Marie */
const NAME_WORD = String.raw`\p{Lu}(?:['’]\p{Lu})?\p{Ll}+(?:\p{Lu}\p{Ll}+)?(?:-\p{Lu}\p{Ll}+)?`
const IS_NAME_WORD = new RegExp(`^${NAME_WORD}$`, 'u')
const INITIAL = String.raw`\p{Lu}\.`
/** a name of one to three words, an initial after the first: "Sarah", "Sarah K.", "Mary Ann Smith" */
const NAME = `${NAME_WORD}(?:[ \\t](?:${NAME_WORD}|${INITIAL})){0,2}`
const TITLES = ['Mr', 'Mrs', 'Ms', 'Mx', 'Dr', 'Prof']
const TITLE = `(?:${TITLES.join('|')})`
/** not inside a longer word (letters of any script, digits) */
const NB = String.raw`(?<![\p{L}\p{N}])`
const NE = String.raw`(?![\p{L}\p{N}])`
const wordSet = (s: string) => new Set(s.trim().split(/\s+/))
/** English words that are no one's name on their own (lower case; a plural with -s or -es counts too, "Ines" is no
 * plural of "in") */
const STOP = wordSet(`
  a an the and or but nor if then else so as at by for from in into of on onto to with without within about above below
  under over after before between during through until upon via per not no yes ok okay also only just still even both
  either neither other others another same any some most many few more less much all each every everyone everybody
  everything someone somebody something anyone anybody anything nobody nothing none one two three four five six seven
  eight nine ten first second third last next new old final main top bottom here there now please thanks thank hi
  hello dear regards best cheers fyi i me my mine we us our ours you your yours he him his she her hers they them their
  theirs it its this that these those who whom whose what which where when why how is are was were be been being have
  has had do does did can could would should must might shall
  overview summary agenda notes note minutes recap update decision action item step owner attendee attendance present
  absent participant invited invitee guest apologies regrets template quote invoice proposal report frame field filled
  kept whole team check task todo done pending open closed source background context goal objective result status
  risk blocker issue question answer idea topic theme highlight takeaway key follow followup timeline schedule deadline
  milestone budget spend spent cost revenue metric number data analysis finding recommendation conclusion introduction
  intro appendix reference contents table figure section part chapter page header footer title subtitle heading body
  signature terms term conditions scope deliverable requirement assumption exclusion payment misc general detail
  description info information comment feedback review approval signoff draft final version change log history
  archive win lot kudos roundtable shoutout housekeeping announcement discussion option plan exhibit variant tier phase
  type class level round zone block unit line row column total example sample tip warning caution important reminder
  fix bug request
  customer client recipient email phone mobile tel fax address company companies contact attn attention name date due
  valid until qty quantity amount subtotal tax taxes vat sales total discount shipping fee rate hour price pricing ref
  po sku id code net balance deposit paid currency memo prepared approved issued expires expiry vendor supplier buyer
  seller ship subject regarding cc bcc signed
  admin administrator manager lead director head chief member staff people person folks user host chair facilitator
  organizer presenter speaker notetaker assignee reviewer approver stakeholder partner agency intern boss design
  designer engineering engineer product finance legal ops operations support hr it pr content growth brand creative
  social analytics accounting leadership management executive board committee marketing marketer rep account success
  procurement purchasing ceo cfo cto coo cmo vp copywriter photographer videographer editor writer developer
  contractor freelancer consultant coordinator strategist analyst specialist assistant printer recruiter
  monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun january february
  march july september october november december feb mar apr jun jul aug sep sept oct nov dec today tomorrow yesterday
  tonight day days week weekly month monthly daily quarterly yearly annual annually year quarter weekend morning
  afternoon evening noon midnight spring fall holiday eod eow asap tbd
  draft send share read list use write put add sort keep leave skip ask take fill copy start end show give make find
  include say cite link tag flag count look pick choose treat split merge order format begin finish close prepare
  confirm compare summarize summarise collect gather pull set assign track call ping book create build launch publish
  post upload download run test clean remove delete move rename save print submit approve reject discuss decide align
  sync meet talk reach invite remind notify tell let get go try need want see watch think know consider ensure verify
  validate prioritize focus finalize wrap kick kickoff handle own coordinate organize setup prep research analyze
  analyse audit measure explain describe define outline map develop implement deploy deliver release rollout remember
  agreed agree back welcome reply access prior similar sure mention attach attached sent shared
  webinar newsletter campaign promo promotion landing website site blog ad ads search media paid organic seo sem ppc
  video copy copies asset deck slides slide brief strategy roadmap pipeline deal contract partnership sponsor office
  calendar meeting standup retro demo training onboarding hiring survey poll insights competitor market audience
  persona segment channel platform tool app feature service project program stage wave sprint fiscal target forecast
  estimate receipt purchase shipment delivery inventory stock offer coupon sale signups signup registrations
  subscribers followers traffic clicks impressions conversions conversion tracking dashboard stats spreadsheet sheet
  doc document file folder drive slack zoom google linkedin facebook instagram twitter tiktok youtube press case study
  studies photo image event story stories article giveaway contest tone voice style headline caption hashtag hook
  angle message messaging visual length word size color colour font logo layout location venue time priority effort
  impact category label region language url
`)
/** names that are also words: taken only where they are clearly a name, found in a skill only where they read as one */
const WORD_NAMES = wordSet(`
  will may june april august jan mark bill grace hope faith joy sue rob pat art max chase drew grant frank guy jack ray
  rich dawn rose summer autumn winter hunter reed lane chip nick don bob kit penny sandy holly ivy iris ruby amber pearl
  daisy lily violet hazel heather jade olive sage sky destiny major miles norm matt herb gene dale glen cliff rod lance
  mason carter taylor victor noble wade stone clay gray grey green brown white black young long little hall wood hill
  king bell love small sharp swift bright earl duke prince rex jean bud buck chuck hank woody rusty sunny misty brook
  river storm rain forest dusty
`)
/** names that are also months: "May 20", "in June" are the month */
const MONTH_NAMES = new Set(['jan', 'april', 'may', 'june', 'august'])
/** the shapes of nouns, refused where only a word's place says it is a name */
const NOUNISH = /(?:tion|sion|ment|ness|ings?|ity|ities|ship|ables?|ics|ism|ist|ology|ware)s?$/
/** a team after "from" or in brackets: "Mike from sales", "Mike (sales)" */
const TEAMS = wordSet('sales marketing design legal finance ops operations engineering product hr it accounting partnerships pr creative content growth brand events social analytics data support procurement purchasing leadership management agency client vendor')
/** words a company's name rarely starts with alone ("General", "United"): its first word is put only when it is not one */
const CO_COMMON = wordSet('general american national united first global international pacific atlantic western eastern northern southern north south east west digital capital royal standard union universal advanced applied allied associated consolidated continental federal mutual great prime smart blue green red black white golden silver coastal mountain valley city state county metro urban modern classic premier summit pioneer')
const CO_SUFFIX = String.raw`Inc|LLC|L\.L\.C|Ltd|Corp|Corporation|Co|Company|GmbH|PLC|LLP`
/** a word of a company's name: capitalized, not a suffix itself ("Acme Ltd. and Foo Corp." are two) */
const CO_WORD = String.raw`(?!(?:${CO_SUFFIX})\.?(?![\p{L}\p{N}]))\p{Lu}[\p{L}\p{N}&'’.-]*`
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MON = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?'
const ordinal = (d: number) => `${d}${d % 100 >= 11 && d % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][d % 10] ?? 'th')}`
const NUM = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`

const isStop = (w: string) => {
  const l = w.toLowerCase()
  return STOP.has(l) || (l.length > 3 && l.endsWith('s') && (STOP.has(l.slice(0, -1)) || (l.length > 4 && l.endsWith('es') && STOP.has(l.slice(0, -2)))))
}

/**
 * Whether a name that is also a word (WORD_NAMES) stands as a name somewhere in the text: after a title, before an
 * initial, a family name or "'s", alone on its line or before ":", a dash or a task's verb ("### Mark", "- Mark: …",
 * "- Mark to send …"), or inside a sentence ("ask Mark"); not as the first word of a sentence that goes on ("Mark each
 * task", "Will you …"), and a month's name not before a day or after "in", "by" … ("May 20", "in June").
 */
function asName(t: string, w: string): boolean {
  const month = MONTH_NAMES.has(w.toLowerCase())
  for (const x of t.matchAll(new RegExp(`${NB}${esc(w)}${NE}`, 'gu'))) {
    const before = t.slice(t.lastIndexOf('\n', x.index - 1) + 1, x.index)
    const after = t.slice(x.index + w.length).split('\n', 1)[0]!
    if (new RegExp(`${NB}${TITLE}\\.?[ \\t]$`, 'u').test(before)) return true
    if (/^(?:[ \t]\p{Lu}(?:\.|\p{Ll})|['’]s(?!\p{L}))/u.test(after)) return true
    if (/^[ \t>*#_•+\-\d.)[\]"“]*$/.test(before) || /[.!?:;—–]["”’)]*[ \t]+$/.test(before)) {
      if (!month && /^(?:[ \t]*(?:[:：]|[—–-][ \t]|$)|[ \t]+(?:to|will|owns|should|must)[ \t]+\p{Ll})/u.test(after)) return true
      continue
    }
    if (month && (/^[ \t,.]*\d/.test(after) || /\b(?:in|by|of|on|for|until|till|since|from|before|after|through|during|each|every|next|last|this|early|late|mid|end)[ \t]+$/i.test(before))) continue
    return true
  }
  return false
}

/**
 * What belonged to that one run. The team's own name and the company's are not specifics (a skill may name its own
 * company). A given name alone is a common word too often (하나, 지원): only its forms with 님/씨 count. English names:
 * the file's header.
 */
export function specificsOf(m: { question: string; answer: string; files: readonly string[] }, o: { people: readonly string[]; own: readonly string[] }): string[] {
  const text = [m.question, m.answer, ...m.files.map((f) => path.posix.basename(f))].join('\n').normalize('NFC')
  const out = new Set<string>()
  const own = o.own.map((x) => x.normalize('NFC').trim().toLowerCase()).filter(Boolean)
  // the team's own name, or a part of it ("Acme" of "Acme Marketing"; for Latin words whole words only: "Mark" is no
  // part of "Acme Marketing")
  const ownHas = (s: string) => own.some((x) => s === x || (/[가-힣]/.test(s) ? x.includes(s) : new RegExp(`${NB}${esc(s)}${NE}`, 'u').test(x)))
  const put = (raw: string) => {
    const s = raw.normalize('NFC').trim()
    if (s.length < 2 || ownHas(s.toLowerCase())) return
    out.add(s)
  }
  /** a given name: only as it is addressed ("민지님", "민지 씨") */
  const given = (g: string) => { for (const f of [`${g}님`, `${g} 님`, `${g}씨`, `${g} 씨`]) put(f) }
  const has = (s: string) => new RegExp(`${NB}${esc(s)}${NE}`, 'u').test(text)
  // the words the text writes in lower case somewhere ("webinar"), e-mail addresses and links aside (dan@…)
  const lower = new Set(text.replace(LINK, ' ').replace(EMAIL, ' ').match(/(?<![\p{L}\p{N}])\p{Ll}+(?![\p{L}\p{N}])/gu) ?? [])
  const inLower = (w: string) => { const l = w.toLowerCase(); return lower.has(l) || lower.has(`${l}s`) || (l.endsWith('s') && lower.has(l.slice(0, -1))) }
  /** whether a word may be a name where it stands: 0 an account, a list of people, a title; 1 a name by its form
   * ("Sarah K.", "Mike from sales"); 2 only by its place (a task's owner, a heading) */
  const nameOk = (w: string, sure: 0 | 1 | 2) => {
    const l = w.toLowerCase()
    if (WORD_NAMES.has(l)) return sure < 2
    if (isStop(w)) return false
    return sure === 0 || (!inLower(w) && (sure === 1 || !NOUNISH.test(l)))
  }
  /** a Latin name, as a whole and word by word ("Sarah K." gives "Sarah" too); a name that is also a word passes beside
   * a surer one ("Will Turner" under a heading) */
  const person = (n: string, sure: 0 | 1 | 2) => {
    const ws = n.trim().split(/\s+/)
    if (!IS_NAME_WORD.test(ws[0]!) || !ws.every((w) => IS_NAME_WORD.test(w) || new RegExp(`^${INITIAL}$`, 'u').test(w))) return
    const named = ws.filter((w) => IS_NAME_WORD.test(w))
    const ok = named.map((w) => nameOk(w, sure))
    const sureOne = named.some((w, i) => ok[i] && !WORD_NAMES.has(w.toLowerCase()))
    if (!named.every((w, i) => ok[i] || (sureOne && WORD_NAMES.has(w.toLowerCase())))) return
    if (ws.length > 1) put(ws.join(' '))
    for (const w of named) if (w.length >= 3 && !isStop(w)) put(w)
  }
  const fullName = (n: string) => {
    if (/^[가-힣]{2,4}$/.test(n)) { put(n); if (n.length === 3) given(n.slice(1)) }
    else person(n, 0)
  }
  /** a team account with a Latin name, when any of its forms is in the run: then all of them */
  const account = (n: string) => {
    const ws = n.split(/\s+/).filter((w) => IS_NAME_WORD.test(w))
    if (!ws.length) return
    const first = ws[0]!, last = ws.length > 1 ? ws[ws.length - 1]! : ''
    const forms = last ? [ws.join(' '), `${first} ${last[0]}.`] : []
    const named = forms.some(has) || (!!last && TITLES.some((t) => has(`${t}. ${last}`) || has(`${t} ${last}`)))
      || ws.some((w) => w.length >= 3 && !isStop(w) && (WORD_NAMES.has(w.toLowerCase()) ? asName(text, w) : has(w)))
    if (!named) return
    for (const f of forms) put(f)
    for (const w of ws) if (w.length >= 3 && !isStop(w)) put(w)
  }
  // the team's accounts named in the run
  for (const name of o.people) {
    const n = name.normalize('NFC').trim()
    if (!n) continue
    if (/^[가-힣]{2,4}$/.test(n)) {
      if (text.includes(n)) fullName(n)
      else if (n.length === 3 && new RegExp(`${n.slice(1)}\\s?(?:님|씨)`).test(text)) given(n.slice(1))
    } else account(n)
  }
  // the attendees of meeting notes, and the lines that name people ("Owner:", "Prepared by:", "Attn:"): parts split
  // by commas, "and" or a sentence's end, bracketed words and what follows a name in lower case ("joined late") dropped
  const listed = (line: string) => {
    for (const raw of line.replace(/\([^)]*\)/g, ' ').split(new RegExp(`[,，、·/;|]|\\s+및\\s+|\\s+(?:and|&)\\s+|(?<!(?:^|\\s)(?:${TITLES.join('|')}|\\p{Lu}))\\.(?:\\s+|$)`, 'u'))) {
      const n = raw.trim().replace(/^(?:and|&)\s+/, '').replace(/\s*(?:님|씨)$/, '').replace(new RegExp(`\\s*(?:${TITLE_WORDS})$`), '')
      if (/^[가-힣]{2,4}$/.test(n)) { if (!NOT_NAMES.has(n)) fullName(n); continue }
      const x = new RegExp(`^(?:${TITLE}\\.?[ \\t]+)?(${NAME})(?=[ \\t]+\\p{Ll}|[ \\t.:!?]*$)`, 'u').exec(n)
      if (x) person(x[1]!, 0)
    }
  }
  for (const x of text.matchAll(/(?:참석자?|참여자?)\s*[:：]\s*([^\n]+)/g)) listed(x[1]!)
  for (const x of text.matchAll(/(?<!\p{L})(?:attendees?|attendance|present|participants?|invited|invitees?|guests?|absent|apologies|regrets|owners?|assignees?|assigned to|facilitator|host|chair|note[- ]?taker|prepared by|requested by|approved by|attn|attention|contact|cc)(?:\*\*|__)?[ \t]*[:：][ \t]*(?:\*\*|__)?([^\n]+)/giu)) listed(x[1]!)
  // a name with a title: "Ms. Rivera", "Mr Chen", "Dr. Ana Ruiz" (that form, and the name without it)
  for (const x of text.matchAll(new RegExp(`${NB}(${TITLE})(\\.?)[ \\t]+(${NAME_WORD})(?:[ \\t]+(${NAME_WORD}))?${NE}`, 'gu'))) {
    const n = x[4] && nameOk(x[4], 0) ? `${x[3]} ${x[4]}` : x[3]!
    put(`${x[1]}${x[2]} ${n}`)
    person(n, 0)
  }
  // a name by its form: "Mike from sales", "Mike (sales)", "Sarah K."
  for (const x of text.matchAll(new RegExp(`${NB}(${NAME_WORD})(?:[ \\t](\\p{Lu})\\.)?(?:[ \\t]+from[ \\t]+(?:the[ \\t]+)?|[ \\t]*\\()(\\p{L}+)`, 'gu'))) {
    if (TEAMS.has(x[3]!.toLowerCase())) person(x[2] ? `${x[1]} ${x[2]}.` : x[1]!, 1)
  }
  for (const x of text.matchAll(new RegExp(`${NB}(${NAME_WORD})[ \\t](\\p{Lu})\\.${NE}`, 'gu'))) person(`${x[1]} ${x[2]}.`, 1)
  // a task's owner at the start of a line or a quote: "- Sarah: …", "- Dan to …", "- Priya — …", "\"Sarah K. to …",
  // when the name is said more than once in the run (a label said once is no one: "Tone: friendly")
  for (const x of text.matchAll(new RegExp(`(?:^|["“])[ \\t]*(?:(?:[-*•+]|\\d{1,2}[.)])[ \\t]+)?(?:\\[[ xX]\\][ \\t]*)?(?:\\*\\*)?(${NAME_WORD}(?:[ \\t](?:${NAME_WORD}|${INITIAL}))?)(?:\\*\\*)?(?=[ \\t]*[:：—–]|[ \\t]+-[ \\t]|[ \\t]+(?:to|will|owns|should|must|needs to)[ \\t]+\\p{Ll})`, 'gmu'))) {
    const first = x[1]!.split(/[ \t]/)[0]!
    if ([...text.matchAll(new RegExp(`${NB}${esc(first)}${NE}`, 'gu'))].length > 1) person(x[1]!, 2)
  }
  // a role's line that holds just a full name: "Account Executive: Nora Quinn", "Designer: Tom R." (the whole name
  // only: its first word may be a verb, "Next: Match Contoso", its last a company's, "Customer: Brightline Outdoor")
  for (const x of text.matchAll(new RegExp(`[:：][ \\t]+(${NAME_WORD})[ \\t](${NAME_WORD}|${INITIAL})[ \\t]*(?:[.(]|$)`, 'gmu'))) {
    if (nameOk(x[1]!, 1) && (!IS_NAME_WORD.test(x[2]!) || nameOk(x[2]!, 1))) put(`${x[1]} ${x[2]}`)
  }
  // a per-person heading of the answer ("### Sarah Klein", "**Mike**"), when a word of it is named outside the headings
  const HEADING = /^[ \t]*(?:#{1,6}[ \t]+(.+?)[ \t]*#*|(?:[-*][ \t]+)?\*\*([^*\n]+)\*\*[ \t]*:?)[ \t]*$/gm
  const body = text.replace(HEADING, '')
  for (const x of text.matchAll(HEADING)) {
    const h = (x[1] ?? x[2] ?? '').replace(/[ \t]*\([^)]*\)[ \t]*$/, '').replace(/(?:[ \t]+[—–|·-]|:)[ \t].*$/, '').replace(/:$/, '').trim()
    if (!new RegExp(`^${NAME}$`, 'u').test(h)) continue
    if (h.split(/\s+/).some((w) => w.length >= 3 && IS_NAME_WORD.test(w) && new RegExp(`${NB}${esc(w)}${NE}`, 'u').test(body))) person(h, 2)
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
  // up to five capitalized words before Inc, LLC, Ltd, Corp, Co … ("Northwind Traders, Inc."), without a sentence's
  // first words ("Ask …", "Client …"); and the first word of a longer name ("Brightline" of "Brightline Outdoor LLC")
  for (const x of text.matchAll(new RegExp(`${NB}(${CO_WORD}(?:[ \\t]+(?:${CO_WORD}|&|and|of)){0,4}),?[ \\t]+(?:${CO_SUFFIX})(?![\\p{L}\\p{N}-])`, 'gu'))) {
    const ws = x[1]!.split(/[ \t]+/)
    while (ws.length && (isStop(ws[0]!) || TITLES.includes(ws[0]!.replace(/\.$/, '')))) ws.shift()
    while (ws.length && /^(?:&|and|of)$/.test(ws[ws.length - 1]!)) ws.pop()
    if (!ws.length) continue
    put(ws.join(' '))
    const first = ws[0]!
    if (ws.length > 1 && first.length >= 4 && IS_NAME_WORD.test(first) && !CO_COMMON.has(first.toLowerCase()) && !inLower(first)) put(first)
  }
  // dates (a day, or a month of a year; a year alone is often a rule's own: "2024년 개정")
  const dates = [
    /\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g, /\b\d{4}[-./]\d{1,2}\b(?![-./]\d)/g, /\b20\d{6}\b/g, /(?<![\d,.])\d{1,2}\/\d{1,2}(?![\d/])/g,
    /(?<![\d,.])\d{1,2}\.\d{1,2}(?=\s?\((?:월|화|수|목|금|토|일)\))/g, /(?<![\d-])\d{2}-\d{2}(?![\d-])/g,
    /\d{1,2}월\s?\d{1,2}일/g, /\d{4}년\s?\d{1,2}월/g, /(?<!\d)\d{1,2}\s?\((?:월|화|수|목|금|토|일)\)/g,
    new RegExp(`${NB}(?:${MON})\\.?[ \\t]+\\d{4}${NE}`, 'gu'),
  ]
  for (const re of dates) for (const x of text.matchAll(re)) put(x[0])
  // a month's day in its written forms, each also as the others ("Nov 20" → "November 20", "November 20th", "11/20")
  const day = (mon: string, d: string) => {
    const i = MONTHS.findIndex((x) => x.slice(0, 3) === mon.slice(0, 3)), n = Number(d)
    if (i < 0 || n < 1 || n > 31) return
    const full = MONTHS[i]!, abbr = full.slice(0, 3)
    for (const f of [`${full} ${n}`, `${full} ${ordinal(n)}`, `${abbr} ${n}`, `${abbr}. ${n}`, ...(i === 8 ? [`Sept ${n}`, `Sept. ${n}`] : []), `${i + 1}/${n}`]) if (f !== `May. ${n}`) put(f)
  }
  for (const x of text.matchAll(new RegExp(`${NB}(${MON})\\.?[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?${NE}(?:,?[ \\t]+\\d{4}${NE})?`, 'gu'))) { put(x[0]); day(x[1]!, x[2]!) }
  for (const x of text.matchAll(new RegExp(`${NB}(\\d{1,2})(?:st|nd|rd|th)?[ \\t]+(?:of[ \\t]+)?(${MON})\\.?${NE}(?:,?[ \\t]+\\d{4}${NE})?`, 'gu'))) { put(x[0]); day(x[2]!, x[1]!) }
  // 11/03/2026, 11/3/26 (and the day without the year)
  for (const x of text.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g)) { put(x[0]); put(`${x[1]}/${x[2]}`); put(`${Number(x[1])}/${Number(x[2])}`) }
  // money (with its currency), and numbers of a million or more (a count such as 1,000개 is a rule's own)
  const amounts = [
    new RegExp(`[₩$€¥£][ \\t]?${NUM}(?:[kKmMbB](?!\\p{L})|[ \\t](?:thousand|million|billion)(?!\\p{L}))?`, 'gu'),
    /\d[\d,]*(?:\.\d+)?\s?(?:만\s?원|억\s?원|천\s?원|원|만원|달러|엔|USD|KRW|EUR|JPY|GBP|dollars?|euros?)(?![가-힣A-Za-z])/g,
    new RegExp(`(?<!\\p{L})(?:USD|US\\$|EUR|GBP|CAD|AUD)[ \\t]?${NUM}(?:[kKmM](?!\\p{L}))?`, 'gu'),
    /\b\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?\b/g,
    // a number with k or M is money only beside a budget word: "1.2k over budget" ("1.2k signups" is a count)
    new RegExp(`(?<![\\p{L}\\p{N}.,$])\\d+(?:\\.\\d+)?[kKmM]${NE}(?=(?:[ \\t]+\\p{L}+){0,2}?[ \\t]+(?:budget|spend|spending|revenue|cost|costs)${NE})`, 'gu'),
  ]
  for (const re of amounts) for (const x of text.matchAll(re)) put(x[0])
  for (const x of text.matchAll(new RegExp(`${NB}(?:budget|spend|spent|spending|cost|costs|revenue|fee|fees)(?:[ \\t]+\\p{L}+){0,2}?[ \\t]+(\\d+(?:\\.\\d+)?[kKmM])${NE}`, 'gu'))) put(x[1]!)
  // a document's number: Q-2026-0117, INV-0042
  for (const x of text.matchAll(/(?<![\w-])[A-Z]{1,4}-(?:\d{2,4}-)?\d{3,6}(?![\w-])/g)) put(x[0])
  // contact data
  for (const x of text.matchAll(CONTACT)) put(x[0])
  return [...out]
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
/** phone numbers (02-000-0000, 010 1234 5678, +82 10-…, (415) 555-0134, 415.555.0134, +1 415 555 0134) and
 * account-like numbers (000-000000-00-000) */
const PHONE = /(?<![\w-])(?:\+\d{1,3}[-.\s]?)?(?:0?\d{1,3}[-.\s]|\(\d{2,4}\)\s?)\d{3,4}[-.\s]\d{4}(?![\w-])/g
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
    // a listed path written out here, spaces and all ("groups/Acme Marketing/Meeting notes/"): the match stops at
    // the first space, so the text from the match on is compared; it must end there ("…/Meeting notes old/" is another)
    if (listed.some((f) => t.startsWith(f, x.index) && /^(?:$|[/`'")\]>,.;:]|\s+(?!\S*\/))/.test(t.slice(x.index + f.length)))) continue
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
    // a name that is also a word only where it reads as a name ("Mark each task" is the word)
    else if (WORD_NAMES.has(s.toLowerCase()) ? asName(text, s) : new RegExp(`(?<![A-Za-z0-9])${esc(s)}(?![A-Za-z0-9])`).test(text)) found.add(s)
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
