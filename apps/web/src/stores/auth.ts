import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Grade, SubscriptionStatus, CurrencyStatus } from '@boen/shared';
import { isAuthenticated, getCurrentUser, logout, getToken, type FrostUser } from '@/services/auth';
import { setOnUnauthorized } from '@/services/chat';
import { useChatStore } from './chat';
import { useExamStore } from './exam';
import router from '@/router';

// 注册 401 自动登出回调：当 API 请求返回 401 时，自动清除登录状态并跳转到登录页
setOnUnauthorized(() => {
  const store = useAuthStore();
  store.doLogout();
});

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
  const currency = ref<CurrencyStatus | null>(null);

  // ── Computed ──────────────────────────────────────────────
  const isPremium = computed(() => subscription.value?.isPremium ?? false);
  const dailyRemaining = computed(() => subscription.value?.dailyRemaining ?? null);
  const pointsBalance = computed(() => currency.value?.balance ?? 0);

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

  /** 拉取星月积分状态（余额/今日已赚/可兑换产品） */
  async function fetchCurrencyStatus() {
    try {
      const token = getToken();
      if (!token) return;
      const res = await fetch('/api/currency/status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        currency.value = (await res.json()) as CurrencyStatus;
      }
    } catch {
      /* 静默失败 */
    }
  }

  /** 结算事件回写最新余额（SSE settlement / 考试结果携带） */
  function applyEarnedPoints(balance: number | undefined) {
    if (typeof balance === 'number' && currency.value) {
      currency.value = { ...currency.value, balance };
    } else if (typeof balance === 'number') {
      // 尚未拉取过 status：异步补拉一次
      fetchCurrencyStatus();
    }
  }

  /** 领取每日登录奖励（北京时间每天一次，+50 积分）。返回是否成功 + 提示。 */
  async function claimDailyLogin(): Promise<{ ok: boolean; reward?: number; message?: string }> {
    const token = getToken();
    if (!token) return { ok: false, message: '请先登录' };
    try {
      const res = await fetch('/api/currency/claim-daily', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { ok?: boolean; reward?: number; balance?: number; message?: string };
      if (typeof data.balance === 'number' && currency.value) {
        currency.value = { ...currency.value, balance: data.balance, claimedToday: true };
      }
      if (res.ok && data.ok) return { ok: true, reward: data.reward };
      return { ok: false, message: data.message ?? '领取失败' };
    } catch {
      return { ok: false, message: '网络错误，请稍后再试' };
    }
  }

  /** 用星月积分兑换会员：成功后同时更新订阅与积分余额 */
  async function redeemMembershipWithPoints(productKey: string): Promise<{ ok: boolean; error?: string; message?: string }> {
    const token = getToken();
    if (!token) return { ok: false, error: 'unauthorized', message: '请先登录' };
    try {
      const res = await fetch('/api/currency/redeem-membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ productKey }),
      });
      const data = (await res.json()) as Partial<SubscriptionStatus> & { balance?: number; error?: string; message?: string };
      if (res.ok) {
        await fetchSubscription();
        if (typeof data.balance === 'number' && currency.value) {
          currency.value = { ...currency.value, balance: data.balance };
        } else {
          fetchCurrencyStatus();
        }
        return { ok: true };
      }
      if (typeof data.balance === 'number' && currency.value) {
        currency.value = { ...currency.value, balance: data.balance };
      }
      return { ok: false, error: data.error, message: data.message };
    } catch {
      return { ok: false, error: 'network', message: '网络错误，请稍后再试' };
    }
  }

  /**
   * 创建 Waffo 收银台会话，返回支付页地址。
   * 调用方负责用 window.open(url, '_blank', 'noopener,noreferrer') 新标签页打开 ——
   * 用 location.href 会丢失商户页面状态（未保存的输入、滚动位置等）。
   */
  async function createCheckout(planKey: string): Promise<{ ok: boolean; checkoutUrl?: string; error?: string; message?: string }> {
    const token = getToken();
    if (!token) return { ok: false, error: 'unauthorized', message: '请先登录' };
    try {
      const res = await fetch('/api/payment/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ planKey, email: currentUser.value?.email, acceptedTermsVersion: '1.1' }),
      });
      const data = (await res.json()) as { checkoutUrl?: string; error?: string; message?: string };
      if (res.ok && data.checkoutUrl) return { ok: true, checkoutUrl: data.checkoutUrl };
      return { ok: false, error: data.error, message: data.message ?? '创建支付会话失败' };
    } catch {
      return { ok: false, error: 'network', message: '网络错误，请稍后再试' };
    }
  }

  /**
   * 支付回跳后轮询订阅状态。Waffo 的 Webhook 到达有秒级延迟，
   * 且服务端 5 分钟订阅缓存已被发卡逻辑主动失效，所以轮询能真实反映结果。
   */
  async function pollSubscription(timeoutMs = 24000, intervalMs = 1500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await fetchSubscription();
      if (subscription.value?.membership.source === 'waffo') return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, intervalMs));
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
      await Promise.all([chatStore.loadConversations(), examStore.loadExams(), fetchSubscription(), fetchCurrencyStatus()]);
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
    fetchCurrencyStatus();
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
    currency,
    isPremium,
    dailyRemaining,
    pointsBalance,
    checkAuth,
    handleOAuthSuccess,
    handleOAuthError,
    doLogout,
    saveProfile,
    openSetupDialog,
    fetchSubscription,
    decrementDailyUsage,
    fetchCurrencyStatus,
    applyEarnedPoints,
    redeemMembershipWithPoints,
    claimDailyLogin,
    createCheckout,
    pollSubscription,
  };
});
