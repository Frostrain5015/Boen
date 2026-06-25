/**
 * 聊天滚动管理
 *
 * 提供滚动容器引用、自动滚动到底部、溢出检测等功能。
 * 内部使用 ResizeObserver 监听容器尺寸变化，自动更新溢出状态。
 */
import { ref, nextTick, onMounted, onUnmounted } from 'vue';

export function useScrollManagement() {
  /** 滚动容器的 DOM 引用 */
  const scroller = ref<HTMLElement | null>(null);
  /** 内容是否超出容器高度（用于显示/隐藏顶部淡出遮罩） */
  const hasScrollOverflow = ref(false);

  /** 检查滚动容器是否溢出 */
  function checkScrollOverflow() {
    nextTick(() => {
      const el = scroller.value;
      if (!el) return;
      hasScrollOverflow.value = el.scrollHeight > el.clientHeight + 1;
    });
  }

  /** 滚动到底部（可选强制滚动） */
  function scrollDown(force = false) {
    const doScroll = () => {
      const el = scroller.value;
      if (!el) return;
      const threshold = Math.max(280, el.clientHeight * 0.5);
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      if (force || isNearBottom) el.scrollTo({ top: el.scrollHeight, behavior: force ? 'instant' : 'smooth' });
      hasScrollOverflow.value = el.scrollHeight > el.clientHeight + 1;
    };
    if (force) {
      doScroll();
    } else {
      nextTick(() => requestAnimationFrame(doScroll));
    }
  }

  let overflowObserver: ResizeObserver | undefined;

  onMounted(() => {
    nextTick(() => {
      if (scroller.value) {
        overflowObserver = new ResizeObserver(() => checkScrollOverflow());
        overflowObserver.observe(scroller.value);
      }
    });
  });

  onUnmounted(() => {
    overflowObserver?.disconnect();
  });

  return {
    scroller,
    hasScrollOverflow,
    checkScrollOverflow,
    scrollDown,
  };
}
