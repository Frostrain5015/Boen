import { reactive, readonly } from 'vue';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

const toasts = reactive<ToastItem[]>([]);
let nextId = 0;

function push(type: ToastType, message: string, duration: number) {
  const id = nextId++;
  toasts.push({ id, type, message, duration });
  if (duration > 0) setTimeout(() => dismiss(id), duration);
}

function dismiss(id: number) {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx >= 0) toasts.splice(idx, 1);
}

export function useToast() {
  return {
    toasts: readonly(toasts),
    dismiss,
    success: (msg: string) => push('success', msg, 4000),
    error: (msg: string) => push('error', msg, 6000),
    info: (msg: string) => push('info', msg, 4000),
    warning: (msg: string) => push('warning', msg, 5000),
  };
}
