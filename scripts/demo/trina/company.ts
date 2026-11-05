// "트리나": a FICTIONAL 15-person company for `bun run demo:trina` (scripts/demo/trina/README.md). Every person, customer,
// number and document is made up. The viewer is 한지우, who joined the 마케팅팀 today; the demo can also show the
// same question asked as the team lead and as the CEO (docs/DECISIONS.md "Demo company: a new hire at 트리나").
//
// The team's owner is a separate account, `trina-admin`, with a random password of its own (start.ts writes it to the
// data folder, 0600): the demo can be open to every network the Mac is on and the demo people's password is public, so
// no demo person may be the owner or an admin (an owner or admin can reach the Mac through admin screens). The CEO,
// 정해온, is a member who reads more through folder rules.
//
// Who sees what (folder rules, set through the same REST API as Admin › 폴더 권한):
//   shared/ (공용)                    everyone (규정, 신입 온보딩 가이드, 사내 용어집, 전사 회의록)
//   groups/<team>/                    that team (made with the group); the CEO reads every team folder (`groups`), so
//                                     인사팀's 급여표 and 평가 are for 인사팀 and the CEO
//   shared/경영/                      the CEO only (write): the company-wide budget
//   shared/경영/팀별/<team>/          that team's lead (read) and the CEO: each lead sees their own team's budget sheet
//   skills/marketing/                 마케팅팀 and the CEO (read): the two skills from the marketing pack
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DemoFile } from '../../../shared/src/api'
import { DEMO_PASSWORD, type DemoCompany, type DemoPerson } from '../seed'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')
const PACK = path.join(ROOT, 'resources', 'skill-packs', 'marketing', 'ko')

export const TRINA_TEAMS = ['마케팅팀', '영업팀', '인사팀', '경영지원'] as const
type Team = (typeof TRINA_TEAMS)[number]
const person = (username: string, name: string, group: Team | null, role: DemoPerson['role'] = 'member'): DemoPerson => ({ username, name, role, group })

/** the team's owner: not a person of the company, never a demo person (its password: start.ts ownerPassword) */
export const TRINA_OWNER = 'trina-admin'
export const TRINA_PEOPLE: DemoPerson[] = [
  person(TRINA_OWNER, '데모 관리자', null, 'owner'),
  person('haeon', '정해온', null), // 대표 (a member)
  person('minjae', '서민재', '마케팅팀'), // 마케팅팀 팀장
  person('haneul', '이하늘', '마케팅팀'),
  person('doyoon', '김도윤', '마케팅팀'),
  person('yuna', '최유나', '마케팅팀'),
  person('jiwoo', '한지우', '마케팅팀'), // 오늘 입사한 신입
  person('woojin', '권우진', '영업팀'), // 영업팀 팀장
  person('sungmin', '배성민', '영업팀'),
  person('chaewon', '임채원', '영업팀'),
  person('daeun', '노다은', '영업팀'),
  person('seoyoon', '문서윤', '인사팀'), // 인사팀 팀장
  person('eunbi', '조은비', '인사팀'),
  person('jaehee', '류재희', '경영지원'), // 경영지원 팀장
  person('yoonseo', '탁윤서', '경영지원'),
  person('haram', '장하람', '경영지원'),
]
/** each team's lead (username) */
export const TRINA_LEADS: Record<Team, string> = { 마케팅팀: 'minjae', 영업팀: 'woojin', 인사팀: 'seoyoon', 경영지원: 'jaehee' }
export const TRINA_NEW_HIRE = 'jiwoo'
export const TRINA_CEO = 'haeon'

const teamOf = (username: string) => TRINA_PEOPLE.find((p) => p.username === username)?.group ?? null

export const TRINA: DemoCompany = {
  teamName: '트리나',
  people: TRINA_PEOPLE,
  groups: [
    { name: '마케팅팀', description: '캠페인, 광고, 콘텐츠' },
    { name: '영업팀', description: '고객사, 체험 박스, 계약' },
    { name: '인사팀', description: '채용, 평가, 급여, 복지' },
    { name: '경영지원', description: '비용, 장비, 계약 관리' },
  ],
  rules: [
    { path: 'groups', rules: [{ user: 'haeon', access: 'read' }], why: 'the CEO (haeon): read every team folder' },
    { path: 'shared/경영', rules: [{ everyone: true, access: 'none' }, { user: 'haeon', access: 'write' }], why: 'everyone: none, the CEO (haeon): write' },
    ...TRINA_TEAMS.map((t) => ({ path: `shared/경영/팀별/${t}`, rules: [{ user: TRINA_LEADS[t], access: 'read' as const }], why: `${t} lead (${TRINA_LEADS[t]}): read` })),
    // the CEO too: what the marketing skills say may then be saved in the marketing folder, which the CEO reads, without
    // a "wider audience" card in the middle of a marketing answer
    { path: 'skills/marketing', rules: [{ everyone: true, access: 'none' }, { group: '마케팅팀', access: 'read' }, { user: 'haeon', access: 'read' }], why: '마케팅팀 and the CEO: read, everyone else: none' },
  ],
  filesDir: path.join(import.meta.dir, 'files'),
  uploaderOf(rel) {
    if (rel.startsWith('groups/')) {
      const team = rel.split('/')[1] as Team
      // the meeting notes are written by a team member, the rest by the lead
      if (team === '마케팅팀' && rel.includes('/회의록/')) return 'yuna'
      return TRINA_LEADS[team] ?? TRINA_OWNER
    }
    if (rel.startsWith('shared/규정/') || rel === 'shared/신입-온보딩-가이드.md') return TRINA_LEADS.인사팀
    if (rel.startsWith('shared/회의록/')) return TRINA_LEADS.경영지원
    // team skills and rules: only the owner writes skills/
    if (rel.startsWith('skills/')) return TRINA_OWNER
    return TRINA_CEO
  },
  // two skills of the marketing pack, where the pack installs them (server/src/onboarding/skill-packs.ts)
  extraFiles: ['weekly-report', 'ad-copy'].map((name) => ({ rel: `skills/marketing/${name}/SKILL.md`, source: path.join(PACK, name, 'SKILL.md') })),
  // answers without sub-agents: quicker on a phone, and every recorded answer is one agent's (record.ts); a Korean
  // company's clock, whatever the Mac's
  settings: { aiSubagents: false, timeZone: 'Asia/Seoul' },
  // the new hire's answers in Korean from the first word: without it the AI wrote a short English line before looking at
  // images ("Let me view the images."), the first thing a viewer read in the card news scene (recorded with this memory)
  memories: [{ username: TRINA_NEW_HIRE, text: '한지우는 작업 중간에 나오는 안내까지 모두 한국어로 받는 걸 좋아해요. 영어 문장은 읽기 어려워해요.' }],
  profile: {
    website: 'https://trina-box.example',
    name: '트리나',
    oneLine: '사무실에 커피와 간식을 정기 배송하는 구독 서비스 트리나 박스를 운영해요.',
    products: '트리나 박스 베이직(월 19만 원부터), 트리나 박스 플러스(월 39만 원부터), 연말·행사용 간식 박스',
    audience: '직원 10~100명 사무실의 총무·경영지원 담당자',
    tone: ['친근하게', '짧고 또렷하게', '과장 없이'],
    avoid: '최고·1등 같은 최상급 비교, 확인되지 않은 건강 효능',
    sources: [],
  },
}

export const SAME_QUESTION = '이번 분기 예산 요약해 줘'

/** "…예요" after a vowel, "…이에요" after a final consonant (서민재예요, 정해온이에요) */
export const copula = (word: string) => {
  const c = word.normalize('NFC').charCodeAt(word.length - 1) - 0xac00
  return c >= 0 && c < 11172 && c % 28 !== 0 ? '이에요' : '예요'
}

/** The demo file the server reads with MYCEL_DEMO (shared/src/api/demo.ts DemoFile). */
/** the showcase prompts (scripts/demo/trina/scenarios.ts records them; Home suggests them once recorded) */
export const SHOWCASE = {
  cardNews: '11월 캠페인 카드뉴스 5장을 우리 제품 이미지로 만들어 줘',
  proposal: 'A사 제안서 형식으로 B사 제안서 만들어 줘. 구성은 예산 안에서 알아서 정해 줘',
  report: '10월 채널별 성과를 보고서용 엑셀로 정리하고 차트로도 보여 줘',
  letter: '협회에서 온 한글 공문 읽고 회신 초안을 워드 파일로 만들어 줘',
} as const

/** where the recorded real answers are (record.ts writes them, the demo server replays them) */
export const TRINA_RECORDINGS = path.join(import.meta.dir, 'recordings')

/**
 * The demo file the server reads with MYCEL_DEMO (shared/src/api/demo.ts DemoFile). `replays`: the folder of recorded
 * answers (none while recording); a showcase prompt is suggested only when that person's recording of it is there.
 */
export function trinaDemoFile(o: { replays?: string | null } = {}): DemoFile {
  const name = (u: string) => TRINA_PEOPLE.find((p) => p.username === u)!.name
  const lead = TRINA_LEADS.마케팅팀
  const recorded = (slug: string) => !!o.replays && fs.existsSync(path.join(o.replays, `${slug}.json`))
  const show = (pairs: [string, string][]) => pairs.filter(([slug]) => recorded(slug)).map(([, prompt]) => prompt)
  return {
    company: TRINA.teamName,
    password: DEMO_PASSWORD,
    sameQuestion: SAME_QUESTION,
    ...(o.replays ? { replays: o.replays } : {}),
    personas: [
      {
        key: 'newHire',
        username: TRINA_NEW_HIRE,
        intro: `오늘 트리나 ${teamOf(TRINA_NEW_HIRE)}에 입사한 ${name(TRINA_NEW_HIRE)}${copula(name(TRINA_NEW_HIRE))}`,
        questions: ['우리 회사 휴가 규정 알려줘', '이번 주 마케팅팀 회의록에서 내 할 일 정리해 줘', '신입 첫 주에 뭘 하면 돼?',
          ...show([['newhire-cardnews', SHOWCASE.cardNews], ['newhire-proposal', SHOWCASE.proposal]])],
      },
      {
        key: 'lead',
        username: lead,
        intro: `트리나 ${teamOf(lead)} 팀장 ${name(lead)}${copula(name(lead))}`,
        questions: [SAME_QUESTION, ...show([['lead-proposal', SHOWCASE.proposal], ['lead-report', SHOWCASE.report], ['lead-letter', SHOWCASE.letter]])],
      },
      {
        key: 'ceo',
        username: TRINA_CEO,
        intro: `트리나 대표 ${name(TRINA_CEO)}${copula(name(TRINA_CEO))}`,
        questions: [SAME_QUESTION, '상반기 평가 결과 요약해 줘'],
      },
    ],
  }
}

/** Where the owner's password is kept: <demo folder>/owner-password, readable by this Mac user only. */
export const ownerPasswordFile = (home: string) => path.join(home, 'owner-password')

/** The owner's password: read from the demo folder, or made (random, 0600) the first time. `created`: show it once. */
export function ensureOwnerPassword(home: string): { password: string; created: boolean; file: string } {
  const file = ownerPasswordFile(home)
  try {
    const password = fs.readFileSync(file, 'utf8').trim()
    if (password.length >= 16) return { password, created: false, file }
  } catch {}
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const password = crypto.randomBytes(18).toString('base64url')
  fs.writeFileSync(file, password + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return { password, created: true, file }
}
