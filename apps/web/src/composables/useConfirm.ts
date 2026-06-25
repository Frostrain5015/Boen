/**
 * 全局确认弹窗（单例模式）
 *
 * 基于 Promise 的确认对话框 API，支持常规操作和危险操作两种模式。
 * UI 渲染由 ConfirmDialog.vue 组件负责，通过 isOpen / options 响应式状态联动。
 *
 * 调用方式：
 *   const cf = useConfirm();
 *   const ok = await cf.confirm({ title: '删除', message: '确定吗？', danger: true });
 *   if (ok) proceed();
 */
import { ref } from 'vue';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作模式：确认按钮显示为红色警告色 */
  danger?: boolean;
}

/** 弹窗是否打开 */
const isOpen = ref(false);
/** 当前弹窗配置 */
const options = ref<ConfirmOptions>({ title: '', message: '' });
/** Promise resolve 回调，由 handleConfirm / handleCancel 触发 */
let resolver: ((value: boolean) => void) | null = null;

export function useConfirm() {
  /** 弹出确认框，返回用户的选择结果（true=确认，false=取消） */
  function confirm(opts: ConfirmOptions): Promise<boolean> {
    options.value = opts;
    isOpen.value = true;
    return new Promise<boolean>((resolve) => {
      resolver = resolve;
    });
  }

  /** 用户点击「确认」按钮 */
  function handleConfirm() {
    isOpen.value = false;
    resolver?.(true);
    resolver = null;
  }

  /** 用户点击「取消」或弹窗外区域 */
  function handleCancel() {
    isOpen.value = false;
    resolver?.(false);
    resolver = null;
  }

  return { isOpen, options, confirm, handleConfirm, handleCancel };
}
