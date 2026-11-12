- **Connected folders** are checked again at every sync, not only when they are connected. If the connected folder is
  later replaced by a link, or now leads to a different place, the sync stops and the owner sees "This folder was not
  synced" with what to do. A file or folder inside it that is a link is never copied, even one swapped in while a sync
  is running, so a sync can no longer copy the server's own files or a closed folder into connected/.
