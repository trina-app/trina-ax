- Word, PowerPoint and Excel files are now built and checked the same way in teams that never chose the dev
  environment (teams set up before it came): commands run there in a narrow documents mode (no internet, no team
  folders, only the chat's own work folder). This turns on without an admin step; an admin who saves the dev environment
  off turns it off too, and a server operator can turn it off with `MYCEL_DOCUMENTS_MODE=0`.
- When Trina looks at the pages of a Word or Excel file, fonts from Office (Calibri, Cambria, Malgun Gothic, MS Gothic,
  SimSun …) are drawn with matching open fonts, so Korean, Japanese and Chinese text never comes out blank and pages
  break where they do in Office. Text with no language of its own is drawn in the team's language (Korean unless the
  team writes Japanese or Chinese). Ubuntu 24.04 servers now show these pages too.
