- AI apps (Claude, ChatGPT) connected to the team server keep working when someone floods the server's sign-in pages:
  their tool calls, token refreshes and upload links no longer share a limit with requests that carry no valid sign-in.
- Registered apps that never finished connecting are removed a day after their last use, and a full list makes room
  from them instead of refusing every new app. One address can register at most 12 apps a minute and 240 an hour, and
  start at most 10 sign-ins for one app in 10 minutes.
