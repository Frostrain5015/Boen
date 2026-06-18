import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';

// 国内服务器从 HF 镜像拉模型权重，规避 huggingface.co 不可达；可用 HF_ENDPOINT 覆盖
env.remoteHost = process.env.HF_ENDPOINT ?? 'https://hf-mirror.com';

/**
 * 本地中文 embedding（bge-small-zh-v1.5，ONNX，进程内运行）。
 * 选本地是为了不绑定模型厂商——未来 chat 模型可切换，向量化保持离线、免费、稳定。
 * 归一化输出，余弦相似度即点积。
 */
const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
/** bge 短查询检索建议加的中文指令前缀（passage 不加） */
const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) extractorPromise = pipeline('feature-extraction', MODEL_ID);
  return extractorPromise;
}

/** 批量向量化（passage 侧，不加指令前缀） */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  return out.tolist() as number[][];
}

/** 向量化一条检索查询（加 bge 中文指令前缀） */
export async function embedQuery(query: string): Promise<number[]> {
  const [v] = await embedTexts([QUERY_INSTRUCTION + query]);
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
  return Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
}
