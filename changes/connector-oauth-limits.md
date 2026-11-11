- AI apps (Claude, ChatGPT) connected to the team server keep working when someone floods the server's sign-in pages:
  their tool calls, token refreshes and upload links no longer share a limit with requests that carry no valid sign-in.
  New apps can still connect during a flood: a full list makes room from apps that never finished connecting (these
  are also removed a day after their last use), one address can register at most 60 apps an hour, and one app can
  have at most 10 sign-ins in progress from one address.
