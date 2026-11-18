- Desktop app on Windows: when "Find work files on this computer" looks through a folder on a network share, it no
  longer goes into a link or junction that Windows shows as one, nor into any folder of that share that turns out to be
  your home folder, a folder above it or a Windows system folder. DFS folders of a company namespace are still looked
  through. On this computer's own drives, a folder where another drive is mounted is skipped; OneDrive folders are
  still looked through.
