- A self-installed server can sign in to Google (Drive, Gmail, Calendar, Docs and Sheets) through the hosting service,
  like a hosted team, once the hosting service has registered it: no Google client of its own and no Google review.
  The operator sets `MYCEL_GOOGLE_DRIVE_BROKER_URL`, removes the server's own Google client and runs
  `admin.js google-broker-key` for the key and address to register. Until the hosting service serves it, the admin
  page still lets an admin set a Google client of its own. A server with its own client is unchanged.
