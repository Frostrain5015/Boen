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
