// Every word of the demo story in Japanese (from strings/en.ts, not word for word). Register: a small, friendly
// Japanese startup on Slack. Colleagues write light, polite です・ます to each other ("ミナさん"); the CEO and Leo are
// a little more casual. The email to the agency is a proper Japanese business email (お世話になっております), not
// stiff. People keep their names in katakana as a Japanese colleague would write them (Aiko Tanaka in Japanese order,
// 田中アイコ); the agency name Fieldnote stays Latin. Pictures and team files are the `.ja.` files in ../assets,
// banner words in ../source/banners/copy.ja.json (headline in Noto Serif JP, the rest in Noto Sans JP).
//
// Plain strings only. `{project}` in a text becomes a link to the campaign project; {time}, {subject}, {reply} are
// filled in by the story (../story.ts) or the engine.
import type { Strings } from './en'

export const ja: Strings = {
  company: 'スティープリング',

  people: {
    mina: { name: 'ミナ・リー', title: 'マーケティング · 本日入社' },
    sara: { name: 'サラ・ジェンセン', title: 'マーケティングリード' },
    daniel: { name: 'ダニエル・オコイェ', title: 'CEO' },
    leo: { name: 'レオ・サントス', title: 'マーケティング（営業へ異動予定）' },
    tom: { name: 'トム・ベッカー', title: 'オペレーションリード' },
    aiko: { name: '田中アイコ', title: '営業' },
    omar: { name: 'オマル・ハッダード', title: 'オンラインショップ' },
    chris: { name: 'クリス・ウォーカー', title: 'アカウントディレクター', org: 'Fieldnote' },
  },
  marketingGroup: 'マーケティング',
  project: { name: 'ゆずジンジャー ローンチキャンペーン', description: '冬季限定ゆずジンジャー、月曜日発売' },

  brandSkill: 'brand-guide',

  paths: {
    companyIntro: 'shared/会社紹介.md',
    brief: 'ゆずジンジャー ローンチブリーフ.md',
    leoBanner: 'ローンチバナー_レオ_初稿.png',
    banner: 'ローンチバナー_最終.jpg',
    square: 'インスタ_スクエア.jpg',
    story: 'インスタ_ストーリーズ.jpg',
    captions: 'キャプション.md',
    photo: 'higgsfield_ゆずジンジャー.jpg',
  },

  steps: {
    read: 'ファイルを読む',
    useSkill: 'スキルを使用',
    save: 'ファイルを保存',
    makeBanner: 'バナーを作成',
    makeSquare: 'インスタ用スクエアを作成',
    makeStory: 'インスタ用ストーリーズを作成',
    writeCaptions: 'キャプションを書く',
    higgsfieldHero: '写真を生成 · 霜のついた窓辺にパウチとアイスのゆずジンジャー、朝の光、16:9',
    higgsfieldCrops: '写真を生成 · 同じカットで1:1と9:16',
    gmailSearch: 'メールを検索「クリス」',
    gmailSend: 'メールを送信',
  },

  home: {
    title: 'ミナさん、入社おめでとうございます！今日からよろしくお願いします。',
    subtitle: 'サラさんからの招待 · 7人が参加しています',
  },

  rooms: {
    everyone: [
      { from: 'daniel', text: '今日からマーケティングチームにミナ・リーさんが加わります。みんなよろしく！🎉' },
      { from: 'tom', text: 'ミナさん、ようこそ！注文や配送のことはオペレーションに気軽に聞いてくださいね。' },
      { from: 'aiko', text: 'ミナさん、はじめまして☺️ 今週どこかでコーヒー行きませんか？' },
      { from: 'omar', text: 'ようこそ！ショップにバナーを載せるときは声をかけてください。' },
    ],
    marketing: [
      { from: 'leo', text: 'ローンチバナーの初稿、プロジェクトに上げました。正直な感想お願いします😅' },
      { from: 'sara', text: 'レオさん、ありがとうございます。見てみますね。' },
    ],
  },

  leoChat: {
    title: 'ローンチバナー 初稿',
    ask: 'ゆずジンジャーブレンドのローンチバナーを作って。発売から2週間は20%オフ',
    answer: 'バナーの初稿です。',
  },

  answers: {
    company: {
      prompt: 'うちの会社って、何をしている会社ですか？',
      text: [
        '**スティープリング**は水出し用のティーバッグを作っています。冷たい水に入れておくだけで完成。12人で、オンラインショップとカフェ向けに販売しています。',
        '',
        '**ミナさんの仕事**：サラさんのマーケティングチームで、ローンチバナーとSNSを担当します。',
        '',
        '**今週**：**月曜日**にゆずジンジャーが発売です。いちばん急ぎなのはローンチバナーです。',
        '',
        '**チームスキル**：チームで共有しているスキルがあります（「ブランドガイド」「SNS投稿3案」など）。必要なときは私が代わりに使います。',
      ].join('\n'),
      personLine: '{name}、{title}：{text}',
      peopleTitle: 'まず知っておきたい人',
      people: {
        sara: '何でも気軽に相談できます。',
        leo: 'バナーの初稿を作った人で、ミナさんに引き継ぎます。',
        daniel: 'ローンチの最終OKを出します。',
      },
    },
    banner: {
      prompt: 'ブランドガイドに沿って、Higgsfieldで新しい背景を作って',
      text: [
        'Higgsfieldで撮り直しました。霜のついた窓辺に、緑のパウチとアイスのゆずジンジャー。スクエアとストーリーズも同じカットなので、どのサイズでもパウチが同じに見えます。',
        '',
        'ブランドガイドに沿って、見出しはNoto Serif JP、それ以外はNoto Sans JP。ゆずイエローは20%オフのバッジだけに使いました。',
        '',
        'キャプション：',
      ].join('\n'),
      after: 'レオさんの初稿はそのまま残してあります。',
    },
    captions: [
      '冬季限定、ゆずジンジャー🍋 寝る前に冷たい水へティーバッグをひとつ。朝には、ぱっと明るい一杯に。発売から2週間は20%オフ。',
      'ゆず＋しょうが。以上。説明はいらないやつです。（あ、今週は20%オフでもあります）',
      '実はチームでは何か月も前からこっそり飲んでいました。月曜日からは、みなさんの番です。',
    ],
    captionsTitle: 'キャプション：ゆずジンジャー ローンチ',
    deliverables: {
      banner: 'Webバナー · 1200×628',
      square: 'インスタ用スクエア · 1080×1080',
      story: 'インスタ用ストーリーズ · 1080×1920',
      captions: 'キャプション3案',
      photo: 'Higgsfieldの写真',
    },
    compare: { before: 'Before：レオさんの初稿', after: 'After' },
    otherSizes: '同じトーンで、サイズ違いも：',
    sendTo: '#マーケティングに送る',
    mail: {
      prompt: 'バナーをクリスさんにメールで送って',
      intro: '下書きを作りました。クリスさんのアドレスはチームの過去のメールにありました。',
    },
  },

  mail: {
    to: 'クリス・ウォーカー (chris.walker@fieldnote.example)',
    labels: { to: '宛先', subject: '件名', attachments: '添付' },
    plain: {
      subject: '月曜ローンチのバナー最終版です',
      body: [
        'クリスさん',
        '',
        'はじめまして、スティープリングのマーケティングチームに入ったミナです。今後バナーの件は私がご連絡します。',
        '',
        'ローンチバナーの最終版（1200×628）とインスタ用スクエアを添付しました。ダニエルのOKも出ています。月曜日から掲載していただけますか？',
        '',
        'よろしくお願いします！',
        'ミナ',
      ],
    },
    formal: {
      subject: '【スティープリング】ローンチキャンペーン用バナー最終版のご送付',
      body: [
        'Fieldnote',
        'クリス・ウォーカー様',
        '',
        'いつもお世話になっております。',
        'このたびスティープリングのマーケティングチームに着任いたしました、ミナ・リーと申します。',
        '',
        'ローンチキャンペーン用バナーの最終版（1200×628）と、Instagram用スクエア版を添付にてお送りいたします。いずれも弊社CEOの承認を得ております。',
        'ローンチ日の月曜日より掲載いただけますと幸いです。',
        '',
        '今後ともどうぞよろしくお願いいたします。',
        '',
        'スティープリング マーケティングチーム',
        'ミナ・リー',
      ],
    },
    confirm: 'このメールをGmailで送信しますか？',
    send: '送信',
    makeFormal: 'もっと丁寧にする',
    sendShort: '短いほうで送る',
    formalIntro: '丁寧な文面にしました：',
    sent: 'クリスさんに送信しました。件名「{subject}」、バナーとスクエアを添付しています。',
  },

  events: {
    leadDm: 'ミナさん、レオさんが作った月曜ローンチのバナー、もう少し手を入れたくて。デザインが得意だと聞いたので、見てもらえませんか？資料は全部プロジェクトに入っています。\n\n{project}',
    leadDmToast: 'ちょっといいですか？🙏',
    ceoShip: '🔥 これだ。これでいこう。',
    leoHow: 'え、どうやってこんなに早く作ったんですか😂',
    leadGmail: 'ミナさん、Gmailはもうつながっています。トリナに頼めば、代理店Fieldnoteのクリスさんに送ってくれますよ。',
    chrisReply: 'すごくいいですね。月曜から掲載します。',
    chrisRelayed: 'クリスさんからさっき返信が来ました：「{reply}」🎉 ミナさん、初日から最高です。',
    ceoShoutout: '@ミナ・リー さん、入社初日で月曜ローンチのキャンペーンが完成しました。ありがとう！🎉',
    saraWelcome: 'ミナさん、チームへようこそ💛',
  },

  guide: {
    ask: { text: 'トリナに会社のことを聞いてみましょう →', away: '最初の質問はホームにあります →' },
    dm: { text: 'サラさんからメッセージが届きました →', away: 'サラさんが1:1トークで待っています →' },
    project: { text: 'サラさんのメッセージからプロジェクトを開きましょう →', away: 'サラさんが1:1トークで待っています →' },
    banner: { text: 'トリナにHiggsfieldで作り直してもらいましょう →', away: 'レオさんのバナーがプロジェクトで待っています →' },
    share: { text: '#マーケティングに送りましょう →', away: '新しいバナーを共有する準備ができました →' },
    room: { text: '#マーケティングを開きましょう：チームが反応しています →', away: '#マーケティングを開きましょう：チームが反応しています →' },
    mail: { text: '✦ トリナにクリスさんへのメールを頼みましょう →', away: 'クリスさんがまだバナーを待っています →' },
    everyone: { text: 'ダニエルさんが#全員に投稿した内容を見てみましょう →', away: 'ダニエルさんが#全員に投稿した内容を見てみましょう →' },
  },

  fallback: { text: 'このデモはおすすめの質問で進みます。こちらを試してください：', question: '次のステップ' },

  end: {
    title: 'ミナの初日：ローンチキャンペーンを{time}で完成',
    body: '「うちの会社って何をしている会社？」から、CEOが承認し代理店が掲載するローンチバナーまで。入社初日に。',
    stats: {
      time: 'かかった時間',
      filesRead: '読んだファイル',
      deliverables: '成果物',
      approvals: 'CEOの承認',
      emails: '送ったメール',
    },
    usually: 'ふつうは2日ほど',
    signup: 'プランを見る',
    explore: '見て回る',
    tryLive: '今度はご自身で試してみましょう',
    liveBusy: 'ライブデモは今混み合っています',
    liveRetry: 'もう一度確認',
    popupTitle: 'ミナの初日、おつかれさまでした🎉',
    popupLine: 'ローンチキャンペーンを{time}で完成。ふつうは2日ほどかかります。',
    recap: ['チームのファイルを2つ読む', 'チームスキル「ブランドガイド」を使用', 'Higgsfieldで成果物を4つ作成', 'CEOが承認', '代理店にメールを送信'],
  },
}
