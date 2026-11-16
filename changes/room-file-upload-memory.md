- Fixed: a large file sent in a chat room could take the whole team server down. The server read the upload into
  memory before it checked the size, and an upload that arrived without a declared length passed the 50 MB limit;
  that memory was not given back, so a few such uploads used all of it and everyone got "502" until the server came
  back. Uploads are now written straight to disk and the limit is counted while the bytes arrive. The same fix covers
  files uploaded on the Files page, chat attachments, voice recordings and plugin files.
- You can now send files of up to 10 GB in a chat room, a DM or a group chat (it was 50 MB). A large file goes up in
  small pieces, shows its percent on the chip and goes on by itself after a lost connection while the chat stays open. A file over 10 GB is
  refused at once: "This file is too big to send in a chat. The limit is 10 GB."
