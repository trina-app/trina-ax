- Atlassian (Jira, Confluence) works after you sign in. Its connection said "The address answered, but not like a
  connector", and chats said a saved connection key couldn't be read. Long sign-in tokens, like the ones Atlassian's
  newer address gives, were too big for the step that keeps keys out of answers, so that step failed. It now handles
  long tokens and many connections, and still hides every key. If a key ever can't be checked, Trina holds the text
  back instead of showing it unchecked.
- While you sign in to Atlassian, Trina explains what to do if Atlassian says your admin has blocked this domain: an
  Atlassian admin has to add your team's address, which the message names, to the allowed domains first.
