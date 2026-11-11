- The knowledge graph is removed. Trina's AI finds your files the way it did before: it lists folders, matches file
  names, searches the words inside files and reads them. In tests it found the same files without the knowledge graph,
  and it no longer quotes text that was already deleted from a file or waits for files to be indexed after a restart.
  Admin › Team settings no longer has a Knowledge graph section, and the Files search box lists the lines that contain
  your words. On the first start after the update, the server deletes the old index from its data folder. Admins: a
  `knowledgeGraph` entry in `server.json` is now ignored (the log says so once), so you can delete it.
