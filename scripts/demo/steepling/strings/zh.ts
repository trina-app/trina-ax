// 自由体验 demo 里故事之外的简体中文内容（从 en.ts 改写，不是逐字翻译）：故事前后的聊天室和对话、其他团队、CEO 文件夹、
// 假的 Gmail 和云盘、顶部栏的推荐。人物、公司、数字、地址全是虚构的（见 ../README.md）。
// 故事本身的文字在 scripts/demo/mina/strings/zh.ts。语气：同事之间用“你”，轻松自然的创业公司口吻。
import type { FreeRoamStrings } from './en'

export const zh: FreeRoamStrings = {
  groups: {
    marketing: '活动、社媒、横幅和商品页',
    operations: { name: '运营', description: '订单、发货、客户咨询' },
    sales: { name: '销售', description: '咖啡馆和办公室供货' },
    shop: { name: '线上商城', description: '商城运营和订阅' },
  },

  leadership: {
    folder: 'shared/管理层',
    files: [
      {
        name: '2027 计划（草稿）.md',
        text: [
          '# 2027 计划（草稿，仅 CEO）',
          '',
          'Steepling 是为这个演示虚构的公司，本页内容均为示例。',
          '',
          '- 2027 年冬季两款新品（暂名：香料梨、可可路易波士）',
          '- 春天再开一个咖啡馆供货区域',
          '- 招聘：运营 1 人，设计师 1 人',
          '',
          '还没对外公开。按这个做计划之前，先来找我聊聊。',
        ].join('\n'),
      },
    ],
  },

  files: [
    {
      path: 'groups/运营/发货说明.md',
      text: '# 发货说明\n\n演示用的示例内容。\n\n- **下午 2 点**前的订单当天发货\n- 咖啡馆供货：照常每周二送\n- 客户咨询：一个工作日内回复\n',
    },
    {
      path: 'groups/销售/咖啡馆客户.md',
      text: '# 咖啡馆客户\n\n演示用的示例内容。\n\n| 咖啡馆 | 区域 | 订单 | 下次拜访 |\n|---|---|---|---|\n| Harbour Beans | 港口区 | 每月 40 箱 | 周二 |\n| The Reading Room | 老城区 | 每月 25 箱 | 下周 |\n| Corner Kettle | 河畔 | 每月 15 箱 | 两周后 |\n',
    },
    {
      path: 'groups/线上商城/商城日程.md',
      text: '# 商城日程\n\n演示用的示例内容。\n\n- 上市日（周一）7:00：上线上新横幅（柚子姜，8 折）\n- 第二周的周日：上市优惠结束\n- 每天：下午 2 点前的订单当天发货\n',
    },
    {
      path: 'groups/市场部/竞品笔记.md',
      text: '# 竞品笔记\n\n演示用的示例内容。这里的品牌全是虚构的。\n\n| 品牌 | 本月动态 | 价格 |\n|---|---|---|\n| Coldleaf | 冬季薄荷拼配，买一送一 | 10.50 美元 / 10 包 |\n| Brewbright | 办公室订阅 85 折 | 8.90 美元 / 10 包 |\n| Teatime Co. | 推出玻璃瓶包装 | 12.00 美元 / 10 包 |\n',
    },
  ],

  personas: {
    mina: '我是 Mina Lee，今天刚加入 Steepling 市场部。',
    sara: '我是 Sara Jensen，Steepling 的市场负责人。',
  },

  memory: 'Mina 在柚子姜上市这周加入市场部，从 Leo 手里接过横幅和社媒的工作。',

  profile: {
    oneLine: 'Steepling 做冷泡茶包：丢进冷水里，几个小时后就能喝。',
    products: 'Steepling 冷泡茶 6 种口味（10 包 9.90 美元），冬季限定柚子姜拼配（10 包 11.90 美元）',
    audience: '不想烧水也想喝茶的人，还有咖啡馆和办公室',
    tone: ['安静、温暖', '简单、亲切', '不夸张'],
    avoid: '“最好”“第一”这类说法，以及没有依据的数字',
  },

  everyoneBefore: [
    { from: 'tom', minutesAgo: 7 * 1440 + 120, text: '通知：现在**下午 2 点**前的订单当天发货。细节在运营的文件夹里。' },
    { from: 'omar', minutesAgo: 5 * 1440 + 300, text: '明早 7 点商城更新，会停 10 分钟左右。' },
    { from: 'daniel', minutesAgo: 3 * 1440 + 60, text: '十月线上销售额创了历史新高。谢谢大家 🙏' },
    { from: 'aiko', minutesAgo: 2 * 1440 + 200, text: 'Harbour Beans 把下一单加了一倍 ☕' },
  ],
  marketingBefore: [
    { from: 'sara', minutesAgo: 6 * 1440 + 30, text: '这周同步：柚子姜上市简报放到团队文件夹了。Leo，横幅第一稿麻烦周三前给我。' },
    { from: 'leo', minutesAgo: 6 * 1440 + 20, text: '好的 👍' },
  ],
  shareNote: '周一上市用的横幅、方图和快拍都做好了 👇',
  leoDm: 'Mina 欢迎！之前的横幅文件都在上市项目里。有不懂的随时问我 🙂',
  bannerThread: '@Mina Lee 结霜窗边的感觉很好。方图版也发给 Omar，让他放到商城页面上。',
  launchDay: {
    name: '上市当天',
    messages: [
      { from: 'omar', text: '周一早上 7 点，新横幅我来上到商城。' },
      { from: 'sara', text: '好。Mina 的最终文件在项目里。' },
      { from: 'tom', text: '运营这边接单准备好了 📦' },
    ],
  },

  pressRelease: {
    title: '新闻稿草稿',
    ask: '用新闻稿技能，帮我写柚子姜上市的新闻稿',
    answer: [
      '按团队技能**新闻稿草稿**的格式，我先写了一版。',
      '',
      '**Steepling 推出冬季限定冷泡茶“柚子姜”**',
      '',
      '*明亮的柚子香，再添一点生姜的暖，冷水泡一夜，早上就能喝*',
      '',
      '冷泡茶品牌 Steepling 将于[上市日期]推出冬季限定柚子姜拼配。一个茶包丢进一瓶冷水，几个小时后即可饮用。',
      '',
      'Steepling CEO Daniel Okoye 表示：“[引语]”。',
      '',
      '柚子姜 10 包装售价 11.90 美元，在 Steepling 线上商城和合作咖啡馆有售，上市头两周享 8 折。',
      '',
      '**关于 Steepling**：Steepling 制作冷泡茶包。10 个人的团队，通过线上商城以及咖啡馆和办公室供货销售。',
      '',
      '**联系人**：[姓名，邮箱]',
      '',
      '需要确认：CEO 的引语、上市日期。',
    ].join('\n'),
  },

  gmail: {
    welcome: {
      subject: '欢迎加入 Steepling！',
      body: 'Mina 你好，\n\n欢迎入职！账号都准备好了。周一上市的资料都在上市项目里，十点一起喝杯咖啡吧。\n\nSara',
    },
    specs: {
      subject: '柚子姜上市横幅尺寸',
      body: 'Leo 你好，\n\n柚子姜上市这次用网页 1200×628、Instagram 1080×1080。周五前把最终版发给我，周一起就上线。\n\n谢谢！\nChris\nFieldnote Studio',
    },
    replyBody: 'Mina 你好，\n\n欢迎入职！{reply}\n\nChris\nFieldnote Studio',
    forwardNote: '供参考：这是 Chris 发来的上市尺寸要求。现在由 Mina 负责了。',
    forwarded: '---------- 转发的邮件 ----------',
    forwardPrefix: 'Fwd: ',
    replyPrefix: 'Re: ',
  },

  drive: [
    { id: 'media-plan', name: 'Fieldnote 柚子姜上市媒体计划', mimeType: 'application/vnd.google-apps.spreadsheet', folder: 'Fieldnote', minutesAgo: 9 * 1440, text: '渠道,尺寸,开始,时长,预算\n网页横幅,1200×628,上市日（周一）,2 周,1200 美元\nInstagram,1080×1080,上市日（周一）,2 周,800 美元\nInstagram 快拍,1080×1920,上市日（周一）,1 周,400 美元\n' },
    { id: 'photo-ideas', name: '上市照片创意', mimeType: 'application/vnd.google-apps.document', folder: '', minutesAgo: 4 * 1440, text: '上市照片创意\n\n- 结霜的窗边，晨光\n- 绿色包装袋放在冰杯旁边\n- 照片里不放文字\n' },
  ],

  skillTitles: {
    'brand-guide': '品牌手册',
    'social-posts': '三版社媒文案',
    'press-release': '新闻稿草稿',
    'competitor-roundup': '竞品速览',
    handover: '交接助手',
    'review-digest': '客户评价汇总',
  },

  suggestions: [
    { label: '写下周的社媒文案', prompt: '帮我给下周社媒日历里的两个空档写初稿' },
    { label: '汇总客户评价', prompt: '整理一下最近两个月的客户评价' },
    { label: 'Chris 回复了吗？', prompt: 'Chris 回我的邮件了吗？帮我看看 Gmail' },
  ],
}
