import { ref } from 'vue';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作模式：确认按钮变红 */
  danger?: boolean;
}

const isOpen = ref(false);
const options = ref<ConfirmOptions>({ title: '', message: '' });
let resolver: ((value: boolean) => void) | null = null;

export function useConfirm() {
  function confirm(opts: ConfirmOptions): Promise<boolean> {
    options.value = opts;
    isOpen.value = true;
    return new Promise<boolean>((resolve) => {
      resolver = resolve;
    });
  }

  function handleConfirm() {
    isOpen.value = false;
    resolver?.(true);
    resolver = null;
  }

  function handleCancel() {
    isOpen.value = false;
    resolver?.(false);
    resolver = null;
  }

  return { isOpen, options, confirm, handleConfirm, handleCancel };
}
