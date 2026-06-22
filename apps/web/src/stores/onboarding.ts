import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { MascotState } from '@/components/Mascot.vue';
import { useAuthStore } from './auth';
import { useUiStore } from './ui';

// ── 新手引导步骤定义 ──────────────────────────────────────────
export interface TourStep {
  /** 高亮目标的 CSS 选择器（data-tour="xxx"）；省略则为居中无聚光的纯说明步骤 */
  target?: string;
  title: string;
  text: string;
  /** 气泡相对目标的方位；居中步骤可省略 */
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  /** 吉祥物表情 */
  mascot?: MascotState;
}

/** localStorage 标记键（按用户 sub 维度区分，与 profile 写入策略一致） */
const SEEN_KEY = 'boen_onboarding_seen';

export const useOnboardingStore = defineStore('onboarding', () => {
  const active = ref(false);
  const stepIndex = ref(0);
  const steps = ref<TourStep[]>([]);

  const currentStep = computed<TourStep | undefined>(() => steps.value[stepIndex.value]);
  const total = computed(() => steps.value.length);
  const isFirst = computed(() => stepIndex.value === 0);
  const isLast = computed(() => stepIndex.value === steps.value.length - 1);

  function seenKey(): string {
    const sub = useAuthStore().currentUser?.sub;
    return sub ? `${SEEN_KEY}_${sub}` : SEEN_KEY;
  }

  /** 按当前用户情况组装步骤（大学用户无学科/学习模式，跳过对应步骤） */
  function buildSteps(): TourStep[] {
    const isCollege = useUiStore().isCollege;
    const list: TourStep[] = [
      {
        title: '嗨，我是博文！👋',
        text: '欢迎加入！我是你的专属学习小伙伴。花 20 秒带你认识一下，很快就好～',
        placement: 'center',
        mascot: 'happy',
      },
      {
        target: '[data-tour="nav"]',
        title: '这里是导航栏',
        text: '对话、考试、错题本和学习档案都在这儿，随时点开规划你的学习。',
        placement: 'right',
        mascot: 'idle',
      },
    ];
    if (!isCollege) {
      list.push({
        target: '[data-tour="subject"]',
        title: '切换学科',
        text: '在语文、数学、英语、科学之间自由切换，我会跟着你一起换思路。',
        placement: 'bottom',
        mascot: 'quiz',
      });
      list.push({
        target: '[data-tour="modes"]',
        title: '选个学习模式',
        text: '复习巩固、预习新课、集中突破弱项——选好模式，我就知道该怎么陪你学。',
        placement: 'top',
        mascot: 'thinking',
      });
    }
    list.push({
      target: '[data-tour="input"]',
      title: '在这里向我提问',
      text: '不会的题、想学的知识，直接打字或点麦克风说给我听，我随时都在。',
      placement: 'top',
      mascot: 'listening',
    });
    list.push({
      title: '开始学习吧！🎉',
      text: '就是这么简单。有任何问题尽管问我，我们一起加油！',
      placement: 'center',
      mascot: 'happy',
    });
    return list;
  }

  /** 首次登录 + 已完成设置 + 未看过引导时自动开启（在对话页挂载时调用） */
  function maybeStart() {
    const auth = useAuthStore();
    if (!auth.authenticated || !auth.userProfile) return;
    try {
      if (localStorage.getItem(seenKey())) return;
    } catch { /* localStorage 不可用则照常展示 */ }
    start();
  }

  function start() {
    // 确保侧栏展开，导航栏可被聚光定位
    useUiStore().sidebarOpen = true;
    steps.value = buildSteps();
    stepIndex.value = 0;
    active.value = true;
  }

  function next() {
    if (isLast.value) { finish(); return; }
    stepIndex.value += 1;
  }

  function prev() {
    if (!isFirst.value) stepIndex.value -= 1;
  }

  function finish() {
    active.value = false;
    try { localStorage.setItem(seenKey(), '1'); } catch { /* ignore */ }
  }

  return {
    active,
    stepIndex,
    steps,
    currentStep,
    total,
    isFirst,
    isLast,
    maybeStart,
    start,
    next,
    prev,
    finish,
  };
});
