import { logger } from '../utils/logger';
import { getConfig } from '../config/config';

type EmbedFn = (text: string) => Promise<Float32Array>;

let _embed: EmbedFn | null = null;
let _modelName = '';
let _loading = false;
let _loadPromise: Promise<void> | null = null;

/** Detect whether we're running as a single executable (SEA). */
function isSea(): boolean {
  try {
    // node:sea is only available inside an SEA binary
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

async function loadModel(modelName: string): Promise<void> {
  if (_loading) {
    await _loadPromise;
    return;
  }

  // @xenova/transformers loads ONNX WASM backends and downloads models from
  // HuggingFace — neither works inside a single-executable binary.
  if (isSea()) {
    logger.info('SEA mode — embedding model loading skipped (not supported in single-executable builds)');
    _embed = null;
    return;
  }

  _loading = true;
  _loadPromise = (async () => {
    try {
      // Dynamic import so it doesn't block startup if package is missing
      const { pipeline, env } = await import('@xenova/transformers');
      // Disable GPU; use WASM/CPU only
      env.backends.onnx.wasm.numThreads = 2;

      logger.info('Loading embedding model', { model: modelName });
      const extractor = await pipeline('feature-extraction', modelName);

      _embed = async (text: string): Promise<Float32Array> => {
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        return new Float32Array(output.data as number[]);
      };
      _modelName = modelName;
      logger.info('Embedding model loaded', { model: modelName });
    } catch (err) {
      logger.warn('Failed to load embedding model; semantic search disabled', {
        error: String(err),
      });
      _embed = null;
    }
  })();

  await _loadPromise;
  _loading = false;
}

export async function getEmbedFunction(): Promise<EmbedFn | null> {
  const config = getConfig();
  const modelName = config.context.embeddingModel;

  if (_embed !== null && _modelName === modelName) return _embed;
  if (_embed === null && !_loading) await loadModel(modelName);

  return _embed;
}

export async function embedText(text: string): Promise<Float32Array | null> {
  const fn = await getEmbedFunction();
  if (!fn) return null;
  try {
    return await fn(text.slice(0, 2000)); // cap input length
  } catch (err) {
    logger.error('Embedding failed', { error: String(err) });
    return null;
  }
}

/** Kick off model loading in the background at startup */
export function warmupEmbeddings(): void {
  const config = getConfig();
  loadModel(config.context.embeddingModel).catch(() => {
    // Already logged inside loadModel
  });
}
