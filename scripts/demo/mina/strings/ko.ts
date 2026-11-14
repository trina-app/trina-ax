// 데모 이야기의 모든 한국어 문장 (strings/en.ts 를 옮긴 것). 한국 회사의 슬랙 말투: 동료끼리 존댓말, 가볍지만 예의 있게.
// 그림과 팀 파일은 ../assets 의 `.ko.` 파일, 배너 문구는 ../source/banners/copy.ko.json.
//
// Plain strings only. `{project}` in a text becomes a link to the campaign project; {time}, {subject}, {reply} are
// filled in by the story (../story.ts) or the engine.
import type { Strings } from './en'

export const ko: Strings = {
  company: '스티플링',

  people: {
    mina: { name: '이미나', title: '마케팅 · 오늘 입사' },
    sara: { name: '사라 젠슨', title: '마케팅 팀장' },
    daniel: { name: '대니얼 오코예', title: '대표' },
    leo: { name: '레오 산토스', title: '마케팅 (영업팀으로 이동 예정)' },
    tom: { name: '톰 베커', title: '운영 팀장' },
    aiko: { name: '아이코 다나카', title: '영업' },
    omar: { name: '오마르 하다드', title: '온라인 몰' },
    chris: { name: '크리스 워커', title: '어카운트 디렉터', org: 'Fieldnote' },
  },
  marketingGroup: '마케팅',
  project: { name: '11월 런칭 캠페인', description: '겨울 한정 유자 진저 출시, 11월 23일(월)' },

  paths: {
    companyIntro: 'shared/회사 소개.md',
    brandGuide: 'shared/브랜드 가이드.md',
    brief: '11월 런칭 브리프.md',
    leoBanner: '런칭배너_레오_초안.png',
    banner: '런칭배너_최종.jpg',
    square: '인스타_정사각.jpg',
    story: '인스타_스토리.jpg',
    captions: '캡션.md',
    photo: 'higgsfield_유자진저.jpg',
  },

  steps: {
    read: '파일 읽기',
    save: '파일 저장',
    makeBanner: '배너 만들기',
    makeSquare: '인스타 정사각 만들기',
    makeStory: '인스타 스토리 만들기',
    writeCaptions: '캡션 쓰기',
    higgsfieldHero: '사진 생성 · 성에 낀 창가의 파우치와 아이스 유자 진저, 아침 햇살, 16:9',
    higgsfieldCrops: '사진 생성 · 같은 장면으로 1:1, 9:16',
    gmailSearch: '메일 검색 "크리스"',
    gmailSend: '메일 보내기',
  },

  home: {
    title: '미나님, 입사를 축하해요! 오늘부터 잘 부탁드려요.',
    subtitle: '사라님이 초대했어요 · 7명이 함께하고 있어요',
  },

  rooms: {
    everyone: [
      { from: 'daniel', text: '오늘 마케팅팀에 이미나님이 합류했어요. 다들 환영해 주세요! 🎉' },
      { from: 'tom', text: '미나님 환영해요! 주문이나 배송 관련은 운영팀에 편하게 물어보세요.' },
      { from: 'aiko', text: '미나님 반가워요 ☺️ 이번 주에 커피 한잔해요!' },
      { from: 'omar', text: '환영합니다! 몰에 배너 올릴 일 있으면 저 불러 주세요.' },
    ],
    marketing: [
      { from: 'leo', text: '런칭 배너 1차안 프로젝트에 올려 뒀어요. 솔직하게 말씀해 주세요 😅' },
      { from: 'sara', text: '고마워요 레오님, 한번 볼게요.' },
    ],
  },

  leoChat: {
    title: '런칭 배너 1차안',
    ask: '유자 진저 블렌드 런칭 배너 만들어 줘. 20% 할인, 11/23~12/6',
    answer: '배너 1차안이에요.',
  },

  answers: {
    company: {
      prompt: '우리 회사는 뭐 하는 회사예요?',
      text: [
        '**스티플링**은 콜드브루 티백을 만들어요. 찬물에 넣어 두기만 하면 끝이에요. 12명이 온라인 몰과 카페 납품으로 팔고 있어요.',
        '',
        '**미나님 업무**: 사라님 마케팅팀에서 런칭 배너와 SNS를 맡아요.',
        '',
        '**이번 주**: **월요일**에 유자 진저가 출시돼요. 런칭 배너가 제일 급한 일이에요.',
      ].join('\n'),
      peopleTitle: '먼저 알아 둘 사람',
      people: {
        sara: '뭐든 편하게 물어보세요.',
        leo: '배너 1차안을 만들었고, 미나님께 넘겨줘요.',
        daniel: '런칭 최종 OK를 줘요.',
      },
    },
    banner: {
      prompt: '브랜드 가이드대로 Higgsfield로 새 배경 만들어줘',
      text: [
        'Higgsfield로 새로 찍었어요. 성에 낀 창가에 초록 파우치랑 아이스 유자 진저를 놓았어요. 정사각과 스토리도 같은 장면이라 어디서나 파우치가 똑같이 보여요.',
        '',
        '제목은 Noto Serif KR, 나머지는 Pretendard로 쓰고, 유자 노랑은 20% 배지에만 넣었어요.',
        '',
        '캡션:',
      ].join('\n'),
      after: '레오님 1차안은 그대로 두었어요.',
    },
    captions: [
      '겨울 한정, 유자 진저 🍋 자기 전에 찬물에 티백 하나 넣어 두면 아침이 한결 산뜻해져요. 12월 6일까지 20% 할인.',
      '유자 + 생강. 끝. 설명 더 필요 없음. (아 맞다, 이번 주 20% 할인도 해요)',
      '사실 저희 팀은 8월부터 몰래 마시고 있었어요. 월요일부터 여러분 차례예요.',
    ],
    captionsTitle: '캡션: 유자 진저 런칭',
    deliverables: {
      banner: '웹 배너 · 1200×628',
      square: '인스타 정사각 · 1080×1080',
      story: '인스타 스토리 · 1080×1920',
      captions: '캡션 3개',
      photo: 'Higgsfield 사진',
    },
    compare: { before: '전: 레오님 1차안', after: '후' },
    otherSizes: '같은 느낌으로 사이즈별로:',
    sendTo: '#마케팅에 보내기',
    mail: {
      prompt: '배너 크리스한테 메일로 보내줘',
      intro: '초안 써 봤어요. 크리스님 주소는 팀 지난 메일에서 찾았어요.',
    },
  },

  mail: {
    to: '크리스 워커 (chris.walker@fieldnote.example)',
    labels: { to: '받는 사람', subject: '제목', attachments: '첨부' },
    plain: {
      subject: '월요일 런칭 배너 최종본 보내드려요',
      body: [
        '크리스님, 안녕하세요.',
        '',
        '스티플링 마케팅팀에 새로 온 이미나예요. 앞으로 배너 건은 제가 연락드릴게요.',
        '',
        '런칭 배너 최종본(1200×628)이랑 인스타 정사각 첨부했어요. 대표님 OK 받았어요. 11월 23일 월요일부터 걸어 주실 수 있을까요?',
        '',
        '감사합니다!',
        '미나 드림',
      ],
    },
    formal: {
      subject: '[스티플링] 11월 23일(월) 런칭 캠페인 배너 최종본 송부드립니다',
      body: [
        '크리스 워커님께,',
        '',
        '안녕하십니까. 스티플링 마케팅팀에 새로 합류한 이미나입니다.',
        '',
        '런칭 캠페인 배너 최종본(1200×628)과 인스타그램 정사각 버전을 첨부하여 보내드립니다. 두 파일 모두 대표님 승인을 마쳤습니다. 11월 23일 월요일부터 게재 부탁드립니다.',
        '',
        '감사합니다. 앞으로 잘 부탁드립니다.',
        '',
        '이미나 드림',
        '스티플링 마케팅팀',
      ],
    },
    confirm: '이 메일을 Gmail로 보낼까요?',
    send: '보내기',
    makeFormal: '더 정중하게 다듬기',
    sendShort: '짧은 버전으로 보내기',
    formalIntro: '더 정중하게 다듬었어요:',
    sent: '크리스님께 보냈어요. 제목 "{subject}", 배너와 정사각 이미지를 첨부했어요.',
  },

  events: {
    leadDm: '미나님, 레오님이 만든 월요일 런칭 배너 좀 손봐야 할 것 같아요. 디자인 잘하신다고 들었는데 한번 봐 주실래요? 자료는 프로젝트에 다 있어요.\n\n{project}',
    leadDmToast: '잠깐 시간 돼요? 🙏',
    ceoShip: '🔥 이거예요. 이걸로 가죠.',
    leoHow: '헐 이걸 어떻게 이렇게 빨리 하셨어요 😂',
    leadGmail: '미나님, 우리 Gmail 연결돼 있어요. 트리나한테 에이전시 Fieldnote 크리스님께 보내 달라고 하면 돼요.',
    chrisReply: '너무 좋네요, 월요일부터 걸게요.',
    chrisRelayed: '크리스님 방금 답장 왔어요: "{reply}" 🎉 미나님 첫날부터 최고예요.',
    ceoShoutout: '@이미나 님 덕분에 입사 첫날 월요일 런칭 캠페인 준비 끝났어요. 고마워요 🎉',
    saraWelcome: '미나님 우리 팀에 온 걸 환영해요 💛',
  },

  guide: {
    ask: { text: '트리나에게 회사에 대해 물어보세요 →', away: '첫 질문은 홈에 있어요 →' },
    dm: { text: '사라님이 메시지를 보냈어요 →', away: '사라님이 DM에서 기다리고 있어요 →' },
    project: { text: '사라님 메시지에서 프로젝트를 열어 보세요 →', away: '사라님이 DM에서 기다리고 있어요 →' },
    banner: { text: '트리나에게 Higgsfield로 다시 만들어 달라고 해 보세요 →', away: '레오님 배너가 프로젝트에서 기다리고 있어요 →' },
    share: { text: '#마케팅에 보내 보세요 →', away: '새 배너를 공유할 준비가 됐어요 →' },
    room: { text: '#마케팅을 열어 보세요: 팀 반응이 오고 있어요 →', away: '#마케팅을 열어 보세요: 팀 반응이 오고 있어요 →' },
    mail: { text: '✦ 트리나에게 크리스님께 메일 보내 달라고 해 보세요 →', away: '크리스님이 아직 배너를 기다리고 있어요 →' },
    everyone: { text: '대니얼 대표님이 #전체에 올린 글을 보세요 →', away: '대니얼 대표님이 #전체에 올린 글을 보세요 →' },
  },

  fallback: { text: '이 데모는 추천 질문으로 움직여요. 이걸 눌러 보세요:', question: '다음 단계' },

  end: {
    title: '미나의 첫날: 런칭 캠페인 {time} 만에 완료',
    body: '"우리 회사는 뭐 하는 회사예요?"에서 대표님이 승인하고 에이전시가 거는 런칭 배너까지. 입사 첫날에요.',
    stats: {
      time: '걸린 시간',
      filesRead: '읽은 파일',
      deliverables: '결과물',
      approvals: '대표님 승인',
      emails: '보낸 메일',
    },
    usually: '보통은 2일 정도',
    signup: '요금제 보고 무료로 시작하기',
    explore: '둘러보기',
    popupTitle: '미나의 첫날 끝 🎉',
    popupLine: '런칭 캠페인을 {time} 만에 끝냈어요. 보통은 2일 정도 걸려요.',
    recap: ['팀 파일 3개 읽기', 'Higgsfield로 결과물 4개 만들기', '대표님 승인', '에이전시에 메일 보내기'],
  },
}
