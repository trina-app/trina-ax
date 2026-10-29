# Synthetic Hangul preview corpus

The agreement HWP/HWPX and notice HWPX are synthetic QA documents from the approved 2026-10-29 rhwp spike (no customer documents). The synthetic form was generated with @rhwp/core 0.8.7; it has a 3×3 table with deliberately mixed sizes/alignment. The two-page HWP was generated with createBlankDocument, two English paragraphs and insertPageBreak(0,1,0).

The malformed XML, oversized ZIP metadata and huge declared table variants are bounded synthetic inputs from that spike. Tests also construct locked/distribution flags, truncation and oversized inputs in memory. Locked fixtures exercise policy rejection, not password decryption.

Renderer/allowlisted font identities are pinned in resources/hwp/manifest.json. PNG pixels are approximate; these tests do not certify Hancom layout compatibility.
