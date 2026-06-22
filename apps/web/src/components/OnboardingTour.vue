<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { ChevronLeft, ChevronRight, Check } from 'lucide-vue-next';
import { useOnboardingStore } from '@/stores/onboarding';
import Mascot from '@/components/Mascot.vue';

const tour = useOnboardingStore();

/** 目标元素的视口矩形（无目标 / 居中步骤时为 null） */
const targetRect = ref<DOMRect | null>(null);
/** 聚光与气泡容器的实测尺寸（用于边界夹紧定位） */
const boxRef = ref<HTMLElement | null>(null);
const boxSize = ref({ w: 420, h: 220 });
/** 视口尺寸（响应式，供定位计算） */
const viewport = ref({ w: window.innerWidth, h: window.innerHeight });

const HOLE_PAD = 8; // 聚光洞相对目标的外扩
const GAP = 22;     // 气泡与目标的间距
const EDGE = 14;    // 视口边缘安全距

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** 读取当前步骤目标的位置 */
function measure() {
  const sel = tour.currentStep?.target;
  if (!sel) { targetRect.value = null; return; }
  const el = document.querySelector(sel);
  targetRect.value = el ? el.getBoundingClientRect() : null;
}

/** 步骤切换 / 激活时重新定位，并等待布局（侧栏展开等）过渡完成 */
watch(
  () => [tour.active, tour.stepIndex] as const,
  async () => {
    if (!tour.active) return;
    await nextTick();
    requestAnimationFrame(measure);
    // 侧栏宽度过渡 ~300ms，延迟再测一次确保稳定
    window.setTimeout(measure, 340);
  },
  { immediate: true },
);

function onViewportChange() {
  if (!tour.active) return;
  viewport.value = { w: window.innerWidth, h: window.innerHeight };
  measure();
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) boxSize.value = { w: r.width, h: r.height };
    });
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
  ro?.disconnect();
});

// 容器挂载后接入 ResizeObserver
watch(boxRef, (el) => {
  if (ro) {
    ro.disconnect();
    if (el) ro.observe(el);
  }
});

/** 聚光洞样式（目标存在时） */
const holeStyle = computed(() => {
  const r = targetRect.value;
  if (!r) return null;
  return {
    top: `${r.top - HOLE_PAD}px`,
    left: `${r.left - HOLE_PAD}px`,
    width: `${r.width + HOLE_PAD * 2}px`,
    height: `${r.height + HOLE_PAD * 2}px`,
  };
});

/** 吉祥物 + 气泡容器的定位 */
const boxStyle = computed(() => {
  const r = targetRect.value;
  const place = tour.currentStep?.placement ?? (r ? 'bottom' : 'center');
  const { w, h } = boxSize.value;
  const { w: vw, h: vh } = viewport.value;

  if (!r || place === 'center') {
    return {
      top: `${(vh - h) / 2}px`,
      left: `${(vw - w) / 2}px`,
    };
  }

  let top: number;
  let left: number;
  switch (place) {
    case 'top':
      top = r.top - GAP - h;
      left = r.left + r.width / 2 - w / 2;
      break;
    case 'left':
      left = r.left - GAP - w;
      top = r.top + r.height / 2 - h / 2;
      break;
    case 'right':
      left = r.right + GAP;
      top = r.top + r.height / 2 - h / 2;
      break;
    case 'bottom':
    default:
      top = r.bottom + GAP;
      left = r.left + r.width / 2 - w / 2;
      break;
  }
  return {
    top: `${clamp(top, EDGE, vh - h - EDGE)}px`,
    left: `${clamp(left, EDGE, vw - w - EDGE)}px`,
  };
});

/** 气泡尾巴指向：当气泡在目标下方时尾巴朝上，依此类推 */
const tailClass = computed(() => {
  const r = targetRect.value;
  const place = tour.currentStep?.placement ?? (r ? 'bottom' : 'center');
  if (!r || place === 'center') return 'tail-hidden';
  return `tail-${place}`;
});

function onPrev() { tour.prev(); }
function onNext() { tour.next(); }
function onSkip() { tour.finish(); }
</script>

<template>
  <Transition name="tour-fade">
    <div
      v-if="tour.active"
      class="tour-root"
      :class="{ 'tour-dim': !targetRect }"
      role="dialog"
      aria-modal="true"
      aria-label="新手引导"
    >
      <!-- 聚光洞：巨大 box-shadow 反选遮罩，仅露出目标 -->
      <div v-if="holeStyle" class="tour-hole" :style="holeStyle"></div>

      <!-- 吉祥物 + 说话气泡 -->
      <div ref="boxRef" class="tour-box" :style="boxStyle">
        <div class="tour-mascot">
          <Mascot :size="76" :state="tour.currentStep?.mascot ?? 'idle'" :float="true" :limbs="true" :animated="true" />
        </div>

        <div class="tour-bubble" :class="tailClass">
          <span class="tour-tail"></span>

          <button class="tour-skip" type="button" @click="onSkip">跳过</button>

          <h3 class="tour-title">{{ tour.currentStep?.title }}</h3>
          <p class="tour-text">{{ tour.currentStep?.text }}</p>

          <div class="tour-footer">
            <!-- 进度点 -->
            <div class="tour-dots">
              <span
                v-for="(_, i) in tour.total"
                :key="i"
                class="tour-dot"
                :class="{ 'is-active': i === tour.stepIndex }"
              ></span>
            </div>

            <div class="tour-actions">
              <button v-if="!tour.isFirst" class="tour-btn tour-btn-ghost" type="button" @click="onPrev">
                <ChevronLeft class="h-4 w-4" /> 上一步
              </button>
              <button class="tour-btn tour-btn-accent" type="button" @click="onNext">
                <template v-if="tour.isLast">
                  开始学习 <Check class="h-4 w-4" />
                </template>
                <template v-else>
                  下一步 <ChevronRight class="h-4 w-4" />
                </template>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.tour-root {
  position: fixed;
  inset: 0;
  z-index: 9990;
  /* 透明层捕获所有点击，强制走引导按钮（聚光的暗化由 .tour-hole 的 box-shadow 提供） */
  background: transparent;
  pointer-events: auto;
}
/* 居中说明步骤：无聚光洞，整屏暗化 */
.tour-dim {
  background: rgba(44, 39, 34, 0.55);
  backdrop-filter: blur(2px);
}

/* ── 聚光洞 ── */
.tour-hole {
  position: fixed;
  border-radius: 16px;
  pointer-events: none;
  box-shadow:
    0 0 0 9999px rgba(44, 39, 34, 0.55),
    0 0 0 2.5px var(--accent),
    0 0 22px 6px var(--accent-glow);
  transition: top 0.4s cubic-bezier(0.34, 1.4, 0.64, 1),
    left 0.4s cubic-bezier(0.34, 1.4, 0.64, 1),
    width 0.4s cubic-bezier(0.34, 1.4, 0.64, 1),
    height 0.4s cubic-bezier(0.34, 1.4, 0.64, 1);
}

/* ── 吉祥物 + 气泡容器 ── */
.tour-box {
  position: fixed;
  z-index: 1;
  display: flex;
  align-items: flex-end;
  gap: 6px;
  width: max-content;
  max-width: min(420px, calc(100vw - 28px));
  pointer-events: auto;
  transition: top 0.4s cubic-bezier(0.34, 1.4, 0.64, 1),
    left 0.4s cubic-bezier(0.34, 1.4, 0.64, 1);
  animation: tourBoxIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.tour-mascot {
  flex-shrink: 0;
  filter: drop-shadow(0 10px 16px rgba(86, 64, 40, 0.32));
}

/* ── 气泡 ── */
.tour-bubble {
  position: relative;
  flex: 1;
  min-width: 0;
  background: var(--surface);
  border: 1.5px solid #fff;
  border-radius: 20px;
  padding: 16px 18px 14px;
  box-shadow:
    0 22px 44px -22px rgba(86, 64, 40, 0.4),
    0 8px 18px -10px rgba(86, 64, 40, 0.28),
    inset 0 2px 0 rgba(255, 255, 255, 0.9);
}

/* 尾巴：一个旋转方块，指向吉祥物 / 目标 */
.tour-tail {
  position: absolute;
  width: 14px;
  height: 14px;
  background: var(--surface);
  border-left: 1.5px solid #fff;
  border-bottom: 1.5px solid #fff;
  border-bottom-left-radius: 4px;
}
/* 气泡在目标下方 → 尾巴朝上 */
.tail-bottom .tour-tail { top: -7px; left: 28px; transform: rotate(135deg); }
/* 气泡在目标上方 → 尾巴朝下 */
.tail-top .tour-tail { bottom: -7px; left: 28px; transform: rotate(-45deg); }
/* 气泡在目标右侧 → 尾巴朝左（贴吉祥物一侧） */
.tail-right .tour-tail { left: -7px; bottom: 24px; transform: rotate(45deg); }
/* 气泡在目标左侧 → 尾巴朝右 */
.tail-left .tour-tail { right: -7px; bottom: 24px; transform: rotate(-135deg); }
.tail-hidden .tour-tail,
/* 默认（居中）尾巴贴左下指向吉祥物 */
.tour-bubble:not([class*="tail-"]) .tour-tail { left: -7px; bottom: 24px; transform: rotate(45deg); }

.tour-skip {
  position: absolute;
  top: 10px;
  right: 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-soft);
  opacity: 0.7;
  transition: opacity 0.2s ease, color 0.2s ease;
}
.tour-skip:hover { opacity: 1; color: var(--ink); }

.tour-title {
  font-family: var(--font-display, sans-serif);
  font-size: 16px;
  font-weight: 800;
  color: var(--ink);
  margin: 0 0 6px;
  padding-right: 32px;
}
.tour-text {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink-soft);
  margin: 0 0 14px;
}

.tour-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.tour-dots { display: flex; align-items: center; gap: 5px; }
.tour-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--line);
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.tour-dot.is-active {
  width: 18px;
  background: var(--accent);
}

.tour-actions { display: flex; align-items: center; gap: 8px; }
.tour-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 34px;
  padding: 0 14px;
  border-radius: 16px;
  font-family: var(--font-display, sans-serif);
  font-size: 13px;
  font-weight: 700;
  transition: transform 0.15s ease, background 0.2s ease, border-color 0.2s ease;
}
.tour-btn:active { transform: scale(0.96); }
.tour-btn-ghost {
  background: #fff;
  border: 1.5px solid var(--line);
  color: var(--ink-soft);
}
.tour-btn-ghost:hover { border-color: var(--accent); color: var(--accent-strong); }
.tour-btn-accent {
  background: linear-gradient(180deg, var(--accent), var(--accent-strong));
  color: #fff;
  box-shadow:
    0 10px 20px -10px var(--accent-glow),
    inset 0 -2px 0 rgba(0, 0, 0, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.4);
}
.tour-btn-accent:hover { transform: translateY(-1px); }

@keyframes tourBoxIn {
  0% { opacity: 0; transform: scale(0.92) translateY(8px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}

/* ── 进入 / 退出 ── */
.tour-fade-enter-active { transition: opacity 0.3s ease; }
.tour-fade-leave-active { transition: opacity 0.25s ease; }
.tour-fade-enter-from,
.tour-fade-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .tour-hole,
  .tour-box { transition: none; }
  .tour-box { animation: none; }
}
</style>
