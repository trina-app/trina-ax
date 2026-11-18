- With an AI model you set up yourself (OpenAI-compatible address), the AI can no longer save over a file it just read
  with an almost empty version: the save is refused and the file stays as it was, unless you asked for the whole file to
  be emptied or replaced.
- When a step of such an answer didn't work and the answer doesn't say so, a line at the end now says which step it was
  ("One step didn't work: Save."), so "done" never stands alone after a failed save.
- The same answers no longer start with the AI's own work notes ("Let me check…"): only the actual answer is shown.
- Links with no address (`[quote]()`) now show as plain words instead of a broken link.
- When the AI service itself is busy, the message now says so and suggests trying again shortly or picking another
  model. It no longer reads as if your team's usage limit was reached.
