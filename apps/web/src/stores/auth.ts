import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Grade, SubscriptionStatus, CurrencyStatus, MembershipPlanKey } from '@boen/shared';
import { isGrade, MEMBERSHIP_TERMS_VERSION } from '@boen/shared';
import { clearToken, isAuthenticated, getCurrentUser, logout, getToken, type FrostUser } from '@/services/auth';
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
const DEV_GRADE_KEY = 'boen_dev_learning_grade';

function readName(sub: string): string {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`${PROFILE_KEY}_${sub}`) ?? 'null');
    if (stored && typeof stored === 'object' && 'name' in stored && typeof stored.name === 'string') return stored.name;
  } catch { /* ignore */ }
  return '';
}

export const useAuthStore = defineStore('auth', () => {
  // ── State ─────────────────────────────────────────────────
  const authChecked = ref(false);
  const authenticated = ref(false);
  const currentUser = ref<FrostUser | null>(null);
  const isOAuthCallback = ref(window.location.pathname === '/auth/callback');
  const grade = ref<Grade | null>(null);
  const gradeStatus = ref<'loading' | 'ready' | 'error'>('loading');
  const profileName = ref('');
  const userProfile = computed(() => grade.value
    ? { grade: grade.value, name: profileName.value || currentUser.value?.preferred_username || currentUser.value?.username || '' }
    : null);
  let loadingGradeToken: string | null = null;
  const subscription = ref<SubscriptionStatus | null>(null);
  const subscriptionChecked = ref(false);
  const currency = ref<CurrencyStatus | null>(null);

  // ── Computed ──────────────────────────────────────────────
  const isPremium = computed(() => subscription.value?.isPremium ?? false);
  const dailyRemaining = computed(() => subscription.value?.dailyRemaining ?? null);
  const pointsBalance = computed(() => currency.value?.balance ?? 0);

  // ── Actions ───────────────────────────────────────────────

  async function fetchSubscription() {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch('/api/subscription/status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const status = (await res.json()) as SubscriptionStatus;
        if (getToken() === token) subscription.value = status;
      }
    } catch {
      /* 静默失败，不影响基础功能 */
    } finally {
      if (getToken() === token) subscriptionChecked.value = true;
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
        body: JSON.stringify({ planKey, email: currentUser.value?.email, acceptedTermsVersion: MEMBERSHIP_TERMS_VERSION }),
      });
      const data = (await res.json()) as { checkoutUrl?: string; error?: string; message?: string };
      if (res.ok && data.checkoutUrl) return { ok: true, checkoutUrl: data.checkoutUrl };
      return { ok: false, error: data.error, message: data.message ?? '无法打开收银台，请稍后重试' };
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

  async function loadLearningProfile() {
    const token = getToken();
    if (!token || loadingGradeToken === token) return;
    gradeStatus.value = 'loading';
    loadingGradeToken = token;
    try {
      if (import.meta.env.DEV && token.startsWith('local-dev-token-')) {
        const stored = sessionStorage.getItem(DEV_GRADE_KEY);
        grade.value = isGrade(stored) ? stored : null;
        gradeStatus.value = 'ready';
        return;
      }
      const res = await fetch('/api/account/learning-profile', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (getToken() !== token) return;
      if (res.status === 401) {
        clearToken();
        authenticated.value = false;
        grade.value = null;
        return;
      }
      if (!res.ok) throw new Error('Learning profile unavailable');
      const data: unknown = await res.json();
      if (getToken() !== token) return;
      if (!data || typeof data !== 'object' || !('grade' in data) || (data.grade !== null && !isGrade(data.grade))) {
        throw new Error('Invalid learning profile');
      }
      grade.value = data.grade;
      gradeStatus.value = 'ready';
    } catch {
      if (getToken() === token) gradeStatus.value = 'error';
    } finally {
      if (loadingGradeToken === token) loadingGradeToken = null;
    }
  }

  async function saveGrade(selected: Grade): Promise<void> {
    const token = getToken();
    if (!token) throw new Error('请重新登录');
    if (import.meta.env.DEV && token.startsWith('local-dev-token-')) {
      sessionStorage.setItem(DEV_GRADE_KEY, selected);
      grade.value = selected;
      return;
    }
    const res = await fetch('/api/account/learning-profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ grade: selected }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (getToken() !== token) throw new Error('请重新登录');
    if (res?.status === 401) {
      clearToken();
      authenticated.value = false;
      grade.value = null;
      throw new Error('请重新登录');
    }
    if (!res?.ok) throw new Error('年级未保存，请重试');
    grade.value = selected;
  }

  function saveName(name: string) {
    profileName.value = name;
    const sub = currentUser.value?.sub;
    if (!sub) return;
    try { localStorage.setItem(`${PROFILE_KEY}_${sub}`, JSON.stringify({ name })); }
    catch { /* browser storage can be unavailable */ }
  }

  async function checkAuth() {
    if (isOAuthCallback.value) return;
    grade.value = null;
    gradeStatus.value = 'loading';
    profileName.value = '';
    subscription.value = null;
    subscriptionChecked.value = false;
    const auth = isAuthenticated();
    authenticated.value = auth;
    if (auth) {
      currentUser.value = await getCurrentUser();
      authenticated.value = isAuthenticated();
    }
    authChecked.value = true;
    if (!authenticated.value) return;
    profileName.value = currentUser.value ? readName(currentUser.value.sub) : '';
    const chatStore = useChatStore();
    const examStore = useExamStore();
    await Promise.all([loadLearningProfile(), chatStore.loadConversations(), examStore.loadExams(), fetchSubscription(), fetchCurrencyStatus()]);
  }

  async function handleOAuthSuccess(plan?: MembershipPlanKey) {
    await router.replace(plan ? { name: 'setup', query: { plan } } : '/');
    isOAuthCallback.value = false;
    authChecked.value = false;
    await checkAuth();
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

  return {
    authChecked,
    authenticated,
    currentUser,
    isOAuthCallback,
    grade,
    gradeStatus,
    profileName,
    userProfile,
    subscription,
    subscriptionChecked,
    currency,
    isPremium,
    dailyRemaining,
    pointsBalance,
    checkAuth,
    handleOAuthSuccess,
    handleOAuthError,
    doLogout,
    loadLearningProfile,
    saveGrade,
    saveName,
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
