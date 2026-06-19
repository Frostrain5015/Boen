import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Grade } from '@boen/shared';
import { isAuthenticated, getCurrentUser, logout, type FrostUser } from '@/services/auth';
import { useChatStore } from './chat';
import { useExamStore } from './exam';

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

  // ── Actions ───────────────────────────────────────────────

  async function checkAuth() {
    if (isOAuthCallback.value) return;
    const auth = isAuthenticated();
    authenticated.value = auth;
    if (auth) {
      currentUser.value = await getCurrentUser();
      const chatStore = useChatStore();
      const examStore = useExamStore();
      await Promise.all([chatStore.loadConversations(), examStore.loadExams()]);
    }
    authChecked.value = true;
  }

  function handleOAuthSuccess() {
    window.history.replaceState({}, '', '/');
    isOAuthCallback.value = false;
    authenticated.value = true;
    authChecked.value = true;
    getCurrentUser().then((user) => {
      currentUser.value = user;
    });
    const chatStore = useChatStore();
    const examStore = useExamStore();
    chatStore.loadConversations();
    examStore.loadExams();
    // Prompt profile setup on first login
    if (!userProfile.value) showSetupDialog.value = true;
  }

  function handleOAuthError() {
    window.history.replaceState({}, '', '/');
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
    checkAuth,
    handleOAuthSuccess,
    handleOAuthError,
    doLogout,
    saveProfile,
    openSetupDialog,
  };
});
