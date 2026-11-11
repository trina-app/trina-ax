- An answer cut off when the AI's launcher restarted no longer keeps its chat "running" and its place in the answer queue
  until the server restarts. Its place comes back once the AI's process is gone (or, at the latest, a few minutes after
  the answer's time limit), and the chat takes new questions again.
- An unexpected error while starting one answer now fails only that answer. Before, every later question was refused
  until the server restarted.
- An error while ending an answer no longer leaves the answer streaming and its queue place taken.
