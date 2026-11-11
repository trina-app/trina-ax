- **Uploads:** a file going up when the connection drops now waits for it ("연결을 기다리는 중") and goes on by itself
  when it is back, from what the team server already has, for up to 10 minutes. It used to fail after about 15 seconds
  (a small file at once) and stay failed. A file that still fails has **다시 시도**, also in a folder upload on a phone.
- The same file uploaded again into the same folder (a retry whose answer was lost, or photos picked again) is kept
  once: no more "IMG_0001 (2).jpg" copies of a file that is already there. Another file with that name still gets a
  name of its own.
