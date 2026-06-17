<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Mascot from '@/components/Mascot.vue';
import { handleOAuthCallback } from '@/services/auth';

const emit = defineEmits<{
  (e: 'success'): void;
  (e: 'error', message: string): void;
}>();

const status = ref<'processing' | 'success' | 'error'>('processing');
const errorMessage = ref('');

onMounted(async () => {
  try {
    const success = await handleOAuthCallback(window.location.href);
    if (success) {
      status.value = 'success';
      // 清除 URL 参数
      window.history.replaceState({}, document.title, window.location.pathname);
      setTimeout(() => emit('success'), 800);
    } else {
      status.value = 'error';
      errorMessage.value = '无效的回调参数';
      emit('error', errorMessage.value);
    }
  } catch (err) {
    status.value = 'error';
    errorMessage.value = err instanceof Error ? err.message : '登录失败';
    emit('error', errorMessage.value);
  }
});
</script>

<template>
  <div class="relative flex h-full flex-col items-center justify-center">
    <div class="app-bg"></div>
    <div class="app-grain"></div>

    <div class="relative z-10 flex flex-col items-center gap-4">
      <!-- 吉祥物动画 -->
      <Mascot
        :size="80"
        :float="true"
        :state="status === 'processing' ? 'thinking' : status === 'success' ? 'happy' : 'surprise'"
      />

      <!-- 状态文字 -->
      <div class="text-center">
        <h2 class="text-xl font-bold text-[var(--ink)]">
          {{ status === 'processing' ? '正在登录…' : status === 'success' ? '登录成功！' : '登录失败' }}
        </h2>
        <p v-if="status === 'processing'" class="mt-1 text-sm text-[var(--ink-soft)]">
          正在验证你的身份
        </p>
        <p v-else-if="status === 'success'" class="mt-1 text-sm text-[var(--success)]">
          正在跳转…
        </p>
        <p v-else class="mt-1 text-sm text-[var(--error)]">
          {{ errorMessage }}
        </p>
      </div>

      <!-- 加载动画 -->
      <div v-if="status === 'processing'" class="mt-2 flex gap-1.5">
        <span
          v-for="i in 3"
          :key="i"
          class="h-2 w-2 rounded-full bg-[var(--accent)]"
          :style="{ animationDelay: `${i * 150}ms` }"
          style="animation: dotJump 1s ease-in-out infinite"
        ></span>
      </div>
    </div>
  </div>
</template>
