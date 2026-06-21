import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export interface ModelConfig {
  provider: 'openai' | 'anthropic' | 'deepseek';
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  /** DeepSeek 专用：是否启用 thinking 模式（默认 true）。关闭后 tool_choice/function calling 可用 */
  enableThinking?: boolean;
}

/**
 * 可插拔模型工厂。
 * - openai：OpenAI 兼容接口（讯飞 MaaS / Kimi K2.6），换 baseURL。
 * - anthropic：Claude 原生。
 * - deepseek：DeepSeek V4 Flash（OpenAI 兼容），baseURL = https://api.deepseek.com
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
  const modelKwargs: Record<string, unknown> = {};
  // DeepSeek V4 默认开启 thinking，tool_choice 需要关闭 thinking 才能用
  if (isDeepSeek && cfg.enableThinking === false) {
    modelKwargs.thinking = { type: 'disabled' };
  }
  return new ChatOpenAI({
    model: isDeepSeek ? (cfg.model || 'deepseek-chat') : cfg.model,
    apiKey: cfg.apiKey,
    temperature: cfg.temperature ?? 0.7,
    timeout: 120000,
    maxTokens: cfg.maxTokens ?? 4096,
    maxRetries: 2,
    streamUsage: false,
    modelKwargs: Object.keys(modelKwargs).length > 0 ? modelKwargs : undefined,
    configuration: {
      baseURL: isDeepSeek ? 'https://api.deepseek.com' : (cfg.baseUrl || undefined),
    },
  });
}
