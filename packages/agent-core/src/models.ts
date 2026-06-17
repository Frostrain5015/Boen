import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export interface ModelConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
}

/**
 * 可插拔模型工厂：LangGraph 节点只依赖抽象的 BaseChatModel。
 * - openai：覆盖一切 OpenAI 兼容接口（讯飞 MaaS / DeepSeek / 通义兼容模式 等），仅换 baseURL。
 * - anthropic：Claude 原生。
 */
export function getChatModel(cfg: ModelConfig): BaseChatModel {
  if (cfg.provider === 'anthropic') {
    return new ChatAnthropic({
      model: cfg.model,
      apiKey: cfg.apiKey,
      temperature: cfg.temperature ?? 0.7,
      ...(cfg.baseUrl ? { anthropicApiUrl: cfg.baseUrl } : {}),
    });
  }
  return new ChatOpenAI({
    model: cfg.model,
    apiKey: cfg.apiKey,
    temperature: cfg.temperature ?? 0.7,
    // 部分 OpenAI 兼容厂商（如讯飞 MaaS）在每个流式分片里都回传 token 用量，
    // 会触发 LangChain 的 chunk 合并告警；关闭流式用量请求以消除噪音。
    streamUsage: false,
    configuration: cfg.baseUrl ? { baseURL: cfg.baseUrl } : undefined,
  });
}
