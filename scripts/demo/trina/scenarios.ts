// What the 트리나 demo shows besides what the viewer asks (docs/DECISIONS.md "Demo company: a new hire at 트리나", round 2):
// prompts each demo person ran once with the real AI (scripts/demo/trina/record.ts writes them to recordings/).
// - showcase: suggested on that person's Home; sending it replays the recorded answer at a natural pace.
// - history: seeded as that person's past chats (`daysAgo`), so their sidebar shows what was done before.
// Each prompt only needs files that person can open (record.ts runs it as them; the replay runs its tools as them).
import { SHOWCASE, TRINA_CEO, TRINA_LEADS, TRINA_NEW_HIRE } from './company'

export interface Scenario { slug: string; username: string; prompt: string; kind: 'showcase' | 'history'; daysAgo?: number }

const lead = TRINA_LEADS.마케팅팀

export const SCENARIOS: Scenario[] = [
  // the new hire: two scenes to try, and what they did before starting
  { slug: 'newhire-cardnews', username: TRINA_NEW_HIRE, kind: 'showcase', prompt: SHOWCASE.cardNews },
  { slug: 'newhire-proposal', username: TRINA_NEW_HIRE, kind: 'showcase', prompt: SHOWCASE.proposal },
  { slug: 'newhire-brand', username: TRINA_NEW_HIRE, kind: 'history', daysAgo: 1, prompt: '입사 전에 읽어 둘 수 있게 브랜드 가이드 핵심만 5줄로 정리해 줘' },
  { slug: 'newhire-quiz', username: TRINA_NEW_HIRE, kind: 'history', daysAgo: 0, prompt: '사내 용어집으로 혼자 풀어 볼 퀴즈 5문제를 화면에서 바로 풀 수 있게 만들어 줘' },
  // the marketing lead: three scenes, and a week of work
  { slug: 'lead-proposal', username: lead, kind: 'showcase', prompt: SHOWCASE.proposal },
  { slug: 'lead-report', username: lead, kind: 'showcase', prompt: SHOWCASE.report },
  { slug: 'lead-letter', username: lead, kind: 'showcase', prompt: SHOWCASE.letter },
  { slug: 'lead-todos', username: lead, kind: 'history', daysAgo: 6, prompt: '10월 27일 마케팅 주간회의 회의록에서 할 일만 뽑아서 담당·기한 엑셀로 팀 폴더에 저장해 줘' },
  { slug: 'lead-blog', username: lead, kind: 'history', daysAgo: 5, prompt: '트리나 박스 플러스를 소개하는 블로그 글 초안을 브랜드 가이드 말투로 써 줘' },
  { slug: 'lead-weekly', username: lead, kind: 'history', daysAgo: 4, prompt: '지난주 회의록이랑 캠페인 기획안 보고 마케팅팀 주간 보고 초안 써 줘' },
  { slug: 'lead-adcopy', username: lead, kind: 'history', daysAgo: 3, prompt: '연말 시즌 박스 인스타그램 광고 문구 3안 써 줘' },
  { slug: 'lead-competitors', username: lead, kind: 'history', daysAgo: 2, prompt: '경쟁사 3곳 연말 프로모션 비교표를 엑셀로 만들어 줘' },
  // the CEO: the whole company at a glance
  { slug: 'ceo-sales', username: TRINA_CEO, kind: 'history', daysAgo: 6, prompt: '영업팀 고객사 현황에서 플랜별 고객 수와 월 매출을 표로 요약해 줘' },
  { slug: 'ceo-schedule', username: TRINA_CEO, kind: 'history', daysAgo: 5, prompt: '매주 월요일 오전 9시에 내가 볼 수 있는 지난주 회의록을 모두 모아서 주간 보고를 써서 내 폴더에 저장하는 예약 작업 만들어 줘' },
  { slug: 'ceo-notice', username: TRINA_CEO, kind: 'history', daysAgo: 4, prompt: '11월 2일 전사 회의록으로 전 직원 공지문 초안 워드 파일로 만들어 줘' },
  { slug: 'ceo-review', username: TRINA_CEO, kind: 'history', daysAgo: 3, prompt: '상반기 평가 결과를 팀별로 요약한 보고서를 워드로 만들어 줘' },
  { slug: 'ceo-churn', username: TRINA_CEO, kind: 'history', daysAgo: 2, prompt: '해지 예정인 고객사와 이유를 정리하고 붙잡을 방법을 제안해 줘' },
  { slug: 'ceo-budget-chart', username: TRINA_CEO, kind: 'history', daysAgo: 1, prompt: '4분기 팀별 예산 집행률을 차트로 보여 줘' },
]
