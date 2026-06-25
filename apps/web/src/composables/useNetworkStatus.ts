/**
 * 网络状态监听
 *
 * 基于 navigator.onLine + online/offline 事件，提供响应式的网络连接状态。
 * 模块级单例，所有组件共用同一个 isOnline 实例，避免重复注册事件监听。
 */
import { readonly, ref } from 'vue';

const isOnline = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
let listening = false;

function startListening() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('online', () => { isOnline.value = true; });
  window.addEventListener('offline', () => { isOnline.value = false; });
}

export function useNetworkStatus() {
  startListening();
  return { isOnline: readonly(isOnline) };
}
