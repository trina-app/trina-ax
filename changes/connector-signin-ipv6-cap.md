- **AI apps (Claude, ChatGPT)**: one large IPv6 address block can no longer stop new connections by sending from many
  sub-networks. While the server is busy, such a block (an IPv6 /32) is slowed down as one network, and a person
  connecting from elsewhere gets through. Someone holding several sub-networks inside your provider's block can still
  slow your connection during such a flood.
- **AI apps**: the server does less work for requests from apps that are not connected yet during a flood (at most
  6,000 a minute, was 30,000). Connected apps are not affected. A flood from very many networks at once (about 120
  IPv4 /24s) can therefore stop new connections for the rest of that minute.
