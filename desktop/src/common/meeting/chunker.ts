// Meeting notes: the cutter that makes pieces of speech at pauses lives in shared/src/speech-pieces.ts (the web app's
// voice input uses it too); this file re-exports it for the desktop app.
export { chunker, pieceWav, rmsOf, RATE, MAX_PIECE_MS, MIN_CLEAR_MS, type Chunker, type Piece, type Track } from '@mycel/shared/speech-pieces'
