<script setup lang="ts">
import { onMounted, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { NotebookPen } from 'lucide-vue-next';
import MistakeBook from '@/components/MistakeBook.vue';
import PremiumGate from '@/components/PremiumGate.vue';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useOnboardingStore } from '@/stores/onboarding';
import type { Subject } from '@/stores/chat';

const router = useRouter();
const authStore = useAuthStore();
const uiStore = useUiStore();
const onboarding = useOnboardingStore();

// 首次进入错题本（星月卡用户可见内容时）播放一次引导
onMounted(() => {
  if (!authStore.isPremium) return;
  nextTick(() => onboarding.maybeStart('mistakes'));
});

function handleBack() {
  router.push('/');
}

function handlePractice(detail: { prompt: string; subject: Subject; grade: string }) {
  router.push('/');
  uiStore.handleMistakePractice(detail);
}
</script>

<template>
  <PremiumGate feature-name="错题本" :icon="NotebookPen">
    <MistakeBook
      class="flex-1"
      :grade="authStore.userProfile?.grade ?? '7'"
      :initial-subject="uiStore.subject"
      @back="handleBack"
      @practice="handlePractice"
    />
  </PremiumGate>
</template>
