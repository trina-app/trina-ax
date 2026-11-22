- Demo gate: a new setting, `limits.exemptIpHashes`, lets chosen addresses (such as the office's) skip the hourly and
  daily start limits and have more live demo copies at once (`limits.exemptLivePerIp`, default 6). It names the keyed
  hash the gate already stores, never a raw address. Empty by default, so nothing changes until it is set.
- Demo gate: on the busy, limit, ended and error pages the buttons now fill the same centred column as the text, stacked
  like the start page's Start button. At wide screens the two buttons sat in a wider row and the page looked lopsided.
