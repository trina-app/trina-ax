// The embedder of search by meaning (contract: meaning/vectors.ts). CONTRACT STUB (wave 2 setup): the meaning-index
// agent replaces the inside (the pinned model files, their hash check and download, transformers.js with remote models
// off, the e5 prefixes, mean pooling and normalization). Callers rely only on this signature.
import type { Embedder } from './vectors'

export interface EmbedderOptions {
  /** the team's own model folder (<data>/models): files downloaded there and checked against their pinned hashes */
  modelDir: string
  /** a read-only model folder shared by the teams of a host ($MYCEL_MODELS_DIR/semantic), used when its files match */
  sharedDir?: string | null
  /** ONNX threads (one for indexing in the background, a few for a person's query) */
  threads?: number
}

/** Opens the embedder: the model files ready (checked, downloaded when missing) and loaded. Throws when it cannot. */
export async function openEmbedder(_o: EmbedderOptions): Promise<Embedder> {
  throw new Error('meaning embedder: not built yet (wave 2 contract stub)')
}
