- Putting a seal or picture on a PDF from a source checkout (development and tests) no longer fails now and then with
  "the image could not be read (a damaged PNG or JPG)". The helper that reads the picture was sometimes built with the
  wrong PNG decoder; the build now names the right one.
