- Demo: the banner's words are now a small file, `banner.json`, next to the banner pictures in the project. Asking
  "흐린 아침 말고 밝은 아침으로 해줘" changes only those words, and the AI redraws every size in one step. Before, the AI
  could not see the banner's words: it treated the request as a new photo, rewrote words nobody asked to change, and
  said it did not know the original headline.
