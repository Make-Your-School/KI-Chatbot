// Local embedding pipeline using transformers.js.
//
// The model (default: multilingual-e5-small, ~120 MB) is downloaded once on
// first use and cached under ./data/transformers-cache.
// Runs fully on CPU — slow first call (~10-20s warmup), then ~20-50ms per query.
//
// e5-family models expect a "query:" / "passage:" prefix depending on which
// side of the retrieval you're on. Don't remove these prefixes.

import { mkdirSync } from "node:fs";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { config } from "./config.ts";

let embedder: FeatureExtractionPipeline | null = null;
let loading: Promise<FeatureExtractionPipeline> | null = null;

mkdirSync(config.rag.cacheDir, { recursive: true });
env.cacheDir = config.rag.cacheDir;
env.useBrowserCache = false;
env.useFSCache = true;

export const getEmbedder = (): Promise<FeatureExtractionPipeline> => {
  if (embedder) return Promise.resolve(embedder);
  if (loading) return loading;
  loading = pipeline("feature-extraction", config.rag.embeddingModel, {
    dtype: "fp32",
  }).then(p => {
    embedder = p as FeatureExtractionPipeline;
    loading = null;
    return embedder;
  });
  return loading;
};

const embed = async (prefixed: string): Promise<Float32Array> => {
  const pipe = await getEmbedder();
  const out = await pipe(prefixed, { pooling: "mean", normalize: true });
  // out.data is a Float32Array of length embeddingDim.
  return out.data as Float32Array;
};

export const embedQuery = (text: string): Promise<Float32Array> =>
  embed(`query: ${text}`);

export const embedPassage = (text: string): Promise<Float32Array> =>
  embed(`passage: ${text}`);
