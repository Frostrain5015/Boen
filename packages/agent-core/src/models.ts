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
  /**
   * 是否启用 thinking 模式。两家开关字段不同（已实测）：
   * - deepseek：用 thinking:{type:'enabled'|'disabled'}；强制 tool_choice 时必须 disabled，否则 400。
   * - openai(讯飞 MaaS)：用顶层 enable_thinking:true（DeepSeek 式 thinking 字段会被静默忽略）。
   * 省略时保持各家默认（deepseek 默认开、讯飞默认关）。
   */
  enableThinking?: boolean;
  /** 请求超时（ms），默认 120000。thinking 模式耗时长，出卷场景建议调大。 */
  timeout?: number;
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
  if (isDeepSeek) {
    // DeepSeek V4：thinking:{type} 控制。强制 tool_choice 时必须 disabled（实测开启会 400）。
    if (cfg.enableThinking === true) modelKwargs.thinking = { type: 'enabled' };
    else if (cfg.enableThinking === false) modelKwargs.thinking = { type: 'disabled' };
    // 省略 → 保持 DeepSeek 默认（thinking 开启）
  } else if (cfg.enableThinking) {
    // 其它 OpenAI 兼容接口：思考开关是顶层 enable_thinking 参数
    modelKwargs.enable_thinking = true;
  }
  return new ChatOpenAI({
    model: isDeepSeek ? (cfg.model || 'deepseek-chat') : cfg.model,
    apiKey: cfg.apiKey,
    temperature: cfg.temperature ?? 0.7,
    timeout: cfg.timeout ?? 120000,
    maxTokens: cfg.maxTokens ?? 4096,
    maxRetries: 2,
    streamUsage: false,
    modelKwargs: Object.keys(modelKwargs).length > 0 ? modelKwargs : undefined,
    configuration: {
      baseURL: isDeepSeek ? 'https://api.deepseek.com' : (cfg.baseUrl || undefined),
    },
  });
}
