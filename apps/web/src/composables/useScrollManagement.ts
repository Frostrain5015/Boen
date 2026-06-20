import { ref, nextTick, onMounted, onUnmounted } from 'vue';

export function useScrollManagement() {
  const scroller = ref<HTMLElement | null>(null);
  const hasScrollOverflow = ref(false);

  function checkScrollOverflow() {
    nextTick(() => {
      const el = scroller.value;
      if (!el) return;
      hasScrollOverflow.value = el.scrollHeight > el.clientHeight + 1;
    });
  }

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
