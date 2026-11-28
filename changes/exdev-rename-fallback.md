- Files the AI makes (Word reports, Excel sheets, slides and other documents) are saved again on Linux servers installed
  with the standard installer, including Windows (WSL2). Since 0.20.2 every such save failed with "internal error"
  because the server's data and team folders are two mounts of one disk there; the file is now copied when a move
  between them is refused.
