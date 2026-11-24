- On Linux team servers, **Download as a video file** for a promo video with photos no longer fails for lack of
  memory. The video file is made from copies of the photos at the size the video needs (a phone's 12 or 48 MP photo
  went in at full size), the video tool sizes its browser and encoder by the memory and CPUs it is given, not by the
  whole server's, and it encodes the video after drawing it instead of at the same time. The photos in the team folder
  and the video next to the chat are unchanged.
