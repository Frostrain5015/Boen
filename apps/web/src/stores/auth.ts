import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Grade, SubscriptionStatus } from '@boen/shared';
import { isAuthenticated, getCurrentUser, logout, getToken, type FrostUser } from '@/services/auth';
import { useChatStore } from './chat';
import { useExamStore } from './exam';
import router from '@/router';

// ── User Profile types & helpers ────────────────────────────
const PROFILE_KEY = 'boen_user_profile';
export type UserProfile = { name: string; grade: Grade };
/** Map legacy gradeBand to a representative grade */
const BAND_TO_GRADE: Record<string, Grade> = { primary: '3', middle: '8', undergrad: 'college' };

/** 初始化时尝试所有可能的 key（scoped + unscoped），scoped 优先级高 */
function loadProfileFallback(sub?: string): UserProfile | null {
  const keys = sub ? [`${PROFILE_KEY}_${sub}`, PROFILE_KEY] : [PROFILE_KEY];
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const p = JSON.parse(raw);
      if (p.name && p.grade) return { name: p.name, grade: p.grade };
      if (p.name && p.gradeBand) return { name: p.name, grade: BAND_TO_GRADE[p.gradeBand] ?? '8' };
    } catch { /* ignore */ }
  }
  return null;
}

export const useAuthStore = defineStore('auth', () => {
  // ── State ─────────────────────────────────────────────────
  const authChecked = ref(false);
  const authenticated = ref(false);
  const currentUser = ref<FrostUser | null>(null);
  const isOAuthCallback = ref(window.location.pathname === '/auth/callback');
  const showSetupDialog = ref(false);
  // 初始化时还没有 currentUser，只能扫 unscoped key；scoped 的稍后在 checkAuth 中补扫
  const userProfile = ref<UserProfile | null>(loadProfileFallback());
  const subscription = ref<SubscriptionStatus | null>(null);

  // ── Computed ──────────────────────────────────────────────
  const isPremium = computed(() => subscription.value?.isPremium ?? false);
  const dailyRemaining = computed(() => subscription.value?.dailyRemaining ?? null);

  // ── Actions ───────────────────────────────────────────────

  async function fetchSubscription() {
    try {
      const token = getToken();
      if (!token) return;
      const res = await fetch('/api/subscription/status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        subscription.value = (await res.json()) as SubscriptionStatus;
      }
    } catch {
      /* 静默失败，不影响基础功能 */
    }
  }

  /** 兑换码开通会员：成功后写入最新订阅状态（后端已即时失效缓存） */
  async function redeemCode(code: string): Promise<{ ok: boolean; error?: string; message?: string }> {
    const token = getToken();
    if (!token) return { ok: false, error: 'unauthorized', message: '请先登录' };
    try {
      const res = await fetch('/api/subscription/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as Partial<SubscriptionStatus> & { error?: string; message?: string };
      if (res.ok) {
        subscription.value = data as SubscriptionStatus;
        return { ok: true };
      }
      return { ok: false, error: data.error, message: data.message };
    } catch {
      return { ok: false, error: 'network', message: '网络错误，请稍后再试' };
    }
  }

  function decrementDailyUsage() {
    if (subscription.value && !subscription.value.isPremium && subscription.value.dailyRemaining != null) {
      subscription.value = {
        ...subscription.value,
        dailyUsed: (subscription.value.dailyUsed ?? 0) + 1,
        dailyRemaining: Math.max(0, subscription.value.dailyRemaining - 1),
      };
    }
  }

  function loadProfileFromStorage(): UserProfile | null {
    // 1. 优先 scoped key（saveProfile 的写入路径）
    const scopedKey = currentUser.value?.sub ? `${PROFILE_KEY}_${currentUser.value.sub}` : null;
    if (scopedKey) {
      try {
        const raw = localStorage.getItem(scopedKey);
        if (raw) {
          const p = JSON.parse(raw);
          if (p.name && p.grade) return p;
          if (p.name && p.gradeBand) return { name: p.name, grade: BAND_TO_GRADE[p.gradeBand] ?? '8' };
        }
      } catch { /* ignore */ }
    }
    // 2. 降级到 unscoped key（旧版本遗留数据）
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.name && p.grade) return p;
        if (p.name && p.gradeBand) return { name: p.name, grade: BAND_TO_GRADE[p.gradeBand] ?? '8' };
      }
    } catch { /* ignore */ }
    return null;
  }

  async function checkAuth() {
    if (isOAuthCallback.value) return;
    const auth = isAuthenticated();
    authenticated.value = auth;
    if (auth) {
      currentUser.value = await getCurrentUser();
      // 初始化时 loadProfile() 读不到 scoped key，这里从双 key 重新加载
      userProfile.value = loadProfileFromStorage();
      const chatStore = useChatStore();
      const examStore = useExamStore();
      await Promise.all([chatStore.loadConversations(), examStore.loadExams(), fetchSubscription()]);
    }
    authChecked.value = true;
  }

  function handleOAuthSuccess() {
    router.replace('/');
    isOAuthCallback.value = false;
    authenticated.value = true;
    authChecked.value = true;
    getCurrentUser().then((user) => {
      currentUser.value = user;
      userProfile.value = loadProfileFallback(user?.sub);
      if (!userProfile.value) router.push('/setup');
    });
    fetchSubscription();
    const chatStore = useChatStore();
    const examStore = useExamStore();
    chatStore.loadConversations();
    examStore.loadExams();
  }

  function handleOAuthError() {
    router.replace('/');
    isOAuthCallback.value = false;
    authChecked.value = true;
    authenticated.value = false;
  }

  function doLogout() {
    logout();
  }

  function saveProfile(p: UserProfile) {
    userProfile.value = p;
    const scopedKey = currentUser.value?.sub ? `${PROFILE_KEY}_${currentUser.value.sub}` : PROFILE_KEY;
    localStorage.setItem(scopedKey, JSON.stringify(p));
    showSetupDialog.value = false;
  }

  function openSetupDialog() {
    router.push('/setup');
  }

  return {
    authChecked,
    authenticated,
    currentUser,
    isOAuthCallback,
    showSetupDialog,
    userProfile,
    subscription,
    isPremium,
    dailyRemaining,
    checkAuth,
    handleOAuthSuccess,
    handleOAuthError,
    doLogout,
    saveProfile,
    openSetupDialog,
    fetchSubscription,
    redeemCode,
    decrementDailyUsage,
  };
});
