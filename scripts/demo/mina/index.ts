// "미나의 첫날": the Korean story of the hands-on demo (format: web/demo/script.ts). 차곡 is a fictional company; every
// person, number, address and file here is made up (scripts/demo/mina/README.md). Pictures and text files are in
// ./assets, and ./source shows how the pictures were made.
import type { DemoAnswer, DemoAsk, DemoReply, DemoScript } from '../../../web/demo/script'

const P = '11월 런칭 캠페인'
const LEO_BANNER = `projects/${P}/런칭배너_레오_v1.png`
const BANNER_A = `projects/${P}/런칭배너_v2.png`
const BANNER_B = `projects/${P}/런칭배너_v3_새배경.png`
const BG_B = `projects/${P}/배경_유자생강.png`
const FINAL = `projects/${P}/런칭배너_최종.png`
/** The CEO's final file. The format has no "the banner the visitor made", so it is version A, the first suggestion;
 * if the engine learns to pick the asset of the banner answer that finished, use banner-b.png after `banner-b`. */
const FINAL_ASSET = 'banner-a.png'
const GUIDE = 'shared/브랜드 가이드.md'
const BRIEF = `groups/마케팅/${P} 브리프.md`

// ---- the mail to the agency: two drafts, one confirm card each, one sent line each

const TO = '김지훈 실장님 (jihoon.kim@mulgyeol.example)'
const ATTACH = '런칭배너_최종.png'

const plainMail = {
  subject: '[차곡] 11월 런칭 배너 최종본 보내드립니다',
  body: [
    '김 실장님, 안녕하세요. 차곡 마케팅팀 윤미나입니다.',
    '이번에 새로 합류해서, 앞으로 배너 작업은 제가 연락드릴게요.',
    '',
    '11월 런칭 캠페인 배너 최종본 보내드립니다. 대표님 확인까지 마쳤어요.',
    '- 크기: 1200×628',
    '- 게재: 11월 23일(월)부터',
    '',
    '인스타그램용 1080×1080이 필요하시면 말씀해 주세요.',
    '감사합니다.',
    '윤미나 드림',
  ],
}

const politeMail = {
  subject: '[차곡] 11월 런칭 캠페인 배너 최종본 송부드립니다',
  body: [
    '김지훈 실장님께,',
    '',
    '안녕하십니까. 차곡 마케팅팀에 새로 합류한 윤미나입니다.',
    '늘 저희 캠페인을 도와주셔서 감사드립니다.',
    '',
    '11월 런칭 캠페인 배너의 최종본을 첨부하여 송부드립니다.',
    '내부 검토와 대표님 승인을 모두 마친 파일입니다.',
    '- 크기: 1200×628',
    '- 게재 시작: 11월 23일(월)',
    '',
    '인스타그램용 1080×1080 크기가 필요하시면 말씀해 주십시오. 바로 준비하겠습니다.',
    '앞으로 잘 부탁드립니다.',
    '',
    '윤미나 올림',
  ],
}

type Mail = typeof plainMail
const draft = (m: Mail) =>
  `**받는 사람** ${TO}\n**제목** ${m.subject}\n**첨부** ${ATTACH}\n\n${m.body.map((l) => (l ? `> ${l}` : '>')).join('\n')}`
const sent = (m: Mail): DemoReply => ({
  steps: [{ label: 'Gmail · 메일 보내기', tool: 'gmail', ms: 1200 }],
  text: `보냈어요. 김지훈 실장님께 **${ATTACH}**를 첨부해서 "${m.subject}"로 보냈어요.\n\nGmail 보낸편지함에서도 볼 수 있어요.`,
})
const notSent: DemoReply = { text: '보내지 않았어요. 고칠 곳을 말씀해 주시면 다시 써 드릴게요.' }
/** the confirm card under a draft; `polish` adds "더 정중하게" (the plain draft only) */
const confirm = (m: Mail, polish: boolean): DemoAsk => ({
  question: 'Gmail로 이 메일을 보낼까요?',
  options: [
    { label: '보내기', reply: sent(m) },
    ...(polish
      ? [{ label: '더 정중하게 다듬기', reply: { text: `더 정중하게 다듬었어요.\n\n${draft(politeMail)}`, ask: confirm(politeMail, false) } }]
      : []),
    { label: '취소', reply: notSent },
  ],
})
const mailSteps = [
  { label: 'Gmail · 메일 찾기 "김지훈 실장"', tool: 'gmail', ms: 1100 },
  { label: `파일 읽기 · ${FINAL}`, tool: 'read' },
]

// ---- the AI answers

const answers: DemoAnswer[] = [
  {
    id: 'company',
    where: 'home',
    prompt: '우리 회사는 뭐 하는 회사예요?',
    steps: [
      { label: '파일 읽기 · shared/회사소개.md', tool: 'read' },
      { label: `파일 읽기 · ${BRIEF}`, tool: 'read' },
      { label: '팀 스킬 보기', tool: 'glob', ms: 500 },
    ],
    text: [
      '**차곡**은 찬물에 넣어 두기만 하면 되는 **콜드브루 티백**을 만드는 회사예요. 성수동에서 12명이 일하고, 온라인 몰과 카페·사무실 납품으로 팔아요. 11월 23일에는 겨울 한정 **유자생강 블렌드**가 나와요.',
      '',
      '미나님은 마케팅팀에서 **런칭 배너와 SNS 디자인**을 맡게 돼요. 팀장은 박서연님이에요.',
      '',
      '바로 쓸 수 있는 팀 스킬이에요.',
      '- **SNS 카피 3안**: 제품만 말하면 인스타 문구를 세 가지로 써 줘요',
      '- **보도자료 초안**: 출시 소식을 보도자료 형식으로 정리해요',
      '- **경쟁사 요약**: 다른 차 브랜드 소식을 표 한 장으로 묶어요',
      '',
      '배너와 SNS는 레오님이 하던 일을 이어받아요. **인수인계 도와드릴까요?**',
      '',
      '이미지는 Higgsfield가 연결돼 있어서 저한테 말만 하면 만들어 드려요.',
    ].join('\n'),
  },
  {
    // not in the guide: there for a visitor who says yes to the handover offer
    id: 'handover',
    where: 'any',
    label: '인수인계 도와줘',
    prompt: '인수인계 도와줘',
    steps: [
      { label: '스킬 사용 · 인수인계 도우미', tool: 'read', ms: 500 },
      { label: `파일 읽기 · ${BRIEF}`, tool: 'read' },
      { label: `파일 목록 · projects/${P}`, tool: 'glob' },
    ],
    text: [
      '레오님께 이어받을 일이에요.',
      '',
      '| 일 | 지금 상태 | 마감 |',
      '|---|---|---|',
      '| 런칭 배너 1200×628 | 레오님 1차안 있음 | 11월 18일(수) |',
      '| 인스타그램 피드 3장 | 시작 전 | 11월 20일(금) |',
      '',
      `배너 1차안은 {{project:launch}}에 있어요. 밖에서는 물결 에이전시 김지훈 실장님이 배너를 받아 11월 23일부터 게재해요.`,
      '',
      '마감이 가장 빠른 **런칭 배너**부터 보시면 돼요.',
    ].join('\n'),
  },
  {
    id: 'banner-a',
    where: { project: 'launch' },
    label: '제목 크게, 브랜드 색으로',
    prompt: '제목을 크게, 브랜드 색으로 정리해줘',
    steps: [
      { label: `파일 읽기 · ${GUIDE}`, tool: 'read' },
      { label: `파일 읽기 · ${LEO_BANNER}`, tool: 'read' },
      { label: '배너 만들기 · 1200×628', tool: 'write', ms: 1600 },
      { label: `파일 저장 · ${BANNER_A}`, tool: 'write' },
    ],
    text: [
      '브랜드 가이드에 맞춰 정리했어요.',
      '',
      '- **제목을 크게**: "겨울엔, 유자생강" 한 줄만 크게 두고, 나머지는 작게 내렸어요',
      '- **브랜드 색**: 하늘색·분홍 대신 찻잎 그린과 크림을 쓰고, 할인만 유자 옐로로 눈에 띄게 했어요',
      '- **글꼴**: 가이드대로 Pretendard로 바꿨어요',
      '- **로고**: 오른쪽 아래에서 왼쪽 위로 옮겼어요',
      '',
      `![런칭배너 v2]({{file:${BANNER_A}}})`,
      '',
      '레오님 원본은 그대로 두었어요.',
    ].join('\n'),
    files: [{ path: BANNER_A, asset: 'banner-a.png' }],
  },
  {
    id: 'banner-b',
    where: { project: 'launch' },
    label: 'Higgsfield로 새 배경',
    prompt: 'Higgsfield로 새 배경 이미지 만들어서 넣어줘',
    steps: [
      { label: `파일 읽기 · ${GUIDE}`, tool: 'read' },
      { label: 'Higgsfield · 배경 이미지 만들기 (찻잎 그린, 유자 조각, 부드러운 빛)', tool: 'higgsfield', ms: 2600 },
      { label: `파일 저장 · ${BG_B}`, tool: 'write' },
      { label: '배너 만들기 · 1200×628', tool: 'write', ms: 1400 },
      { label: `파일 저장 · ${BANNER_B}`, tool: 'write' },
    ],
    text: [
      'Higgsfield로 배경을 새로 만들어 넣었어요.',
      '',
      '- **배경**: 짙은 찻잎 그린 위에 유자 조각과 잎이 흐릿하게 보이는 사진 느낌으로 만들었어요',
      '- **글씨**: 크림색으로 바꿔서 짙은 배경에서도 잘 읽혀요',
      '- **할인**: 유자 옐로 배지 하나만 그대로 두었어요',
      '',
      `![런칭배너 v3]({{file:${BANNER_B}}})`,
      '',
      '배경만 따로 쓰실 수 있게 같은 폴더에 저장해 두었어요.',
    ].join('\n'),
    files: [
      { path: BG_B, asset: 'bg-b.png' },
      { path: BANNER_B, asset: 'banner-b.png' },
    ],
  },
  {
    id: 'mail',
    where: { side: 'mkt-room' },
    label: '김 실장님께 메일 보내기',
    prompt: '이 배너 김 실장님께 메일로 보내줘',
    steps: mailSteps,
    text: `메일 초안이에요. 받는 분 주소는 지난 메일에서 찾았어요.\n\n${draft(plainMail)}`,
    ask: confirm(plainMail, true),
  },
  {
    id: 'mail-polite',
    where: { side: 'mkt-room' },
    label: '더 정중하게 써서 보내기',
    prompt: '좀 더 정중하게 써서 보내줘',
    steps: mailSteps,
    text: `정중하게 써 봤어요. 받는 분 주소는 지난 메일에서 찾았어요.\n\n${draft(politeMail)}`,
    ask: confirm(politeMail, false),
  },
]

const script: DemoScript = {
  version: 1,
  locale: 'ko',
  company: { name: '차곡' },
  visitor: 'mina',
  people: [
    { id: 'mina', name: '윤미나', title: '마케팅 · 오늘 입사', avatar: 'avatar-mina.png' },
    { id: 'seoyeon', name: '박서연', title: '마케팅팀장', avatar: 'avatar-seoyeon.png' },
    { id: 'woojin', name: '정우진', title: '대표', avatar: 'avatar-woojin.png' },
    { id: 'leo', name: '강레오', title: '마케팅 (11월 23일부터 영업)', avatar: 'avatar-leo.png' },
    { id: 'doyun', name: '한도윤', title: '운영팀장', avatar: 'avatar-doyun.png' },
    { id: 'haeun', name: '최하은', title: '영업', avatar: 'avatar-haeun.png' },
    { id: 'jisu', name: '오지수', title: '개발 · 온라인 몰', avatar: 'avatar-jisu.png' },
  ],
  groups: [{ id: 'mkt', name: '마케팅', members: ['mina', 'seoyeon', 'leo', 'woojin'] }],
  rooms: [
    {
      id: 'all',
      kind: 'all',
      members: ['mina', 'seoyeon', 'woojin', 'leo', 'doyun', 'haeun', 'jisu'],
      messages: [
        { from: 'woojin', text: '오늘 마케팅팀에 윤미나님이 합류했어요. 다들 환영해 주세요 🎉', minutesAgo: 40 },
        { from: 'doyun', text: '미나님 환영합니다! 주문·배송 궁금한 건 운영팀에 편하게 물어보세요.', minutesAgo: 38 },
        { from: 'haeun', text: '반가워요 미나님 ☺️ 카페 납품용 자료도 나중에 같이 봐요.', minutesAgo: 35 },
        { from: 'jisu', text: '환영해요! 몰 배너 올릴 때 저 부르시면 돼요.', minutesAgo: 33 },
      ],
    },
    {
      id: 'mkt-room',
      kind: 'team',
      group: 'mkt',
      members: ['mina', 'seoyeon', 'leo', 'woojin'],
      messages: [
        { from: 'leo', text: '11월 런칭 배너 1차안 프로젝트에 올려 뒀어요. 의견 주세요!', files: [LEO_BANNER], minutesAgo: 70 },
        { from: 'seoyeon', text: '고마워요 레오님. 브랜드 가이드랑 한번 맞춰 볼게요.', minutesAgo: 62 },
      ],
    },
    { id: 'dm-lead', kind: 'dm', members: ['mina', 'seoyeon'] },
  ],
  projects: [
    {
      id: 'launch',
      name: P,
      description: '겨울 한정 유자생강 블렌드 출시 (11.23 ~ 12.6)',
      members: ['mina', 'seoyeon', 'leo', 'woojin'],
      chats: [
        {
          id: 'leo-banner',
          title: '런칭 배너 1차안',
          by: 'leo',
          turns: [
            {
              ask: '유자생강 블렌드 출시 배너 만들어줘. 20% 할인, 11/23~12/6',
              answer: `배너 1차안을 만들었어요.\n\n![런칭배너 1차안]({{file:${LEO_BANNER}}})`,
              files: [LEO_BANNER],
            },
          ],
        },
      ],
    },
  ],
  files: [
    { path: 'shared/회사소개.md', asset: '회사소개.md' },
    { path: GUIDE, asset: '브랜드 가이드.md' },
    { path: BRIEF, asset: `${P} 브리프.md` },
    { path: LEO_BANNER, asset: 'banner-leo.png' },
    // team skills, at the path the product keeps them (skills/<name>/SKILL.md)
    { path: 'skills/sns-copy-3/SKILL.md', asset: 'skill-sns-copy-3.md' },
    { path: 'skills/press-release-draft/SKILL.md', asset: 'skill-press-release-draft.md' },
    { path: 'skills/competitor-summary/SKILL.md', asset: 'skill-competitor-summary.md' },
    { path: 'skills/handover-helper/SKILL.md', asset: 'skill-handover-helper.md' },
  ],
  home: { title: '신입사원 미나님, 입사를 축하합니다', prompt: '우리 회사는 뭐 하는 회사예요?' },
  answers,
  events: [
    {
      id: 'dm-1',
      after: { answer: 'company' },
      delayMs: 2500,
      room: 'dm-lead',
      from: 'seoyeon',
      text: '미나님, 디자인 잘한다고 하셨죠? 레오님이 만든 런칭 배너인데 한번 개선해 볼래요? 우리 브랜드 가이드 참고하면 돼요.\n\n{{project:launch}}',
    },
    { id: 'lead-reply', after: { shared: 'mkt-room' }, delayMs: 2000, room: 'mkt-room', from: 'seoyeon', text: '오 훨씬 좋네요! 대표님, 이거로 진행해도 될까요?' },
    { id: 'leo-cheer', after: { event: 'lead-reply' }, delayMs: 1500, room: 'mkt-room', from: 'leo', text: '와 깔끔하네요 👍 마음 편하게 넘기겠어요.' },
    {
      id: 'ceo-ok',
      after: { event: 'leo-cheer' },
      delayMs: 2500,
      room: 'mkt-room',
      from: 'woojin',
      text: '좋네요, 진행하세요 👍',
      files: [FINAL],
      newFiles: [{ path: FINAL, asset: FINAL_ASSET }],
    },
    {
      id: 'gmail',
      after: { event: 'ceo-ok' },
      delayMs: 2000,
      room: 'mkt-room',
      from: 'seoyeon',
      text: '미나님, 우리 Gmail 연결돼 있어요. 트리나한테 에이전시 김 실장님께 보내 달라고 하면 돼요.',
    },
  ],
  guide: [
    { id: 'ask', text: '다음: 회사에 대해 물어보기 →', go: 'home', highlight: '[data-testid="member-welcome-ask"]', until: { answer: 'company' } },
    { id: 'dm', text: '다음: 팀장님 메시지 열기 →', go: { room: 'dm-lead' }, after: { event: 'dm-1' }, until: { opened: { project: 'launch' } } },
    { id: 'banner', text: '다음: 배너 고치기 →', go: { project: 'launch' }, suggest: ['banner-a', 'banner-b'], until: { answer: ['banner-a', 'banner-b'] } },
    { id: 'share', text: '다음: #마케팅에 보내기 →', go: { project: 'launch' }, highlight: '[data-testid="share-to-room"]', until: { shared: 'mkt-room' } },
    { id: 'mail', text: '다음: ✦ 트리나에게 메일 부탁하기 →', go: { side: 'mkt-room' }, after: { event: 'gmail' }, suggest: ['mail', 'mail-polite'], until: { answer: ['mail', 'mail-polite'] } },
  ],
  fallback: { text: '이 데모는 추천 질문으로 움직여요. 아래에서 하나 눌러 보세요.', question: '이렇게 물어보세요' },
  end: {
    after: { answer: ['mail', 'mail-polite'] },
    title: '미나의 첫날, 끝',
    body: '회사 파악부터 배너 수정, 대표님 승인, 에이전시 메일까지. 입사 첫날 트리나와 함께 끝냈어요.\n\n우리 팀도 이렇게 일해 보세요.',
    signup: { label: '우리 팀으로 시작하기', url: 'https://trina.app/' },
    explore: { label: '자유롭게 둘러보기' },
  },
}

export default script
