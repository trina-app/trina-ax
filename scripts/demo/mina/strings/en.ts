// Every word of the demo story in English (the source language). A new language is a copy of this file,
// strings/<locale>.ts, translated, plus its pictures and text files in ../assets with the same `.<locale>.` names
// (../source/render.mjs makes the banners from ../source/banners/copy.<locale>.json).
//
// Plain strings only. `{project}` in a text becomes a link to the campaign project; the story (../story.ts) adds the
// pictures, file links, steps and timing around the words. Keep every AI answer short: about 15–20 seconds to read.

export const en = {
  company: 'Steepling',

  people: {
    mina: { name: 'Mina Lee', title: 'Marketing · first day' },
    sara: { name: 'Sara Jensen', title: 'Marketing lead' },
    daniel: { name: 'Daniel Okoye', title: 'CEO' },
    leo: { name: 'Leo Santos', title: 'Marketing (moving to Sales)' },
    tom: { name: 'Tom Becker', title: 'Operations lead' },
    aiko: { name: 'Aiko Tanaka', title: 'Sales' },
    omar: { name: 'Omar Haddad', title: 'Online shop' },
    chris: { name: 'Chris Walker', title: 'Account director', org: 'Fieldnote' },
  },
  marketingGroup: 'Marketing',
  project: { name: 'November launch campaign', description: 'Winter Yuzu Ginger launch, Monday Nov 23' },

  /** team file names (folders and names in the team drive) */
  paths: {
    companyIntro: 'shared/Company intro.md',
    brandGuide: 'shared/Brand guide.md',
    brief: 'November launch brief.md',
    leoBanner: 'launch-banner-leo-v1.png',
    // A and B save under the same names (the latest one wins), so the mail always attaches what the visitor made
    banner: 'launch-banner-new.png',
    square: 'instagram-square.png',
    story: 'instagram-story.png',
    captions: 'captions.md',
    brandCheck: 'brand-check.md',
    background: 'background-yuzu-ginger.png',
  },

  /** the words of the steps shown above an answer */
  steps: {
    read: 'Read',
    save: 'Save',
    makeBanner: 'Make banner',
    makeSquare: 'Make Instagram square',
    makeStory: 'Make Instagram story',
    writeCaptions: 'Write captions',
    higgsfield: 'Generate background image (leaf green, yuzu slices, soft light)',
    gmailSearch: 'Search mail',
    gmailSend: 'Send email',
  },

  home: {
    title: 'Welcome aboard, Mina! Congratulations on your first day.',
    subtitle: 'Sara invited you · 7 people are here',
  },

  rooms: {
    everyone: [
      { from: 'daniel', text: 'Mina Lee joins our Marketing team today. Say hi! 🎉' },
      { from: 'tom', text: 'Welcome Mina! Anything orders or shipping, ping Ops.' },
      { from: 'aiko', text: 'Hi Mina ☺️ coffee this week?' },
      { from: 'omar', text: 'Welcome! Tell me when a banner needs to go up on the shop.' },
    ],
    marketing: [
      { from: 'leo', text: 'First draft of the launch banner is up in the project. Be honest 😅' },
      { from: 'sara', text: 'Thanks Leo, I\'ll take a look.' },
    ],
  },

  leoChat: {
    title: 'Launch banner, first draft',
    ask: 'Make a launch banner for the Yuzu Ginger blend. 20% off, 11/23 to 12/6',
    answer: 'Here\'s a first draft of the banner.',
  },

  answers: {
    company: {
      prompt: 'What does our company do?',
      text: [
        '**Steepling** makes cold-brew tea bags. Drop one in cold water, done. 12 of us, selling online and to cafés.',
        '',
        '**Your job**: launch banners and social, on Sara\'s Marketing team.',
        '',
        '**This week**: Yuzu Ginger launches **Monday**. The launch banner is the big open item.',
      ].join('\n'),
      /** "people to know", one line each (in the answer's text) */
      peopleTitle: 'People to know',
      people: {
        sara: 'Your lead. Ask her anything.',
        leo: 'Made the first banner. Moves to Sales Monday.',
        daniel: 'CEO. Says yes to the launch.',
      },
    },
    bannerA: {
      prompt: 'Fix it with our brand guide',
      text: [
        'Fixed it with the brand guide, and made the rest of the launch set while I was at it.',
        '',
        '- **One big title**, everything else smaller',
        '- **Leaf green and cream**, yuzu yellow only on the sale badge',
        '- **Logo top left**, Pretendard throughout',
        '',
        'Captions for the posts:',
      ].join('\n'),
      after: 'Leo\'s original is still in the project, untouched.',
    },
    bannerB: {
      prompt: 'Make a new background with Higgsfield',
      text: [
        'New background from Higgsfield: deep leaf green, soft yuzu slices, a bit of window light. Text is cream so it reads on the dark.',
        '',
        'Same set in every size, plus captions for the posts:',
      ].join('\n'),
      after: 'The background is saved on its own too, if you want it for other posts.',
    },
    /** the captions both versions come with (A and B share them) */
    captions: [
      'New for winter: Yuzu Ginger 🍋 Drop a bag in cold water before bed, wake up to something bright. 20% off till Dec 6.',
      'yuzu + ginger. that\'s it. that\'s the post. (ok fine, it\'s also 20% off this week)',
      'Our team has been quietly drinking this since August. It\'s yours from Monday.',
    ],
    captionsTitle: 'Captions: Yuzu Ginger launch',
    /** brand-check notes that come with version A */
    brandCheck: {
      title: 'Brand check: launch banner v2',
      lines: [
        'Title: one message, "Hello, Yuzu Ginger", 3× the body size',
        'Colours: leaf green #1F4D3A and cream #F6F1E7; yuzu yellow #F2B630 only on the sale badge',
        'Removed: pastel gradient, red sale text, stars',
        'Font: Pretendard ExtraBold / Regular',
        'Logo: top left, 64 px from the edge',
      ],
    },
    deliverables: {
      banner: 'Web banner · 1200×628',
      square: 'Instagram square · 1080×1080',
      story: 'Instagram story · 1080×1920',
      captions: '3 captions',
      brandCheck: 'Brand check',
      background: 'Higgsfield background',
    },
    compare: { before: 'Before: Leo\'s draft', after: 'After' },
    /** the other sizes, shown in the answer under the new banner */
    otherSizes: 'Same look, every size:',
    sendTo: 'Send to #Marketing',
    mail: {
      prompt: 'Email the banner to Chris',
      intro: 'Here\'s a draft. Chris\'s address was in your team\'s past emails.',
    },
  },

  mail: {
    to: 'Chris Walker (chris.walker@fieldnote.example)',
    labels: { to: 'To', subject: 'Subject', attachments: 'Attached' },
    plain: {
      subject: 'Final banner for Monday\'s launch',
      body: [
        'Hi Chris,',
        '',
        'I\'m Mina, I just joined Marketing at Steepling. I\'ll be your contact for banners from now on.',
        '',
        'Attached: the final launch banner (1200×628) and the Instagram square. Daniel has signed off. Can you run them from Monday, Nov 23?',
        '',
        'Thanks!',
        'Mina',
      ],
    },
    formal: {
      subject: 'Steepling launch campaign: final banner for Monday, November 23',
      body: [
        'Dear Chris,',
        '',
        'I hope you\'re well. My name is Mina Lee, and I\'ve just joined the Marketing team at Steepling.',
        '',
        'Please find attached the final launch banner (1200×628) and the Instagram square version. Both have been approved by our CEO. Could you please run them from Monday, November 23?',
        '',
        'Thank you, and I look forward to working with you.',
        '',
        'Kind regards,',
        'Mina Lee',
        'Marketing, Steepling',
      ],
    },
    confirm: 'Send this email with Gmail?',
    send: 'Send',
    makeFormal: 'Make it more formal',
    /** the formal draft's second button (so every confirm card has the same two buttons) */
    sendShort: 'Send the shorter one',
    formalIntro: 'More formal version:',
    /** {subject} is filled in */
    sent: 'Sent to Chris: "{subject}", with the banner and the square attached.',
  },

  events: {
    leadDm: 'Leo\'s banner for Monday\'s launch needs love. You\'re the design person — can you take a pass? Everything\'s in the project.\n\n{project}',
    leadDmToast: 'Got a sec? 🙏',
    ceoShip: '🔥 This is it. Ship it.',
    leoHow: 'wait how did you do this so fast 😂',
    leadGmail: 'Mina, Gmail\'s connected. Ask Trina to send it to Chris at Fieldnote, our agency.',
    chrisReply: 'Looks great, running it Monday.',
    /** Sara passes on the agency's reply in #Marketing; {reply} is chrisReply */
    chrisRelayed: 'Chris just replied to your email: "{reply}" 🎉 Great first day, Mina.',
  },

  /** each step's line, and `away`: the line while the visitor is somewhere else */
  guide: {
    ask: { text: 'Ask Trina about the company →', away: 'Your first question is on Home →' },
    dm: { text: 'Sara sent you a message →', away: 'Sara is waiting in your DMs →' },
    project: { text: 'Open the project in Sara\'s message →', away: 'Sara is waiting in your DMs →' },
    banner: { text: 'Pick one: brand guide or Higgsfield →', away: 'Leo\'s banner is waiting in the project →' },
    share: { text: 'Send it to #Marketing →', away: 'Your new banner is ready to share →' },
    room: { text: 'Open #Marketing: the team is reacting →', away: 'Open #Marketing: the team is reacting →' },
    mail: { text: 'Ask ✦ Trina to email Chris →', away: 'Chris still needs the banner →' },
  },

  fallback: { text: 'This demo follows suggested prompts. Try this one:', question: 'Next step' },

  end: {
    title: 'That\'s Mina\'s first day',
    body: 'From "what do we do here?" to a launch banner the CEO approved and the agency is running. Day one.',
    stats: {
      time: 'Time',
      filesRead: 'Files read',
      deliverables: 'Deliverables',
      approvals: 'CEO approval',
      emails: 'Email sent',
    },
    /** one line under the numbers: what this usually takes */
    usually: 'Without Trina: about 2 days',
    signup: 'Start your team\'s free trial',
    explore: 'Look around',
  },
}

/** the shape every locale's strings file has */
export type Strings = typeof en
