<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { User, LogOut, Settings } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';

const authStore = useAuthStore();
const uiStore = useUiStore();

function onClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest('.user-menu')) {
    uiStore.showUserMenu = false;
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('click', onClickOutside);
});
</script>

<template>
  <div class="user-menu relative">
    <button
      @click="uiStore.showUserMenu = !uiStore.showUserMenu"
      class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border-2 border-[var(--line)] bg-[var(--surface)] shadow-[0_6px_16px_-8px_rgba(86,64,40,0.4),inset_0_1.5px_0_rgba(255,255,255,0.8)] transition-all hover:border-[var(--accent)] hover:shadow-[0_9px_22px_-8px_var(--accent-glow),inset_0_1.5px_0_rgba(255,255,255,0.8)]"
    >
      <img
        v-if="authStore.currentUser?.picture"
        :src="authStore.currentUser.picture"
        :alt="authStore.currentUser.username"
        class="h-full w-full object-cover"
      />
      <User v-else class="h-4 w-4 text-[var(--ink-soft)]" />
    </button>

    <!-- 下拉菜单 -->
    <div
      v-if="uiStore.showUserMenu"
      class="absolute right-0 top-10 z-50 w-56 origin-top-right overflow-hidden rounded-2xl border border-white bg-[var(--surface)] shadow-[0_22px_48px_-22px_rgba(86,64,40,0.5),0_8px_20px_-12px_rgba(86,64,40,0.3),inset_0_2px_0_rgba(255,255,255,0.9)]"
      v-motion
      :initial="{ opacity: 0, scale: 0.95, y: -8 }"
      :enter="{ opacity: 1, scale: 1, y: 0, transition: { duration: 200 } }"
    >
      <div class="px-4 py-3">
        <p class="text-sm font-semibold text-[var(--ink)]">{{ authStore.currentUser?.username ?? '用户' }}</p>
        <p class="text-xs text-[var(--ink-soft)]">{{ authStore.currentUser?.email ?? '' }}</p>
      </div>
      <div class="border-t border-[var(--line)]">
        <button
          @click="authStore.openSetupDialog(); uiStore.showUserMenu = false"
          class="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--accent-soft)]"
        >
          <Settings class="h-4 w-4" />
          <span>设置</span>
        </button>
        <button
          @click="authStore.doLogout()"
          class="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-[var(--error)] transition-colors hover:bg-[var(--error)]/5"
        >
          <LogOut class="h-4 w-4" />
          <span>退出登录</span>
        </button>
      </div>
    </div>
  </div>
</template>
