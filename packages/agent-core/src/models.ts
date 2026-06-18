import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export interface ModelConfig {
  provider: 'openai' | 'anthropic' | 'deepseek';
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
}

/**
 * 可插拔模型工厂。
 * - openai：OpenAI 兼容接口（讯飞 MaaS 等），换 baseURL。
 * - anthropic：Claude 原生。
 * - deepseek：DeepSeek API（OpenAI 兼容），baseURL = https://api.deepseek.com
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

  const isDeepSeek = cfg.provider === 'deepseek';
  return new ChatOpenAI({
    model: isDeepSeek ? (cfg.model || 'deepseek-chat') : cfg.model,
    apiKey: cfg.apiKey,
    temperature: cfg.temperature ?? 0.7,
    streamUsage: false,
    configuration: {
      baseURL: isDeepSeek ? 'https://api.deepseek.com' : (cfg.baseUrl || undefined),
    },
  });
}
