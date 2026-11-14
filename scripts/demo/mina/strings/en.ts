// Every word of the demo story in English (the source language). A new language is a copy of this file,
// strings/<locale>.ts, translated, plus its pictures and text files in ../assets with the same `.<locale>.` names
// (../source/render.mjs makes the banners from ../source/banners/copy.<locale>.json).
//
// Plain strings only. `{project}` in a text becomes a link to the campaign project; the story (../story.ts) adds
// the pictures, file links and steps around the words. Keep every AI answer short: about 20 seconds to read.

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
  },
  marketingGroup: 'Marketing',
  project: { name: 'November launch campaign', description: 'Winter Yuzu Ginger launch (Nov 23 – Dec 6)' },

  /** team file names (folders and names in the team drive) */
  paths: {
    companyIntro: 'shared/Company intro.md',
    brandGuide: 'shared/Brand guide.md',
    brief: 'November launch brief.md',
    leoBanner: 'launch-banner-leo-v1.png',
    bannerA: 'launch-banner-v2.png',
    bannerB: 'launch-banner-v3-new-background.png',
    backgroundB: 'background-yuzu-ginger.png',
    final: 'launch-banner-final.png',
  },

  /** the words of the steps shown above an answer */
  steps: {
    read: 'Read',
    save: 'Save',
    list: 'List',
    teamSkills: 'Team skills',
    useSkill: 'Use skill',
    handoverSkill: 'Handover helper',
    makeBanner: 'Make banner',
    higgsfield: 'Generate background image (leaf green, yuzu slices, soft light)',
    gmailSearch: 'Search mail',
    gmailSend: 'Send email',
  },

  home: {
    title: 'Welcome aboard, Mina! Congratulations on your first day.',
  },

  rooms: {
    everyone: [
      { from: 'daniel', text: 'Mina Lee joins our Marketing team today. Please say hi! 🎉' },
      { from: 'tom', text: 'Welcome, Mina! Anything about orders or shipping, just ask us in Ops.' },
      { from: 'aiko', text: 'Hi Mina ☺️ Would love to show you our café pitch deck sometime.' },
      { from: 'omar', text: 'Welcome! Ping me when a banner needs to go up on the shop.' },
    ],
    marketing: [
      { from: 'leo', text: 'First draft of the launch banner is up in the project. Thoughts welcome!' },
      { from: 'sara', text: 'Thanks Leo. I\'ll check it against the brand guide.' },
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
        'Steepling makes **cold-brew tea bags**: drop one in cold water and it\'s ready in a few hours. We\'re 12 people, selling online and to cafés and offices. The winter **Yuzu Ginger** blend launches November 23.',
        '',
        'You\'re on Marketing, looking after **launch banners and social design**. Sara Jensen is your lead.',
        '',
        'Team skills you can use now:',
        '- **3 social post options**: three Instagram captions for a product',
        '- **Press release draft**: launch news as a press release',
        '- **Competitor roundup**: other tea brands\' news on one page',
        '',
        'You\'re taking over from Leo. **Want help with the handover?**',
        '',
        'Higgsfield is connected too, so just ask when you need an image.',
      ].join('\n'),
    },
    handover: {
      prompt: 'Yes, help me with the handover',
      label: 'Help with the handover',
      text: [
        'Here\'s what you\'re taking over from Leo:',
        '',
        '| Work | Where it stands | Due |',
        '|---|---|---|',
        '| Launch banner 1200×628 | Leo\'s first draft is up | Wed, Nov 18 |',
        '| 3 Instagram posts | Not started | Fri, Nov 20 |',
        '',
        'The banner draft is in {project}. Outside the company, Chris Walker at Fieldnote Studio puts the banners live from November 23.',
        '',
        'I\'d start with the **launch banner**, it\'s due first.',
      ].join('\n'),
    },
    bannerA: {
      prompt: 'Make the title bigger and use our brand colors',
      label: 'Bigger title, brand colors',
      text: [
        'Cleaned it up to match the brand guide:',
        '',
        '- **Bigger title**: just "Hello, Yuzu Ginger" up top, everything else smaller',
        '- **Brand colors**: leaf green and cream instead of the pastels, yuzu yellow only on the sale badge',
        '- **Font**: switched to Pretendard, like the guide says',
        '- **Logo**: moved from bottom right to top left',
      ].join('\n'),
      imageAlt: 'Launch banner v2',
      after: 'Leo\'s original is still there, untouched.',
    },
    bannerB: {
      prompt: 'Make a new background with Higgsfield and put it in',
      label: 'New background with Higgsfield',
      text: [
        'Made a new background with Higgsfield and put it in:',
        '',
        '- **Background**: deep leaf green with soft, out-of-focus yuzu slices and leaves, like a photo',
        '- **Text**: now cream, so it reads well on the dark green',
        '- **Sale**: kept the one yuzu yellow badge',
      ].join('\n'),
      imageAlt: 'Launch banner v3',
      after: 'I saved the background on its own in the same folder too.',
    },
    mail: {
      prompt: 'Email this banner to Chris',
      label: 'Email it to Chris',
      intro: 'Here\'s a draft. I found Chris\'s address in your past emails.',
    },
    mailFormal: {
      prompt: 'Make it a bit more formal and send it',
      label: 'More formal, then send',
      intro: 'Here\'s a more formal version. I found Chris\'s address in your past emails.',
    },
  },

  mail: {
    to: 'Chris Walker (chris.walker@fieldnote.example)',
    attachment: 'launch-banner-final.png',
    labels: { to: 'To', subject: 'Subject', attachment: 'Attachment' },
    plain: {
      subject: 'Final November launch banner',
      body: [
        'Hi Chris,',
        '',
        'I\'m Mina, I just joined the Marketing team at Steepling, so I\'ll be your contact for banners from now on.',
        '',
        'Here\'s the final banner for the November launch. Daniel has signed off on it.',
        '- Size: 1200×628',
        '- Goes live: Monday, November 23',
        '',
        'If you need a 1080×1080 version for Instagram, just let me know.',
        '',
        'Thanks,',
        'Mina',
      ],
    },
    formal: {
      subject: 'Steepling November launch campaign: final banner',
      body: [
        'Dear Chris,',
        '',
        'I hope you\'re well. My name is Mina Lee, and I\'ve recently joined the Marketing team at Steepling. Thank you for all your help with our campaigns.',
        '',
        'Please find attached the final banner for our November launch campaign. It has been reviewed by the team and approved by our CEO.',
        '- Size: 1200×628',
        '- Start date: Monday, November 23',
        '',
        'If you need a 1080×1080 version for Instagram, please let me know.',
        '',
        'Kind regards,',
        'Mina Lee',
        'Marketing, Steepling',
      ],
    },
    confirm: 'Send this email with Gmail?',
    send: 'Send',
    makeFormal: 'Make it more formal',
    formalIntro: 'Here\'s a more formal version.',
    cancel: 'Cancel',
    /** {attachment} and {subject} are filled in */
    sent: 'Sent. Chris now has **{attachment}** in an email titled "{subject}".\n\nYou\'ll find it in your Gmail Sent folder.',
    notSent: 'Not sent. Tell me what to change and I\'ll redo it.',
  },

  events: {
    leadDm: 'Hi Mina! You said you\'re good at design, right? Here\'s the launch banner Leo made. Want to take a pass at improving it? Our brand guide should help.\n\n{project}',
    leadReply: 'Oh, that\'s so much better! Daniel, OK to go with this one?',
    leoCheer: 'Looks really clean 👍 Happy to hand it over.',
    ceoOk: 'Looks good, go ahead 👍',
    leadGmail: 'Mina, our Gmail is connected. Just ask Trina to send it to Chris at the agency.',
  },

  guide: {
    ask: 'Next: ask about the company →',
    dm: 'Next: open Sara\'s message →',
    banner: 'Next: fix the banner →',
    share: 'Next: send it to #Marketing →',
    mail: 'Next: ask ✦ Trina to email it →',
  },

  fallback: { text: 'This demo runs on suggested prompts. Pick one below.', question: 'Try asking' },

  end: {
    title: 'That\'s Mina\'s first day',
    body: 'Getting to know the company, fixing a banner, the CEO\'s OK and an email to the agency, all on day one with Trina.\n\nTry it with your team.',
    signup: 'Start with your team',
    explore: 'Look around',
  },
}

/** the shape every locale's strings file has */
export type Strings = typeof en
