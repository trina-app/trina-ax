- Large uploads no longer exhaust the team server's memory: the server reads at most 3 upload chunks at once (others
  wait), frees memory after each chunk, and asks the app to retry a little later while memory is high. Before, three
  200 MB uploads at once slowed every page to 8-12 seconds and could stop the server.
