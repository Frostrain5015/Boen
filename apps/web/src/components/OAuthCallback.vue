<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { handleOAuthCallback } from '@/services/auth';
import AppLoading from '@/components/AppLoading.vue';

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
  <AppLoading
    :status="status"
    :message="
      status === 'processing' ? '正在登录…' :
      status === 'success' ? '登录成功！' :
      `登录失败：${errorMessage}`
    "
    :hint="
      status === 'processing' ? '正在验证你的身份' :
      status === 'success' ? '正在跳转到应用…' :
      '请稍后重试'
    "
  />
</template>
