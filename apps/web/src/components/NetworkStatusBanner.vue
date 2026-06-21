<script setup lang="ts">
import { WifiOff } from 'lucide-vue-next';
import { useNetworkStatus } from '@/composables/useNetworkStatus';

const { isOnline } = useNetworkStatus();
</script>

<template>
  <Transition name="network-status">
    <div v-if="!isOnline" class="network-status" role="status" aria-live="polite">
      <WifiOff class="h-4 w-4" />
      <span>网络已断开，正在进行的请求会在恢复后同步结果</span>
    </div>
  </Transition>
</template>

<style scoped>
.network-status {
  position: fixed;
  z-index: 70;
  top: max(0.75rem, env(safe-area-inset-top));
  left: 50%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  max-width: calc(100vw - 2rem);
  transform: translateX(-50%);
  border: 1px solid #f2c46e;
  border-radius: 999px;
  background: #fff7df;
  box-shadow: 0 12px 28px -18px rgba(86, 64, 40, 0.45);
  color: #8a5608;
  padding: 0.55rem 0.9rem;
  font-size: 0.78rem;
  font-weight: 700;
}
.network-status-enter-active,
.network-status-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.network-status-enter-from,
.network-status-leave-to { opacity: 0; transform: translate(-50%, -0.5rem); }
</style>
