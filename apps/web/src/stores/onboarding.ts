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

  function buildMistakesSteps(): TourStep[] {
    return [
      {
        title: '错题本来啦 📒',
        text: '这里把你做错的题集中归档，自动分析错因并归入知识画像。带你看看怎么用～',
        placement: 'center',
        mascot: 'happy',
      },
      {
        target: '[data-tour="mistake-add"]',
        title: '新增错题',
        text: '点这个加号，拍照上传整页试卷或单题照片，也能手动录入，我会自动识别切题。',
        placement: 'bottom',
        mascot: 'quiz',
      },
      {
        target: '[data-tour="mistake-list"]',
        title: '错题列表',
        text: '所有错题按学科归档在这儿。点开任意一题，右侧会显示错因诊断、知识点归因和针对性练习。',
        placement: 'right',
        mascot: 'idle',
      },
      {
        title: '随时来复盘！✨',
        text: '错题越攒越少，说明你越来越强。需要讲解时随时叫我～',
        placement: 'center',
        mascot: 'happy',
      },
    ];
  }

  function buildProfileSteps(): TourStep[] {
    return [
      {
        title: '这是你的学习档案 🧠',
        text: '这里汇总你各知识点的熟练度，帮你看清强项和薄弱点。快速带你逛一圈～',
        placement: 'center',
        mascot: 'happy',
      },
      {
        target: '[data-tour="profile-overall"]',
        title: '综合熟练度',
        text: '星级是你当前学科的整体掌握度，下面分别是待加强 / 良好 / 优秀的知识点数量。',
        placement: 'right',
        mascot: 'idle',
      },
      {
        target: '[data-tour="profile-report"]',
        title: '诊断报告',
        text: '点一下，我会用 AI 生成一份学习诊断报告，分析薄弱点并给出学习建议。',
        placement: 'right',
        mascot: 'thinking',
      },
      {
        target: '[data-tour="profile-recommend"]',
        title: '推荐练习',
        text: '我会挑出最该补强的知识点放在这里，点任意一项就能立刻开始针对练习。',
        placement: 'right',
        mascot: 'quiz',
      },
      {
        target: '[data-tour="profile-outline"]',
        title: '课程大纲',
        text: '按教材章节展开知识点，可以逐章测试或深入探索，掌握进度一目了然。',
        placement: 'left',
        mascot: 'listening',
      },
      {
        title: '一起变强吧！🎉',
        text: '常回来看看档案，你的进步都会记录在这里。',
        placement: 'center',
        mascot: 'happy',
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
