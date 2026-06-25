/**
 * 全局 Toast 通知系统（单例模式）
 *
 * 提供 success / error / info / warning 四种类型的轻量通知。
 * 所有通知在右下角堆叠展示（由 ToastProvider.vue 渲染），超时后自动消失。
 *
 * 调用方式：
 *   const toast = useToast();
 *   toast.success('操作成功');
 *   toast.error('操作失败');
 */
import { reactive, readonly } from 'vue';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  /** 自动消失延迟（ms），0 表示不自动消失 */
  duration: number;
}

/** 全局通知列表（模块级单例） */
const toasts = reactive<ToastItem[]>([]);
let nextId = 0;

/** 推送一条通知 */
function push(type: ToastType, message: string, duration: number) {
  const id = nextId++;
  toasts.push({ id, type, message, duration });
  if (duration > 0) setTimeout(() => dismiss(id), duration);
}

/** 关闭指定通知 */
function dismiss(id: number) {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx >= 0) toasts.splice(idx, 1);
}

export function useToast() {
  return {
    /** 只读通知列表（由 ToastProvider.vue 渲染） */
    toasts: readonly(toasts),
    dismiss,
    success: (msg: string) => push('success', msg, 4000),
    error: (msg: string) => push('error', msg, 6000),
    info: (msg: string) => push('info', msg, 4000),
    warning: (msg: string) => push('warning', msg, 5000),
  };
}
