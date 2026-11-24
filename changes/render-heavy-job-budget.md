- A promo video's MP4, LibreOffice page views and HTML-to-PDF prints now share one memory budget on the server. On a
  server with less than 6 GiB they run one at a time, so a video and a large Word file no longer run the server out of
  memory together. While another job runs, the video button says **Waits for another job to finish…** ("다른 작업이
  끝나면 시작해요").
- The MP4's time limit now follows the server's CPUs and the video's length (about 11 minutes on 2 cores) instead of a
  fixed 8 minutes, and a failed MP4 says why: it took too long, or it needed more memory.
