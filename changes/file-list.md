- **File list.** Every night (02:00–05:00 in the team's time zone) the server has the team's AI read new and changed
  files in shared, project, group and connected folders, and keeps one English line per file saying what it really is
  (type, names, date, a short phrase). The in-app AI sees these lines as a `_FILES.md` in each folder and searches them
  first, so a scan named `temp.pdf` or a photo named `IMG_2031.jpg` is found by what it is. Each person sees only the
  lines of files they can open; nothing is written into the team folder, and no file is ever moved, renamed or changed.
- The reading uses the team's own AI account (Admin › AI accounts; a person's own account is never used) on its
  smallest model, and counts against that account's limit: **after this update, a team's file contents go to its AI
  provider on the first night**, a capped amount per night. Personal folders are not read.
- On by default. An admin can see the status (files listed, last and next run, which AI account it uses) and turn it
  off in Admin › Team settings › File list; off deletes the stored lines. A server's host can turn it off in
  `server.json` (`fileList.enabled: false`).
