- Word, PowerPoint and Excel files are now built and checked the same way for everyone, also where the team's dev
  environment is off: commands then run in a narrow documents mode (no internet, no team folders, only the chat's own
  work folder). This turns on without an admin step; a server operator can turn it off with `MYCEL_DOCUMENTS_MODE=0`.
- When Trina looks at the pages of a Word or Excel file, fonts from Office (Calibri, Cambria, Malgun Gothic, MS Gothic,
  SimSun …) are drawn with matching open fonts, so Korean, Japanese and Chinese text never comes out blank and pages
  break where they do in Office. Ubuntu 24.04 servers now show these pages too.
