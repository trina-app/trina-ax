- People's messages in rooms, DMs and thread replies now show Markdown like the AI's answers: **bold**, *italic*,
  `code`, lists, code blocks and [links](https://example.com). Line breaks stay, @mentions still stand out and web
  addresses are still links. HTML stays text, `javascript:` links stay text, and pictures from other sites are not
  loaded by themselves. Quotes of a message, a message being sent, previews and notifications stay plain text.
  A link whose words do not show where it goes (`[paypal.com](https://…)`, `[here](…)`, an e-mail address) shows
  the real site or address in brackets next to it. Lists and quotes nest at most 6 deep, and a message Markdown
  cannot draw (or would read only very slowly) shows as plain text instead.
- A message (or an AI answer) stuffed with footnote marks such as `[^1]:` no longer freezes a room for seconds:
  people's messages show footnote marks as typed, and so does an answer whose footnotes would read that slowly. Very
  long messages of very short lines, and other text Markdown would read slowly, show as plain text.
