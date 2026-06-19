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

function loadProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p.name && p.grade) return { name: p.name, grade: p.grade };
    // Legacy: { name, gradeBand } -> representative grade
    if (p.name && p.gradeBand) return { name: p.name, grade: BAND_TO_GRADE[p.gradeBand] ?? '8' };
  } catch { /* ignore corrupt data */ }
  return null;
}

function saveProfileToStorage(p: UserProfile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}

export const useAuthStore = defineStore('auth', () => {
  // ── State ─────────────────────────────────────────────────
  const authChecked = ref(false);
  const authenticated = ref(false);
  const currentUser = ref<FrostUser | null>(null);
  const isOAuthCallback = ref(window.location.pathname === '/auth/callback');
  const showSetupDialog = ref(false);
  const userProfile = ref<UserProfile | null>(loadProfile());
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

  function decrementDailyUsage() {
    if (subscription.value && !subscription.value.isPremium && subscription.value.dailyRemaining != null) {
      subscription.value = {
        ...subscription.value,
        dailyUsed: (subscription.value.dailyUsed ?? 0) + 1,
        dailyRemaining: Math.max(0, subscription.value.dailyRemaining - 1),
      };
    }
  }

  async function checkAuth() {
    if (isOAuthCallback.value) return;
    const auth = isAuthenticated();
    authenticated.value = auth;
    if (auth) {
      currentUser.value = await getCurrentUser();
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
    });
    fetchSubscription();
    const chatStore = useChatStore();
    const examStore = useExamStore();
    chatStore.loadConversations();
    examStore.loadExams();
    // Prompt profile setup on first login
    if (!userProfile.value) showSetupDialog.value = true;
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
    saveProfileToStorage(p);
    showSetupDialog.value = false;
  }

  function openSetupDialog() {
    showSetupDialog.value = true;
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
    decrementDailyUsage,
  };
});
