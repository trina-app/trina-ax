# Synthetic image fixtures

No customer or personal data. `synthetic.png` is a programmatically generated 64×64 RGB gradient.
`synthetic.heic` is that PNG encoded with macOS `sips -s format heic`; it tests the Linux libheif
primary-image path. `synthetic.webp` is a 1×1 synthetic WebP decoded from this fixed Base64:
`UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA`.
Corrupt files, huge headers, bomb archives and EXIF/GPS metadata are generated in tests.
