- **Relay:** one visitor can no longer make a team unreachable by opening many connections and not reading the answers.
  One address (IPv6: one /64) can hold at most 256 of a team's streams at once (`RELAY_MAX_STREAMS_PER_IP`), and an answer
  the visitor stopped reading is cut after 30 seconds (`RELAY_CLIENT_STALL_MS`). Before, 1,100 such connections took every
  stream and nobody else could open the team's address.
