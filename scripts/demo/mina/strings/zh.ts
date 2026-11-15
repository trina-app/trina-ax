// Every word of the demo story in Simplified Chinese (from strings/en.ts, not word for word). Register: a friendly
// mainland startup on Feishu/Slack: 你 between colleagues, light and natural, some English work words ("banner") as
// people really type them; the formal email is a proper Chinese business email (尊敬的…／此致 敬礼). People keep their
// names in Latin script, as colleagues with English names do in Chinese companies; "Steepling" stays Latin too.
// Pictures and team files: the `.zh.` files in ../assets; banner words: ../source/banners/copy.zh.json.
//
// Plain strings only. `{project}` in a text becomes a link to the campaign project; {time}, {subject}, {reply} are
// filled in by the story (../story.ts) or the engine.
import type { Strings } from './en'

export const zh: Strings = {
  company: 'Steepling',

  people: {
    mina: { name: 'Mina Lee', title: '市场部 · 入职第一天' },
    sara: { name: 'Sara Jensen', title: '市场负责人' },
    daniel: { name: 'Daniel Okoye', title: 'CEO' },
    leo: { name: 'Leo Santos', title: '市场部（即将调往销售部）' },
    tom: { name: 'Tom Becker', title: '运营负责人' },
    aiko: { name: 'Aiko Tanaka', title: '销售' },
    omar: { name: 'Omar Haddad', title: '线上商城' },
    chris: { name: 'Chris Walker', title: '客户总监', org: 'Fieldnote' },
  },
  marketingGroup: '市场部',
  project: { name: '11月新品上市活动', description: '冬季限定柚子姜上市，11月23日（周一）' },

  paths: {
    companyIntro: 'shared/公司介绍.md',
    brandGuide: 'shared/品牌手册.md',
    brief: '11月上新简报.md',
    leoBanner: '上新banner_Leo_初稿.png',
    banner: '上新banner_定稿.jpg',
    square: 'Instagram方图.jpg',
    story: 'Instagram快拍.jpg',
    captions: '文案.md',
    photo: 'higgsfield_柚子姜.jpg',
  },

  steps: {
    read: '读取',
    save: '保存',
    makeBanner: '制作 banner',
    makeSquare: '制作 Instagram 方图',
    makeStory: '制作 Instagram 快拍',
    writeCaptions: '写文案',
    higgsfieldHero: '生成照片 · 结霜窗边的绿色包装袋和冰柚子姜，晨光，16:9',
    higgsfieldCrops: '生成照片 · 同一画面，1:1 和 9:16',
    gmailSearch: '搜索邮件 "Chris"',
    gmailSend: '发送邮件',
  },

  home: {
    title: 'Mina，欢迎加入！祝你入职第一天顺利。',
    subtitle: 'Sara 邀请了你 · 这里有 7 个人',
  },

  rooms: {
    everyone: [
      { from: 'daniel', text: 'Mina Lee 今天加入市场部啦，大家打个招呼！🎉' },
      { from: 'tom', text: '欢迎 Mina！订单、发货有什么问题，直接找运营就行。' },
      { from: 'aiko', text: 'Hi Mina ☺️ 这周约个咖啡？' },
      { from: 'omar', text: '欢迎！商城要上 banner 的时候跟我说一声。' },
    ],
    marketing: [
      { from: 'leo', text: '上新 banner 初稿放到项目里了，大家直说就行 😅' },
      { from: 'sara', text: '谢啦 Leo，我看一下。' },
    ],
  },

  leoChat: {
    title: '上新 banner 初稿',
    ask: '帮我做一张柚子姜新品的上新 banner。8折，11/23 到 12/6',
    answer: '这是 banner 初稿。',
  },

  answers: {
    company: {
      prompt: '我们公司是做什么的？',
      text: [
        '**Steepling** 做冷泡茶包。丢一包进冷水里，就好了。公司一共 12 个人，在线上商城卖，也给咖啡馆供货。',
        '',
        '**你的工作**：在 Sara 的市场部，负责上新 banner 和社媒。',
        '',
        '**这周**：柚子姜**周一**上市，上新 banner 是眼下最要紧的事。',
      ].join('\n'),
      peopleTitle: '先认识这几位',
      people: {
        sara: '有什么都可以问她。',
        leo: '做了 banner 初稿，会交接给你。',
        daniel: '上新最后由他拍板。',
      },
    },
    banner: {
      prompt: '按品牌手册，用 Higgsfield 做一个新背景',
      text: [
        '用 Higgsfield 重新拍了一张：结霜的窗边，放着我们的绿色包装袋和一杯冰柚子姜。方图和快拍用的是同一个画面，所以每个尺寸里的包装都一模一样。',
        '',
        '标题用 Noto Serif SC，其余文字用 Noto Sans SC，柚子黄只用在 8 折标签上。',
        '',
        '文案：',
      ].join('\n'),
      after: 'Leo 的初稿没有动。',
    },
    captions: [
      '冬季新品：柚子姜 🍋 睡前丢一包进冷水，醒来就是一瓶清爽。12月6日前享 8 折。',
      '柚子 + 姜。没了。就这些。（好吧，这周还打 8 折）',
      '其实我们团队从 8 月就在偷偷喝了。周一起，轮到你了。',
    ],
    captionsTitle: '文案：柚子姜上新',
    deliverables: {
      banner: '网页 banner · 1200×628',
      square: 'Instagram 方图 · 1080×1080',
      story: 'Instagram 快拍 · 1080×1920',
      captions: '3 条文案',
      photo: 'Higgsfield 照片',
    },
    compare: { before: '之前：Leo 的初稿', after: '之后' },
    otherSizes: '同一套视觉，各个尺寸：',
    sendTo: '发送到 #市场部',
    mail: {
      prompt: '把 banner 发邮件给 Chris',
      intro: '草稿写好了。Chris 的邮箱是从团队以前的邮件里找到的。',
    },
  },

  mail: {
    to: 'Chris Walker (chris.walker@fieldnote.example)',
    labels: { to: '收件人', subject: '主题', attachments: '附件' },
    plain: {
      subject: '周一上新的 banner 定稿',
      body: [
        'Hi Chris，',
        '',
        '我是 Mina，刚加入 Steepling 市场部，之后 banner 的事都由我来对接。',
        '',
        '附件是上新 banner 定稿（1200×628）和 Instagram 方图，Daniel 已经确认过了。麻烦从 11 月 23 日周一开始投放，可以吗？',
        '',
        '谢谢！',
        'Mina',
      ],
    },
    formal: {
      subject: '【Steepling】11月23日（周一）新品上市活动 banner 定稿',
      body: [
        '尊敬的 Chris：',
        '',
        '您好！我是 Steepling 市场部新入职的 Mina Lee，今后 banner 相关事宜将由我与您对接。',
        '',
        '随信附上新品上市活动的 banner 定稿（1200×628）及 Instagram 方图版本，两份文件均已通过我司 CEO 审批。烦请于 11 月 23 日（周一）起安排投放。',
        '',
        '感谢您的支持，期待与您合作。',
        '',
        '此致',
        '敬礼！',
        '',
        'Mina Lee',
        'Steepling 市场部',
      ],
    },
    confirm: '用 Gmail 发送这封邮件？',
    send: '发送',
    makeFormal: '改得更正式一点',
    sendShort: '发送简短版',
    formalIntro: '更正式的版本：',
    sent: '已发给 Chris：「{subject}」，附上了 banner 和方图。',
  },

  events: {
    leadDm: 'Mina，Leo 做的周一上新 banner 还得再打磨一下。听说你很会做设计，能帮忙改一版吗？资料都在项目里。\n\n{project}',
    leadDmToast: '有空吗？🙏',
    ceoShip: '🔥 就它了，上！',
    leoHow: '等等，你怎么这么快就搞定了 😂',
    leadGmail: 'Mina，Gmail 已经连好了。让 Trina 发给我们合作的代理公司 Fieldnote 的 Chris 就行。',
    chrisReply: '很棒，周一就上线。',
    chrisRelayed: 'Chris 刚回了你的邮件：「{reply}」🎉 第一天就这么给力，Mina！',
    ceoShoutout: '给 @Mina Lee 点个赞：入职第一天，周一的上新活动就搞定了 🎉',
    saraWelcome: '欢迎加入团队，Mina 💛',
  },

  guide: {
    ask: { text: '问问 Trina 公司是做什么的 →', away: '你的第一个问题在首页 →' },
    dm: { text: 'Sara 给你发了消息 →', away: 'Sara 在私信里等你 →' },
    project: { text: '打开 Sara 消息里的项目 →', away: 'Sara 在私信里等你 →' },
    banner: { text: '让 Trina 用 Higgsfield 重做一版 →', away: 'Leo 的 banner 在项目里等你 →' },
    share: { text: '发送到 #市场部 →', away: '新 banner 可以分享了 →' },
    room: { text: '打开 #市场部：大家都在回应 →', away: '打开 #市场部：大家都在回应 →' },
    mail: { text: '让 ✦ Trina 给 Chris 发邮件 →', away: 'Chris 还在等 banner →' },
    everyone: { text: '看看 Daniel 在 #所有人 发了什么 →', away: '看看 Daniel 在 #所有人 发了什么 →' },
  },

  fallback: { text: '这个演示按推荐的问题进行。试试这个：', question: '下一步' },

  end: {
    title: 'Mina 的第一天：{time} 搞定上新活动',
    body: '从“我们公司是做什么的？”，到 CEO 批准、代理公司开始投放的上新 banner。入职第一天。',
    stats: {
      time: '用时',
      filesRead: '读取的文件',
      deliverables: '交付物',
      approvals: 'CEO 批准',
      emails: '已发邮件',
    },
    usually: '通常要 2 天左右',
    signup: '查看套餐，免费开始',
    explore: '随便看看',
    popupTitle: 'Mina 的第一天 🎉',
    popupLine: '{time} 搞定上新活动。通常要 2 天左右。',
    recap: ['读了 3 个团队文件', '用 Higgsfield 做了 4 个素材', 'CEO 批准', '给代理公司发了邮件'],
  },
}
