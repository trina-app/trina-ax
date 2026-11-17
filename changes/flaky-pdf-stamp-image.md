- Putting a seal or picture on a PDF no longer fails now and then with "the image could not be read (a damaged PNG or
  JPG)". The helper that reads the picture was sometimes built with the wrong PNG decoder; every build of it (in
  development and the release bundles) now names the right one and stops if the wrong one gets in.
