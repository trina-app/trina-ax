// The free-roam demo's words beyond the scripted story (English, the source language): the lived-in rooms and chats
// around the story, the other teams, the CEO's folder, the fake Gmail and Drive, the bar's suggestions. Every person,
// company, number and address is made up (../README.md). The story's own words come from scripts/demo/mina/strings.
//
// `{project}` is a link to the launch project; `@<name>` a mention.

export const en = {
  /** the other teams (the story's Marketing is scripts/demo/mina's marketingGroup) */
  groups: {
    marketing: 'Campaigns, social, banners and product pages',
    operations: { name: 'Operations', description: 'Orders, shipping, customer questions' },
    sales: { name: 'Sales', description: 'Cafés and offices' },
    shop: { name: 'Online shop', description: 'The shop and subscriptions' },
  },

  /** the CEO's own folder: nobody else opens it (the owner reads everything) */
  leadership: {
    folder: 'shared/Leadership',
    files: [
      {
        name: '2027 plan (draft).md',
        text: [
          '# 2027 plan (draft, CEO only)',
          '',
          'Steepling is a fictional company made up for this demo. This page is sample content.',
          '',
          '- Two new winter blends in 2027 (working names: Spiced Pear, Cocoa Rooibos)',
          '- Open a second café partner region in spring',
          '- Hire: one more in Operations, one designer',
          '',
          'Not shared yet. Talk to me before you plan around it.',
        ].join('\n'),
      },
    ],
  },

  /** more team files, so the other teams' folders are not empty */
  files: [
    {
      path: 'groups/Operations/Holiday shipping.md',
      text: '# Holiday shipping\n\nSample content for the demo.\n\n- Last order for delivery before the holidays: **December 18**\n- Cafés: weekly delivery on Tuesdays as usual\n- Questions from customers: answer within one working day\n',
    },
    {
      path: 'groups/Sales/Café accounts.md',
      text: '# Café accounts\n\nSample content for the demo.\n\n| Café | City | Order | Next visit |\n|---|---|---|---|\n| Harbour Beans | Portside | 40 boxes / month | Nov 24 |\n| The Reading Room | Old Town | 25 boxes / month | Dec 2 |\n| Corner Kettle | Riverside | 15 boxes / month | Dec 9 |\n',
    },
    {
      path: 'groups/Online shop/Shop calendar.md',
      text: '# Shop calendar\n\nSample content for the demo.\n\n- Mon Nov 23, 7:00: launch banner up (Yuzu Ginger, 20% off)\n- Dec 6: launch offer ends\n- Dec 18: last order before the holidays\n',
    },
    {
      path: 'groups/Marketing/Competitor notes.md',
      text: '# Competitor notes (November)\n\nSample content for the demo. Every brand here is made up.\n\n| Brand | News this month | Price |\n|---|---|---|\n| Coldleaf | Winter mint blend, 2 for 1 | $10.50 / 10 bags |\n| Brewbright | Office subscription, 15% off | $8.90 / 10 bags |\n| Teatime Co. | New glass bottle | $12.00 / 10 bags |\n',
    },
  ],

  personas: {
    mina: 'I\'m Mina Lee. I joined Steepling\'s Marketing team today.',
    sara: 'I\'m Sara Jensen, Marketing lead at Steepling.',
  },

  memory: 'Mina joined Marketing on her first day of the Yuzu Ginger launch week; she takes over banners and social posts from Leo.',

  profile: {
    oneLine: 'Steepling makes cold-brew tea bags: drop one in cold water and it is ready in a few hours.',
    products: 'Steepling Cold Brew Tea in 6 flavours ($9.90 for 10 bags); the winter-only Yuzu Ginger blend ($11.90 for 10 bags)',
    audience: 'People who like tea without the kettle; cafés and offices',
    tone: ['Calm and warm', 'Plain and friendly', 'No hype'],
    avoid: '"Best" or "number one", and numbers we cannot back up',
  },

  /** before the story: the room had a life */
  everyoneBefore: [
    { from: 'tom', minutesAgo: 7 * 1440 + 120, text: 'Heads up: the last order for delivery before the holidays is **December 18**. Details in our folder.' },
    { from: 'omar', minutesAgo: 5 * 1440 + 300, text: 'The shop is down for 10 minutes tomorrow at 7:00 for an update.' },
    { from: 'daniel', minutesAgo: 3 * 1440 + 60, text: 'October was our best month online so far. Thank you all 🙏' },
    { from: 'aiko', minutesAgo: 2 * 1440 + 200, text: 'Harbour Beans doubled their order for December ☕' },
  ],
  marketingBefore: [
    { from: 'sara', minutesAgo: 6 * 1440 + 30, text: 'Weekly: the November launch brief is in our group folder. Banner first draft from Leo by Wednesday, please.' },
    { from: 'leo', minutesAgo: 6 * 1440 + 20, text: 'On it 👍' },
  ],
  /** Mina's post to #Marketing (her note above the answer she sends) */
  shareNote: 'New launch banner, square and story for Monday 👇',
  /** Leo's DM to Mina, before Sara's */
  leoDm: 'Welcome Mina! My old banner files are in the launch project. Ping me if anything is unclear 🙂',
  /** Sara's reply in the thread under Mina's banner answer (the launch project's chat): Mina's notice in Activity */
  bannerThread: '@Mina Lee Love the frosted window. Could you send the square one to Omar for the shop page too?',
  /** a group chat about launch day */
  launchDay: {
    name: 'Launch day',
    messages: [
      { from: 'omar', text: 'I\'ll put the new banner on the shop Monday at 7:00.' },
      { from: 'sara', text: 'Perfect. Mina\'s final files are in the project.' },
      { from: 'tom', text: 'Ops is ready for the orders 📦' },
    ],
  },

  /** Sara's own chat in the project (shared with its members): the press release she owns in the brief */
  pressRelease: {
    title: 'Press release, first draft',
    ask: 'Use our press release skill for the Yuzu Ginger launch',
    answer: [
      'Here\'s a first draft, following the **Press release draft** team skill.',
      '',
      '**Steepling launches Yuzu Ginger, a winter cold brew, on November 23**',
      '',
      '*Bright yuzu and a warm kick of ginger, ready in cold water overnight.*',
      '',
      'Steepling, the cold-brew tea company, launches its winter-only Yuzu Ginger blend on Monday, November 23. Drop one bag in a bottle of cold water and it\'s ready in a few hours.',
      '',
      '"[quote]" said Daniel Okoye, CEO of Steepling.',
      '',
      'Yuzu Ginger is $11.90 for 10 bags at the Steepling online shop and partner cafés, 20% off until December 6.',
      '',
      '**About Steepling**: Steepling makes cold-brew tea bags. 10 people, selling online and to cafés and offices.',
      '',
      '**Contact**: [name, email]',
      '',
      'To check: the CEO quote.',
    ].join('\n'),
  },

  /** the fake Gmail (fakes/gmail.json): Chris's reply, an older thread, a welcome */
  gmail: {
    welcome: {
      subject: 'Welcome to Steepling!',
      body: 'Hi Mina,\n\nWelcome aboard! Your accounts are ready. The launch project has everything for Monday, and I\'ll see you at 10 for coffee.\n\nSara',
    },
    specs: {
      subject: 'Banner specs for the November launch',
      body: 'Hi Leo,\n\nFor the November launch we\'ll run 1200×628 on the web and 1080×1080 on Instagram. Send the finals by Friday and we\'ll schedule them from Monday.\n\nBest,\nChris\nFieldnote Studio',
    },
    replyBody: 'Hi Mina,\n\nWelcome to the team! {reply}\n\nChris\nFieldnote Studio',
    /** Sara passes Chris's older mail on to Mina */
    forwardNote: 'FYI, Chris\'s specs for the launch. He\'s your contact now.',
    forwarded: '---------- Forwarded message ----------',
    forwardPrefix: 'Fwd: ',
    replyPrefix: 'Re: ',
  },

  /** the fake Google Drive (fakes/drive.json) */
  drive: [
    { id: 'media-plan', name: 'Fieldnote media plan, November', mimeType: 'application/vnd.google-apps.spreadsheet', folder: 'Fieldnote', minutesAgo: 9 * 1440, text: 'Channel,Size,From,To,Budget\nWeb banner,1200×628,2026-11-23,2026-12-06,$1200\nInstagram,1080×1080,2026-11-23,2026-12-06,$800\nInstagram story,1080×1920,2026-11-23,2026-11-29,$400\n' },
    { id: 'photo-ideas', name: 'Launch photo ideas', mimeType: 'application/vnd.google-apps.document', folder: '', minutesAgo: 4 * 1440, text: 'Launch photo ideas\n\n- Frosted window, morning light\n- The green pouch next to an iced glass\n- No text inside the photo\n' },
  ],

  /** the team skills' titles (make.ts writes them into each SKILL.md's metadata), as the Skills page, the chat's skill
   * menu and the AI name them: never the folder name (QA TC-5553: the ko team skill showed "social-posts"). The bar's
   * suggestions below call the skills by these words */
  skillTitles: {
    'brand-guide': 'Brand guide',
    'social-posts': 'Social posts',
    'press-release': 'Press release draft',
    'competitor-roundup': 'Competitor roundup',
    handover: 'Handover helper',
    'review-digest': 'Customer review summary',
  },

  /** the free-roam bar: what a tap asks */
  suggestions: [
    { label: 'Draft next week\'s posts', prompt: 'Use our social posts skill to draft next week\'s posts for the empty slots in the social calendar' },
    { label: 'Summarise customer reviews', prompt: 'Use the customer review summary skill on our reviews' },
    { label: 'Did Chris reply?', prompt: 'Did Chris reply to my email? Check my Gmail' },
  ],
}

export type FreeRoamStrings = typeof en
