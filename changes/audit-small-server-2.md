- When two people replace the same file at the same moment, File history now keeps each version with its own content,
  and restoring the one in between brings it back. Before, that version could hold the other upload's content and
  restoring it did nothing.
- Linux server: the first-run setup code (`setup/code`) is deleted once the team has its owner, at the next repair or
  update, or by an uninstall that keeps the data. It stayed on the disk before.
