- Voice input no longer waits forever when the first download of the speech model stops halfway. After 2 minutes without
  data (or when the download takes far too long) it stops with a message to check the internet connection and try again,
  and other people's voice input can go ahead.
- An update whose download stops halfway now fails after 2 minutes with a message to check the internet connection.
  Until now it kept backup, restore, export and update answering "Another operation is already running" until the
  server restarted.
