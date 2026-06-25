import { ref } from 'vue';

export interface PickedImage {
  /** Base64 编码的图片数据（不含 data: URI 前缀） */
  data: string;
  /** MIME 类型 */
  mimeType: string;
  /** 原始文件名（用于展示） */
  name: string;
}

/** 最大图片边长（像素） */
const MAX_DIM = 1200;
/** JPEG 压缩质量 */
const JPEG_QUALITY = 0.72;

/**
 * Canvas 压缩图片到指定最大边长，返回 base64 字符串。
 * 保持原始宽高比。
 */
function compressImage(file: File): Promise<PickedImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas 2D context 不可用')); return; }

      ctx.drawImage(img, 0, 0, width, height);
      const mimeType = 'image/jpeg';
      const data = canvas.toDataURL(mimeType, JPEG_QUALITY).replace(/^data:image\/\w+;base64,/, '');
      resolve({ data, mimeType, name: file.name });
    };
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = URL.createObjectURL(file);
  });
}

/**
 * 图片选择 composable。
 * 提供图片选取、压缩预览、清除功能。
 */
export function useImagePicker() {
  const pickedImages = ref<PickedImage[]>([]);

  /** 打开文件选择器并处理选定图片 */
  function pickFromFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      if (!input.files) return;
      const results = await Promise.allSettled(
        Array.from(input.files).map(f => compressImage(f)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          pickedImages.value.push(r.value);
        }
      }
    };
    input.click();
  }

  /** 移除指定索引的图片 */
  function removeImage(index: number): void {
    pickedImages.value.splice(index, 1);
  }

  /** 清空所有图片 */
  function clearImages(): void {
    pickedImages.value = [];
  }

  return {
    pickedImages,
    pickFromFile,
    removeImage,
    clearImages,
  };
}
