// The example story of the hands-on demo (format: web/demo/script.ts). The build plays it when scripts/demo/mina/ is
// not there. Short on purpose: it walks every part of the format once. Fictional company and people only.
import type { DemoScript } from '../script'

const PROJECT = '겨울 캠페인'

const script: DemoScript = {
  version: 1,
  locale: 'ko',
  company: { name: '예시상사' },
  visitor: 'mina',
  people: [
    { id: 'mina', name: '김미나', title: '마케팅 신입' },
    { id: 'lead', name: '한서윤', title: '마케팅팀장' },
    { id: 'ceo', name: '오대표', title: '대표' },
    { id: 'leo', name: '이레오', title: '디자이너' },
  ],
  groups: [{ id: 'mkt', name: '마케팅', members: ['mina', 'lead', 'leo', 'ceo'] }],
  rooms: [
    { id: 'all', kind: 'all', members: ['mina', 'lead', 'ceo', 'leo'], messages: [{ from: 'ceo', text: '오늘 미나님이 마케팅팀에 합류했어요. 다들 환영해 주세요!', minutesAgo: 30 }] },
    { id: 'mkt-room', kind: 'team', group: 'mkt', members: ['mina', 'lead', 'leo', 'ceo'], messages: [{ from: 'leo', text: '겨울 캠페인 배너 초안 올려 뒀어요.', files: [`projects/${PROJECT}/배너 초안.png`], minutesAgo: 50 }] },
    { id: 'dm-lead', kind: 'dm', members: ['mina', 'lead'] },
  ],
  projects: [
    {
      id: 'winter', name: PROJECT, description: '12월 겨울 할인 캠페인', members: ['mina', 'lead', 'leo', 'ceo'],
      chats: [{ id: 'leo-banner', title: '겨울 배너 초안', by: 'leo', turns: [{ ask: '겨울 할인 배너 초안 만들어 줘', answer: `초안을 만들었어요.\n\n![배너 초안]({{file:projects/${PROJECT}/배너 초안.png}})`, files: [`projects/${PROJECT}/배너 초안.png`] }] }],
    },
  ],
  files: [
    { path: `projects/${PROJECT}/배너 초안.png`, asset: 'banner-draft.png' },
    { path: `projects/${PROJECT}/캠페인 개요.md`, text: '# 겨울 캠페인\n\n- 기간: 12월 1일 ~ 31일\n- 핵심 문구: 따뜻한 겨울, 20% 할인\n' },
  ],
  home: { title: '신입사원 미나님, 입사를 축하합니다', prompt: '우리 회사는 뭐 하는 회사예요?' },
  answers: [
    {
      id: 'company', where: 'home', prompt: '우리 회사는 뭐 하는 회사예요?',
      steps: [{ label: '파일 읽기 · shared/회사 소개.md', tool: 'read' }, { label: '팀 스킬 보기', tool: 'glob' }],
      text: '**예시상사**는 생활용품을 온라인으로 파는 회사예요.\n\n- 미나님은 **마케팅팀**에서 캠페인을 맡아요.\n- 팀 스킬: 배너 만들기, 보도자료 쓰기\n- 인수인계가 필요하면 말씀해 주세요. 도와드릴게요.\n\nHiggsfield가 연결되어 있어서 이미지도 바로 만들 수 있어요.',
    },
    {
      id: 'fix-banner', where: { project: 'winter' }, label: '제목과 색 고치기', prompt: '배너 제목과 색을 더 눈에 띄게 고쳐 줘',
      steps: [{ label: `파일 읽기 · projects/${PROJECT}/캠페인 개요.md`, tool: 'read' }, { label: 'Higgsfield · 이미지 고치기', tool: 'higgsfield', ms: 1500 }, { label: `파일 저장 · projects/${PROJECT}/배너 v2.png`, tool: 'write' }],
      text: `제목을 키우고 겨울 느낌의 색으로 바꿨어요.\n\n![배너 v2]({{file:projects/${PROJECT}/배너 v2.png}})`,
      files: [{ path: `projects/${PROJECT}/배너 v2.png`, asset: 'banner-v2.png' }],
    },
    {
      id: 'new-bg', where: { project: 'winter' }, label: 'Higgsfield로 새 배경', prompt: 'Higgsfield로 새 배경을 만들어 줘',
      steps: [{ label: 'Higgsfield · 배경 이미지 만들기', tool: 'higgsfield', ms: 1800 }, { label: `파일 저장 · projects/${PROJECT}/배너 v2.png`, tool: 'write' }],
      text: `눈 내리는 배경으로 새로 만들었어요.\n\n![배너 v2]({{file:projects/${PROJECT}/배너 v2.png}})`,
      files: [{ path: `projects/${PROJECT}/배너 v2.png`, asset: 'banner-v2.png' }],
    },
    {
      id: 'mail', where: { side: 'mkt-room' }, prompt: '최종 배너를 메일로 보내 줘',
      text: '받는 사람은 인쇄소(print@example.com)로 할게요. 어떻게 보낼까요?',
      ask: {
        question: '메일을 어떻게 보낼까요?',
        options: [
          { label: '그대로 보내기', reply: { text: '초안이에요.\n\n> 안녕하세요, 겨울 배너 최종본 보냅니다.', ask: { question: 'Gmail로 이 메일을 보낼까요?', options: [{ label: '보내기', reply: { steps: [{ label: 'Gmail · 메일 보내기', tool: 'gmail' }], text: '보냈어요.\n\n> **받는 사람** print@example.com\n> 안녕하세요, 겨울 배너 최종본 보냅니다.' } }, { label: '취소', reply: { text: '보내지 않았어요.' } }] } } },
          { label: '더 정중하게 다듬기', reply: { text: '다듬은 초안이에요.\n\n> 안녕하세요, 예시상사 마케팅팀 김미나입니다. 겨울 캠페인 배너 최종본을 보내 드립니다. 확인 부탁드립니다.', ask: { question: 'Gmail로 이 메일을 보낼까요?', options: [{ label: '보내기', reply: { steps: [{ label: 'Gmail · 메일 보내기', tool: 'gmail' }], text: '보냈어요.\n\n> **받는 사람** print@example.com\n> 안녕하세요, 예시상사 마케팅팀 김미나입니다. 겨울 캠페인 배너 최종본을 보내 드립니다.' } }, { label: '취소', reply: { text: '보내지 않았어요.' } }] } } },
        ],
      },
    },
  ],
  events: [
    { id: 'dm-1', after: { answer: 'company' }, delayMs: 2000, room: 'dm-lead', from: 'lead', text: `미나님, 첫 업무예요. 레오님 배너가 좀 약해서요. {{project:winter}}에서 같이 다듬어 볼래요?` },
    { id: 'lead-reply', after: { shared: 'mkt-room' }, room: 'mkt-room', from: 'lead', text: '오, 훨씬 좋아졌네요!' },
    { id: 'ceo-ok', after: { event: 'lead-reply' }, delayMs: 2500, room: 'mkt-room', from: 'ceo', text: '좋아요, 이걸로 갑시다. 최종 파일 올려요.', files: [`projects/${PROJECT}/배너 최종.png`], newFiles: [{ path: `projects/${PROJECT}/배너 최종.png`, asset: 'banner-v2.png' }] },
    { id: 'gmail', after: { event: 'ceo-ok' }, delayMs: 2000, room: 'mkt-room', from: 'lead', text: 'Gmail도 연결해 뒀어요. 옆의 ✦ 트리나에게 인쇄소로 메일 보내 달라고 해 보세요.' },
  ],
  guide: [
    { id: 'ask', text: '다음: 회사에 대해 물어보기 →', go: 'home', highlight: '[data-testid="member-welcome-ask"]', until: { answer: 'company' } },
    { id: 'dm', text: '다음: 팀장 DM 열기 →', go: { room: 'dm-lead' }, after: { event: 'dm-1' }, until: { opened: { project: 'winter' } } },
    { id: 'banner', text: '다음: 배너 고치기 →', go: { project: 'winter' }, suggest: ['fix-banner', 'new-bg'], until: { answer: ['fix-banner', 'new-bg'] } },
    { id: 'share', text: '다음: #마케팅에 보내기 →', go: { project: 'winter' }, highlight: '[data-testid="share-to-room"]', until: { shared: 'mkt-room' } },
    { id: 'mail', text: '다음: ✦ 트리나에게 메일 부탁하기 →', go: { side: 'mkt-room' }, after: { event: 'gmail' }, suggest: ['mail'], until: { answer: 'mail' } },
  ],
  fallback: { text: '이 데모는 준비된 질문에만 답해요. 아래에서 하나 골라 보세요.', question: '이렇게 물어보세요' },
  end: {
    after: { answer: 'mail' },
    title: '첫날 끝',
    signup: { label: '우리 팀으로 시작하기', url: 'https://trina.app/' },
  },
}

export default script
