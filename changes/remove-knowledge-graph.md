- The knowledge graph is removed. Trina's AI finds your files the way it did before: it lists folders, matches file
  names, searches the words inside files and reads them. In tests it found the same files without the knowledge graph,
  and it no longer quotes text that was already deleted from a file or waits for files to be indexed after a restart.
  Admin › Team settings no longer has a Knowledge graph section, and the Files search box lists the lines that contain
  your words. The older search by meaning tool (`search`, on only where `MYCEL_SEMANTIC=on` was set) is removed too, and
  `MYCEL_SEMANTIC` does nothing now. On the first start after the update, the server deletes from its data folder the
  old index, the old `semantic.db` and the downloaded search model (about 120 MB). Admins: a `knowledgeGraph` entry in
  `server.json` is now ignored (the log says so once), so you can delete it.
