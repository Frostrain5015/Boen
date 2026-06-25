/**
 * 语音输入 composable
 *
 * 基于 Web Speech API 的语音识别封装，支持连续识别 + 中间结果。
 * 自动识别语言（英语学科用 en-US，其他用 zh-CN）。
 *
 * 调用方式：
 *   const { voiceListening, voiceError, toggleVoiceInput, initVoiceSupport } = useVoiceInput();
 */
import { ref, computed, onUnmounted } from 'vue';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';

// ── Web Speech API 类型声明 ─────────────────────
// 浏览器类型定义不统一（标准版 vs webkit 前缀），这里手动抽取子集
type SpeechRecognitionResultListLike = {
  length: number;
  [index: number]: { [index: number]: { transcript: string } | undefined } | undefined;
};
type SpeechRecognitionResultEventLike = Event & { results: SpeechRecognitionResultListLike };
type SpeechRecognitionErrorEventLike = Event & { error?: string; message?: string };
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
};

export function useVoiceInput() {
  const chatStore = useChatStore();
  const uiStore = useUiStore();

  const speechSupported = ref(false);
  const voiceListening = ref(false);
  const voiceError = ref('');

  let voiceRecognition: SpeechRecognitionLike | null = null;
  /** 语音开始前输入框已有的文本，用于拼接最终结果 */
  let voiceBaseText = '';

  /** 语音按钮的提示文字（支持状态 / 错误信息） */
  const voiceButtonLabel = computed(() => {
    if (!speechSupported.value) return '当前浏览器不支持语音输入';
    if (voiceListening.value) return '停止语音输入';
    return voiceError.value || '语音输入';
  });

  /** 获取浏览器 SpeechRecognition 构造函数（标准版或 webkit 前缀版） */
  function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
    const speechWindow = window as SpeechRecognitionWindow;
    return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
  }

  /** 将语音识别结果拼接到已有的输入框文本中 */
  function composeVoiceInput(base: string, transcript: string) {
    const spoken = transcript.trim();
    if (!spoken) return base;
    if (!base) return spoken;
    if (/\s$/.test(base)) return `${base}${spoken}`;
    // 中文字符直接拼接不加空格，英文单词间加空格
    const compact = /[\u4e00-\u9fff]$/.test(base) || /^[\u4e00-\u9fff]/.test(spoken);
    return `${base}${compact ? '' : ' '}${spoken}`;
  }

  /** 从语音识别结果列表中提取完整文本 */
  function collectSpeechTranscript(results: SpeechRecognitionResultListLike) {
    let transcript = '';
    for (let i = 0; i < results.length; i++) {
      transcript += results[i]?.[0]?.transcript ?? '';
    }
    return transcript;
  }

  /** 将浏览器错误码映射为用户友好的中文提示 */
  function speechErrorMessage(error?: string) {
    const messages: Record<string, string> = {
      'not-allowed': '麦克风权限被拒绝',
      'service-not-allowed': '语音识别服务不可用',
      'audio-capture': '没有找到麦克风',
      'no-speech': '没有听到声音',
      network: '语音识别网络错误',
    };
    return messages[error ?? ''] ?? '语音输入失败';
  }

  /** 停止语音识别（可选是否立即中止） */
  function stopVoiceInput(abort = false) {
    const recognition = voiceRecognition;
    if (!recognition) {
      voiceListening.value = false;
      return;
    }
    voiceRecognition = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      abort ? recognition.abort() : recognition.stop();
    } catch {
      // 浏览器层面已销毁旧实例时静默忽略
    }
    voiceListening.value = false;
  }

  /** 开始语音识别 */
  function startVoiceInput() {
    if (chatStore.busy) return;
    const Recognition = getSpeechRecognitionCtor();
    if (!Recognition) {
      speechSupported.value = false;
      voiceError.value = '当前浏览器不支持语音输入';
      return;
    }

    // 先停止旧实例，再创建新实例
    stopVoiceInput(true);
    voiceBaseText = chatStore.input;
    voiceError.value = '';

    const recognition = new Recognition();
    voiceRecognition = recognition;
    recognition.lang = uiStore.voiceLocale;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      chatStore.input = composeVoiceInput(voiceBaseText, collectSpeechTranscript(event.results));
    };
    recognition.onerror = (event) => {
      voiceError.value = speechErrorMessage(event.error);
    };
    recognition.onend = () => {
      if (voiceRecognition !== recognition) return;
      voiceRecognition = null;
      voiceListening.value = false;
    };

    try {
      recognition.start();
      voiceListening.value = true;
    } catch (err) {
      voiceRecognition = null;
      voiceListening.value = false;
      voiceError.value = err instanceof Error ? err.message : '语音输入启动失败';
    }
  }

  /** 开关语音输入 */
  function toggleVoiceInput() {
    if (voiceListening.value) stopVoiceInput();
    else startVoiceInput();
  }

  /** 初始化时检测语音支持性 */
  function initVoiceSupport() {
    speechSupported.value = Boolean(getSpeechRecognitionCtor());
  }

  // 组件卸载时自动停止语音
  onUnmounted(() => {
    stopVoiceInput(true);
  });

  return {
    speechSupported,
    voiceListening,
    voiceError,
    voiceButtonLabel,
    toggleVoiceInput,
    stopVoiceInput,
    initVoiceSupport,
  };
}
