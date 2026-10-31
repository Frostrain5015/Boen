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

/** 可独立播放（各自「没看过就播一次」）的引导 */
export type TourId = 'chat' | 'mistakes' | 'profile';

/** 各引导的 localStorage 标记键（按用户 sub 维度区分，与 profile 写入策略一致）。
 *  chat 沿用历史键名，避免老用户重复看到。 */
const SEEN_KEYS: Record<TourId, string> = {
  chat: 'boen_onboarding_seen',
  mistakes: 'boen_onboarding_mistakes_seen',
  profile: 'boen_onboarding_profile_seen',
};

export const useOnboardingStore = defineStore('onboarding', () => {
  const activeTour = ref<TourId | null>(null);
  const stepIndex = ref(0);
  const steps = ref<TourStep[]>([]);

  const active = computed(() => activeTour.value !== null);
  const currentStep = computed<TourStep | undefined>(() => steps.value[stepIndex.value]);
  const total = computed(() => steps.value.length);
  const isFirst = computed(() => stepIndex.value === 0);
  const isLast = computed(() => stepIndex.value === steps.value.length - 1);

  function seenKey(tour: TourId): string {
    const sub = useAuthStore().currentUser?.sub;
    return sub ? `${SEEN_KEYS[tour]}_${sub}` : SEEN_KEYS[tour];
  }

  // ── 各引导步骤 ──────────────────────────────────────────────
  function buildChatSteps(): TourStep[] {
    const isCollege = useUiStore().isCollege;
    const list: TourStep[] = [
      {
        target: '[data-tour="nav"]',
        title: '学习工具',
        text: '在这里打开对话、考试、错题本和学习档案。',
        placement: 'right',
        mascot: 'idle',
      },
    ];
    if (!isCollege) {
      list.push({
        target: '[data-tour="subject"]',
        title: '切换学科',
        text: '选择语文、数学、英语或科学。',
        placement: 'bottom',
        mascot: 'quiz',
      });
      list.push({
        target: '[data-tour="modes"]',
        title: '学习模式',
        text: '选择复习、预习或练习，按步骤学习。',
        placement: 'top',
        mascot: 'thinking',
      });
    }
    list.push({
      target: '[data-tour="input"]',
      title: '提问',
      text: '输入问题或上传题目图片；支持的浏览器也可使用语音输入。',
      placement: 'top',
      mascot: 'listening',
    });
    return list;
  }

  function buildMistakesSteps(): TourStep[] {
    return [
      {
        target: '[data-tour="mistake-add"]',
        title: '新增错题',
        text: '上传整页试卷、单题照片，或手动输入题目。',
        placement: 'bottom',
        mascot: 'quiz',
      },
      {
        target: '[data-tour="mistake-list"]',
        title: '错题列表',
        text: '选择错题，查看错因和相关知识点，开始针对性练习。',
        placement: 'right',
        mascot: 'idle',
      },
    ];
  }

  function buildProfileSteps(): TourStep[] {
    return [
      {
        target: '[data-tour="profile-overall"]',
        title: '综合熟练度',
        text: '星级表示当前学科的整体掌握程度，下方是各熟练度的知识点数量。',
        placement: 'right',
        mascot: 'idle',
      },
      {
        target: '[data-tour="profile-report"]',
        title: '诊断报告',
        text: '生成薄弱点分析和学习建议。',
        placement: 'right',
        mascot: 'thinking',
      },
      {
        target: '[data-tour="profile-recommend"]',
        title: '推荐练习',
        text: '选择一个知识点，开始针对性练习。',
        placement: 'right',
        mascot: 'quiz',
      },
      {
        target: '[data-tour="profile-outline"]',
        title: '课程大纲',
        text: '展开教材章节，查看知识点，开始章节测试或探索学习。',
        placement: 'left',
        mascot: 'listening',
      },
    ];
  }

  const BUILDERS: Record<TourId, () => TourStep[]> = {
    chat: buildChatSteps,
    mistakes: buildMistakesSteps,
    profile: buildProfileSteps,
  };

  /** 「没看过就播一次」：已登录 + 已完成设置 + 该引导未看过时自动开启 */
  function maybeStart(tour: TourId) {
    if (active.value) return; // 已有引导进行中，不打断
    const auth = useAuthStore();
    if (!auth.authenticated || !auth.userProfile) return;
    try {
      if (localStorage.getItem(seenKey(tour))) return;
    } catch { /* localStorage 不可用则照常展示 */ }
    start(tour);
  }

  function start(tour: TourId) {
    // chat 引导的导航步骤需要侧栏展开
    if (tour === 'chat') useUiStore().sidebarOpen = true;
    steps.value = BUILDERS[tour]();
    stepIndex.value = 0;
    activeTour.value = tour;
  }

  function next() {
    if (isLast.value) { finish(); return; }
    stepIndex.value += 1;
  }

  function prev() {
    if (!isFirst.value) stepIndex.value -= 1;
  }

  function finish() {
    const tour = activeTour.value;
    if (tour) {
      try { localStorage.setItem(seenKey(tour), '1'); } catch { /* ignore */ }
    }
    activeTour.value = null;
    steps.value = [];
    stepIndex.value = 0;
  }

  return {
    activeTour,
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
