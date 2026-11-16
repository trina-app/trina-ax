# The promo video saved as a file

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (adds to the archive's "V — The first result is the company's promo video")
- Branch: feat/save-promo-video (AI flow check FL-16, QA TC-3817)

- **Ask:** "신제품 홍보 영상 아주 짧게, 5초 정도로 만들어줘", then "그 영상 이소라님한테 보내줘". The video existed only as the
  preview beside the chat, so there was no file to send; the AI could only explain how to download and attach it.
- **Rule:** a new tool `save_promo_video` saves the chat's latest promo video as an .mp4 in the team folder (default the
  person's own folder, `users/<id>/videos/<title>.mp4`; `save_as` names another place). It is the same render as the
  preview's download (promo-video/render.ts: one render at a time, a finished one reused), waited for within the answer.
  The file is placed like every file the AI makes (tools/make-file.ts placeProduced: the person's write access, a
  conflict copy over a file not read in this turn, the turn's write budget, the audit line); the video's material and
  pictures are its sources, so a save where more people can read than those files asks first (the wider-audience card,
  with its Always allow as for make_file). Never under skills/. Then share_with_person / post_to_room send it as any file.
  The promo_video result tells the AI to call it when the person wants a file or to send, share or post the video.
- **Where:** only where the MP4 render runs (mp4Available: a development Mac with the pinned HyperFrames CLI). Elsewhere
  (hosted, Linux servers, the Office Mac) the tool is not offered, and the promo_video result tells the AI to say plainly
  that this server cannot save the video as a file. Making the render run on Linux team servers (the queued job in the
  srt dev environment, DECISIONS "V") is the remaining work.
- **Length:** the template is fixed at 18.5 s (five beats on a music grid). The AI now says that in the same answer and
  makes the video, instead of stopping to ask (FL-16 had one question card for it). A shorter cut needs a second timing
  grid in layout.ts / template.ts and its own music edit: not in this change.
- **Version impact:** minor (a new tool).
