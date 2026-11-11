- A self-installed server can sign in to Google (Drive, Gmail, Calendar, Docs and Sheets) through the hosting service,
  like a hosted team, once the hosting service has registered it: no Google client of its own and no Google review.
  `admin.js google-broker-key` prints the key and address to register; the operator then sets
  `MYCEL_GOOGLE_DRIVE_BROKER_URL` and removes the server's own Google client. A server with its own client is unchanged.
