import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';

// 国内服务器从 HF 镜像拉模型权重，规避 huggingface.co 不可达；可用 HF_ENDPOINT 覆盖
env.remoteHost = process.env.HF_ENDPOINT ?? 'https://hf-mirror.com';

/**
 * 本地中文 embedding（bge-small-zh-v1.5，ONNX，进程内运行）。
 * 选本地是为了不绑定模型厂商——未来 chat 模型可切换，向量化保持离线、免费、稳定。
 * 归一化输出，余弦相似度即点积。
 */
export const CURRICULUM_EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5';
export const MULTILINGUAL_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
export type EmbeddingModel = typeof CURRICULUM_EMBEDDING_MODEL | typeof MULTILINGUAL_EMBEDDING_MODEL;
/** bge 短查询检索建议加的中文指令前缀（passage 不加） */
const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';

const extractors = new Map<EmbeddingModel, Promise<FeatureExtractionPipeline>>();
function getExtractor(model: EmbeddingModel): Promise<FeatureExtractionPipeline> {
  const cached = extractors.get(model);
  if (cached) return cached;
  const options = model === MULTILINGUAL_EMBEDDING_MODEL
    ? { dtype: 'q8' as const, session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } }
    : {};
  const extractor = pipeline('feature-extraction', model, options)
    .catch((error: unknown) => {
      extractors.delete(model);
      throw error;
    });
  extractors.set(model, extractor);
  return extractor;
}

/** 批量向量化（passage 侧，不加指令前缀） */
export async function embedTexts(texts: string[], model: EmbeddingModel = CURRICULUM_EMBEDDING_MODEL): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor(model);
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  return out.tolist() as number[][];
}

/** 向量化一条检索查询（加 bge 中文指令前缀） */
export async function embedQuery(query: string, model: EmbeddingModel = CURRICULUM_EMBEDDING_MODEL): Promise<number[]> {
  const prefix = model === MULTILINGUAL_EMBEDDING_MODEL ? 'query: ' : QUERY_INSTRUCTION;
  const [v] = await embedTexts([prefix + query], model);
  return v;
}

/** 余弦相似度（输入已归一化 → 点积即可） */
export function cosineSim(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** number[] ↔ BLOB（Float32 存储，节省一半空间） */
export function vectorToBlob(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}
export function blobToVector(b: Buffer): number[] {
  // 安全构造 Float32Array：复制到对齐缓冲区，防止 b.buffer 未按 4 字节对齐导致 RangeError
  const aligned = Buffer.alloc(b.length);
  b.copy(aligned);
  return Array.from(new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4));
}
