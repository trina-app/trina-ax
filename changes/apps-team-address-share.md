- Settings › Apps now shows the team address for a server you run yourself without the relay, such as an office
  server reached at `https://192.168.1.2:19300` or a Tailscale name with a port. It is the address the server is
  reached at, port included, so people can type it into the desktop or phone app. A plain `http://` address is
  shown with a note that the desktop and phone apps need a secure address (https). A server on the relay still
  shows only its relay address.
- In the phone app, Settings › Apps › "Send the link to a computer" opens the phone's share sheet when the app
  offers one (the Android app's own sheet in the next app release), instead of only copying the link.
