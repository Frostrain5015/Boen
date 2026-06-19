import { ref, computed, onUnmounted } from 'vue';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';

// ── Speech Recognition type definitions ─────────────────────
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
  let voiceBaseText = '';

  const voiceButtonLabel = computed(() => {
    if (!speechSupported.value) return '\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u8bed\u97f3\u8f93\u5165';
    if (voiceListening.value) return '\u505c\u6b62\u8bed\u97f3\u8f93\u5165';
    return voiceError.value || '\u8bed\u97f3\u8f93\u5165';
  });

  function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
    const speechWindow = window as SpeechRecognitionWindow;
    return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
  }

  function composeVoiceInput(base: string, transcript: string) {
    const spoken = transcript.trim();
    if (!spoken) return base;
    if (!base) return spoken;
    if (/\s$/.test(base)) return `${base}${spoken}`;
    const compact = /[\u4e00-\u9fff]$/.test(base) || /^[\u4e00-\u9fff]/.test(spoken);
    return `${base}${compact ? '' : ' '}${spoken}`;
  }

  function collectSpeechTranscript(results: SpeechRecognitionResultListLike) {
    let transcript = '';
    for (let i = 0; i < results.length; i++) {
      transcript += results[i]?.[0]?.transcript ?? '';
    }
    return transcript;
  }

  function speechErrorMessage(error?: string) {
    const messages: Record<string, string> = {
      'not-allowed': '\u9ea6\u514b\u98ce\u6743\u9650\u88ab\u62d2\u7edd',
      'service-not-allowed': '\u8bed\u97f3\u8bc6\u522b\u670d\u52a1\u4e0d\u53ef\u7528',
      'audio-capture': '\u6ca1\u6709\u627e\u5230\u9ea6\u514b\u98ce',
      'no-speech': '\u6ca1\u6709\u542c\u5230\u58f0\u97f3',
      network: '\u8bed\u97f3\u8bc6\u522b\u7f51\u7edc\u9519\u8bef',
    };
    return messages[error ?? ''] ?? '\u8bed\u97f3\u8f93\u5165\u5931\u8d25';
  }

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
      // Ignore stale recognition instances after browser-level teardown.
    }
    voiceListening.value = false;
  }

  function startVoiceInput() {
    if (chatStore.busy) return;
    const Recognition = getSpeechRecognitionCtor();
    if (!Recognition) {
      speechSupported.value = false;
      voiceError.value = '\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u8bed\u97f3\u8f93\u5165';
      return;
    }

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
      voiceError.value = err instanceof Error ? err.message : '\u8bed\u97f3\u8f93\u5165\u542f\u52a8\u5931\u8d25';
    }
  }

  function toggleVoiceInput() {
    if (voiceListening.value) stopVoiceInput();
    else startVoiceInput();
  }

  function initVoiceSupport() {
    speechSupported.value = Boolean(getSpeechRecognitionCtor());
  }

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
